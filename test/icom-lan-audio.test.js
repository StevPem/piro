'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PcmQueue, LanCapture, LanPlayback } = require('../src/icom-lan/audio');

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
  assert.equal(playback.stats.paddedBytes, 1918);
  const drain = playback.drain();
  playback.setKeyed(false);
  await drain;
  assert.equal(playback.waiters.size, 0);
  assert.equal(playback.queue.bytes, 0);
  assert.throws(() => { playback.setKeyed(true); playback.write(Buffer.alloc(3)); }, /aligned/);
  playback.stop();
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
