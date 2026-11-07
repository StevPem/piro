'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RadioConnectionManager } = require('../src/server/radio-connection');
const { ControlServer } = require('../src/server/ws-server');
const { CivDriver } = require('../src/civ/driver');
const { loadRadioIdleTimeout, saveRadioIdleTimeout, radioIdleSettingsPath } = require('../src/server/radio-idle-settings');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, options = {}) {
  let now = 1000, seq = 0;
  const timers = new Map();
  const civ = new EventEmitter();
  Object.assign(civ, {
    session: { connected: true, stopped: false, state: 'connected' }, prepared: true, radioAddr: 0xb6,
    profile: { name: 'IC-7300MK2' }, closes: 0,
    capture: { start() {} }, playback: { start() {} },
    async close() { ++this.closes; this.session.connected = false; this.prepared = false; },
    async open() { this.session.connected = true; this.session.stopped = false; this.prepared = true; },
  });
  const cs = Object.assign(new EventEmitter(), { civ, state: { ptt: false, cwKeying: false }, messages: [],
    broadcastJsonEvent(type, data) { this.messages.push({ type, data }); } });
  const manager = new RadioConnectionManager(civ, cs, {
    ...options, now: () => now,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  cs.radioConnectionManager = manager;
  manager.publish({ state: 'connected' });
  t.after(() => manager.stopIdleTimer());
  return { manager, civ, cs, timers, setTime: (value) => { now = value; }, now: () => now };
}

test('default60-minute idle deadline disconnects without treating an open browser as usage', async (t) => {
  const { manager, civ, cs, setTime, timers } = setup(t);
  assert.equal(manager.idleTimeoutMinutes, 60);
  setTime(1000 + 60 * 60000 - 1);
  assert.equal(manager.checkIdle(), false);
  assert.equal(civ.closes, 0);
  setTime(1000 + 60 * 60000);
  assert.equal(manager.checkIdle(), true);
  await tick();
  assert.equal(civ.closes, 1);
  assert.equal(manager.manual, true);
  assert.equal(cs.state.radioConnection.state, 'disconnected');
  assert.equal(cs.state.radioConnection.disconnectReason, 'idle');
  assert.match(cs.state.radioConnection.message, /inactivity/);
  assert.equal(timers.size, 0);
});

test('operator activity resets the shared deadline and explicit Connect starts a fresh interval', async (t) => {
  const { manager, civ, cs, setTime } = setup(t, { idleTimeoutMinutes: 1 });
  setTime(50000);
  manager.recordActivity();
  assert.equal(cs.state.radioConnection.idleDisconnectAt, 110000);
  setTime(70000);
  assert.equal(manager.checkIdle(), false);
  setTime(110000);
  manager.checkIdle();
  await tick();
  assert.equal(civ.closes, 1);
  setTime(200000);
  manager.setConnected(true);
  await tick();
  assert.equal(manager.ready, true);
  assert.equal(cs.state.radioConnection.idleDisconnectAt, 260000);
  assert.equal(cs.state.radioConnection.disconnectReason, null);
});

test('disabled idle timeout never disconnects or rearms a timer', async (t) => {
  const { manager, civ, setTime, timers } = setup(t);
  await manager.setIdleTimeout(0);
  assert.equal(timers.size, 0);
  setTime(10 * 86400000);
  manager.recordActivity();
  assert.equal(manager.checkIdle(), false);
  assert.equal(civ.closes, 0);
  assert.equal(manager.idleDisconnectAt, null);
});

test('idle expiry confirms physical receive state rather than relying only on browser PTT', async (t) => {
  for (const [name, value] of [['physical transmit', true], ['unknown result', null], ['read failure', new Error('radio timeout')]]) {
    await t.test(name, async (t) => {
      const { manager, civ, setTime } = setup(t, { idleTimeoutMinutes: 1 });
      civ.getTransmitting = async () => { if (value instanceof Error) throw value; return value; };
      setTime(61000);
      manager.checkIdle(); await tick();
      assert.equal(civ.closes, 0, 'Idle expiry must not disconnect without confirmed receive');
      assert.equal(manager.manual, false);
    });
  }
  await t.test('confirmed receive', async (t) => {
    const { manager, civ, setTime } = setup(t, { idleTimeoutMinutes: 1 });
    let reads = 0;
    civ.getTransmitting = async () => { ++reads; return false; };
    setTime(61000);
    manager.checkIdle(); await tick();
    assert.equal(reads, 1);
    assert.equal(civ.closes, 1);
    assert.equal(manager.manual, true);
  });
});

test('new operator activity while the radio-state read is pending cancels idle expiry', async (t) => {
  const { manager, civ, setTime } = setup(t, { idleTimeoutMinutes: 1 });
  let finish;
  let reads = 0;
  civ.getTransmitting = () => { ++reads; return new Promise((resolve) => { finish = resolve; }); };
  setTime(61000);
  manager.checkIdle(); manager.checkIdle();
  await tick(); // The radio read starts in a promise continuation.
  assert.equal(reads, 1, 'Only one physical-state read may be in flight');
  setTime(61020); manager.recordActivity();
  finish(false); await tick();
  assert.equal(civ.closes, 0);
  assert.equal(manager.idleDisconnectAt, 121020);
});

test('a pending operator RPC counts at dispatch before its CI-V work finishes', async (t) => {
  const { manager, civ, setTime } = setup(t, { idleTimeoutMinutes: 1 });
  const server = new ControlServer({ civ, port: 0 });
  await server.listen(); t.after(() => server.close());
  server.radioConnectionManager = manager;
  let finishProbe, finishTune;
  civ.getTransmitting = () => new Promise((resolve) => { finishProbe = resolve; });
  civ.setFrequency = () => new Promise((resolve) => { finishTune = resolve; });
  setTime(61000); manager.checkIdle(); await tick();
  const tuning = server._handleMessage({ send() {} }, Buffer.from(JSON.stringify({ id: 'tune', type: 'setFrequency', value: 14074000 })));
  finishProbe(false); await tick();
  try {
    assert.equal(civ.closes, 0, 'An operator request already in progress must prevent idle release');
    assert.equal(manager.manual, false);
  } finally { finishTune(); await tuning; }
});

test('the actual transmit-state getter rejects unknown raw values instead of confirming receive', async (t) => {
  const read = (value) => CivDriver.prototype.getTransmitting.call({ _readSingleByteSetting: async () => value });
  assert.equal(await read(0), false);
  assert.equal(await read(1), true);
  for (const value of [2, 255]) await assert.rejects(read(value), /transmit state/);
  const { manager, civ, setTime } = setup(t, { idleTimeoutMinutes: 1 });
  civ.getTransmitting = () => read(2);
  setTime(61000); manager.checkIdle(); await tick();
  assert.equal(civ.closes, 0);
});

test('PTT, unknown transmit state, CW keying and queued modem work defer expiry', async (t) => {
  for (const kind of ['ptt', 'unknown', 'cw', 'keyer', 'modem']) await t.test(kind, async (t) => {
    const { manager, civ, cs, setTime } = setup(t, { idleTimeoutMinutes: 1 });
    if (kind === 'ptt') cs.state.ptt = true;
    if (kind === 'unknown') cs.state.ptt = null;
    if (kind === 'cw') cs.state.cwKeying = true;
    if (kind === 'keyer') cs.cwTxBusy = () => true;
    if (kind === 'modem') cs.radioTxBusy = () => true;
    setTime(100000);
    assert.equal(manager.checkIdle(), false);
    assert.equal(civ.closes, 0);
    cs.state.ptt = false; cs.state.cwKeying = false;
    cs.cwTxBusy = cs.radioTxBusy = () => false;
    setTime(110000);
    assert.equal(manager.checkIdle(), false);
    assert.equal(manager.idleDisconnectAt, 170000);
    setTime(169999);
    assert.equal(manager.checkIdle(), false);
    setTime(170000);
    manager.checkIdle(); await tick();
    assert.equal(civ.closes, 1);
  });
});

test('real transmit transitions count, repeated synthetic receive updates do not', async (t) => {
  const { manager, cs, setTime } = setup(t, { idleTimeoutMinutes: 1 });
  setTime(50000); cs.emit('ptt', false);
  assert.equal(manager.idleDisconnectAt, 61000);
  cs.state.ptt = true; cs.emit('ptt', true);
  assert.equal(manager.idleDisconnectAt, 110000);
  setTime(80000); cs.state.ptt = false; cs.emit('ptt', false);
  assert.equal(manager.idleDisconnectAt, 140000);
  setTime(90000); cs.emit('cw-keying', true);
  assert.equal(manager.idleDisconnectAt, 150000);
  setTime(100000); cs.emit('cw-keying', false);
  assert.equal(manager.idleDisconnectAt, 160000);
});

test('invalid or failed settings saves leave the previous timeout intact; writes are ordered', async (t) => {
  let fail = false;
  const saved = [];
  const { manager } = setup(t, { saveIdleTimeout: async (minutes) => { await tick(); if (fail) throw new Error('read-only settings'); saved.push(minutes); } });
  for (const minutes of [-1, 1441, 1.5, '60', null]) await assert.rejects(manager.setIdleTimeout(minutes), /integer/);
  await Promise.all([manager.setIdleTimeout(15), manager.setIdleTimeout(120)]);
  assert.deepEqual(saved, [15, 120]);
  assert.equal(manager.idleTimeoutMinutes, 120);
  fail = true;
  await assert.rejects(manager.setIdleTimeout(30), /read-only/);
  assert.equal(manager.idleTimeoutMinutes, 120);
});

test('passive polls, binary audio and automatic background requests do not reset activity', async (t) => {
  const { manager, civ, cs, setTime } = setup(t, { idleTimeoutMinutes: 1 });
  const server = new ControlServer({ civ, port: 0 });
  await server.listen(); t.after(() => server.close());
  server.radioConnectionManager = manager;
  civ.getFrequency = async () => 14074000;
  civ.setFrequency = async () => {};
  const replies = [];
  const ws = { send: (raw) => replies.push(JSON.parse(raw)) };
  setTime(50000);
  await server._handleMessage(ws, Buffer.from(JSON.stringify({ id: 'poll', type: 'getFrequency' })));
  await server._handleMessage(ws, Buffer.from(JSON.stringify({ id: 'restore', type: 'setFrequency', value: 14074000, background: true })));
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await once(socket, 'open');
  let binaryMessages = 0;
  server.on('binary-message', () => ++binaryMessages);
  socket.send(Buffer.from([1, 0, 0]));
  // Unowned microphone audio is discarded. A same-socket RPC confirms that
  // the preceding packet was handled without depending on a forwarded event.
  const barrier = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('binary activity barrier timed out')), 1500);
    socket.on('message', (raw, binary) => {
      if (!binary && JSON.parse(raw).id === 'binary-barrier') { clearTimeout(timer); resolve(); }
    });
  });
  socket.send(JSON.stringify({ id: 'binary-barrier', type: 'getFrequency' }));
  await barrier;
  assert.equal(binaryMessages, 0);
  socket.terminate();
  assert.equal(manager.idleDisconnectAt, 61000);
  await server._handleMessage(ws, Buffer.from(JSON.stringify({ id: 'gesture', type: 'radioActivity' })));
  assert.equal(manager.idleDisconnectAt, 110000);
  setTime(70000);
  await server._handleMessage(ws, Buffer.from(JSON.stringify({ id: 'tune', type: 'setFrequency', value: 14074000 })));
  assert.equal(manager.idleDisconnectAt, 130000);
  assert.ok(replies.every((reply) => reply.ok));
  assert.equal(cs.state.radioConnection.idleTimeoutMinutes, 1);
});

test('radio-idle preferences persist Off/custom values, default safely and write atomically', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piro-idle-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings', 'radio-connection.json');
  assert.equal(loadRadioIdleTimeout(file), 60);
  await saveRadioIdleTimeout(file, 0);
  assert.equal(loadRadioIdleTimeout(file), 0);
  await saveRadioIdleTimeout(file, 45);
  assert.equal(loadRadioIdleTimeout(file), 45);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['radio-connection.json']);
  fs.writeFileSync(file, '{bad json');
  const warnings = [];
  assert.equal(loadRadioIdleTimeout(file, (message) => warnings.push(message)), 60);
  assert.equal(warnings.length, 1);
  await assert.rejects(saveRadioIdleTimeout(file, -1), /integer/);
  assert.equal(radioIdleSettingsPath({ RADIO_IDLE_SETTINGS_PATH: '' }), null);
  assert.equal(radioIdleSettingsPath({ XDG_CONFIG_HOME: '/settings' }), path.join('/settings', 'piro', 'radio-connection.json'));
});

test('stopping the server idle monitor removes timers and transmit listeners', (t) => {
  const { manager, cs, timers } = setup(t);
  assert.ok(timers.size);
  manager.stopIdleTimer();
  assert.equal(timers.size, 0);
  assert.equal(cs.listenerCount('ptt'), 0);
  assert.equal(cs.listenerCount('cw-keying'), 0);
  assert.equal(manager.checkIdle(), false);
});
