'use strict';

// Run with: node test/scope.test.js

const assert = require('assert');
const { ScopeLineAssembler, decodeScopeChunk, bcdByteToInt } = require('../src/civ/scope');
const { freqToBCD } = require('../src/civ/frame');
const { SCOPE_MODE } = require('../src/civ/commands');

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

function centerHeaderChunk({ mainSub = 0x00, total = 3, centerFreq = 14195000, span = 25000 } = {}) {
  return Buffer.concat([
    Buffer.from([mainSub, 0x01, total, SCOPE_MODE.CENTER]),
    freqToBCD(centerFreq),
    freqToBCD(span),
  ]);
}

function fixedHeaderChunk({ mainSub = 0x00, total = 3, startFreq = 14000000, endFreq = 14350000, inRange = true } = {}) {
  return Buffer.concat([
    Buffer.from([mainSub, 0x01, total, SCOPE_MODE.FIXED]),
    freqToBCD(startFreq),
    freqToBCD(endFreq),
    Buffer.from([inRange ? 0x00 : 0x01]),
  ]);
}

function dataChunk({ mainSub = 0x00, seq, total = 3, samples }) {
  return Buffer.concat([Buffer.from([mainSub, seq, total]), Buffer.from(samples)]);
}

test('bcdByteToInt decodes single-byte BCD correctly', () => {
  assert.strictEqual(bcdByteToInt(0x01), 1);
  assert.strictEqual(bcdByteToInt(0x11), 11);
  assert.strictEqual(bcdByteToInt(0x09), 9);
});

test('decodeScopeChunk parses a center-mode header chunk', () => {
  const chunk = decodeScopeChunk(centerHeaderChunk());
  assert.strictEqual(chunk.seq, 1);
  assert.strictEqual(chunk.total, 3);
  assert.strictEqual(chunk.mode, SCOPE_MODE.CENTER);
  assert.strictEqual(chunk.freqInfo.centerFreq, 14195000);
  assert.strictEqual(chunk.freqInfo.span, 25000);
  assert.strictEqual(chunk.samples.length, 0, 'header chunk carries no sample bytes');
});

test('decodeScopeChunk parses a fixed-mode header chunk with in-range flag', () => {
  const chunk = decodeScopeChunk(fixedHeaderChunk({ inRange: false }));
  assert.strictEqual(chunk.freqInfo.startFreq, 14000000);
  assert.strictEqual(chunk.freqInfo.endFreq, 14350000);
  assert.strictEqual(chunk.freqInfo.inRange, false);
});

test('decodeScopeChunk parses a continuation (data) chunk', () => {
  const chunk = decodeScopeChunk(dataChunk({ seq: 2, samples: [10, 20, 30] }));
  assert.strictEqual(chunk.seq, 2);
  assert.deepStrictEqual([...chunk.samples], [10, 20, 30]);
});

test('decodeScopeChunk throws on a too-short buffer', () => {
  assert.throws(() => decodeScopeChunk(Buffer.from([0x00, 0x01])));
});

test('ScopeLineAssembler reassembles a full center-mode line across 3 chunks', () => {
  const assembler = new ScopeLineAssembler();
  let line = null;
  assembler.on('line', (l) => (line = l));

  assembler.push(centerHeaderChunk());
  assert.strictEqual(line, null, 'no line yet after just the header');
  assembler.push(dataChunk({ seq: 2, samples: [10, 20, 30, 40, 50] }));
  assert.strictEqual(line, null, 'no line yet after 2 of 3 chunks');
  assembler.push(dataChunk({ seq: 3, samples: [60, 70, 80, 90, 100] }));

  assert.ok(line, 'line emitted once all chunks arrived');
  assert.strictEqual(line.mode, SCOPE_MODE.CENTER);
  assert.strictEqual(line.centerFreq, 14195000);
  assert.strictEqual(line.span, 25000);
  assert.deepStrictEqual(
    [...line.points],
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    'points are the concatenated samples from all data chunks, in order'
  );
});

test('ScopeLineAssembler discards an in-progress line if a new header arrives first', () => {
  const assembler = new ScopeLineAssembler();
  const lines = [];
  assembler.on('line', (l) => lines.push(l));

  assembler.push(centerHeaderChunk({ centerFreq: 1000000 }));
  assembler.push(dataChunk({ seq: 2, samples: [1, 2, 3] }));
  // New line starts before the first one's 3rd chunk arrived — stale data discarded.
  assembler.push(centerHeaderChunk({ centerFreq: 2000000 }));
  assembler.push(dataChunk({ seq: 2, samples: [4, 5, 6] }));
  assembler.push(dataChunk({ seq: 3, samples: [7, 8, 9] }));

  assert.strictEqual(lines.length, 1, 'only the second (complete) line was ever emitted');
  assert.strictEqual(lines[0].centerFreq, 2000000);
  assert.deepStrictEqual([...lines[0].points], [4, 5, 6, 7, 8, 9]);
});

test('ScopeLineAssembler ignores continuation chunks with no matching header', () => {
  const assembler = new ScopeLineAssembler();
  let fired = false;
  assembler.on('line', () => (fired = true));

  assembler.push(dataChunk({ seq: 2, samples: [1, 2, 3] })); // no header seen yet
  assert.strictEqual(fired, false);
});

test('ScopeLineAssembler emits an error event (not a throw) on a malformed chunk', () => {
  const assembler = new ScopeLineAssembler();
  let errored = false;
  assembler.on('error', () => (errored = true));
  assembler.push(Buffer.from([0x00, 0x01])); // too short
  assert.strictEqual(errored, true);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
