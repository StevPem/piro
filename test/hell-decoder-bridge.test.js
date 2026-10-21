// Run with: node test/hell-decoder-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { HellDecoderBridge, encodeHellColumnsFrame } = require('../src/server/hell-decoder-bridge');
const { EVENT, BINARY_TYPE } = require('../src/server/protocol');
const { encodeFeldHell } = require('../src/audio/hell-tx');
const { upsampleFloatToPcm } = require('../src/audio/resample');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

class StubControlServer extends EventEmitter {
  constructor(state = {}) {
    super();
    this.state = { hellActive: false, hellToneHz: 1000, ...state };
    this.broadcasts = [];
    this.binary = [];
  }
  broadcastBinary(buf) {
    this.binary.push(buf);
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
}

function setup({ rate = 48000, state } = {}) {
  const controlServer = new StubControlServer(state);
  const capture = new EventEmitter();
  const bridge = new HellDecoderBridge({ controlServer, audioBridge: { capture, sampleRate: rate }, timers: false });
  bridge.start();
  return { controlServer, capture, bridge };
}

/** Decodes HELL_COLUMNS frames the way src/client/rpc.js does. */
function columnsOf(frames) {
  const cols = [];
  for (const f of frames) {
    if (f[0] !== BINARY_TYPE.HELL_COLUMNS) continue;
    const rows = f[1];
    for (let i = 0; i < f[2]; i++) cols.push({ toneHz: f.readUInt16LE(3), ink: f.subarray(5 + i * rows, 5 + (i + 1) * rows) });
  }
  return cols;
}

function feed(capture, pcm, chunkBytes = 1920) {
  for (let i = 0; i < pcm.length; i += chunkBytes) capture.emit('data', pcm.subarray(i, i + chunkBytes));
}

{
  const frame = encodeHellColumnsFrame([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)], 3, 1234);
  check(frame[0] === 0x04 && frame[1] === 3 && frame[2] === 2 && frame.readUInt16LE(3) === 1234 && frame.subarray(5).join() === '1,2,3,4,5,6', 'HELL_COLUMNS frame layout: tag, rows, count, tone, columns');
}
{
  const { controlServer, capture, bridge } = setup();
  check(!bridge.attached && capture.listenerCount('data') === 0, 'idle until Feld-Hell is selected');
  controlServer.emit('hell-active', { active: true, toneHz: 1200 });
  check(bridge.attached && capture.listenerCount('data') === 1 && bridge.toneHz === 1200, 'attaches to capture when Feld-Hell is armed, at the requested tone');

  const enc = encodeFeldHell('CQ DE VK3TR', { toneHz: 1200, amplitude: 0.3 });
  feed(capture, upsampleFloatToPcm(enc.samples, 8000, 48000));
  bridge._flushColumns();
  const cols = columnsOf(controlServer.binary);
  const expect = Math.floor(enc.durationSec * 17.5);
  check(Math.abs(cols.length - expect) <= 2 && cols.every((c) => c.ink.length === 20 && c.toneHz === 1200), `received columns go out as HELL_COLUMNS frames (${cols.length}, ~${expect} expected)`);
  const inked = cols.filter((c) => Math.max(...c.ink) > 200).length;
  check(inked > cols.length * 0.5, `the picture has ink (${inked} of ${cols.length} columns)`);

  controlServer.binary.length = 0;
  // a transmission ends in a blank space, so add half a second of steady tone
  feed(capture, upsampleFloatToPcm(Float32Array.from({ length: 4000 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 1200 * i) / 8000)), 8000, 48000));
  bridge._emitSpectrum();
  const spec = controlServer.binary[0];
  check(spec && spec[0] === BINARY_TYPE.FT8_SPECTRUM, 'the audio spectrum is broadcast while Feld-Hell is selected');
  const binHz = spec.readFloatLE(1);
  const bins = spec.subarray(5);
  // the display scaling saturates around a strong tone: take the middle of the top plateau
  const top = Math.max(...bins);
  const at = [...bins.keys()].filter((i) => bins[i] === top);
  const peak = (at[0] + at.at(-1)) / 2;
  check(Math.abs(peak * binHz - 1200) < 10, `spectrum peak near the tone (${(peak * binHz).toFixed(0)} Hz)`);

  controlServer.emit('hell-active', { active: true, toneHz: 1800 });
  check(bridge.attached && bridge.toneHz === 1800 && bridge._receiver.toneHz === 1800, 'retuning moves the receiver without restarting it');

  controlServer.emit('ptt', true);
  check(!bridge.attached && capture.listenerCount('data') === 0, 'detaches while transmitting');
  controlServer.emit('ptt', false);
  check(bridge.attached, 'reattaches after transmitting');

  controlServer.emit('hell-active', { active: false });
  check(!bridge.attached && capture.listenerCount('data') === 0, 'detaches when Feld-Hell is deselected');
  bridge.stop();
  check(controlServer.listenerCount('hell-active') === 0 && controlServer.listenerCount('ptt') === 0, 'stop() removes its listeners');
}
{
  const { bridge } = setup({ state: { hellActive: true, hellToneHz: 1500 } });
  check(bridge.attached && bridge.toneHz === 1500, 'start() picks up an already-armed state');
  bridge.stop();
}
{
  const { controlServer, bridge } = setup({ rate: 44100 });
  controlServer.emit('hell-active', { active: true });
  check(!bridge.attached && controlServer.broadcasts.some((b) => b.type === EVENT.AUDIO_ERROR && /multiple of 8000/.test(b.data.message)), 'an unsupported capture rate is reported, not attached');
  bridge.stop();
}

{
  // the picture is also read as text; the text so far goes to a page that opens later
  const { controlServer, capture, bridge } = setup();
  controlServer.emit('hell-active', { active: true, toneHz: 1000 });
  const enc = encodeFeldHell('CQ CQ DE VK3TR VK3TR K', { toneHz: 1000, amplitude: 0.3 });
  const quiet = new Float32Array(8000);
  feed(capture, upsampleFloatToPcm(Float32Array.from([...quiet, ...enc.samples, ...quiet, ...quiet, ...quiet]), 8000, 48000));
  bridge._flushColumns();
  const read = controlServer.broadcasts.filter((b) => b.type === EVENT.HELL_TEXT).map((b) => b.data.text).join('');
  // fldigi's ". . ." postamble is really sent (and read); the preamble's dots are too small to open the squelch
  check(read.trim() === 'CQ CQ DE VK3TR VK3TR K...', `the picture is read as text: ${JSON.stringify(read)}`);
  const sent = [];
  controlServer.sendJsonEvent = (ws, type, data) => sent.push({ ws, type, data });
  controlServer.emit('client-connected', 'late');
  check(sent[0]?.type === EVENT.HELL_TEXT && sent[0].data.replace === true && sent[0].data.text === bridge.backlog && /VK3TR K/.test(sent[0].data.text), 'a page that opens later is sent the text so far');
  // deselecting Feld-Hell reads out whatever is left
  controlServer.broadcasts.length = 0;
  feed(capture, upsampleFloatToPcm(Float32Array.from([...encodeFeldHell('TNX 73', { toneHz: 1000, amplitude: 0.3, preamble: false }).samples, ...new Float32Array(2000)]), 8000, 48000));
  controlServer.emit('hell-active', { active: false });
  const tail = controlServer.broadcasts.filter((b) => b.type === EVENT.HELL_TEXT).map((b) => b.data.text).join('');
  check(/TNX 73$/.test(tail), `leaving Feld-Hell reads out the rest at once: ${JSON.stringify(tail)}`);
  bridge.stop();
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall Feld-Hell bridge tests passed');
