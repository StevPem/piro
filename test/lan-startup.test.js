'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const WebSocket = require('ws');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { createLanRadio } = require('../src/server/lan-config');

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, detail, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, typeof detail === 'function' ? detail() : detail);
    await tick(10);
  }
}

async function start(t, peer, { timeoutMs = 15000, callsign = '', env = {} } = {}) {
  const o = peer.config();
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/lan-startup-observer.js'),
    path.join(__dirname, '../src/server/index.js')], {
    env: { ...process.env, CIV_CONNECTION: 'lan', ICOM_LAN_HOST: o.host,
      ICOM_LAN_USERNAME: o.username, ICOM_LAN_PASSWORD: o.password,
      ICOM_LAN_CONTROL_PORT: String(o.controlPort), ICOM_LAN_CIV_PORT: String(o.civPort),
      ICOM_LAN_AUDIO_PORT: String(o.audioPort), CIV_RADIO_ADDR: '', CIV_SCOPE_ENABLED: '1',
      ICOM_LAN_TIMEOUT_MS: String(timeoutMs),
      AUDIO_RX_DEVICE: '', AUDIO_TX_DEVICE: '', AUDIO_SAMPLE_RATE: '48000', AUDIO_CHANNELS: '1',
      TLS_CERT_PATH: '', TLS_KEY_PATH: '', WS_PORT: '0', CW_KEY_LINE: 'dtr',
      STATION_CALLSIGN: callsign, STATION_GRID: '', WSPR_GRID: '', WSPR_UPLOAD: 'off',
      WSPR_UNATTENDED: 'off', FREEDV_REPORTER_ENABLED: '0',
      DEEPGRAM_API_KEY: '', STT_URL: '', STT_MODEL: '', STT_WHISPER_SERVER: '', RIGCTL_PORT: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const h = { child, output: '', errors: '', exit: null, sockets: [], audio: 0, scope: 0 };
  child.stdout.on('data', (p) => { h.output += p; });
  child.stderr.on('data', (p) => { h.errors += p; });
  child.once('exit', (code, signal) => { h.exit = { code, signal }; });
  child.on('message', (m) => { if (m.type === 'test-cw-startup-settled') h.modelSettled = true; });
  const feed = setInterval(() => {
    if (!peer.associations.audio || !peer.associations.civ) return;
    const pcm = Buffer.alloc(1920);
    for (let n = 0; n < 960; n++) pcm.writeInt16LE(Math.round(Math.sin(n * Math.PI / 40) * 1200), n * 2);
    peer.rxAudio(pcm.subarray(0, 1364)); peer.rxAudio(pcm.subarray(1364));
    const points = Buffer.alloc(475, 50);
    peer.replyCiv(Buffer.concat([Buffer.from('270000010100', 'hex'), peer.frequency,
      Buffer.from('005002000000', 'hex'), points]));
  }, 20);
  t.after(async () => {
    clearInterval(feed);
    for (const socket of h.sockets) socket.ws.terminate();
    if (!h.exit) child.kill('SIGTERM');
    try { await until(() => h.exit, () => h.output + h.errors, 12000); }
    finally { if (!h.exit) child.kill('SIGKILL'); }
  });
  await until(() => /Scope output enabled/.test(h.output) || h.exit, () => h.output + h.errors);
  assert.equal(h.exit, null, h.errors);
  await until(() => h.modelSettled || h.exit, () => h.output + h.errors);
  assert.equal(h.exit, null, h.errors);
  h.port = Number(h.output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)?.[1]);
  assert.ok(h.port);
  h.connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}`);
    const socket = { ws, events: [] };
    h.sockets.push(socket);
    ws.on('message', (p, binary) => {
      if (binary) { if (p[0] === 1) ++h.audio; if (p[0] === 2) ++h.scope; }
      else socket.events.push(JSON.parse(p));
    });
    await until(() => socket.events.some((e) => e.type === 'connected'), 'missing browser snapshot');
    return socket;
  };
  let id = 0;
  h.request = async (socket, type, data = {}) => {
    const key = String(++id);
    socket.ws.send(JSON.stringify({ id: key, type, ...data }));
    await until(() => socket.events.some((e) => e.id === key), `missing ${type} response`);
    return socket.events.find((e) => e.id === key);
  };
  return h;
}

test('LAN environment validates ports, native PCM format and custom CI-V address', () => {
  const env = { ICOM_LAN_HOST: '127.0.0.1', ICOM_LAN_USERNAME: 'beer', ICOM_LAN_PASSWORD: 'beer' };
  assert.equal(createLanRadio({ ...env, CIV_RADIO_ADDR: 'B6' }).radioAddr, 0xb6);
  for (const change of [{ ICOM_LAN_CONTROL_PORT: '1bad' }, { ICOM_LAN_AUDIO_PORT: '50001' },
    { AUDIO_SAMPLE_RATE: '16000' }, { AUDIO_CHANNELS: '2' }, { CIV_RADIO_ADDR: 'E0' },
    { ICOM_LAN_MOD_LEVEL: '256' }, { ICOM_LAN_HOST: '' }, { ICOM_LAN_PASSWORD: '' }]) {
    assert.throws(() => createLanRadio({ ...env, ...change }));
  }
});

test('timeout OFF allows RX and warns every browser, including later connections, while refusing TX', async (t) => {
  const peer = await new IcomPeer().start();
  peer.parameters.set('0032', Buffer.from([0]));
  t.after(() => peer.close());
  const h = await start(t, peer);
  for (let n = 0; n < 2; n++) {
    const socket = await h.connect();
    await until(() => socket.events.some((e) => e.type === 'rig-error' && /0032.*OFF/.test(e.data.message)), 'missing timeout warning');
    const snapshot = socket.events.find((e) => e.type === 'connected').data;
    assert.equal(snapshot.audio.enabled, true);
    assert.equal(snapshot.audio.sampleRate, 48000);
    const denied = await h.request(socket, 'setPtt', { value: true });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /time-out/);
    assert.equal((await h.request(socket, 'setPtt', { value: false })).ok, true);
  }
  await until(() => h.audio > 50 && h.scope > 20, 'receive stream stopped with timeout OFF');
  assert.equal(peer.ptt, false);
  assert.ok(!peer.commands.some((f) => f[4] === 0x1c && f[5] === 0 && f[6] === 1));
});

test('a newly disabled timeout warns already connected browsers before native keying', async (t) => {
  const peer = await new IcomPeer().start();
  t.after(() => peer.close());
  const h = await start(t, peer);
  const a = await h.connect(), b = await h.connect();
  assert.ok(!a.events.some((e) => e.type === 'rig-error' && /0032/.test(e.data.message)));
  peer.parameters.set('0032', Buffer.from([0]));
  assert.equal((await h.request(a, 'setPtt', { value: true })).ok, false);
  for (const socket of [a, b]) await until(() => socket.events.some((e) => e.type === 'rig-error' && /0032.*OFF/.test(e.data.message)), 'missing broadcast warning');
  assert.equal(peer.ptt, false);
  await h.request(a, 'setPtt', { value: false });
});

test('malformed microphone packets cannot terminate a keyed native LAN server', async (t) => {
  const peer = await new IcomPeer().start();
  t.after(() => peer.close());
  const h = await start(t, peer);
  const socket = await h.connect();
  assert.equal((await h.request(socket, 'setPtt', { value: true })).ok, true);
  assert.equal(peer.ptt, true);
  for (const [pcm, message] of [[Buffer.alloc(1), /complete S16LE/], [Buffer.alloc(48002), /exceeds 500 ms/]]) {
    const before = socket.events.length;
    socket.ws.send(Buffer.concat([Buffer.from([1]), pcm]));
    await until(() => h.exit || socket.events.slice(before).some((e) =>
      e.type === 'audio-error' && e.data.context === 'mic' && message.test(e.data.message)),
    () => h.output + h.errors);
    assert.equal(h.exit, null, h.errors);
    assert.equal(peer.txAudio.length, 0, 'invalid microphone samples must not reach the radio');
  }
  const valid = Buffer.alloc(1920, 42);
  socket.ws.send(Buffer.concat([Buffer.from([1]), valid]));
  await until(() => peer.txAudio.length >= 2 || h.exit, () => h.output + h.errors);
  assert.equal(h.exit, null, h.errors);
  assert.deepEqual(Buffer.concat(peer.txAudio.map((p) => p.bytes)), valid);
  assert.equal((await h.request(socket, 'getFrequency')).ok, true);
  assert.equal((await h.request(socket, 'setPtt', { value: false })).ok, true);
  assert.equal(peer.ptt, false);
  assert.doesNotMatch(h.errors, /Fatal uncaughtException|Fatal unhandledRejection/);
});

test('the Hamlib-style rigctl port reads and sets the radio, and refuses PTT unless allowed', async (t) => {
  const peer = await new IcomPeer().start();
  t.after(() => peer.close());
  const free = net.createServer().listen(0, '127.0.0.1');
  await once(free, 'listening');
  const port = free.address().port;
  free.close();
  const h = await start(t, peer, { env: { RIGCTL_PORT: String(port) } });
  assert.match(h.output, new RegExp(`rigctl\\) on 127\\.0\\.0\\.1:${port}; programs can't key the radio`));
  const browser = await h.connect();
  const sock = net.connect(port, '127.0.0.1');
  t.after(() => sock.destroy());
  let text = '';
  sock.setEncoding('latin1');
  sock.on('data', (d) => { text += d; });
  await once(sock, 'connect');
  const ask = async (line, lines = 1) => {
    text = '';
    sock.write(`${line}\n`);
    await until(() => text.split('\n').length > lines || /RPRT/.test(text), `no answer to ${line}`);
    return text;
  };
  assert.equal(await ask('f'), '14074000\n');
  assert.equal(await ask('F 7074000'), 'RPRT 0\n');
  await until(() => peer.frequency.equals(Buffer.from('0040070700', 'hex')), 'the radio was not tuned');
  await until(() => browser.events.some((e) => e.type === 'frequency' && e.data.value === 7074000), 'the browser was not told');
  assert.equal(await ask('T 1'), 'RPRT -11\n');
  assert.equal(peer.ptt, false);
});

test('lost LAN media exits cleanly non-zero and a fresh process connects again', async (t) => {
  const peer = await new IcomPeer().start();
  t.after(() => peer.close());
  const h = await start(t, peer);
  await h.connect();
  await until(() => h.audio > 50 && h.scope > 20, 'missing native RX before loss');
  peer.release();
  await until(() => h.exit, () => h.output + h.errors, 12000);
  assert.deepEqual(h.exit, { code: 1, signal: null });
  assert.match(h.output, /Shutting down \(LAN link lost\)/);
  assert.match(h.errors, /LAN radio link lost/);
  const again = await start(t, peer); // The same action systemd performs.
  const socket = await again.connect();
  assert.equal((await again.request(socket, 'getFrequency')).ok, true);
  await until(() => again.audio > 50, 'fresh process did not recover audio');
});

test('silent packet loss exits non-zero without requiring a radio disconnect message', async (t) => {
  const peer = await new IcomPeer().start();
  t.after(() => peer.close());
  const h = await start(t, peer, { timeoutMs: 1000 });
  await h.connect();
  await until(() => h.audio > 50, 'missing receive stream before packet loss');
  peer.sendRaw = () => {}; // Cable/network failure: no goodbye or further replies.
  await until(() => h.exit, () => h.output + h.errors, 12000);
  assert.deepEqual(h.exit, { code: 1, signal: null });
  assert.match(h.output, /Shutting down \(LAN link lost\)/);
});

test('SIGTERM emergency OFF is never followed by an old queued PTT-on during cleanup', async (t) => {
  const peer = await new IcomPeer().start();
  t.after(() => peer.close());
  const h = await start(t, peer);
  const socket = await h.connect();
  assert.equal((await h.request(socket, 'setMode', { mode: 'CW' })).ok, true);
  const before = peer.commands.length;
  let preparing = false, signalled = false;
  const injectPoll = (frame) => {
    if (frame.subarray(4).toString('hex') === '1a050032fd') preparing = true;
    if (!preparing || frame[4] !== 4) return;
    peer.off('command', injectPoll);
    // Queue a real browser poll while PTT's mode read is waiting. When
    // the mode reply arrives, PTT-on will sit behind this frequency read.
    peer.options.delayNextReply = 120;
    socket.ws.send(JSON.stringify({ id: 'shutdown-poll', type: 'getFrequency' }));
  };
  peer.on('command', injectPoll);
  const original = peer.civ.bind(peer);
  peer.civ = (frame, association) => {
    if (preparing && frame[4] === 3 && !signalled) {
      signalled = true;
      peer.options.delayNextReply = 500;
      peer.schedule(() => h.child.kill('SIGTERM'), 30);
    }
    return original(frame, association);
  };
  socket.ws.send(JSON.stringify({ id: 'shutdown-on', type: 'setPtt', value: true }));
  await until(() => h.exit, () => h.output + h.errors, 12000);
  assert.equal(signalled, true, 'shutdown happened with a poll ahead of PTT-on');
  assert.deepEqual(h.exit, { code: 0, signal: null });
  const ptt = peer.commands.slice(before).filter((p) => p[4] === 0x1c && p[5] === 0 && p.length === 8);
  assert.ok(ptt.length >= 1, 'emergency unkey reached the radio');
  assert.ok(ptt.every((p) => p[6] === 0), 'cleanup never rekeyed after emergency OFF');
  assert.equal(peer.ptt, false);
});

test('the unchanged VARA bridge finishes a real modem CQ and resumes receive without its watchdog', async (t) => {
  const peer = await new IcomPeer().start();
  t.after(() => peer.close());
  const h = await start(t, peer, { callsign: 'VK3ABC' });
  const socket = await h.connect();
  assert.equal((await h.request(socket, 'setVaraActive', { active: true })).ok, true);
  await until(() => socket.events.some((e) => e.type === 'vara-status' && e.data.state === 'listening'), 'VARA did not start');
  assert.equal((await h.request(socket, 'vara', { action: 'cq' })).ok, true);
  await until(() => peer.ptt, 'CQ did not key');
  await until(() => !peer.ptt, 'CQ did not release before the 30-second watchdog', 15000);
  assert.ok(peer.txAudio.length > 30, 'missing native modem PCM');
  assert.ok(!socket.events.some((e) => e.type === 'audio-error' && /ran past/.test(e.data.message)));
  const audio = h.audio, scope = h.scope;
  await until(() => h.audio > audio + 10 && h.scope > scope + 10, 'receive stream did not continue after CQ');
});
