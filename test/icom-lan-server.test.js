'use strict';

// Run with: node test/icom-lan-server.test.js
// The Icom LAN server (src/server/icom-lan-server.js) with PiRO's own LAN
// client (src/icom-lan/session.js, the code that talks to a real
// IC-7300MK2) on one side and a real CivDriver with a stand-in IC-7300 on
// the other: login, PiRO pausing and refusing everything while the client
// has the radio, CI-V both ways (without the USB echo), scope data, audio
// both ways, one client at a time, unkeying when the client leaves or goes
// quiet, and the 10-minute limit. Then PiRO's own MK2 driver through it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CivDriver } = require('../src/civ/driver');
const { ControlServer } = require('../src/server/ws-server');
const { EVENT } = require('../src/server/protocol');
const { IcomLanServer } = require('../src/server/icom-lan-server');
const audio = require('../src/server/icom-lan-audio');
const { IcomSession } = require('../src/icom-lan/session');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const P = require('../src/icom-lan/protocol');
const { FakeCivRadio } = require('./fixtures/fake-civ-radio');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, what, ms = 4000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await sleep(10);
  }
}

// Server log lines would bury the test output.
const quiet = () => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return () => Object.assign(console, saved);
};

async function setup(t, { radioOpts = {}, serverOpts = {} } = {}) {
  const restore = quiet();
  t.after(restore);
  const radio = new FakeCivRadio({ echo: true, ...radioOpts });
  const civ = new CivDriver({ path: 'stand-in', transport: radio, radioAddr: radio.addr });
  await civ.open();
  const cs = new ControlServer({ civ, port: 0, heartbeatMs: 0 });
  cs.events = [];
  const broadcast = cs._broadcast.bind(cs);
  cs._broadcast = (payload, except) => {
    cs.events.push(JSON.parse(payload));
    return broadcast(payload, except);
  };
  const capture = new EventEmitter();
  const played = [];
  const audioBridge = { sampleRate: 48000, channels: 1, capture, playback: { write: (b) => played.push(Buffer.from(b)) } };
  const server = new IcomLanServer({ civ, controlServer: cs, audioBridge, port: 0, host: '127.0.0.1', username: 'piro', password: 'secret12', timeoutMs: 600, ...serverOpts });
  const ports = await server.start();
  const sessions = [];
  const client = (opts = {}) => {
    const s = new IcomSession({ host: '127.0.0.1', controlPort: ports.control, civPort: ports.civ, audioPort: ports.audio, username: 'piro', password: 'secret12', timeoutMs: 3000, ...opts });
    s.civIn = [];
    s.rxBytes = 0;
    s.on('civ', (b) => s.civIn.push(b.toString('hex')));
    s.on('rx-audio', (p) => (s.rxBytes += p.length));
    sessions.push(s);
    return s;
  };
  t.after(async () => {
    for (const s of sessions) await s.close().catch(() => {});
    await server.stop();
    cs.close();
    radio.close();
  });
  return { radio, civ, cs, server, ports, client, capture, played };
}

const frame = (hex) => Buffer.from(hex.replace(/\s/g, ''), 'hex');
const tone = (n, hz = 1000, rate = 48000) => {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return b;
};

test('codecs: uLaw, 8- and 16-bit PCM, mono and stereo; resampling both ways', () => {
  for (const s of [-32000, -1000, -10, 0, 10, 1000, 32000]) {
    const back = audio.ulawDecode(audio.ulawEncode(s));
    assert.ok(Math.abs(back - s) <= Math.max(8, Math.abs(s) * 0.07), `uLaw ${s} -> ${back}`);
  }
  const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  assert.deepEqual([...audio.decode(audio.encode(samples, 0x04), 0x04)], [...samples], 'PCM16 is exact');
  assert.equal(audio.encode(samples, 0x10).length, samples.length * 4, 'PCM16 stereo: 4 bytes a sample');
  assert.deepEqual([...audio.decode(audio.encode(samples, 0x10), 0x10)], [...samples], 'PCM16 stereo: the left channel');
  assert.equal(audio.encode(Int16Array.from([0]), 0x02)[0], 128, '8-bit PCM is unsigned: silence is 128');
  assert.equal(audio.encode(samples, 0x20).length, samples.length * 2, 'uLaw stereo: 2 bytes a sample');
  assert.equal(audio.isSupported(0x40, 48000), false, "wfview's Opus is not offered");
  assert.equal(audio.isSupported(0x04, 44100), true);
  // 48 kHz to 8 kHz and back: the length scales, and a 1 kHz tone survives.
  const rx = new audio.RxConverter({ fromRate: 48000, toRate: 8000, codec: 0x04 });
  let out = Buffer.alloc(0);
  for (let i = 0; i < 10; i++) out = Buffer.concat([out, rx.process(tone(960))]);
  assert.ok(Math.abs(out.length / 2 - 1600) <= 2, `48k -> 8k: ${out.length / 2} samples from 9600`);
  const tx = new audio.TxConverter({ codec: 0x04, fromRate: 8000, toRate: 48000 });
  const up = tx.process(out);
  assert.equal(up.length / 2, (out.length / 2) * 6, '8k -> 48k: six times the samples');
  let peak = 0;
  for (let i = 2000; i < up.length / 2 - 200; i++) peak = Math.max(peak, Math.abs(up.readInt16LE(i * 2)));
  assert.ok(peak > 6000 && peak < 10000, `the tone comes back at about its level (${peak})`);
});

test('a client logs in, PiRO pauses and refuses everything, and resumes when it leaves', async (t) => {
  const { radio, cs, client, server } = await setup(t);
  cs.state.ft8Active = true;
  let ft8Off = false;
  cs.on('ft8-active', (on) => (ft8Off = on === false));
  await cs.setPttFromServer(true); // a browser was transmitting
  const s = client();
  await s.open();
  assert.ok(cs.paused, 'PiRO is paused');
  assert.equal(cs.state.lanControl.active, true);
  assert.match(cs.state.lanControl.client, /^icom-pc \(127\.0\.0\.1\)$/);
  assert.ok(cs.events.some((e) => e.type === EVENT.LAN_CONTROL && e.data.active), 'the browsers are told');
  assert.ok(ft8Off && !cs.state.ft8Active, 'PiRO turned FT8 off');
  assert.equal(radio.ptt, false, "the browser's PTT was released before the client got the radio");
  const prog = cs.addExternalClient('rigctl test');
  const r = await prog.request({ type: 'getFrequency' });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Paused: icom-pc \(127\.0\.0\.1\) has control of the radio over the LAN\.$/);
  prog.close();
  assert.equal(server.holder?.clientName, 'icom-pc');
  await s.close();
  await until(() => !cs.paused, 'PiRO to resume');
  assert.ok(cs.events.some((e) => e.type === EVENT.LAN_CONTROL && !e.data.active), 'the browsers are told it is back');
  const after = await cs.addExternalClient('after').request({ type: 'getFrequency' });
  assert.equal(after.ok, true, 'requests work again');
});

test('a wrong password is refused', async (t) => {
  const { cs, client } = await setup(t);
  const s = client({ password: 'wrongpass' });
  await assert.rejects(s.open(), /rejected Icom LAN credentials/);
  assert.equal(cs.paused, false);
});

test('CI-V both ways, without the USB echo; scope data; PiRO follows the frequency', async (t) => {
  const { radio, cs, client, civ } = await setup(t);
  const s = client();
  await s.open();
  s.sendCiv(frame('fefe94e0 05 0050020700 fd')); // set 7.025 MHz
  await until(() => radio.freq === 7025000, 'the radio to be tuned');
  s.sendCiv(frame('fefe94e0 03 fd'));
  await until(() => s.civIn.some((h) => h.startsWith('fefee09403')), 'the frequency answer');
  assert.ok(s.civIn.includes('fefee094fbfd'), 'the OK reached the client');
  assert.ok(!s.civIn.some((h) => h.startsWith('fefe94e0')), 'its own frames (the USB echo) did not');
  await until(() => cs.state.frequency === 7025000, "PiRO's own state to follow the radio's answer");
  let lines = 0;
  civ.on('scope-line', () => lines++);
  s.sendCiv(frame('fefe94e0 27 11 01 fd')); // scope output on
  await until(() => s.civIn.filter((h) => h.startsWith('fefe0094 2700'.replace(' ', ''))).length >= 3, 'scope frames at the client');
  assert.ok(lines >= 1, 'and the browsers still get the scope');
  radio.stopScope();
});

test('audio both ways: received audio in the client codec, transmit audio to the radio', async (t) => {
  const { client, capture, played } = await setup(t);
  const s = client();
  await s.open();
  for (let i = 0; i < 5; i++) capture.emit('data', tone(960));
  await until(() => s.rxBytes >= 9600, 'received audio at the client');
  s.audio.tracked(P.audio(s.audio.localId, s.audio.remoteId, 1, tone(960)), { group: 'audio', append: true });
  await until(() => played.length > 0, 'transmit audio at the radio');
  assert.equal(Buffer.concat(played).length, 1920);
});

test('one client at a time: a second is refused while the first has the radio', async (t) => {
  const { cs, client } = await setup(t);
  const a = client();
  await a.open();
  const b = client();
  await assert.rejects(b.open(), /authentication failed|timed out/);
  assert.match(cs.state.lanControl.client, /icom-pc/);
  await a.close();
  await until(() => !cs.paused, 'PiRO to resume');
});

test('leaving while keyed: PiRO unkeys the radio, then takes it back', async (t) => {
  const { radio, cs, client } = await setup(t);
  const s = client();
  await s.open();
  s.sendCiv(frame('fefe94e0 1c 00 01 fd'));
  await until(() => radio.ptt, 'the client to key the radio');
  await s.close();
  await until(() => !cs.paused, 'PiRO to resume');
  assert.equal(radio.ptt, false, 'unkeyed');
  assert.equal(cs.state.ptt, false);
  assert.ok(radio.written.some((h) => h === 'fefe94e017fffd'), 'CW stop was sent too');
});

test('a client that goes quiet while keyed: unkeyed after the timeout', async (t) => {
  const { radio, cs, client } = await setup(t);
  const s = client();
  await s.open();
  s.sendCiv(frame('fefe94e0 1c 00 01 fd'));
  await until(() => radio.ptt, 'the client to key the radio');
  // The network goes: the client's sockets close without a goodbye.
  clearInterval(s.timer);
  for (const st of s.streams) {
    clearInterval(st.timer);
    st.socket?.close();
    st.socket = null;
  }
  await until(() => !radio.ptt && !cs.paused, 'the timeout to unkey and resume', 5000);
});

test('the 10-minute limit (shortened): PiRO unkeys a client that keeps transmitting', async (t) => {
  const { radio, cs, client, server } = await setup(t, { serverOpts: { txLimitMs: 300 } });
  let limit = false;
  server.on('tx-limit', () => (limit = true));
  const s = client();
  await s.open();
  s.sendCiv(frame('fefe94e0 1c 00 01 fd'));
  await until(() => radio.ptt, 'the client to key the radio');
  await until(() => !radio.ptt, 'the limit to unkey it', 2000);
  assert.ok(limit && cs.events.some((e) => e.type === EVENT.PTT_TIMEOUT && e.data.lan), 'the browsers are told');
  assert.ok(cs.paused, 'the client keeps the radio');
  // CW text counts as transmitting too.
  s.sendCiv(frame('fefe94e0 17 434651 fd'));
  await until(() => radio.written.filter((h) => h === 'fefe94e017fffd').length >= 2, 'CW to be stopped at the limit', 2000);
});

test("PiRO's own IC-7300MK2 driver works through the server", async (t) => {
  const { radio, cs, ports } = await setup(t, { radioOpts: { model: 0xb6, addr: 0x94 } });
  const driver = new IcomLanDriver({ host: '127.0.0.1', controlPort: ports.control, civPort: ports.civ, audioPort: ports.audio, username: 'piro', password: 'secret12', timeoutMs: 3000, txBufferMs: 0 });
  driver.on('error', () => {});
  t.after(() => driver.close().catch(() => {}));
  await driver.open();
  assert.ok(cs.paused);
  assert.equal(await driver.getFrequency(), 14074000);
  await driver.setFrequency(3573000);
  assert.equal(radio.freq, 3573000);
  await driver.setPtt(true);
  assert.equal(radio.ptt, true);
  await driver.setPtt(false);
  assert.equal(radio.ptt, false);
  await driver.close();
  await until(() => !cs.paused, 'PiRO to resume');
  assert.equal(cs.state.frequency, 3573000, 'PiRO read the new frequency when it resumed');
});
