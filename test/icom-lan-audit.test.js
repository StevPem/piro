'use strict';

// Regression cases from the independent audits of a571ea6 and 01ad130. The existing
// localhost peer supplies wire replies without using production encoders.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { IcomSession } = require('../src/icom-lan/session');
const { ControlServer } = require('../src/server/ws-server');
const { wireRadioConnection } = require('../src/server/radio-connection');
const { VaraBridge } = require('../src/server/vara-bridge');
const { AudioBridge } = require('../src/server/audio-bridge');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 2000) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > end) throw new Error('Audit regression timed out');
    await sleep(5);
  }
}

async function setup(t, options = {}) {
  const peer = await new IcomPeer().start();
  const driver = new IcomLanDriver(peer.config(options));
  driver.on('error', () => {});
  let cs;
  t.after(async () => { if (cs) await cs.close(); await driver.close(); await peer.close(); });
  await driver.open();
  cs = new ControlServer({ civ: driver, port: 0 });
  await cs.listen();
  wireRadioConnection(driver, cs);
  return { peer, driver, cs };
}

function rejectOnce(peer, command) {
  const original = peer.civ.bind(peer);
  let rejected = false;
  peer.civ = (frame, association) => {
    if (!rejected && frame.subarray(4).toString('hex') === command) {
      rejected = true;
      peer.replyCiv([0xfa], association);
    } else original(frame, association);
  };
}

test('playback exceptions are contained and release PTT instead of escaping the WebSocket event', async () => {
  const cs = new EventEmitter();
  Object.assign(cs, { state: { ptt: true }, broadcastJsonEvent() {},
    async setPttFromServer(on) { this.state.ptt = on; } });
  const playback = new EventEmitter();
  Object.assign(playback, { write() { throw new Error('queue rejected PCM'); }, restart() {} });
  const bridge = new AudioBridge({ controlServer: cs, capture: new EventEmitter(), playback });
  assert.doesNotThrow(() => bridge._handleBinaryMessage(Buffer.from([1, 0, 0]), {}));
  await until(() => cs.state.ptt === false);
});

test('VARA QSY waits for audio drain and confirmed PTT-off on USB and LAN', async (t) => {
  for (const lan of [false, true]) await t.test(lan ? 'LAN drain' : 'USB', async () => {
    const cs = new EventEmitter();
    const order = [];
    let releaseAck, finishDrain;
    const ack = new Promise((resolve) => { releaseAck = resolve; });
    const drain = new Promise((resolve) => { finishDrain = resolve; });
    const playback = lan ? { drain: () => drain } : {};
    Object.assign(cs, { state: { ptt: true, frequency: 14105000 },
      civ: { async setFrequency() { assert.equal(cs.state.ptt, false); order.push('tune'); } },
      broadcastJsonEvent() {},
      async setPttFromServer(on) { order.push('release'); await ack; this.state.ptt = on; order.push('off'); },
    });
    const bridge = new VaraBridge({ controlServer: cs, audioBridge: { capture: new EventEmitter(), playback, sampleRate: 48000 }, callsign: 'S53ZO' });
    bridge._active = bridge._keyed = true;
    bridge._link = { qsy: { role: 'answerer', phase: 'ack', target: 14105750 } };
    try {
      bridge._handleLine('PTT OFF');
      if (lan) { assert.deepEqual(order, []); finishDrain(true); }
      await until(() => order.includes('release'));
      assert.equal(order.includes('tune'), false);
      releaseAck();
      await until(() => order.includes('tune'));
      assert.deepEqual(order, ['release', 'off', 'tune']);
    } finally { await bridge.stop(); }
  });
});

test('VARA does not retune if PTT-off fails', async () => {
  const cs = new EventEmitter();
  let tuned = false;
  Object.assign(cs, { state: { ptt: true, frequency: 14105000 }, civ: { async setFrequency() { tuned = true; } },
    broadcastJsonEvent() {}, async setPttFromServer() { throw new Error('PTT-off rejected'); } });
  const bridge = new VaraBridge({ controlServer: cs, audioBridge: { capture: new EventEmitter(), playback: {}, sampleRate: 48000 }, callsign: 'S53ZO' });
  bridge._active = bridge._keyed = true;
  bridge._link = { qsy: { role: 'answerer', phase: 'ack', target: 14105750 } };
  bridge._handleLine('PTT OFF');
  await sleep(10);
  assert.equal(tuned, false);
  assert.equal(cs.state.ptt, true);
  await bridge.stop();
});

test('token ACKs delayed by 600ms remain correlated within the configured grace period', async (t) => {
  const peer = await new IcomPeer().start();
  const session = new IcomSession(peer.config({ initialRenewMs: 100, renewMs: 2000,
    tokenGraceMs: 1000, tokenDeadMs: 2500, timeoutMs: 5000 }));
  t.after(async () => { await session.close(); await peer.close(); });
  await session.open();
  const initialAck = session.lastAuth;
  const original = peer.tracked.bind(peer);
  peer.tracked = (role, p, association, fault) => original(role, p, association,
    role === 'control' && p.length === 64 && p[21] === 5 ? { delay: 600 } : fault);
  await until(() => session.lastAuth > initialAck, 1800);
  assert.equal(session.connected, true);
  assert.equal(peer.renewals.length, 2, 'one initial authentication and one scheduled renewal');
  assert.equal(session.pendingRenewals.size, 0);
});

test('a dead CI-V endpoint exhausts the retry budget even if UDP handshakes keep succeeding', async (t) => {
  const { peer, driver } = await setup(t, { requestTimeoutMs: 60, reconnectAttempts: 1, reconnectMs: 20, timeoutMs: 500 });
  let associations = 0;
  driver.session.on('connected', () => associations++);
  peer.civ = () => {};
  peer.release();
  await until(() => driver.session.state === 'failed', 1500);
  await sleep(120);
  assert.equal(associations, 1);
  assert.equal(driver.session.attempts, 1);
  assert.equal(driver.prepared, false);
});

test('reconnect publishes current frequency, mode and DATA mode to clients and decoder listeners', async (t) => {
  const { peer, driver, cs } = await setup(t, { reconnectAttempts: 1, reconnectMs: 20 });
  const modes = [], frequencies = [], events = [];
  driver.on('mode', (mode) => modes.push(mode.mode));
  cs.on('frequency', (frequency) => frequencies.push(frequency));
  const broadcast = cs.broadcastJsonEvent.bind(cs);
  cs.broadcastJsonEvent = (type, data) => { events.push({ type, data }); broadcast(type, data); };
  peer.frequency = Buffer.from('0000101400', 'hex');
  peer.mode = 3;
  peer.dataMode = true;
  const ready = once(driver, 'radio-ready');
  peer.release();
  await ready;
  assert.equal(cs.state.frequency, 14100000);
  assert.equal(cs.state.mode.mode, 'CW');
  assert.equal(cs.state.dataMode, true);
  assert.ok(modes.includes('CW'));
  assert.ok(frequencies.includes(14100000));
  assert.ok(events.some((e) => e.type === 'data-mode' && e.data.on === true));
});

test('failed restoration retains saved TX settings but still records confirmed PTT-off', async (t) => {
  const { peer, driver, cs } = await setup(t);
  const errors = [];
  driver.on('restore-error', (err) => errors.push(err.message));
  await cs.setPttFromServer(true);
  rejectOnce(peer, '1a050084fd');
  await cs.setPttFromServer(false);
  assert.equal(peer.ptt, false);
  assert.equal(cs.state.ptt, false);
  assert.equal(cs._pttWatchdogTimer, null);
  assert.equal(driver.txSaved.length, 1);
  assert.equal(peer.parameters.get('0084')[0], 5);
  assert.equal(errors.length, 1);
  await cs.setPttFromServer(false);
  assert.equal(peer.parameters.get('0084')[0], 0);
  assert.equal(driver.txSaved.length, 0);
});

test('a later initialization NG rolls back earlier RX settings before closing the connection', async (t) => {
  const peer = await new IcomPeer().start();
  const driver = new IcomLanDriver(peer.config());
  driver.on('error', () => {});
  t.after(async () => { await driver.close(); await peer.close(); });
  rejectOnce(peer, '1a050080fd');
  await assert.rejects(driver.open(), /rejected/);
  assert.equal(peer.parameters.get('0079')[0], 1);
  assert.equal(driver.rxSaved.length, 0);
  assert.equal(driver.session.connected, false);
});

test('reconnect and simultaneous PTT-off retain every failed restoration until retry succeeds', async (t) => {
  const { peer, driver, cs } = await setup(t, { modLevel: 100, reconnectAttempts: 1, reconnectMs: 20 });
  await cs.setPttFromServer(true);
  assert.equal(driver.txSaved.length, 2);
  const original = peer.civ.bind(peer);
  let reject = true;
  peer.civ = (frame, association) => {
    if (reject && frame.subarray(4).toString('hex') === '1a05008400fd') peer.replyCiv([0xfa], association);
    else original(frame, association);
  };
  let off, offError;
  driver.session.once('connected', () => { off = cs.setPttFromServer(false).catch((err) => { offError = err; }); });
  const ready = once(driver, 'radio-ready');
  peer.release();
  await ready;
  await off;
  assert.equal(offError, undefined);
  assert.equal(driver.txSaved.length, 1);
  assert.equal(driver.txSaved[0].parameter[1], 0x84);
  assert.equal(peer.parameters.get('0084')[0], 5);
  assert.deepEqual(peer.parameters.get('0083'), Buffer.from([1, 0x28]));
  reject = false;
  await cs.setPttFromServer(false);
  assert.equal(peer.parameters.get('0084')[0], 0);
  assert.equal(driver.txSaved.length, 0);
});

test('new operator source and level selections replace obsolete saved TX baselines', async (t) => {
  for (const setting of [
    { name: 'modulation source', parameter: '0084', value: Buffer.from([2]) },
    { name: 'modulation level', parameter: '0083', value: Buffer.from([1, 0x70]) },
  ]) await t.test(setting.name, async (t) => {
    const { peer, driver, cs } = await setup(t, { modLevel: 100 });
    await cs.setPttFromServer(true);
    rejectOnce(peer, `1a05${setting.parameter}fd`);
    await cs.setPttFromServer(false);
    assert.equal(driver.txSaved.length, 1);
    peer.parameters.set(setting.parameter, Buffer.from(setting.value));
    await cs.setPttFromServer(true);
    await cs.setPttFromServer(false);
    assert.deepEqual(peer.parameters.get(setting.parameter), setting.value);
    assert.equal(driver.txSaved.length, 0);
  });
});

test('an external confirmed PTT-off during VARA drain clears the latch and allows the next burst', async (t) => {
  const { peer, driver, cs } = await setup(t);
  const bridge = new VaraBridge({ controlServer: cs, audioBridge: {
    capture: driver.capture, playback: driver.playback, sampleRate: 48000,
  }, callsign: 'S53ZO' });
  bridge.start();
  bridge._active = bridge._dataReady = true;
  driver.playback.start();
  try {
    await bridge._key();
    driver.playback.write(Buffer.alloc(1920, 1));
    await until(() => driver.playback.lastSentAt !== undefined);
    bridge._handleLine('PTT OFF');
    await until(() => driver.playback.waiters.size > 0);
    await cs.setPttFromServer(false);
    await until(() => bridge._keyed === false);
    assert.equal(peer.ptt, false);
    assert.equal(bridge.state.ptt, false);
    assert.equal(bridge._keyTimer, null);
    bridge._handleLine('PTT ON');
    await until(() => peer.ptt && cs.state.ptt);
    assert.equal(bridge._keyed, true);
  } finally { await bridge.stop(); }
});

test('VARA still completes QSY after its own confirmed release with PTT reconciliation attached', async (t) => {
  const { peer, driver, cs } = await setup(t);
  const bridge = new VaraBridge({ controlServer: cs, audioBridge: {
    capture: driver.capture, playback: driver.playback, sampleRate: 48000,
  }, callsign: 'S53ZO' });
  bridge.start();
  bridge._active = bridge._dataReady = true;
  driver.playback.start();
  try {
    await bridge._key();
    driver.playback.write(Buffer.alloc(1920, 1));
    await until(() => driver.playback.lastSentAt !== undefined);
    bridge._link = { qsy: { role: 'receiver', phase: 'ack', target: 14105750 } };
    bridge._handleLine('PTT OFF');
    await until(() => cs.state.frequency === 14105750);
    assert.equal(peer.ptt, false);
    assert.equal(cs.state.ptt, false);
    assert.equal(bridge._keyed, false);
    assert.equal(bridge._link.qsy.phase, 'tl');
  } finally { await bridge.stop(); }
});

test('loss during post-release restoration cannot overwrite unknown PTT with a stale success', async (t) => {
  const { peer, driver, cs } = await setup(t);
  await cs.setPttFromServer(true);
  const original = peer.civ.bind(peer);
  let lost = false;
  peer.civ = (frame, association) => {
    if (!lost && frame.subarray(4).toString('hex') === '1a050084fd') {
      lost = true;
      peer.release();
    } else original(frame, association);
  };
  const pttEvents = [];
  cs.on('ptt', (on) => pttEvents.push(on));
  await assert.rejects(cs.setPttFromServer(false), /disconnected radio session/);
  assert.equal(driver.session.connected, false);
  assert.equal(cs.state.ptt, null);
  assert.deepEqual(pttEvents, []);
  assert.equal(driver.txSaved.length, 1);
});

test('reconnect snapshot preserves newer transceive observations during and after state reads', async (t) => {
  for (const duringFrequencyRead of [false, true]) await t.test(duringFrequencyRead ? 'during frequency read' : 'after frequency read', async (t) => {
    const { peer, driver, cs } = await setup(t, { reconnectAttempts: 1, reconnectMs: 20 });
    const frequencies = [], modes = [];
    cs.on('frequency', (hz) => frequencies.push(hz));
    driver.on('mode', (value) => modes.push(value.mode));
    const original = peer.civ.bind(peer);
    let changedFrequency = false, changedMode = false;
    peer.civ = (frame, association) => {
      if (!changedFrequency && frame[4] === (duringFrequencyRead ? 3 : 4)) {
        changedFrequency = true;
        const old = peer.frequency;
        peer.frequency = Buffer.from('0000201400', 'hex');
        peer.replyCiv(Buffer.concat([Buffer.from([0]), peer.frequency]), association);
        if (duringFrequencyRead) {
          peer.replyCiv(Buffer.concat([Buffer.from([3]), old]), association);
          return;
        }
      }
      if (!changedMode && frame.subarray(4).toString('hex') === '1a06fd') {
        changedMode = true;
        peer.mode = 3;
        peer.dataMode = true;
        peer.replyCiv([1, 3, 1], association);
      }
      original(frame, association);
    };
    const ready = once(driver, 'radio-ready');
    peer.release();
    await ready;
    assert.equal(cs.state.frequency, 14200000);
    assert.equal(cs.state.mode.mode, 'CW');
    assert.equal(cs.state.dataMode, true);
    assert.ok(frequencies.length >= 2);
    assert.ok(frequencies.every((hz) => hz === 14200000));
    assert.ok(modes.length >= 2);
    assert.ok(modes.every((mode) => mode === 'CW'));
    assert.equal(driver.radioState.frequency, await driver.getFrequency());
    assert.deepEqual(driver.radioState.mode, await driver.getMode());
  });
});

test('failed reconnect initialization restores RX settings before failing the association', async (t) => {
  const { peer, driver } = await setup(t, { reconnectAttempts: 1, reconnectMs: 20 });
  peer.parameters.set('0079', Buffer.from([1]));
  rejectOnce(peer, '1a050080fd');
  let afOnDisconnect;
  driver.session.once('disconnected', () => {
    driver.session.once('disconnected', () => { afOnDisconnect = peer.parameters.get('0079')[0]; });
  });
  peer.release();
  await until(() => driver.session.state === 'failed');
  assert.equal(driver.prepared, false);
  assert.equal(afOnDisconnect, 1);
  assert.equal(peer.parameters.get('0079')[0], 1);
  assert.equal(peer.parameters.get('0080')[0], 1);
  assert.equal(driver.rxSaved.length, 0);
  await driver.close();
  assert.equal(peer.parameters.get('0079')[0], 1);
});

test('reconnect snapshot also preserves a client tune completed between state reads', async (t) => {
  const { peer, driver, cs } = await setup(t, { reconnectAttempts: 1, reconnectMs: 20 });
  const original = peer.civ.bind(peer);
  const replies = [], frequencies = [];
  cs.on('frequency', (hz) => frequencies.push(hz));
  let request;
  peer.civ = (frame, association) => {
    if (!request && frame[4] === 4) {
      request = cs._handleMessage({ send: (raw) => replies.push(JSON.parse(raw)) }, Buffer.from(JSON.stringify({
        id: 'tune-during-reconnect', type: 'setFrequency', value: 14200000,
      })));
    }
    original(frame, association);
  };
  const ready = once(driver, 'radio-ready');
  peer.release();
  await ready;
  await request;
  assert.equal(replies[0].ok, true);
  assert.equal(cs.state.frequency, 14200000);
  assert.equal(driver.radioState.frequency, 14200000);
  assert.equal(await driver.getFrequency(), 14200000);
  assert.ok(frequencies.length >= 2);
  assert.ok(frequencies.every((hz) => hz === 14200000));
});
