'use strict';

// Regression cases from the independent audit of a571ea6. The existing
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
