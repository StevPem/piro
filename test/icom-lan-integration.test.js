'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { IcomPeer, envelope } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { IcomSession } = require('../src/icom-lan/session');
const { CwTxBridge } = require('../src/server/cw-tx-bridge');
const { Ft8Bridge } = require('../src/audio/ft8-bridge');
const { upsampleFloatToPcm } = require('../src/audio/resample');

async function until(predicate, timeout = 2000) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function radio(t, options = {}, driverOptions = {}) {
  const peer = await new IcomPeer(options).start();
  const driver = new IcomLanDriver(peer.config(driverOptions));
  driver.on('error', () => {});
  t.after(async () => { await driver.close(); await peer.close(); });
  await driver.open();
  return { peer, driver };
}

test('real localhost handshake, identity, controls, correct MK2 routing and restoration', async (t) => {
  const { peer, driver } = await radio(t, { address: 0xb4 }, { modLevel: 100 });
  assert.equal(driver.radioAddr, 0xb4); // identify address, not nickname/default.
  assert.equal(driver.profile.name, 'IC-7300MK2');
  assert.equal(peer.parameters.get('0079')[0], 0);
  assert.equal(peer.streamRequest[114], 4);
  assert.equal(peer.streamRequest.readUInt32BE(116), 48000);
  assert.equal(peer.streamRequest.readUInt32BE(124), driver.session.serial.localPort);
  assert.equal(await driver.getFrequency(), 14074000);
  await driver.setFrequency(14074000);
  assert.equal(await driver.getFrequency(), 14074000);
  await driver.setMode('USB');
  await driver.setPtt(true);
  assert.equal(peer.ptt, true);
  assert.equal(peer.parameters.get('0084')[0], 5);
  assert.equal(peer.parameters.get('0083').toString('hex'), '0100');
  await driver.setPtt(false);
  assert.equal(peer.parameters.get('0084')[0], 0);
  assert.equal(peer.parameters.get('0083').toString('hex'), '0128');
  await driver.setDataMode(true);
  await driver.setPtt(true);
  assert.equal(peer.parameters.get('0085')[0], 5);
  await driver.setPtt(false);
  assert.equal(peer.parameters.get('0085')[0], 1);
  assert.equal(driver.playback.queue.bytes, 0);
});

test('reject bad credentials and unknown models without applying MK2 settings', async (t) => {
  for (const options of [{ rejectLogin: true }, { modelId: 0xa4 }]) {
    const peer = await new IcomPeer(options).start();
    const driver = new IcomLanDriver(peer.config());
    driver.on('error', () => {});
    try {
      await assert.rejects(driver.open(), /credentials|IC-7300MK2/);
      assert.equal(peer.parameters.get('0079')[0], 1);
      assert.equal(peer.commands.some((p) => p[4] === 0x1c && p[6] === 1), false);
    } finally { await driver.close(); await peer.close(); }
  }
});

test('control-plane notifications can reuse outer sequence zero; inner token IDs remain correlated', async (t) => {
  const { peer, driver } = await radio(t, { unsequencedControl: true });
  driver.session.renew();
  await until(() => !driver.session.pendingRenewals.size);
  assert.equal(await driver.getFrequency(), 14074000);
  assert.equal(peer.renewals.length, 2);
});

test('an established token rejection ends the session rather than adopting the returned token', async (t) => {
  const { peer, driver } = await radio(t, { rejectRenewal: true });
  driver.session.renew();
  await until(() => driver.session.state === 'failed');
  assert.equal(driver.session.connected, false);
  assert.equal(peer.renewals.length, 2);
  assert.equal(driver.playback.queue.bytes, 0);
});

test('typed CW busy retry, completion, speed/break-in restore, and abort use the radio keyer', async (t) => {
  const { peer, driver } = await radio(t, { cwBusy: 1 });
  await driver.setMode('CW');
  const cs = new EventEmitter();
  Object.assign(cs, { civ: driver, state: { ptt: false }, clients: new Set([{}]), broadcastJsonEvent: (_type, data) => statuses.push(data) });
  const statuses = [];
  const bridge = new CwTxBridge({ controlServer: cs, estimateSeconds: () => 0.02, leadSec: 0, txEndQuietMs: 10 });
  bridge.start();
  t.after(() => bridge.stop());
  const oldSpeed = Buffer.from(peer.keySpeed);
  await bridge.send({ text: 'CQ TEST', wpm: 25 });
  assert.equal(peer.cwText.join(''), 'CQ TEST');
  assert.equal(statuses.at(-1).status, 'sent');
  assert.deepEqual(peer.keySpeed, oldSpeed);
  assert.equal(peer.breakIn, 0);
  const pending = bridge.send({ text: 'LONG CQ', wpm: 20 });
  await until(() => statuses.at(-1)?.status === 'sending');
  bridge.abort();
  await pending;
  assert.equal(statuses.at(-1).status, 'aborted');
  assert.equal(peer.cwStopped, true);
});

test('RX PCM and a 475-point single-packet LAN scope reach existing driver interfaces', async (t) => {
  const { peer, driver } = await radio(t);
  const pcm = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI / 24) * 12000), i * 2);
  const chunks = [];
  driver.capture.on('data', (p) => chunks.push(p));
  driver.capture.start();
  for (let n = 0; n < 3; n++) {
    peer.rxAudio(pcm.subarray(0, 1364));
    peer.rxAudio(pcm.subarray(1364));
  }
  await until(() => chunks.length >= 3);
  assert.deepEqual(Buffer.concat(chunks).subarray(0, 5760), Buffer.concat([pcm, pcm, pcm]));
  driver.capture.stop();
  const linePromise = once(driver, 'scope-line');
  // 00 selector, division 01/01, Center, 14.074 MHz, 25 kHz, range flag.
  const body = Buffer.concat([Buffer.from('2700000101000040071400005002000000', 'hex'), Buffer.alloc(475, 77)]);
  peer.replyCiv(body);
  const [line] = await linePromise;
  assert.equal(line.points.length, 475);
  assert.equal(line.points[0], 77);
});

test('TX PCM uses real audio UDP packets at 20ms cadence, preserves amplitude, and flushes on unkey', async (t) => {
  const { peer, driver } = await radio(t);
  driver.playback.start();
  await driver.setPtt(true);
  const pcm = Buffer.alloc(1920 * 6);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i % 2 ? 32767 : -32768, i * 2);
  driver.playback.write(pcm);
  await until(() => peer.txAudio.length >= 12);
  assert.deepEqual(Buffer.concat(peer.txAudio.map((p) => p.bytes)), pcm);
  assert.deepEqual(peer.txAudio.slice(0, 2).map((p) => p.bytes.length), [1364, 556]);
  assert.ok(peer.txAudio[10].at - peer.txAudio[0].at >= 70);
  driver.playback.write(pcm);
  await driver.setPtt(false);
  const after = peer.txAudio.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(peer.txAudio.length, after);
  assert.equal(driver.playback.queue.bytes, 0);
});

test('renewals match independent 16-bit fields across 255/256 and full wrap; missing acknowledgements expire', async (t) => {
  let now = 0;
  const peer = await new IcomPeer().start();
  const session = new IcomSession(peer.config({ now: () => now, timeoutMs: 1e9, tokenDeadMs: 80000 }));
  t.after(async () => { await session.close(); await peer.close(); });
  await session.open();
  session.innerSeq = 255;
  for (const seq of [255, 256, 65535, 0]) {
    session.innerSeq = seq;
    session.renew();
    await until(() => !session.pendingRenewals.size);
    assert.equal(peer.renewals.at(-1), seq);
  }
  peer.options.ignoreRenewals = true;
  now = 60001;
  session.tick();
  await until(() => peer.renewals.length >= 6);
  now = 80001;
  session.tick();
  await until(() => session.state === 'failed');
  assert.equal(session.connected, false);
});

test('media release reconnects with fresh IDs and drops queued keying/audio from the old session', async (t) => {
  const { peer, driver } = await radio(t, {}, { reconnectAttempts: 2, reconnectMs: 20 });
  driver.playback.start();
  await driver.setPtt(true);
  driver.playback.write(Buffer.alloc(19200, 3));
  const old = driver.session.serial;
  const ready = once(driver, 'radio-ready');
  peer.release();
  await ready;
  assert.notEqual(driver.session.serial.localId, old.localId);
  assert.equal(old.replay.size, 0);
  assert.equal(driver.playback.queue.bytes, 0);
  assert.equal(driver.playback.keyed, false);
  assert.equal(peer.ptt, false);
  assert.equal(await driver.getMode().then((m) => m.mode), 'USB');
});

test('packet loss is retransmitted once a later unsolicited update exposes the gap', async (t) => {
  const { peer, driver } = await radio(t, {}, { reorderMs: 10 });
  let updates = 0;
  driver.on('frequency', () => updates++);
  peer.options.dropNextReply = true;
  const read = driver.getFrequency();
  await until(() => !peer.options.dropNextReply);
  const update = peer.replyCiv(Buffer.concat([Buffer.from([0]), peer.frequency]));
  peer.sendRaw('civ', update); // duplicate must not repeat the unsolicited event.
  assert.equal(await read, 14074000);
  await until(() => updates === 1);
  assert.ok(peer.received.some((p) => p.role === 'civ' && p.packet.readUInt16LE(4) === 1));
});

test('PTT off supersedes a pending PTT-on ACK, and retired audio cannot be replayed', async (t) => {
  const { peer, driver } = await radio(t);
  driver.playback.start();
  // Delay only the PTT-on acknowledgement, after routing has been confirmed.
  peer.on('command', (frame) => {
    if (frame[4] === 0x1c && frame[5] === 0 && frame[6] === 1) peer.options.delayNextReply = 60;
  });
  const on = driver.setPtt(true);
  const rejected = assert.rejects(on, /cancelled/);
  await until(() => peer.ptt);
  await driver.setPtt(false);
  await rejected;
  assert.equal(peer.ptt, false);
  assert.equal(driver.playback.keyed, false);
  peer.removeAllListeners('command');
  await driver.setPtt(true);
  driver.playback.write(Buffer.alloc(1920, 1));
  await until(() => peer.txAudio.length === 2);
  const oldSeq = peer.txAudio[0].outer;
  await driver.setPtt(false);
  const a = peer.associations.audio;
  peer.sendRaw('audio', envelope(16, 1, a.sid, a.client, oldSeq));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(peer.txAudio.length, 2);
});

test('a new PTT-on waits for the previous release to restore routing, then restores the original source itself', async (t) => {
  const { peer, driver } = await radio(t);
  await driver.setPtt(true);
  const release = driver.setPtt(false);
  const nextKey = driver.setPtt(true);
  await Promise.all([release, nextKey]);
  assert.equal(peer.ptt, true);
  assert.equal(peer.parameters.get('0084')[0], 5);
  await driver.setPtt(false);
  assert.equal(peer.parameters.get('0084')[0], 0);
});

test('a timed-out CI-V transaction resets the session and rejects queued work instead of accepting a late ACK', async (t) => {
  const { peer, driver } = await radio(t, {}, { requestTimeoutMs: 40, reconnectAttempts: 1, reconnectMs: 20 });
  peer.options.delayNextReply = 160;
  const read = driver.getFrequency();
  const queued = driver.getMode();
  const readRejected = assert.rejects(read, /timed out/);
  const queuedRejected = assert.rejects(queued, /reconnecting|closed/);
  const old = driver.session.serial;
  const ready = once(driver, 'radio-ready');
  await Promise.all([readRejected, queuedRejected]);
  await ready;
  const a = peer.associations.civ;
  const stale = envelope(28, 0, old.remoteId, old.localId, 50);
  peer.sendRaw('civ', stale, a);
  await until(() => driver.session.serial.counters.stale > 0);
  assert.equal(await driver.getFrequency(), 14074000);
  assert.equal(driver._queue.length, 0);
});

test('silent radio exhausts a bounded reconnect budget without exposing credentials', async (t) => {
  const peer = await new IcomPeer({ silent: true }).start();
  const session = new IcomSession(peer.config({ timeoutMs: 80, reconnectAttempts: 1, reconnectMs: 10 }));
  t.after(async () => { await session.close(); await peer.close(); });
  const states = [];
  session.on('status', (s) => states.push(s));
  await assert.rejects(session.open(), /timed out/);
  assert.equal(states.filter((s) => s.state === 'connecting').length, 2);
  assert.equal(states.at(-1).state, 'failed');
  assert.ok(!JSON.stringify(states).includes('beer'));
});

test('stop commands bypass queued polling while the current CI-V transaction finishes', async (t) => {
  const { peer, driver } = await radio(t);
  const start = peer.commands.length;
  peer.options.delayNextReply = 40;
  const current = driver.getMode();
  const reads = Array.from({ length: 8 }, () => driver.getSMeter());
  const off = driver.setPtt(false);
  await Promise.all([current, off, ...reads]);
  const commands = peer.commands.slice(start);
  assert.equal(commands[0][4], 4);
  assert.equal(commands[1].subarray(4).toString('hex'), '1c0000fd');
  assert.ok(commands.slice(2).every((c) => c[4] === 0x15));
});

test('Stop remains accepted when the CI-V polling queue is full', async (t) => {
  const { peer, driver } = await radio(t);
  peer.options.delayNextReply = 40;
  const current = driver.getMode();
  const reads = Array.from({ length: 256 }, () => driver.getSMeter().catch((err) => err));
  await driver.setPtt(false);
  await current;
  const results = await Promise.all(reads);
  assert.equal(results.filter((value) => value instanceof Error).length, 1);
  assert.match(results.find((value) => value instanceof Error).message, /urgent stop/);
  assert.equal(peer.ptt, false);
  assert.equal(driver._queue.length, 0);
});

test('existing FT8 bridge sends its PCM through the LAN backend, drains the radio tail and cancels on loss', async (t) => {
  const { peer, driver } = await radio(t);
  driver.playback.start();
  const cs = new EventEmitter();
  const statuses = [];
  Object.assign(cs, { state: { ptt: false }, broadcastJsonEvent: (_type, data) => statuses.push(data),
    broadcastBinary: () => {}, setPttFromServer: async (on) => { await driver.setPtt(on); cs.state.ptt = on; cs.emit('ptt', on); } });
  const clock = new EventEmitter();
  Object.assign(clock, { start() {}, stop() {}, nextSlotStart: () => 15000 });
  const worker = new EventEmitter();
  Object.assign(worker, { terminate() {}, postMessage() {} });
  const samples = Float32Array.from({ length: 1200 }, (_, i) => Math.sin(i * Math.PI / 10) * 0.5);
  const bridge = new Ft8Bridge({ civ: driver, controlServer: cs,
    audioBridge: { capture: driver.capture, playback: driver.playback, sampleRate: 48000 },
    slotClock: clock, worker, encodeFn: () => samples,
    pskReporter: { start() {}, stop() {} }, dataSettleMs: 0, pttReleaseMarginMs: 0 });
  t.after(() => bridge.stop());
  bridge.start();
  const sending = bridge.send('CQ S53ZO JN76');
  clock.emit('boundary', { slotStartMs: 15000, slotMs: 15000 });
  await sending;
  const expected = upsampleFloatToPcm(samples, 12000, 48000);
  assert.deepEqual(Buffer.concat(peer.txAudio.map((p) => p.bytes)), expected);
  assert.equal(peer.parameters.get('0085')[0], 1);
  assert.equal(peer.ptt, false);
  assert.equal(statuses.at(-1).status, 'sent');
  const lastAudioAt = peer.txAudio.at(-1).at;
  assert.ok(performance.now() - lastAudioAt >= 290);
  const pending = bridge.send('CQ S53ZO JN76');
  const rejected = assert.rejects(pending, /connection lost/i);
  cs.emit('radio-disconnected');
  await rejected;
  const before = peer.txAudio.length;
  clock.emit('boundary', { slotStartMs: 30000, slotMs: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(peer.txAudio.length, before);
});
