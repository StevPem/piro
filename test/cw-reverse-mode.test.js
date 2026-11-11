'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { ControlServer } = require('../src/server/ws-server');
const { EventEmitter } = require('node:events');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f) { const end = Date.now() + 5000; while (!f()) { assert.ok(Date.now() < end, 'timed out'); await sleep(5); } }
async function rig(t) {
  const peer = await new IcomPeer().start();
  const driver = new IcomLanDriver(peer.config()); driver.on('error', () => {});
  await driver.open();
  const cs = new ControlServer({ civ: driver, port: 0 }); await cs.listen();
  t.after(async () => { await cs.close(); await driver.close(); await peer.close(); });
  return { peer, driver, cs };
}

const { CwTxBridge } = require('../src/server/cw-tx-bridge');
const { CwPaddleBridge } = require('../src/server/cw-paddle-bridge');
test('actual reverse-CW driver mode supports typed CW and paddle keying', async t => {
  const { peer, driver, cs } = await rig(t);
  await driver.setMode('CW_R'); cs.state.mode = await driver.getMode();
  assert.equal(cs.state.mode.mode, 'CW_R');
  const statuses = []; cs.broadcastJsonEvent = (type, data) => { if (type === 'cw-tx') statuses.push(data); };
  const text = new CwTxBridge({ controlServer: cs, estimateSeconds: () => .001, txEndQuietMs: 1, txEndMaxWaitMs: 1500 });
  await text.send({ text: 'E', wpm: 20 });
  assert.deepEqual(peer.cwText, ['E']);
  assert.equal(text.transmitting, false);
  const paddle = new CwPaddleBridge({ controlServer: cs, delayMs: 20 });
  paddle.start();
  try {
    paddle.key({}, { session: 'reverse', t: 0, d: 120 });
    await until(() => peer.ptt);
    await until(() => !peer.ptt);
    assert.equal(paddle.active, true);
  } finally { paddle.stop(); }
});
test('non-CW radio modes remain rejected', async t => {
  const { driver, cs } = await rig(t);
  cs.state.mode = await driver.getMode();
  const text = new CwTxBridge({ controlServer: cs });
  await assert.rejects(text.send({ text: 'E', wpm: 20 }), /CW first/);
  assert.throws(() => new CwPaddleBridge({ controlServer: cs }).key({}, { session: 'wrong', t: 0, d: 60 }), /CW first/);
});
