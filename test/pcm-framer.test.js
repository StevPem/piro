'use strict';

// Run with: node test/pcm-framer.test.js

const assert = require('assert');
const { PcmFramer } = require('../src/audio/pcm-framer');

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

test('emits no frame until enough bytes have accumulated', () => {
  const framer = new PcmFramer(10);
  const frames = [];
  framer.on('frame', (f) => frames.push(f));
  framer.push(Buffer.alloc(4));
  framer.push(Buffer.alloc(4));
  assert.strictEqual(frames.length, 0);
});

test('emits a frame as soon as exactly enough bytes arrive', () => {
  const framer = new PcmFramer(10);
  const frames = [];
  framer.on('frame', (f) => frames.push(f));
  framer.push(Buffer.alloc(10, 1));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].length, 10);
});

test('carries leftover bytes over to the next push', () => {
  const framer = new PcmFramer(10);
  const frames = [];
  framer.on('frame', (f) => frames.push(f));
  framer.push(Buffer.alloc(15, 1)); // 1 frame + 5 leftover bytes
  assert.strictEqual(frames.length, 1);
  framer.push(Buffer.alloc(5, 2)); // completes the second frame
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[1].length, 10);
});

test('emits multiple frames from one large push', () => {
  const framer = new PcmFramer(10);
  const frames = [];
  framer.on('frame', (f) => frames.push(f));
  framer.push(Buffer.alloc(35)); // 3 full frames + 5 leftover
  assert.strictEqual(frames.length, 3);
});

test('preserves byte content and ordering across a split frame', () => {
  const framer = new PcmFramer(4);
  const frames = [];
  framer.on('frame', (f) => frames.push(f));
  framer.push(Buffer.from([1, 2]));
  framer.push(Buffer.from([3, 4, 5, 6]));
  assert.strictEqual(frames.length, 1);
  assert.deepStrictEqual([...frames[0]], [1, 2, 3, 4]);
});

test('reset() discards any partial buffered frame', () => {
  const framer = new PcmFramer(10);
  const frames = [];
  framer.on('frame', (f) => frames.push(f));
  framer.push(Buffer.alloc(6));
  framer.reset();
  framer.push(Buffer.alloc(6));
  assert.strictEqual(frames.length, 0, 'the two 6-byte pushes should not combine into a frame after reset');
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
