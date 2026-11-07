'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { CwTxBridge } = require('../src/server/cw-tx-bridge');
const { CwPaddleBridge } = require('../src/server/cw-paddle-bridge');

// Exercise the real TX transition without a session, socket, or radio.
function lanRig(mode) {
  const calls = [];
  const driver = Object.assign(Object.create(IcomLanDriver.prototype), {
    prepared: true, txRevision: 1, txSaved: [], options: { modLevel: 100 },
    session: { connected: true },
    playback: { arm() {}, setKeyed(on) { calls.push(['audio', on]); } },
    getMode: async () => ({ mode }), getDataMode: async () => false,
    readParameter: async () => 0,
    writeParameter: async (...args) => { calls.push(['setting', ...args]); },
    _send: async (cmd, sub, data) => {
      calls.push(['ptt', data[0]]);
      return { data: Buffer.alloc(0) };
    },
  });
  return { driver, calls };
}

for (const mode of ['CW', 'CW_R', 'CW-R']) {
  test(`${mode} keys LAN PTT without changing modulation settings`, async () => {
    const { driver, calls } = lanRig(mode);
    await driver.transitionPtt(true, 1, {});
    assert.deepEqual(calls, [['ptt', 1], ['audio', true]]);
    assert.deepEqual(driver.txSaved, []);
  });

  test(`${mode} accepts typed CW`, async () => {
    const sent = [];
    const civ = {
      getMode: async () => ({ mode }), getKeySpeed: async () => 20,
      getBreakIn: async () => 1, sendCw: async (text) => { sent.push(text); return true; },
    };
    const cs = { civ, state: { ptt: false }, broadcastJsonEvent() {} };
    const bridge = new CwTxBridge({ controlServer: cs, estimateSeconds: () => 0 });
    await bridge.send({ text: 'E', wpm: 20 });
    assert.deepEqual(sent, ['E']);
  });

  test(`${mode} accepts a paddle element`, () => {
    const timers = new Map();
    let next = 0;
    const cs = { civ: {}, state: { mode: { mode }, ptt: false }, broadcastJsonEvent() {} };
    const bridge = new CwPaddleBridge({ controlServer: cs, now: () => 1000,
      setTimer: (fn) => { timers.set(++next, fn); return next; },
      clearTimer: (id) => timers.delete(id) });
    bridge.key({}, { session: 'mode-guard', t: 0, d: 60 });
    assert.equal(cs.state.cwKeying, true);
    assert.equal(timers.size, 3);
    bridge._end('test complete');
    assert.equal(timers.size, 0);
  });
}

for (const mode of ['RTTY', 'RTTY_R', 'RTTY-R']) {
  test(`${mode} rejects audio TX before keying PTT or changing settings`, async () => {
    const { driver, calls } = lanRig(mode);
    await assert.rejects(driver.transitionPtt(true, 1, {}), /not FSK RTTY/);
    assert.equal(calls.some(([kind, value]) => kind === 'ptt' && value === 1), false);
    assert.equal(calls.some(([kind]) => kind === 'setting'), false);
    assert.deepEqual(driver.txSaved, []);
  });
}
