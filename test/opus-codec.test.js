'use strict';

// Run with: node test/opus-codec.test.js
// Uses the real opusscript WASM codec (no hardware/mocking needed).

const assert = require('assert');
const { OpusCodec, computeFrame } = require('../src/audio/opus-codec');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    failures++;
  }
}

function sineFrame(samplesPerFrame, freq = 440, sampleRate = 48000, amplitude = 10000) {
  const buf = Buffer.alloc(samplesPerFrame * 2);
  for (let i = 0; i < samplesPerFrame; i++) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

function rms(buf) {
  let sumSq = 0;
  const n = buf.length / 2;
  for (let i = 0; i < n; i++) sumSq += buf.readInt16LE(i * 2) ** 2;
  return Math.sqrt(sumSq / n);
}

test('computeFrame derives correct sizes for 48kHz/mono/20ms', () => {
  const { samplesPerFrame, frameBytes } = computeFrame({ sampleRate: 48000, channels: 1, frameMs: 20 });
  assert.strictEqual(samplesPerFrame, 960);
  assert.strictEqual(frameBytes, 1920);
});

test('encode() rejects a frame of the wrong size', () => {
  const codec = new OpusCodec();
  assert.throws(() => codec.encode(Buffer.alloc(100)), /expects exactly 1920-byte/);
});

test('encode/decode round-trip preserves frame length and rough signal energy', () => {
  const codec = new OpusCodec();
  const original = sineFrame(codec.samplesPerFrame);
  const packet = codec.encode(original);
  assert.ok(packet.length > 0 && packet.length < original.length, 'opus packet should be compressed');

  const decoded = codec.decode(packet);
  assert.strictEqual(decoded.length, codec.frameBytes, 'decoded PCM must match the configured frame size');

  // Opus is lossy, so we don't expect bit-exact output, but a 440Hz tone's
  // energy should survive encoding at a very rough order of magnitude —
  // this mainly guards against the wiring being broken (e.g. silence out,
  // wrong sample rate/channel count causing garbage).
  const originalRms = rms(original);
  const decodedRms = rms(decoded);
  assert.ok(
    decodedRms > originalRms * 0.5 && decodedRms < originalRms * 1.5,
    `decoded RMS (${decodedRms.toFixed(0)}) should be roughly close to original (${originalRms.toFixed(0)})`
  );
});

test('works with a non-default sample rate/channel configuration', () => {
  const codec = new OpusCodec({ sampleRate: 16000, channels: 1, frameMs: 20 });
  assert.strictEqual(codec.samplesPerFrame, 320);
  assert.strictEqual(codec.frameBytes, 640);
  const original = sineFrame(codec.samplesPerFrame, 440, 16000);
  const packet = codec.encode(original);
  const decoded = codec.decode(packet);
  assert.strictEqual(decoded.length, codec.frameBytes);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
