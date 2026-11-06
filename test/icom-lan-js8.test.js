'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Js8Bridge } = require('../src/server/js8-bridge');
const { buildMessageFrames } = require('../src/audio/js8/js8-varicode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'JS8 regression timed out');
    await sleep(5);
  }
}

function setup() {
  const cs = new EventEmitter();
  const ptt = [];
  const playback = { writes: [], write(pcm) { this.writes.push(pcm); }, restart() {} };
  Object.assign(cs, {
    state: { frequency: 14078000, js8TxHz: 1500 },
    broadcastJsonEvent() {},
    async setPttFromServer(on) { ptt.push(on); },
  });
  const clock = new EventEmitter();
  Object.assign(clock, { nextSlotStart: () => 15000 });
  const bridge = new Js8Bridge({
    controlServer: cs, callsign: 'S53ZO', grid: 'JN76', slotClock: clock,
    audioBridge: { sampleRate: 48000, capture: new EventEmitter(), playback },
    setTimer(fn) { setImmediate(fn); return 1; }, clearTimer() {},
  });
  bridge._active = true;
  const f = buildMessageFrames('S53ZO', 'JN76', '', 'CQ CQ CQ JN76')[0];
  const frame = { frame: f.frame, bits: f.type, text: f.text };
  return { bridge, cs, playback, ptt, frame };
}

test('JS8 encode finishing after Stop cannot requeue a transmission', async () => {
  const { bridge, frame } = setup();
  let finish;
  bridge._call = () => new Promise((resolve) => { finish = resolve; });
  const encoding = bridge.request({ action: 'cq' });
  const rejected = assert.rejects(encoding, /cancelled/i);
  await bridge.request({ action: 'stop' });
  finish({ frames: [frame] });
  await rejected;
  assert.equal(bridge._queue.length, 0);
  assert.equal(bridge.state.sending, null);
});

test('JS8 encode finishing in another LAN generation cannot requeue a transmission', async () => {
  const { bridge, cs, frame } = setup();
  cs.civ = { session: { generation: 1 } };
  let finish;
  bridge._call = () => new Promise((resolve) => { finish = resolve; });
  const encoding = bridge.request({ action: 'cq' });
  const rejected = assert.rejects(encoding, /cancelled/i);
  cs.civ.session.generation++;
  finish({ frames: [frame] });
  await rejected;
  assert.equal(bridge._queue.length, 0);
  assert.equal(bridge.state.sending, null);
});

test('JS8 waits for LAN playback drain before releasing PTT', async () => {
  const { bridge, playback, ptt, frame } = setup();
  let finish;
  playback.drain = () => new Promise((resolve) => { finish = resolve; });
  bridge._queue = [frame];
  bridge.state.sending = { sent: 0, total: 1 };
  const sending = bridge._sendNextFrame(15000);
  await until(() => finish);
  assert.deepEqual(ptt, [true]);
  finish(true);
  await sending;
  assert.deepEqual(ptt, [true, false]);
  assert.equal(bridge.state.sending, null);
});

test('JS8 Stop while draining drops playback and a stale completion cannot overwrite a new message', async () => {
  const { bridge, playback, ptt, frame } = setup();
  let finish, restarted = false;
  playback.drain = () => new Promise((resolve) => { finish = resolve; });
  playback.restart = () => { restarted = true; };
  bridge._queue = [frame, frame];
  bridge.state.sending = { sent: 0, total: 2 };
  const sending = bridge._sendNextFrame(15000);
  await until(() => finish);
  await bridge.request({ action: 'stop' });
  assert.equal(restarted, true);
  assert.deepEqual(ptt, [true, false]);
  const next = { text: 'NEW', sent: 0, total: 1 };
  bridge.state.sending = next;
  bridge._queue = [frame];
  finish(false);
  await sending;
  assert.equal(bridge.state.sending, next);
  assert.equal(bridge._queue.length, 1);
  assert.equal(playback.writes.length, 1);
});

test('JS8 Stop during the PTT-off acknowledgement preserves a newer queued message', async () => {
  const { bridge, cs, frame } = setup();
  let release;
  cs.setPttFromServer = async (on) => {
    if (!on) await new Promise((resolve) => { release = resolve; });
  };
  bridge._queue = [frame];
  bridge.state.sending = { sent: 0, total: 1 };
  const sending = bridge._sendNextFrame(15000);
  await until(() => release);
  await bridge.request({ action: 'stop' });
  const next = { text: 'NEW', sent: 0, total: 1 };
  bridge.state.sending = next;
  bridge._queue = [frame];
  release();
  await sending;
  assert.equal(bridge.state.sending, next);
  assert.equal(bridge._queue.length, 1);
});

test('JS8 Stop during the PTT-on acknowledgement does not restore stale keyed state', async () => {
  const { bridge, cs, playback, ptt, frame } = setup();
  let key;
  cs.setPttFromServer = async (on) => {
    ptt.push(on);
    if (on) await new Promise((resolve) => { key = resolve; });
  };
  bridge._queue = [frame];
  bridge.state.sending = { sent: 0, total: 1 };
  const sending = bridge._sendNextFrame(15000);
  await until(() => key);
  await bridge.request({ action: 'stop' });
  key();
  await sending;
  assert.deepEqual(ptt, [true, false]);
  assert.equal(bridge.state.keyed, false);
  assert.equal(playback.writes.length, 0);
});
