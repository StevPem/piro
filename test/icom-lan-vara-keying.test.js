'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { LanPlayback } = require('../src/icom-lan/audio');
const { VaraBridge } = require('../src/server/vara-bridge');

function bridgeFor(civ) {
  const cs = new EventEmitter();
  cs.civ = civ;
  cs.state = { ptt: false };
  cs.broadcastJsonEvent = () => {};
  cs.setPttFromServer = async (on) => {
    await civ.setPtt(on);
    cs.state.ptt = on;
    cs.emit('ptt', on);
  };
  const bridge = new VaraBridge({ controlServer: cs, callsign: 'S53ZO',
    audioBridge: { sampleRate: 48000, capture: new EventEmitter(), playback: civ.playback } });
  bridge.start();
  bridge._active = true;
  bridge._dataReady = true;
  return { bridge, cs };
}

for (const action of ['modem release', 'deactivate']) {
  test(`VARA ${action} waits for pending native LAN key before releasing`, async (t) => {
    const peer = await new IcomPeer().start();
    t.after(() => peer.close());
    const civ = new IcomLanDriver(peer.config());
    t.after(() => civ.close());
    await civ.open();
    civ.playback.start();
    const { bridge, cs } = bridgeFor(civ);
    t.after(() => bridge.stop());
    peer.options.delayNextReply = 150;
    const key = bridge._key();
    // Wait until the native transition has armed playback, before its delayed
    // CI-V preparation replies. drain() currently returns false in this state.
    while (!civ.playback.armed) await new Promise((r) => setImmediate(r));
    const release = action === 'deactivate' ? bridge.deactivate() : bridge._unkey({ drain: true });
    await Promise.all([key, release]);
    assert.equal(peer.ptt, false, 'a late PTT ON must not escape the release');
    assert.equal(cs.state.ptt, false);
    assert.equal(bridge._keyed, false);
    assert.equal(bridge._keyTimer, null);
  });
}

test('VARA pending-key failure releases without deadlocking or dropping the watchdog early', async (t) => {
  const session = new EventEmitter();
  session.connected = true;
  session.generation = 1;
  const playback = new LanPlayback(session);
  playback.start();
  t.after(() => playback.stop());
  let rejectKey;
  const civ = { session, playback, async setPtt(on) {
    if (on) { playback.arm(); await new Promise((_, reject) => { rejectKey = reject; }); }
    playback.setKeyed(on);
  } };
  const { bridge, cs } = bridgeFor(civ);
  t.after(() => bridge.stop());
  const key = bridge._key();
  const release = bridge._unkey({ drain: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(bridge._keyed, true, 'pending ON still needs its safety latch');
  assert.ok(bridge._keyTimer, 'pending ON still needs its watchdog');
  rejectKey(new Error('Synthetic radio rejected key'));
  await Promise.all([key, release]);
  assert.equal(cs.state.ptt, false);
  assert.equal(bridge._keyed, false);
  assert.equal(bridge._keyTimer, null);
});

test('VARA release waiting on old key does not release a reconnected radio', async (t) => {
  const session = new EventEmitter();
  session.connected = true;
  session.generation = 1;
  const playback = new LanPlayback(session);
  playback.start();
  t.after(() => playback.stop());
  let completeKey;
  const writes = [];
  const civ = { session, playback, async setPtt(on) {
    writes.push([on, session.generation]);
    if (on) { playback.arm(); await new Promise((resolve) => { completeKey = resolve; }); }
    playback.setKeyed(on);
  } };
  const { bridge, cs } = bridgeFor(civ);
  t.after(() => bridge.stop());
  const key = bridge._key();
  const release = bridge._unkey({ drain: true });
  session.generation++;
  completeKey();
  await Promise.all([key, release]);
  assert.deepEqual(writes, [[true, 1]], 'old cleanup must not send OFF in generation 2');
  assert.equal(cs.state.ptt, true);
});
