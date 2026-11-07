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

for (const kind of ['sstv', 'easypal', 'tty']) {
  test(`${kind}: settling producer cannot clean up a reconnected session`, async (t) => {
    const peer = await new IcomPeer().start();
    const civ = new IcomLanDriver(peer.config());
    civ.on('error', () => {});
    t.after(async () => { await civ.close(); await peer.close(); });
    await civ.open();
    const cs = new EventEmitter();
    cs.civ = civ;
    cs.state = { ptt: false };
    const statuses = [];
    cs.broadcastJsonEvent = (_event, data) => statuses.push(data.status);
    const writes = [];
    cs.setPttFromServer = async (on) => {
      writes.push([on, civ.session.generation]);
      await civ.setPtt(on);
      cs.state.ptt = on;
    };
    let dataWritten;
    const settling = new Promise((resolve) => { dataWritten = resolve; });
    const setDataMode = civ.setDataMode.bind(civ);
    civ.setDataMode = async (on) => {
      await setDataMode(on);
      if (on) dataWritten();
    };
    const opts = { controlServer: cs, audioBridge: { sampleRate: 48000, playback: civ.playback }, pttReleaseMarginMs: 0 };
    let bridge, request;
    if (kind === 'sstv') {
      bridge = new SstvTxBridge({ ...opts, mode: 'R8BW', encode: async () => ({ pcm: Buffer.alloc(2), durationSec: 0 }) });
      const m = MODES.R8BW;
      request = { rgb: Buffer.alloc(m.width * m.lines * 3), width: m.width, height: m.lines };
    } else if (kind === 'easypal') {
      bridge = new EasypalTxBridge({ ...opts, encode: async () => ({ pcm: Buffer.alloc(2), jpeg: Buffer.from([255, 216, 255, 217]), durationSec: 0 }) });
      request = { jpeg: Buffer.from([255, 216, 255, 217]) };
    } else {
      bridge = new TtyBridge(opts);
      request = { mode: 'HELL', text: 'X' };
    }
    bridge.start();
    t.after(() => bridge.stop());
    cs.on('radio-disconnected', () => bridge.abort());
    const old = bridge.send(request).catch(() => {});
    await settling;
    cs.state.ptt = null;
    cs.emit('radio-disconnected');
    await civ.close();
    await civ.open();
    cs.state.ptt = false;
    await cs.setPttFromServer(true);
    const generation = civ.session.generation;
    await old;
    assert.equal(peer.ptt, true, 'old producer must not unkey the new session');
    assert.equal(peer.dataMode, true, 'old producer must not restore DATA OFF in the new session');
    assert.deepEqual(writes.filter(([, gen]) => gen === generation), [[true, generation]]);
    assert.equal(bridge.transmitting, false);
    if (kind === 'tty') assert.equal(statuses.at(-1), 'aborted');
  });
}

for (const kind of ['sstv', 'easypal']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`${kind}: late encoder ${outcome} preserves a newer producer`, async () => {
      const cs = new EventEmitter();
      const statuses = [];
      const writes = [];
      let flushed = 0;
      cs.state = { ptt: false };
      cs.civ = {
        session: { generation: 1 },
        getMode: async () => ({ mode: 'USB' }),
        getDataMode: async () => true,
        setDataMode: async () => {},
      };
      cs.broadcastJsonEvent = (_event, data) => statuses.push(data.status);
      cs.setPttFromServer = async (on) => { cs.state.ptt = on; };
      const audioBridge = { sampleRate: 48000, playback: {
        write: (pcm) => writes.push(pcm), restart: () => { flushed++; },
      } };
      let finish, fail, entered;
      const encoding = new Promise((resolve) => { entered = resolve; });
      const deferred = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const result = { pcm: Buffer.alloc(96000), jpeg: Buffer.from([255, 216, 255, 217]), durationSec: 1 };
      let calls = 0;
      const opts = { controlServer: cs, audioBridge, pttReleaseMarginMs: 0, encode: () => {
        if (++calls === 1) { entered(); return deferred; }
        return Promise.resolve(result);
      } };
      const bridge = kind === 'sstv' ? new SstvTxBridge({ ...opts, mode: 'R8BW' }) : new EasypalTxBridge(opts);
      const m = MODES.R8BW;
      const request = kind === 'sstv' ? { rgb: Buffer.alloc(m.width * m.lines * 3), width: m.width, height: m.lines } : { jpeg: result.jpeg };
      const old = bridge.send(request).catch(() => {});
      await encoding;
      cs.civ.session.generation = 3;
      const current = bridge.send(request);
      while (!writes.length) await new Promise((resolve) => setImmediate(resolve));
      const owned = bridge._tx;
      const before = statuses.length;
      if (outcome === 'resolve') finish(result);
      else fail(new Error('old encoder failed'));
      await old;
      assert.equal(bridge._tx, owned);
      assert.equal(cs.state.ptt, true);
      assert.equal(writes.length, 1);
      assert.equal(flushed, 0);
      assert.equal(statuses.length, before);
      bridge.abort();
      await current;
      assert.equal(cs.state.ptt, false, 'same-session abort still releases PTT');
      assert.equal(flushed, 1, 'same-session abort still discards queued audio');
    });
  }
}

for (const kind of ['sstv', 'easypal']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`${kind}: stale encoder ${outcome} clears its cached busy status when still owner`, async () => {
      const cs = new EventEmitter();
      const statuses = [];
      cs.state = { ptt: false };
      cs.civ = { session: { generation: 1 }, getMode: async () => ({ mode: 'USB' }) };
      cs.broadcastJsonEvent = (_event, data) => statuses.push(data.status);
      let finish, fail, entered;
      const encoding = new Promise((resolve) => { entered = resolve; });
      const deferred = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const opts = { controlServer: cs, audioBridge: { sampleRate: 48000, playback: {} }, encode: () => { entered(); return deferred; } };
      const bridge = kind === 'sstv' ? new SstvTxBridge({ ...opts, mode: 'R8BW' }) : new EasypalTxBridge(opts);
      const m = MODES.R8BW;
      const request = kind === 'sstv' ? { rgb: Buffer.alloc(m.width * m.lines * 3), width: m.width, height: m.lines } : { jpeg: Buffer.from([255, 216, 255, 217]) };
      const old = bridge.send(request).catch(() => {});
      await encoding;
      assert.ok(bridge._current);
      cs.civ.session.generation = 3;
      if (outcome === 'resolve') finish({ pcm: Buffer.alloc(2), durationSec: 0 });
      else fail(new Error('old encoder failed'));
      await old;
      assert.equal(bridge._current, null);
      assert.equal(bridge.transmitting, false);
      assert.ok(['aborted', 'error'].includes(statuses.at(-1)));
    });
  }
}

for (const newer of [false, true]) {
  for (const outcome of ['resolve', 'reject']) {
    test(`tty: stale RTTY plan ${outcome} ${newer ? 'preserves newer producer' : 'reports aborted when still owner'}`, async () => {
      const cs = new EventEmitter();
      const statuses = [];
      const writes = [];
      cs.state = { ptt: false };
      let finish, fail, entered;
      const reading = new Promise((resolve) => { entered = resolve; });
      const deferred = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      cs.civ = {
        session: { generation: 1 },
        getMode: () => { entered(); return deferred; },
        getFrequency: async () => 14000000,
        getDataMode: async () => true,
      };
      cs.broadcastJsonEvent = (_event, data) => statuses.push(data.status);
      cs.setPttFromServer = async (on) => { cs.state.ptt = on; };
      const bridge = new TtyBridge({ controlServer: cs, audioBridge: { sampleRate: 48000, playback: { write: (pcm) => writes.push(pcm), restart: () => {} } }, pttReleaseMarginMs: 0 });
      const old = bridge.send({ mode: 'RTTY', text: 'X' }).catch(() => {});
      await reading;
      cs.civ.session.generation = 3;
      let current;
      if (newer) {
        current = bridge.send({ mode: 'HELL', text: 'X' });
        while (!writes.length) await new Promise((resolve) => setImmediate(resolve));
      }
      const owned = bridge._tx;
      const before = statuses.length;
      if (outcome === 'resolve') finish({ mode: 'USB' });
      else fail(new Error('disconnected while reading'));
      await old;
      if (newer) {
        assert.equal(bridge._tx, owned);
        assert.equal(cs.state.ptt, true);
        assert.equal(statuses.length, before);
        bridge.abort();
        await current;
      } else {
        assert.equal(bridge.transmitting, false);
        assert.equal(statuses.at(-1), 'aborted');
      }
    });
  }
}
