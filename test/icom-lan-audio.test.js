'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PcmQueue, LanCapture, LanPlayback } = require('../src/icom-lan/audio');

test('draining a modem tail finishes while its worker continues producing receive-time silence', async () => {
  const session = new EventEmitter();
  const output = [];
  Object.assign(session, { connected: true, options: { txBufferMs: 0 }, sendAudio: (p) => output.push(p) });
  const playback = new LanPlayback(session);
  playback.active = true;
  playback.setKeyed(true);
  const tail = Buffer.alloc(3840, 17);
  playback.write(tail);
  let ticks = 0;
  // VARA returns an output block for every RX input, even after PTT OFF.
  // Keep the queue nonempty deterministically instead of relying on timer races.
  playback.wait = async () => {
    assert.ok(++ticks <= 8, 'drain waited indefinitely for future modem silence');
    playback.pump();
    playback.write(Buffer.alloc(1920));
  };
  try {
    assert.equal(await playback.drain(), true);
    assert.deepEqual(Buffer.concat(output).subarray(0, tail.length), tail);
    assert.ok(playback.queue.bytes > 0, 'future silence does not have to finish before unkeying');
  } finally { playback.stop(); }
});

test('PCM queue crosses arbitrary chunk boundaries, pads once, and releases consumed buffers', () => {
  const q = new PcmQueue();
  q.push(Buffer.from([1, 2, 3]));
  q.push(Buffer.from([4, 5]));
  assert.deepEqual([...q.take(4)], [1, 2, 3, 4]);
  assert.deepEqual([...q.take(4, true)], [5, 0, 0, 0]);
  assert.equal(q.bytes, 0);
  assert.equal(q.chunks.length, 0);
});

test('RX jitter buffer has a hard cap, starts after prebuffering, and fills underflows with silence', () => {
  const session = new EventEmitter();
  const capture = new LanCapture(session, { jitterMs: 20, maxMs: 60 });
  capture.active = true;
  const output = [];
  capture.on('data', (p) => output.push(p));
  capture.pump();
  assert.equal(output.length, 0);
  session.emit('rx-audio', Buffer.alloc(1920 * 5, 7));
  assert.equal(capture.queue.bytes, 1920 * 3);
  assert.equal(capture.stats.droppedBytes, 3840);
  for (let n = 0; n < 4; n++) capture.pump();
  assert.deepEqual(output[0], Buffer.alloc(1920, 7));
  assert.deepEqual(output.at(-1), Buffer.alloc(1920));
  session.emit('disconnected');
  assert.equal(capture.primed, false);
  assert.equal(capture.queue.bytes, 0);
});

test('TX bounds voice latency, preserves finite waveforms, pads tails and stops drains on cancellation', async () => {
  const session = new EventEmitter();
  const output = [];
  Object.assign(session, { connected: true, options: { txBufferMs: 300 }, sendAudio: (p) => output.push(p) });
  const playback = new LanPlayback(session, { maxVoiceMs: 40, maxFiniteMs: 200 });
  playback.active = true;
  playback.setKeyed(true);
  for (let n = 0; n < 5; n++) playback.write(Buffer.alloc(1920, n));
  assert.equal(playback.queue.bytes, 3840);
  assert.equal(playback.stats.droppedBytes, 5760);
  playback.flush();
  const finite = Buffer.alloc(9600, 42);
  playback.write(finite);
  assert.equal(playback.queue.bytes, finite.length);
  assert.throws(() => playback.write(Buffer.alloc(19200)), /limit/);
  assert.equal(playback.queue.bytes, finite.length);
  for (let n = 0; n < 5; n++) playback.pump();
  assert.deepEqual(Buffer.concat(output), finite);
  playback.write(Buffer.from([0, 128]));
  playback.pump();
  assert.equal(playback.stats.paddedBytes, 0, 'partial input remains buffered until finalization');
  const drain = playback.drain();
  assert.equal(playback.stats.paddedBytes, 1918);
  playback.setKeyed(false);
  await drain;
  assert.equal(playback.waiters.size, 0);
  assert.equal(playback.queue.bytes, 0);
  assert.throws(() => { playback.setKeyed(true); playback.write(Buffer.alloc(3)); }, /aligned/);
  playback.stop();
});

test('RX catches up after coalesced callbacks without losing valid 48 kHz decoder samples', () => {
  let now = 0;
  const session = new EventEmitter();
  const capture = new LanCapture(session, { now: () => now });
  capture.active = true;
  const input = [], output = [];
  capture.on('data', (p) => output.push(p));
  // A continuous radio source, but JS callbacks only run every third frame.
  // There is enough buffer and CPU time to recover; samples must not vanish.
  for (let n = 1; n <= 100; n++) {
    now = n * 20;
    const pcm = Buffer.alloc(1920, n);
    input.push(pcm);
    session.emit('rx-audio', pcm);
    if (n % 3 === 0) capture.pumpDue();
  }
  now = 2040;
  capture.pumpDue();
  assert.deepEqual(Buffer.concat(output), Buffer.concat(input));
  assert.equal(capture.stats.droppedBytes, 0);
  assert.equal(capture.stats.silenceBytes, 0);
});

test('arbitrary native RADE chunks retain exact PCM duration and samples through LAN transmission', async () => {
  const { RadeBridge } = require('../src/server/rade-bridge');
  const session = new EventEmitter();
  const sent = [];
  Object.assign(session, { connected: true, options: { txBufferMs: 0 }, sendAudio: (p) => sent.push(Buffer.from(p)) });
  const playback = new LanPlayback(session);
  const expected = [];
  const iq = Buffer.alloc(80 * 8); // ten ms at the native 8 kHz modem rate.
  for (let i = 0; i < 80; i++) iq.writeFloatLE(Math.sin(i / 3) * 0.2, i * 8);
  const convert = (destination) => RadeBridge.prototype._handleModulatedAudio.call({
    _txGain: 1, audioBridge: { playback: destination, sampleRate: 48000 },
    _reportError: (_context, err) => { throw err; },
  }, iq);
  playback.start();
  playback.setKeyed(true);
  try {
    for (let n = 0; n < 30; n++) {
      convert({ write: (pcm) => expected.push(Buffer.from(pcm)) });
      convert(playback);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await playback.drain();
    assert.equal(Buffer.concat(expected).length, 28800);
    assert.deepEqual(Buffer.concat(sent), Buffer.concat(expected));
    assert.equal(playback.stats.paddedBytes, 0);
    playback.write(Buffer.from([0, 128]));
    await playback.drain();
    assert.equal(playback.stats.paddedBytes, 1918, 'only the explicitly finalized tail is padded');
    assert.deepEqual(Buffer.concat(sent).subarray(28800, 28802), Buffer.from([0, 128]));
  } finally { playback.stop(); }
});

test('audio arriving during asynchronous PTT preparation waits for confirmation and is flushed if cancelled', () => {
  const session = new EventEmitter();
  const sent = [];
  Object.assign(session, { connected: true, sendAudio: (p) => sent.push(p) });
  const playback = new LanPlayback(session);
  playback.active = true;
  playback.arm();
  playback.write(Buffer.alloc(1920, 11));
  playback.pump();
  assert.equal(sent.length, 0);
  playback.setKeyed(true);
  playback.pump();
  assert.deepEqual(Buffer.concat(sent), Buffer.alloc(1920, 11));
  playback.arm();
  playback.write(Buffer.alloc(1920, 12));
  playback.setKeyed(false);
  playback.setKeyed(true);
  playback.pump();
  assert.equal(sent.length, 2);
});
