'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { SstvTxBridge } = require('../src/server/sstv-tx-bridge');
const { EasypalTxBridge } = require('../src/server/easypal-tx-bridge');
const { TtyBridge } = require('../src/audio/tty-bridge');
const { MODES } = require('../src/audio/sstv-modes');

async function fixture(t, kind, { failures = 0, missingOnAck = false, keyCompletionError = false, cancelDrain = false } = {}) {
  const peer = await new IcomPeer().start();
  const civ = new IcomLanDriver(peer.config({ requestTimeoutMs: 250 }));
  civ.on('error', () => {});
  await civ.open();
  if (kind === 'rtty') await civ.setMode('RTTY', 1);
  t.after(async () => { rejecting = false; civ.playback.stop(); await civ.close(); await peer.close(); });
  const cs = new EventEmitter();
  cs.civ = civ;
  cs.state = { ptt: false };
  const statuses = [], power = [], unsafe = [];
  cs.broadcastJsonEvent = (_event, data) => { if (data.status) statuses.push(data.status); };
  cs.setPttFromServer = async (on) => {
    await civ.setPtt(on);
    if (on && keyCompletionError) throw new Error('Synthetic key-completion failure');
    cs.state.ptt = on;
    cs.emit('ptt', on);
  };
  const respond = peer.civ.bind(peer);
  let rejecting = false;
  peer.civ = (frame, association) => {
    const ptt = frame[4] === 0x1c && frame[5] === 0 && frame.length === 8;
    if (ptt && frame[6] === 1) {
      rejecting = true;
      if (missingOnAck) { peer.ptt = true; return; }
    }
    if (ptt && frame[6] === 0 && rejecting && failures > 0) {
      failures--;
      peer.replyCiv([0xfa], association);
      return;
    }
    // These are producer restoration commands, independent of the driver's
    // native modulation-input rollback (covered separately).
    if (peer.ptt && ((frame[4] === 0x1a && frame[5] === 6 && frame[6] === 0)
      || frame[4] === 5 || frame[4] === 6)) unsafe.push([...frame.subarray(4, -1)]);
    respond(frame, association);
  };
  civ.getTxPower = async () => 100;
  civ.setTxPower = async (watts) => { power.push([watts, peer.ptt]); return watts; };
  const playback = cancelDrain ? civ.playback : { write() {}, drain: async () => true };
  if (cancelDrain) {
    playback.start();
    const drain = playback.drain.bind(playback);
    playback.drain = async () => {
      const pending = drain();
      await cs.setPttFromServer(false); // same-session external release cancels queued PCM
      return pending;
    };
  }
  const opts = { controlServer: cs, audioBridge: { sampleRate: 48000, playback },
    dataSettleMs: 0, pttReleaseMarginMs: 0, txPowerW: 1 };
  let bridge, request;
  if (kind === 'sstv') {
    bridge = new SstvTxBridge({ ...opts, mode: 'R8BW', encode: async () => ({ pcm: Buffer.alloc(2), durationSec: 0 }) });
    const m = MODES.R8BW;
    request = { rgb: Buffer.alloc(m.width * m.lines * 3), width: m.width, height: m.lines };
  } else if (kind === 'easypal') {
    const jpeg = Buffer.from([255, 216, 255, 217]);
    bridge = new EasypalTxBridge({ ...opts, encode: async () => ({ pcm: Buffer.alloc(2), durationSec: 0, jpeg }) });
    request = { jpeg };
  } else {
    bridge = new TtyBridge(opts);
    bridge._synthesize = () => ({ pcm: Buffer.alloc(2), durationSec: 0 });
    request = { mode: 'RTTY', text: 'X' };
  }
  return { peer, civ, cs, bridge, statuses, power, unsafe, send: () => bridge.send(request) };
}

for (const kind of ['sstv', 'easypal', 'rtty']) {
  test(`${kind}: rejected release preserves TX routing instead of restoring while keyed`, async (t) => {
    const f = await fixture(t, kind, { failures: Infinity });
    await assert.rejects(f.send(), /set PTT/);
    assert.equal(f.peer.ptt, true);
    assert.equal(f.cs.state.ptt, true, 'failed release must not publish receive');
    assert.equal(f.peer.dataMode, true);
    assert.deepEqual(f.unsafe, [], 'DATA/mode/frequency restoration is unsafe before release');
    if (kind !== 'rtty') assert.deepEqual(f.power, [[1, false]], 'do not restore the previous high power while keyed');
    assert.equal(f.statuses.at(-1), 'error');
  });

  test(`${kind}: a successful release retry permits restoration`, async (t) => {
    const f = await fixture(t, kind, { failures: 1 });
    await assert.rejects(f.send(), /set PTT/);
    assert.equal(f.peer.ptt, false);
    assert.equal(f.cs.state.ptt, false);
    assert.equal(f.peer.dataMode, false);
    assert.deepEqual(f.unsafe, []);
    if (kind !== 'rtty') assert.deepEqual(f.power, [[1, false], [100, false]]);
    else assert.equal(f.peer.mode, 4, 'RTTY mode is restored after confirmed receive');
    assert.equal(f.statuses.at(-1), 'error', 'the original release error remains visible');
  });

  test(`${kind}: ordinary successful completion still restores in receive`, async (t) => {
    const f = await fixture(t, kind);
    await f.send();
    assert.equal(f.peer.ptt, false);
    assert.equal(f.peer.dataMode, false);
    assert.deepEqual(f.unsafe, []);
    if (kind !== 'rtty') assert.deepEqual(f.power, [[1, false], [100, false]]);
    else assert.equal(f.peer.mode, 4);
    assert.equal(f.statuses.at(-1), 'sent');
  });

  test(`${kind}: a missing key acknowledgement invalidates old restoration work`, async (t) => {
    const f = await fixture(t, kind, { failures: Infinity, missingOnAck: true });
    await assert.rejects(f.send(), /timed out/);
    assert.equal(f.peer.ptt, true, 'the peer keyed despite its missing acknowledgement');
    assert.equal(f.cs.state.ptt, false, 'cached receive is not proof of release after an uncertain key');
    assert.equal(f.peer.dataMode, true);
    assert.deepEqual(f.unsafe, []);
    if (kind !== 'rtty') assert.deepEqual(f.power, [[1, false]]);
    assert.equal(f.statuses.at(-1), kind === 'rtty' ? 'aborted' : 'error');
  });

  test(`${kind}: cancelled native drain reports aborted rather than sent`, async (t) => {
    const f = await fixture(t, kind, { cancelDrain: true });
    await f.send();
    assert.equal(f.peer.ptt, false);
    assert.equal(f.statuses.at(-1), 'aborted');
    assert.ok(!f.statuses.includes('sent'));
  });

  test(`${kind}: a newer key intent after release fences old same-session restoration`, async (t) => {
    const f = await fixture(t, kind);
    const generation = f.civ.session.generation;
    let nextKey;
    f.cs.on('ptt', (on) => {
      if (!on && !nextKey) nextKey = f.cs.setPttFromServer(true);
    });
    await f.send();
    await nextKey;
    assert.equal(f.civ.session.generation, generation);
    assert.equal(f.peer.ptt, true);
    assert.equal(f.peer.mode, 1, 'old RTTY cleanup must not change the newer USB transmission');
    assert.equal(f.peer.dataMode, true);
    assert.deepEqual(f.unsafe, []);
    if (kind !== 'rtty') assert.deepEqual(f.power, [[1, false]], 'stale cleanup must not restore high power');
  });
}

for (const kind of ['sstv', 'easypal']) {
  test(`${kind}: restoration already in progress finishes before newer native key preparation`, async (t) => {
    const f = await fixture(t, kind);
    let entered, finish;
    const restoring = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { finish = resolve; });
    t.after(() => finish());
    const setPower = f.civ.setTxPower.bind(f.civ);
    f.civ.setTxPower = async (watts) => {
      if (watts === 100) { entered(); await held; }
      return setPower(watts);
    };
    const old = f.send();
    await restoring;
    const nextKey = f.cs.setPttFromServer(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.peer.ptt, false, 'new PTT waits behind the restoration transaction');
    finish();
    await Promise.all([old, nextKey]);
    assert.equal(f.peer.ptt, true);
    assert.deepEqual(f.power, [[1, false], [100, false]]);
    assert.deepEqual(f.unsafe, []);
  });
}

test('RTTY setup aborted before keying cannot release a newer same-session producer', async (t) => {
  const f = await fixture(t, 'rtty');
  let entered, finish;
  const settingFrequency = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { finish = resolve; });
  t.after(() => finish());
  const setFrequency = f.civ.setFrequency.bind(f.civ);
  f.civ.setFrequency = async (hz) => { await setFrequency(hz); entered(); await held; };
  const old = f.send();
  await settingFrequency;
  await f.cs.setPttFromServer(true);
  f.bridge.abort();
  finish();
  await old;
  assert.equal(f.peer.ptt, true);
  assert.equal(f.peer.mode, 1);
  assert.equal(f.peer.dataMode, true);
  assert.equal(f.statuses.at(-1), 'aborted');
});
