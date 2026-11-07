'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { serverEnvironment } = require('./icom-lan-demo');
const { createRadio } = require('../src/server/radio-connection');

async function waitFor(predicate, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Server test timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('configuration preserves USB defaults and rejects invalid LAN settings', () => {
  const usb = createRadio({});
  assert.equal(usb.path, '/dev/ttyUSB0');
  assert.equal(usb.baudRate, 19200);
  assert.equal(usb.session, undefined);
  assert.equal(createRadio({ CW_KEY_LINE: 'rts' }).keyLine, 'rts');
  assert.equal(createRadio({ CW_KEY_LINE: 'off' }).keyLine, null);
  const env = { CIV_CONNECTION: 'lan', ICOM_LAN_HOST: '127.0.0.1', ICOM_LAN_USERNAME: 'beer', ICOM_LAN_PASSWORD: 'beer' };
  for (const patch of [{ CIV_CONNECTION: 'tcp' }, { AUDIO_CHANNELS: '2' }, { AUDIO_SAMPLE_RATE: '16000' },
    { ICOM_LAN_CONTROL_PORT: '1junk' }, { CIV_RADIO_ADDR: 'E0' }, { ICOM_LAN_HOST: '' },
    { ICOM_LAN_PASSWORD: '' }, { ICOM_LAN_MOD_LEVEL: '256' }]) assert.throws(() => createRadio({ ...env, ...patch }));
  const driver = createRadio({ ...env, CIV_RADIO_ADDR: 'B4' });
  assert.equal(driver.radioAddr, 0xb4);
  assert.equal(driver.keyLine, null);
});

test('normal PiRO process starts without ALSA and carries control, PCM and scope through the real browser protocol', { timeout: 25000 }, async (t) => {
  const peer = await new IcomPeer().start();
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server/index.js')], {
    env: serverEnvironment(peer), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '', exit;
  child.stdout.on('data', (p) => { output += p; });
  child.stderr.on('data', (p) => { errors += p; });
  child.on('exit', (code) => { exit = code; });
  let ws;
  t.after(async () => {
    ws?.terminate();
    if (exit === undefined) child.kill('SIGTERM');
    // shutdown() allows eight seconds; leave time for process exit under load.
    try { await waitFor(() => exit !== undefined, 10000); }
    finally { if (exit === undefined) child.kill('SIGKILL'); await peer.close(); }
  });
  await waitFor(() => output.includes('Scope output enabled') || exit !== undefined);
  assert.equal(exit, undefined, errors);
  assert.ok(output.includes('Audio bridge started'));
  const port = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)?.[1];
  assert.ok(port, output);
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [], binary = [];
  ws.on('message', (p, isBinary) => { if (isBinary) binary.push(Buffer.from(p)); else events.push(JSON.parse(p)); });
  await waitFor(() => events.some((e) => e.type === 'connected'));
  const snapshot = events.find((e) => e.type === 'connected').data;
  assert.equal(snapshot.radioConnection.transport, 'lan');
  assert.equal(snapshot.audio.sampleRate, 48000);
  assert.equal(snapshot.audio.enabled, true);
  assert.equal(JSON.stringify(snapshot).includes('beer'), false);
  let id = 0;
  const request = async (type, fields = {}) => {
    const requestId = String(++id);
    ws.send(JSON.stringify({ id: requestId, type, ...fields }));
    await waitFor(() => events.some((e) => e.id === requestId));
    const reply = events.find((e) => e.id === requestId);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply;
  };
  await request('setFrequency', { value: 14080000 });
  await request('setPtt', { value: true });
  ws.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(1920, 4)]));
  await waitFor(() => peer.txAudio.length >= 2);
  assert.deepEqual(Buffer.concat(peer.txAudio.map((p) => p.bytes)), Buffer.alloc(1920, 4));
  await request('setPtt', { value: false });
  // The audited crash packet must produce an error/release, not an uncaught
  // exception that kills the service while the radio is keyed.
  await request('setPtt', { value: true });
  ws.send(Buffer.from([1, 0]));
  await waitFor(() => !peer.ptt && events.some((e) => e.type === 'audio-error' && /aligned/.test(e.data.message)));
  assert.equal(exit, undefined, errors);
  assert.equal((await request('getFrequency')).data.value, 14080000);
  for (let n = 0; n < 3; n++) peer.rxAudio(Buffer.alloc(1920, 5));
  await waitFor(() => binary.some((p) => p[0] === 1));
  assert.deepEqual(binary.find((p) => p[0] === 1).subarray(1), Buffer.alloc(1920, 5));
  peer.replyCiv(Buffer.concat([Buffer.from('2700000101000040071400005002000000', 'hex'), Buffer.alloc(475, 90)]));
  await waitFor(() => binary.some((p) => p[0] === 2));
  assert.equal(binary.find((p) => p[0] === 2).length, 12 + 475);
  assert.equal(errors.includes('arecord'), false, errors);
  assert.equal(errors.includes('aplay'), false, errors);
  assert.equal(errors.includes('amixer'), false, errors);
  // Exercise last-browser CW cancellation through normal server wiring.
  await request('setMode', { mode: 'CW' });
  peer.cwStopped = false;
  await request('sendCw', { text: 'CQ CQ CQ DE S53ZO S53ZO', wpm: 6 });
  await waitFor(() => peer.cwText.length > 0);
  ws.close();
  await waitFor(() => peer.cwStopped && !peer.ptt);
  // A fresh browser must not inherit a falsely cached PTT-on state.
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let secondSnapshot;
  ws.on('message', (p, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(p);
    events.push(message);
    if (message.type === 'connected') secondSnapshot = message.data;
  });
  await waitFor(() => secondSnapshot);
  assert.equal(secondSnapshot.ptt, false);
  // Loss during another CW message must cancel it and reconnect without
  // sending any additional text chunk from the interrupted message.
  peer.cwStopped = false;
  const beforeText = peer.cwText.length;
  await request('sendCw', { text: 'TEST TEST TEST TEST TEST TEST TEST TEST TEST TEST TEST TEST', wpm: 6 });
  await waitFor(() => peer.cwText.length > beforeText);
  const beforeRelease = peer.cwText.length;
  const oldAssociation = peer.associations.civ;
  const beforeReleaseEvents = events.length;
  const beforeReleaseOutput = output.length;
  peer.release();
  await waitFor(() => peer.associations.civ !== oldAssociation && peer.cwStopped);
  await waitFor(() => events.slice(beforeReleaseEvents).some((e) => e.type === 'radio-connection' && e.data.state === 'connected' && e.data.model === 'IC-7300MK2'));
  // Activity updates also publish connected status. Wait for initialization
  // and scope recovery, not an earlier status still in the socket queue.
  await waitFor(() => output.slice(beforeReleaseOutput).includes('Scope output enabled after radio reconnect.'));
  assert.equal(peer.cwText.length, beforeRelease);
  assert.ok(events.some((e) => e.type === 'cw-tx-status' && ['aborted', 'error'].includes(e.data.status)));
  child.kill('SIGTERM');
  await waitFor(() => exit !== undefined);
  assert.equal(exit, 0, errors);
  assert.equal(peer.ptt, false);
  assert.equal(peer.parameters.get('0079')[0], 1); // startup AF setting restored.
  assert.ok(peer.received.some(({ role, packet: p }) => role === 'control' && p.length === 64 && p[21] === 1));
  for (const role of ['control', 'civ', 'audio']) assert.ok(peer.received.some((p) => p.role === role && p.packet.readUInt16LE(4) === 5));
});

test('radio loss disables VARA in the shared app state and it can be explicitly activated after reconnect', { timeout: 25000 }, async (t) => {
  const peer = await new IcomPeer().start();
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server/index.js')], {
    env: { ...serverEnvironment(peer), STATION_CALLSIGN: 'S53ZO' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '', exit, ws;
  child.stdout.on('data', (p) => { output += p; });
  child.stderr.on('data', (p) => { errors += p; });
  child.on('exit', (code) => { exit = code; });
  t.after(async () => {
    ws?.terminate();
    if (exit === undefined) child.kill('SIGTERM');
    try { await waitFor(() => exit !== undefined, 10000); }
    finally { if (exit === undefined) child.kill('SIGKILL'); await peer.close(); }
  });
  await waitFor(() => output.includes('Scope output enabled') || exit !== undefined);
  assert.equal(exit, undefined, errors);
  const port = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)[1];
  const events = [];
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('message', (p, binary) => { if (!binary) events.push(JSON.parse(p)); });
  await waitFor(() => events.some((e) => e.type === 'connected'));
  let id = 0;
  const request = async (type, data) => {
    const requestId = `vara-${++id}`;
    ws.send(JSON.stringify({ id: requestId, type, ...data }));
    await waitFor(() => events.some((e) => e.id === requestId));
    const reply = events.find((e) => e.id === requestId);
    assert.equal(reply.ok, true, JSON.stringify(reply));
  };
  await request('setVaraActive', { active: true });
  await waitFor(() => events.some((e) => e.type === 'vara-status' && e.data.state === 'listening'));
  const before = events.length;
  peer.release();
  await waitFor(() => events.slice(before).some((e) => e.type === 'app-modes' && e.data.varaActive === false));
  await waitFor(() => events.slice(before).some((e) => e.type === 'radio-connection' && e.data.state === 'connected' && e.data.model));
  await waitFor(() => events.slice(before).some((e) => e.type === 'vara-status' && e.data.state === 'off'));
  const again = events.length;
  await request('setVaraActive', { active: true });
  await waitFor(() => events.slice(again).some((e) => e.type === 'vara-status' && e.data.state === 'listening'));
  await request('vara', { action: 'cq' });
  assert.equal(exit, undefined, errors);
});

test('reconnect updates the scope snapshot after initial scope enable fails', { timeout: 25000 }, async (t) => {
  const peer = await new IcomPeer().start();
  const respond = peer.civ.bind(peer);
  let rejected = false;
  peer.civ = (frame, association) => {
    if (!rejected && frame[4] === 0x27 && frame[5] === 0x10 && frame[6] === 1) {
      rejected = true;
      peer.replyCiv([0xfa], association);
      return;
    }
    respond(frame, association);
  };
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server/index.js')], {
    env: serverEnvironment(peer), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '', exit, ws;
  child.stdout.on('data', (p) => { output += p; });
  child.stderr.on('data', (p) => { errors += p; });
  child.on('exit', (code) => { exit = code; });
  t.after(async () => {
    ws?.terminate();
    if (exit === undefined) child.kill('SIGTERM');
    try { await waitFor(() => exit !== undefined, 10000); }
    finally { if (exit === undefined) child.kill('SIGKILL'); await peer.close(); }
  });
  await waitFor(() => errors.includes('Radio rejected the enable-scope commands') || exit !== undefined, 20000);
  assert.equal(exit, undefined, errors);
  assert.equal(rejected, true);
  const port = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)?.[1];
  assert.ok(port, output);
  const snapshot = async () => {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let connected;
    ws.on('message', (p, binary) => {
      if (binary) return;
      const event = JSON.parse(p);
      if (event.type === 'connected') connected = event.data;
    });
    await waitFor(() => connected);
    return connected;
  };
  assert.equal((await snapshot()).scope.enabled, false);
  ws.terminate();
  const before = peer.commands.length;
  const association = peer.associations.civ;
  peer.release();
  await waitFor(() => peer.associations.civ !== association
    && peer.commands.slice(before).some((frame) => frame[4] === 0x27 && frame[5] === 0x14));
  await waitFor(() => output.includes('Scope output enabled after radio reconnect.'));
  assert.equal((await snapshot()).scope.enabled, true);
  assert.equal(exit, undefined, errors);
});
