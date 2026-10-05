'use strict';

// Plain-Node assertion tests, no test framework dependency.
// Run with: node test/frame.test.js

const assert = require('assert');
const {
  encodeFrame,
  FrameParser,
  freqToBCD,
  bcdToFreq,
} = require('../src/civ/frame');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test('freqToBCD encodes 14,195,000 Hz correctly', () => {
  const bytes = freqToBCD(14195000);
  assert.deepStrictEqual([...bytes], [0x00, 0x50, 0x19, 0x14, 0x00]);
});

test('bcdToFreq decodes 14,195,000 Hz correctly', () => {
  const hz = bcdToFreq(Buffer.from([0x00, 0x50, 0x19, 0x14, 0x00]));
  assert.strictEqual(hz, 14195000);
});

test('freqToBCD / bcdToFreq round-trip across a range of frequencies', () => {
  const samples = [1800000, 7074000, 14074000, 50313000, 144200000, 432100000];
  for (const hz of samples) {
    assert.strictEqual(bcdToFreq(freqToBCD(hz)), hz, `round-trip failed for ${hz}`);
  }
});

test('encodeFrame builds a well-formed frame with data', () => {
  const frame = encodeFrame({
    to: 0x94,
    from: 0xe0,
    cmd: 0x05,
    data: freqToBCD(14195000),
  });
  assert.deepStrictEqual(
    [...frame],
    [0xfe, 0xfe, 0x94, 0xe0, 0x05, 0x00, 0x50, 0x19, 0x14, 0x00, 0xfd]
  );
});

test('encodeFrame builds a well-formed frame with subCmd, no data', () => {
  const frame = encodeFrame({ to: 0x94, from: 0xe0, cmd: 0x15, subCmd: 0x02 });
  assert.deepStrictEqual([...frame], [0xfe, 0xfe, 0x94, 0xe0, 0x15, 0x02, 0xfd]);
});

test('FrameParser parses a single frame delivered in one chunk', () => {
  const parser = new FrameParser();
  const raw = Buffer.from([0xfe, 0xfe, 0xe0, 0x94, 0x03, 0x00, 0x50, 0x19, 0x14, 0x00, 0xfd]);
  const frames = parser.push(raw);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].to, 0xe0);
  assert.strictEqual(frames[0].from, 0x94);
  assert.strictEqual(frames[0].cmd, 0x03);
  assert.strictEqual(bcdToFreq(frames[0].payload), 14195000);
});

test('FrameParser parses a frame delivered across multiple chunks', () => {
  const parser = new FrameParser();
  const raw = Buffer.from([0xfe, 0xfe, 0xe0, 0x94, 0x03, 0x00, 0x50, 0x19, 0x14, 0x00, 0xfd]);
  let frames = [];
  for (let i = 0; i < raw.length; i++) {
    frames = frames.concat(parser.push(raw.subarray(i, i + 1)));
  }
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(bcdToFreq(frames[0].payload), 14195000);
});

test('FrameParser parses back-to-back frames in one chunk', () => {
  const parser = new FrameParser();
  const frame1 = encodeFrame({ to: 0xe0, from: 0x94, cmd: 0xfb }); // OK reply
  const frame2 = encodeFrame({ to: 0xe0, from: 0x94, cmd: 0x15, subCmd: 0x02, data: [0x01, 0x20] });
  const frames = parser.push(Buffer.concat([frame1, frame2]));
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].cmd, 0xfb);
  assert.strictEqual(frames[1].cmd, 0x15);
  assert.strictEqual(frames[1].subCmd, 0x02);
});

test('FrameParser discards noise bytes before a valid preamble', () => {
  const parser = new FrameParser();
  const noise = Buffer.from([0x01, 0x02, 0x03]);
  const frame = encodeFrame({ to: 0xe0, from: 0x94, cmd: 0xfb });
  const frames = parser.push(Buffer.concat([noise, frame]));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].cmd, 0xfb);
});

if (process.exitCode) {
  console.error('\nSome tests failed.');
} else {
  console.log('\nAll tests passed.');
}
