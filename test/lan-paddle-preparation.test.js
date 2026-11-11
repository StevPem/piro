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

const { CwPaddleBridge } = require('../src/server/cw-paddle-bridge');
test('cold native paddle preparation preserves first dot and next element with 35ms replies', async t => {
  const { peer, driver, cs } = await rig(t);
  await driver.setMode('CW'); cs.state.mode = await driver.getMode();
  const reply = peer.replyCiv.bind(peer); peer.replyCiv = (bytes, a) => reply(bytes, a, { delay: 35 });
  const edges = []; peer.on('command', p => { if (p[4] === 0x1c && p[5] === 0 && p.length === 8) edges.push({ on: p[6], at: performance.now() }); });
  const paddle = new CwPaddleBridge({ controlServer: cs, delayMs: 30 }); paddle.start();
  try {
    const ws = {}; paddle.key(ws, { session: 'cold', t: 0, d: 60 });
    paddle.key(ws, { session: 'cold', t: 120, d: 180 });
    await until(() => edges.length >= 4);
    assert.deepEqual(edges.map(e => e.on), [1, 0, 1, 0]);
    assert.ok(edges[1].at - edges[0].at >= 40, 'first dot has not been cancelled or squashed');
    assert.ok(edges[2].at - edges[0].at >= 100, 'following gap is preserved');
    assert.ok(edges[3].at - edges[2].at >= 160, 'dash duration is preserved');
    assert.equal(paddle.active, true);
  } finally { paddle.stop(); peer.replyCiv = reply; }
});
test('stop during native preparation discards every pending key-down', async t => {
  const { peer, driver, cs } = await rig(t);
  await driver.setMode('CW'); cs.state.mode = await driver.getMode();
  const reply = peer.replyCiv.bind(peer); peer.replyCiv = (bytes, a) => reply(bytes, a, { delay: 35 });
  const edges = []; peer.on('command', p => { if (p[4] === 0x1c && p[5] === 0 && p.length === 8) edges.push(p[6]); });
  const paddle = new CwPaddleBridge({ controlServer: cs, delayMs: 30 }); paddle.start();
  paddle.key({}, { session: 'cancel', t: 0, d: 60 }); paddle.stop();
  await sleep(250);
  assert.equal(edges.includes(1), false);
  assert.equal(paddle.active, false);
  peer.replyCiv = reply;
});
test('timeout-off native preparation cannot key the paddle', async t => {
  const { peer, driver, cs } = await rig(t);
  await driver.setMode('CW'); cs.state.mode = await driver.getMode();
  peer.parameters.set('0032', Buffer.from([0]));
  const paddle = new CwPaddleBridge({ controlServer: cs, delayMs: 30 }); paddle.start();
  paddle.key({}, { session: 'timeout-off', t: 0, d: 60 });
  await until(() => !paddle.active);
  assert.equal(peer.ptt, false); paddle.stop();
});

test('an idle gap that outlives the native burst cache prepares the next dot before keying', async t => {
  const { peer, driver, cs } = await rig(t);
  await driver.setMode('CW'); cs.state.mode = await driver.getMode();
  const reply = peer.replyCiv.bind(peer); peer.replyCiv = (bytes, a) => reply(bytes, a, { delay: 35 });
  const edges = []; peer.on('command', p => { if (p[4] === 0x1c && p[5] === 0 && p.length === 8) edges.push(p[6]); });
  const paddle = new CwPaddleBridge({ controlServer: cs, delayMs: 30 }); paddle.start();
  const ws = {};
  try {
    paddle.key(ws, { session: 'idle', t: 0, d: 60 });
    await until(() => edges.length === 2);
    await sleep(2200);
    paddle.key(ws, { session: 'idle', t: 2400, d: 60 });
    await until(() => edges.length >= 4);
    assert.deepEqual(edges, [1, 0, 1, 0]);
    assert.equal(paddle.active, true);
  } finally { paddle.stop(); peer.replyCiv = reply; }
});

test('renew safety state between buffered pairs before their timeout lease expires', async t => {
  const { peer, driver, cs } = await rig(t);
  await driver.setMode('CW'); cs.state.mode = await driver.getMode();
  const reply = peer.replyCiv.bind(peer); peer.replyCiv = (bytes, a) => reply(bytes, a, { delay: 35 });
  const commands = []; peer.on('command', p => {
    if (p[4] === 0x1c && p[5] === 0 && p.length === 8) commands.push(p[6] ? 'on' : 'off');
    if (p.subarray(4).toString('hex') === '1a050032fd') commands.push('timeout');
  });
  const paddle = new CwPaddleBridge({ controlServer: cs, delayMs: 30 }); paddle.start();
  const ws = {};
  try {
    paddle.key(ws, { session: 'renew', t: 0, d: 180 });
    await until(() => commands.includes('on'));
    driver.timeoutCheckedAt = performance.now() - 29500;
    paddle.key(ws, { session: 'renew', t: 1000, d: 60 });
    await until(() => commands.filter(x => x === 'off').length === 2);
    assert.deepEqual(commands, ['timeout', 'on', 'off', 'timeout', 'on', 'off']);
    assert.equal(paddle.active, true);
  } finally { paddle.stop(); peer.replyCiv = reply; }
});

test('key-up preserves a reservation for a later already buffered pair', async t => {
  const { peer, driver, cs } = await rig(t);
  await driver.setMode('CW'); cs.state.mode = await driver.getMode();
  const reply = peer.replyCiv.bind(peer); peer.replyCiv = (bytes, a) => reply(bytes, a, { delay: 35 });
  const edges = []; peer.on('command', p => { if (p[4] === 0x1c && p[5] === 0 && p.length === 8) edges.push(p[6]); });
  const paddle = new CwPaddleBridge({ controlServer: cs, delayMs: 30 }); paddle.start();
  const ws = {};
  try {
    paddle.key(ws, { session: 'buffered-gap', t: 0, d: 180 });
    paddle.key(ws, { session: 'buffered-gap', t: 3000, d: 60 });
    await until(() => edges.length >= 4);
    assert.deepEqual(edges, [1, 0, 1, 0]);
    assert.equal(paddle.active, true);
  } finally { paddle.stop(); peer.replyCiv = reply; }
});
