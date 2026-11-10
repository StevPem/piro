'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
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

async function start(t, peer, { timeoutMs = 15000, callsign = '' } = {}) {
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
      DEEPGRAM_API_KEY: '', STT_URL: '', STT_MODEL: '', STT_WHISPER_SERVER: '' },
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
