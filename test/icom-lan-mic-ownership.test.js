'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { ControlServer } = require('../src/server/ws-server');
const { AudioBridge } = require('../src/server/audio-bridge');

async function setup(t) {
  const peer = await new IcomPeer().start();
  const civ = new IcomLanDriver(peer.config());
  await civ.open();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();
  const audio = new AudioBridge({ controlServer: server, capture: civ.capture, playback: civ.playback, codecType: 'pcm' });
  audio.start();
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    audio.stop();
    await server.close();
    await civ.close();
    await peer.close();
  });
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws);
    await once(ws, 'open');
    return ws;
  }
  let id = 0;
  function request(ws, type, data = {}) {
    const key = String(++id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('request timeout')); }, 1500);
      function receive(p, binary) {
        if (binary) return;
        const m = JSON.parse(p);
        if (m.id !== key) return;
        clearTimeout(timer); ws.off('message', receive);
        if (m.ok) resolve(m.data); else reject(new Error(m.error));
      }
      ws.on('message', receive);
      ws.send(JSON.stringify({ id: key, type, ...data }));
    });
  }
  return { peer, civ, server, connect, request };
}

test('late malformed browser microphone audio cannot unkey a server modem', async (t) => {
  const { peer, server, connect, request } = await setup(t);
  const ws = await connect();
  await server.setPttFromServer(true); // A server modem owns this transmission.
  ws.send(Buffer.from([1, 42])); // AUDIO tag plus misaligned S16LE sample.
  await request(ws, 'getFrequency'); // Ordered behind binary-message handling.
  assert.equal(peer.ptt, true, 'an unrelated microphone frame must not release modem PTT');
  assert.equal(server.state.ptt, true);
});

test('only the native PTT owner supplies microphone audio, including during key preparation', async (t) => {
  const { peer, civ, server, connect, request } = await setup(t);
  const owner = await connect();
  const other = await connect();
  const written = [];
  const write = civ.playback.write.bind(civ.playback);
  civ.playback.write = (pcm) => { written.push(Buffer.from(pcm)); return write(pcm); };
  peer.options.delayNextReply = 100;
  const key = request(owner, 'setPtt', { value: true });
  const deadline = Date.now() + 1000;
  while (!civ.playback.armed) {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setImmediate(resolve));
  }
  owner.send(Buffer.from([1, 11, 0]));
  other.send(Buffer.from([1, 22, 0]));
  await request(other, 'getFrequency');
  await key;
  assert.deepEqual(written, [Buffer.from([11, 0])], 'preserve owner audio while keying; exclude other browsers');
  peer.options.delayNextReply = 100;
  const release = request(owner, 'setPtt', { value: false });
  while (civ.playback.keyed) {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setImmediate(resolve));
  }
  owner.send(Buffer.from([1, 33, 0]));
  await release;
  await request(owner, 'getFrequency');
  assert.equal(written.length, 1, 'late audio after release must not reach the next producer');
});
