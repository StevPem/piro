'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { IcomPeer, envelope } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver, TIMEOUT_MINUTES } = require('../src/icom-lan/driver');
const { IcomSession } = require('../src/icom-lan/session');
const { IcomStream } = require('../src/icom-lan/stream');
const P = require('../src/icom-lan/protocol');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 1500;
  while (!predicate()) { assert.ok(Date.now() < end, 'condition timed out'); await sleep(5); }
}

async function radio(t, options = {}, driverOptions = {}, configure) {
  const peer = await new IcomPeer(options).start();
  configure?.(peer);
  const driver = new IcomLanDriver(peer.config({ txBufferMs: 0, ...driverOptions }));
  const errors = [];
  driver.on('error', (err) => errors.push(err));
  t.after(async () => { await driver.close(); await peer.close(); });
  await driver.open();
  return { peer, driver, errors };
}

test('independent byte vectors pin credentials, endian fields and frame lengths', () => {
  assert.equal(P.packet(16, 3, 0x11223344).toString('hex'), '10000000030000001122334400000000');
  assert.equal(P.passcode('beer').toString('hex'), '2b3f555c000000000000000000000000');
  assert.equal(P.serial(1, 2, 0x102, Buffer.from('fefeb6e003fd', 'hex')).subarray(16).toString('hex'), 'c106000102fefeb6e003fd');
  assert.equal(P.audio(1, 2, 0x304, Buffer.from('0080ff7f0000', 'hex')).subarray(16).toString('hex'), '80000304000000060080ff7f0000');
  assert.equal(P.serialPayload(P.serial(1, 2, 0, Buffer.alloc(498))).length, 498);
  for (const invalid of ['', 'x'.repeat(17), 'é', '\n']) assert.throws(() => P.passcode(invalid));
  assert.equal(P.header(Buffer.alloc(2)), null);
  assert.equal(P.audioPayload(P.audio(1, 2, 0, Buffer.alloc(3))), null);
});

test('stream reorder/replay is bounded and superseded keying never replays', () => {
  let now = 0;
  const s = new IcomStream({ role: 'CI-V', now: () => now, reorderMs: 10, maxPackets: 4 });
  Object.assign(s, { ready: true, localId: 1, remoteId: 2, lastRx: 0, lastIdle: 0, lastPing: 0 });
  const sent = [], received = [];
  s.raw = (p) => sent.push(Buffer.from(p));
  s.on('payload', (p) => received.push(p.readUInt16LE(6)));
  for (const n of [65534, 0]) s.receive(envelope(24, 0, 2, 1, n));
  now = 11; s.tick();
  assert.equal(sent.at(-1).readUInt16LE(4), 1);
  s.receive(envelope(24, 0, 2, 1, 65535));
  assert.deepEqual(received, [65534, 65535, 0]);
  for (let n = 0; n < 6; n++) s.tracked(P.packet(24, 0, 1, 2));
  assert.equal(s.replay.size, 4);
  const retired = s.tracked(P.packet(24, 0, 1, 2), { group: 'ptt' });
  s.tracked(P.packet(24, 0, 1, 2), { group: 'ptt' });
  s.receive(envelope(16, 1, 2, 1, retired));
  assert.equal(sent.at(-1).length, 16);
});

test('stream grants require the authenticated requested radio while allowing token rotation', () => {
  function context() {
    const s = new IcomSession({ host: '127.0.0.1', username: 'beer', password: 'beer' });
    Object.assign(s, { requested: true, authenticated: true, authId: Buffer.from('010203040506', 'hex'), radioId: Buffer.alloc(16, 7) });
    let starts = 0;
    s.serial = s.audio = { start() { ++starts; } };
    const p = Buffer.alloc(144); p[20] = 3; p[96] = 1; s.radioId.copy(p, 32); p.fill(9, 26, 32);
    return { s, p, starts: () => starts };
  }
  for (const corrupt of [(c) => { c.p[20] = 0; }, (c) => { c.p[21] = 1; }, (c) => { c.p[32] ^= 1; },
    (c) => { c.s.authenticated = false; }, (c) => { c.s.requested = false; }, (c) => { c.p[96] = 0; }]) {
    const c = context(); corrupt(c); c.s.controlPayload(c.p); assert.equal(c.starts(), 0);
  }
  const c = context(); c.s.controlPayload(c.p); c.s.controlPayload(c.p);
  assert.equal(c.starts(), 2); assert.deepEqual(c.s.authId, Buffer.alloc(6, 9));
});

test('localhost negotiation verifies actual model/custom address and restores routing', async (t) => {
  const { peer, driver } = await radio(t, { address: 0xb4 }, { modLevel: 100 });
  assert.equal(driver.radioAddr, 0xb4);
  assert.equal(driver.profile.name, 'IC-7300MK2');
  assert.equal(driver.timeoutMinutes, 3);
  assert.equal(driver.timeoutWarning, null);
  assert.equal(peer.parameters.get('0079')[0], 0);
  await driver.setPtt(true);
  assert.equal(peer.parameters.get('0084')[0], 5);
  await driver.setPtt(false);
  assert.equal(peer.ptt, false);
  assert.equal(peer.parameters.get('0084')[0], 0);
  assert.deepEqual(peer.parameters.get('0083'), Buffer.from([1, 0x28]));
});

test('wrong model and rejected login cannot open a usable driver', async () => {
  for (const [options, expected] of [[{ modelId: 0x94 }, /identify/], [{ rejectLogin: true }, /credentials/]]) {
    const peer = await new IcomPeer(options).start();
    const driver = new IcomLanDriver(peer.config());
    driver.on('error', () => {});
    try { await assert.rejects(driver.open(), expected); assert.equal(driver.prepared, false); }
    finally { await driver.close(); await peer.close(); }
  }
});

test('0032 values decode strictly; OFF allows RX but prevents every native keying entry', async (t) => {
  for (let raw = 0; raw < 6; raw++) await t.test(String(raw), async (t) => {
    const { peer, driver } = await radio(t, { civTimeout: raw });
    assert.equal(driver.timeoutMinutes, TIMEOUT_MINUTES[raw]);
    assert.ok(peer.commands.some((p) => p.subarray(4).toString('hex') === '1a050032fd'));
    if (raw === 0) {
      assert.match(driver.timeoutWarning, /OFF/);
      assert.equal(await driver.getFrequency(), 14074000);
      await assert.rejects(driver.setPtt(true), /time-out/);
      await assert.rejects(driver.sendCw('E'), /time-out/);
      await assert.rejects(driver.setTuner(2), /time-out/);
      await driver.setTuner(0);
      assert.equal(peer.ptt, false);
      assert.equal(peer.cwText.length, 0);
      assert.equal(peer.commands.filter((p) => p.subarray(4).toString('hex') === '1c0001fd').length, 0);
      assert.equal(peer.commands.filter((p) => p.subarray(4).toString('hex') === '1c0102fd').length, 0);
    }
  });
});

test('semantic timeout read errors keep receive available and block TX', async (t) => {
  for (const reply of [[0xfa], [0x1a, 5, 0, 0x32, 6], [0x1a, 5, 0, 0x33, 1],
    [0x1a, 5, 0, 0x32], [0x1a, 5, 0, 0x32, 1, 1]]) await t.test(Buffer.from(reply).toString('hex'), async (t) => {
    const { driver } = await radio(t, {}, {}, (peer) => {
      const original = peer.civ.bind(peer);
      peer.civ = (p, a) => p.subarray(4).toString('hex') === '1a050032fd' ? peer.replyCiv(reply, a) : original(p, a);
    });
    assert.equal(driver.timeoutMinutes, null);
    assert.match(driver.timeoutWarning, /could not be verified/);
    assert.equal(await driver.getFrequency(), 14074000);
    await assert.rejects(driver.setPtt(true), /time-out/);
  });
});

test('a changed radio timeout is checked again before transmitting and announced', async (t) => {
  const { peer, driver } = await radio(t);
  const warnings = [];
  driver.on('timeout-warning', (warning) => warnings.push(warning));
  peer.parameters.set('0032', Buffer.from([0]));
  await assert.rejects(driver.setPtt(true), /OFF/);
  assert.equal(warnings.length, 1);
  peer.parameters.set('0032', Buffer.from([2]));
  await driver.setPtt(true); await driver.setPtt(false);
  assert.equal(driver.timeoutMinutes, 5);
  assert.equal(warnings.at(-1), null);
});

test('a wire timeout reading 0032 is fatal rather than being treated as a semantic warning', async () => {
  const peer = await new IcomPeer().start();
  const driver = new IcomLanDriver(peer.config({ requestTimeoutMs: 60 }));
  driver.on('error', () => {});
  const original = peer.civ.bind(peer);
  peer.civ = (p, a) => { if (p.subarray(4).toString('hex') !== '1a050032fd') original(p, a); };
  try {
    await assert.rejects(driver.open(), /timed out/);
    assert.equal(driver.session.ended, true);
    await assert.rejects(driver.open(), /restart/);
  } finally { await driver.close(); await peer.close(); }
});

test('control, serial and audio loss permanently close the transport without reconnecting', async (t) => {
  for (const role of ['control', 'civ', 'audio']) await t.test(role, async (t) => {
    const { peer, driver } = await radio(t);
    const before = peer.received.filter((p) => p.role === 'control' && p.packet.readUInt16LE(4) === 3).length;
    const closed = once(driver, 'close'); const a = peer.associations[role];
    peer.sendRaw(role, envelope(16, 5, a.sid, a.client));
    await closed; await sleep(60);
    assert.equal(driver.session.connected, false);
    assert.equal(driver.prepared, false);
    await assert.rejects(driver.session.open(), /restart/);
    assert.equal(peer.received.filter((p) => p.role === 'control' && p.packet.readUInt16LE(4) === 3).length, before);
  });
});

test('token rejection and expiration permanently close the association', async (t) => {
  for (const kind of ['rejected', 'expired']) await t.test(kind, async (t) => {
    const { peer, driver } = await radio(t, { rejectRenewal: true });
    const closed = once(driver, 'close');
    if (kind === 'rejected') driver.session.renew();
    else { driver.session.lastAuth = -Infinity; driver.session.tick(); }
    await closed;
    assert.equal(driver.session.ended, true);
    assert.equal(driver.playback.queue.bytes, 0);
  });
});

test('CI-V timeout rejects pending requests and prevents late replies from confirming a later command', async (t) => {
  const { peer, driver } = await radio(t, {}, { requestTimeoutMs: 50 });
  peer.civ = () => {};
  const results = await Promise.allSettled([driver.getFrequency(), driver.getMode()]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(driver.session.ended, true);
  assert.equal(driver._queue.length, 0);
  await assert.rejects(driver.getFrequency(), /not open/);
});

test('native OFF drains the complete finite waveform and pads only its final partial sample frame', async (t) => {
  const { peer, driver } = await radio(t);
  driver.playback.start(); await driver.setPtt(true);
  const pcm = Buffer.alloc(3842, 42);
  driver.playback.write(pcm);
  await driver.setPtt(false);
  const sent = Buffer.concat(peer.txAudio.map((p) => p.bytes));
  assert.deepEqual(sent.subarray(0, pcm.length), pcm);
  assert.deepEqual(sent.subarray(pcm.length), Buffer.alloc(1918));
  assert.equal(peer.ptt, false);
});

test('native OFF drains a snapshot while the VARA-style producer keeps returning silence', async (t) => {
  const { peer, driver } = await radio(t);
  driver.playback.start(); await driver.setPtt(true);
  driver.playback.write(Buffer.alloc(3840, 42));
  const timer = setInterval(() => driver.playback.write(Buffer.alloc(1920)), 20);
  t.after(() => clearInterval(timer));
  const started = Date.now(); await driver.setPtt(false);
  assert.ok(Date.now() - started < 500);
  assert.equal(peer.ptt, false);
});

test('restart/abort wakes an in-progress drain and cannot replay the old waveform on the next key', async (t) => {
  const { peer, driver, errors } = await radio(t);
  driver.playback.start(); await driver.setPtt(true);
  driver.playback.write(Buffer.alloc(96000, 42));
  const release = driver.setPtt(false);
  await sleep(10); driver.playback.restart(); await release;
  const before = peer.txAudio.length;
  await driver.setPtt(true); await sleep(40); await driver.setPtt(false);
  assert.equal(peer.txAudio.length, before);
  assert.ok(!errors.some((err) => /release deadline/.test(err.message)));
});

test('emergency unkey discards queued native audio immediately', async (t) => {
  const { peer, driver } = await radio(t);
  driver.playback.start(); await driver.setPtt(true);
  driver.playback.write(Buffer.alloc(96000, 42));
  assert.equal(await driver.forcePttOff(), true);
  assert.equal(driver.playback.queue.bytes, 0);
  assert.equal(driver.playback.keyed, false);
  await until(() => !peer.ptt);
});

test('a stalled playback queue cannot indefinitely delay PTT-off', async (t) => {
  const { peer, driver, errors } = await radio(t, {}, { drainTimeoutMs: 25 });
  driver.playback.active = true; // Deliberately no pump: emulate a failed producer clock.
  await driver.setPtt(true); driver.playback.write(Buffer.alloc(96000));
  const started = Date.now(); await driver.setPtt(false);
  assert.ok(Date.now() - started < 300);
  assert.equal(peer.ptt, false);
  assert.equal(driver.playback.queue.bytes, 0);
  assert.ok(errors.some((e) => /release deadline/.test(e.message)));
});

test('native receive carries exact PCM and the MK2 one-division 475-point scope layout', async (t) => {
  const { peer, driver } = await radio(t, {}, { jitterMs: 20 });
  driver.capture.active = true;
  const pcm = Buffer.alloc(1920, 42);
  peer.rxAudio(pcm); await until(() => driver.capture.primed);
  const audio = once(driver.capture, 'data'); driver.capture.pump();
  assert.deepEqual((await audio)[0], pcm);
  const points = Buffer.alloc(475, 42); const scope = once(driver, 'scope-line');
  peer.replyCiv(Buffer.concat([Buffer.from('270000010100', 'hex'), peer.frequency, Buffer.from('005002000000', 'hex'), points]));
  const [line] = await scope;
  assert.equal(line.centerFreq, 14074000); assert.equal(line.span, 25000); assert.deepEqual(line.points, points);
});

test('confirmed receive invalidates retained CW text and invalid physical state is rejected', async (t) => {
  const { peer, driver } = await radio(t);
  await driver.setMode('CW'); await driver.sendCw('E'); await until(() => !peer.ptt);
  assert.equal(await driver.getTransmitting(), false);
  assert.ok(![...driver.session.serial.replay.values()].some((entry) => entry.group === 'cw' && entry.packet));
  const original = peer.civ.bind(peer);
  peer.civ = (p, a) => p.subarray(4).toString('hex') === '1c00fd' ? peer.replyCiv([0x1c, 0, 2], a) : original(p, a);
  await assert.rejects(driver.getTransmitting(), /Unknown/);
});

test('CW stop cancels text whose safety read is still pending', async (t) => {
  const { peer, driver } = await radio(t);
  await driver.setMode('CW');
  peer.options.delayNextReply = 150;
  const [send, stop] = await Promise.allSettled([driver.sendCw('E'), driver.stopCw()]);
  assert.equal(send.status, 'rejected');
  assert.match(send.reason.message, /cancelled/);
  assert.equal(stop.status, 'fulfilled');
  assert.equal(peer.cwText.length, 0);
  assert.equal(peer.ptt, false);
});

test('tuner stop cancels a start whose safety read is still pending', async (t) => {
  const { peer, driver } = await radio(t);
  peer.options.delayNextReply = 150;
  const [start, stop] = await Promise.allSettled([driver.setTuner(2), driver.setTuner(0)]);
  assert.equal(start.status, 'rejected');
  assert.match(start.reason.message, /cancelled/);
  assert.equal(stop.status, 'fulfilled');
  assert.ok(!peer.commands.some((p) => p.subarray(4).toString('hex') === '1c0102fd'));
});

test('ordinary permitted CW and tuner starts still reach the radio', async (t) => {
  const { peer, driver } = await radio(t);
  await driver.setMode('CW');
  assert.equal(await driver.sendCw('E'), true);
  await driver.stopCw();
  await driver.setTuner(2);
  await driver.setTuner(0);
  assert.deepEqual(peer.cwText, ['E']);
  assert.ok(peer.commands.some((p) => p.subarray(4).toString('hex') === '1c0102fd'));
});

test('tuner STOP retires the old START payload from native wire replay', async (t) => {
  const { peer, driver } = await radio(t);
  await driver.setTuner(2);
  const [seq, retained] = [...driver.session.serial.replay.entries()].find(([, entry]) =>
    entry.group === 'tuner' && entry.packet?.subarray(25).toString('hex') === '1c0102fd');
  assert.ok(retained.packet);
  await driver.setTuner(0);
  assert.equal(driver.session.serial.replay.get(seq).packet, null);
  const before = peer.received.length;
  const a = peer.associations.civ;
  peer.sendRaw('civ', envelope(16, 1, a.sid, a.client, seq));
  await until(() => peer.received.slice(before).some(({ role, packet }) =>
    role === 'civ' && packet.readUInt16LE(6) === seq));
  const replay = peer.received.slice(before).find(({ role, packet }) => role === 'civ' && packet.readUInt16LE(6) === seq).packet;
  assert.equal(replay.length, 16, 'retired START is replaced by an idle envelope, not RF-start data');
});

test('emergency unkey cancels pending CW and tuner safety gates', async (t) => {
  for (const kind of ['CW', 'tuner']) await t.test(kind, async (t) => {
    const { peer, driver } = await radio(t);
    if (kind === 'CW') await driver.setMode('CW');
    peer.options.delayNextReply = 150;
    const pending = kind === 'CW' ? driver.sendCw('E') : driver.setTuner(2);
    const [start, off] = await Promise.allSettled([pending, driver.forcePttOff()]);
    assert.equal(start.status, 'rejected');
    assert.match(start.reason.message, /cancelled/);
    assert.equal(off.status, 'fulfilled');
    assert.equal(peer.cwText.length, 0);
    assert.ok(!peer.commands.some((p) => p.subarray(4).toString('hex') === '1c0102fd'));
  });
});

test('closing cancels pending CW and tuner safety gates before any RF command', async (t) => {
  for (const kind of ['CW', 'tuner']) await t.test(kind, async (t) => {
    const { peer, driver } = await radio(t);
    if (kind === 'CW') await driver.setMode('CW');
    peer.options.delayNextReply = 150;
    const pending = kind === 'CW' ? driver.sendCw('E') : driver.setTuner(2);
    const [start, close] = await Promise.allSettled([pending, driver.close()]);
    assert.equal(start.status, 'rejected');
    assert.equal(close.status, 'fulfilled');
    assert.equal(peer.cwText.length, 0);
    assert.ok(!peer.commands.some((p) => p.subarray(4).toString('hex') === '1c0102fd'));
  });
});
