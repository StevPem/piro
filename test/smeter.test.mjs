// Run with: node test/smeter.test.mjs
//
// Tests the pure functions from src/client/smeter.js directly in Node —
// same .mjs-copy workaround as test/scope-display.test.mjs, since this
// project's package.json sets "type": "commonjs" for the Node side.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, '..', 'src', 'client', 'smeter.js');
const tmpPath = path.join(os.tmpdir(), `smeter-test-${process.pid}.mjs`);
fs.copyFileSync(sourcePath, tmpPath);

let S_METER_LEVELS, sMeterLevelIndex, sMeterLabel;
try {
  ({ S_METER_LEVELS, sMeterLevelIndex, sMeterLabel } = await import(`file://${tmpPath}`));
} finally {
  fs.rmSync(tmpPath, { force: true });
}

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

// The exact source table this was built from (raw CI-V value range ->
// target S-meter reading), supplied by the user, power-curve-derived for
// individual S-values. `lo` here is each row's declared start; the
// source's S0 row read "0-10" and S1's read "10-19" (overlapping at 10)
// — since the bucket algorithm only needs each level's lower bound, S1's
// unambiguous start (10) is what actually determines where S0 ends, so
// that's what's tested here (S0 verified up to 9, not 10).
const TABLE = [
  { lo: 0, hiChecked: 9, label: 'S0' },
  { lo: 10, hiChecked: 19, label: 'S1' },
  { lo: 20, hiChecked: 29, label: 'S2' },
  { lo: 30, hiChecked: 43, label: 'S3' },
  { lo: 44, hiChecked: 56, label: 'S4' },
  { lo: 57, hiChecked: 74, label: 'S5' },
  { lo: 75, hiChecked: 89, label: 'S6' },
  { lo: 90, hiChecked: 110, label: 'S7' },
  { lo: 111, hiChecked: 125, label: 'S8' },
  { lo: 126, hiChecked: 140, label: 'S9' },
  { lo: 141, hiChecked: 165, label: 'S9 + 10dB' },
  { lo: 166, hiChecked: 190, label: 'S9 + 20dB' },
  { lo: 191, hiChecked: 210, label: 'S9 + 30dB' },
  { lo: 211, hiChecked: 230, label: 'S9 + 40dB' },
  { lo: 231, hiChecked: 245, label: 'S9 + 50dB' },
  { lo: 246, hiChecked: 255, label: 'S9 + 60dB' },
];

test('S_METER_LEVELS has exactly 16 entries matching the supplied table, in order', () => {
  assert.strictEqual(S_METER_LEVELS.length, TABLE.length);
  const labels = S_METER_LEVELS.map((l) => l.label);
  assert.deepStrictEqual(labels, TABLE.map((t) => t.label));
});

test('every bucket threshold equals its row\'s declared lower bound from the supplied table', () => {
  S_METER_LEVELS.forEach((level, i) => {
    assert.strictEqual(level.threshold, TABLE[i].lo, `bucket ${i} (${level.label})`);
  });
});

test('thresholds are strictly ascending and start at 0', () => {
  assert.strictEqual(S_METER_LEVELS[0].threshold, 0);
  for (let i = 1; i < S_METER_LEVELS.length; i++) {
    assert.ok(
      S_METER_LEVELS[i].threshold > S_METER_LEVELS[i - 1].threshold,
      `threshold at index ${i} is not strictly greater than the previous one`
    );
  }
});

test('every value across the full 0-255 range lands in the correct row (using each next row\'s start as the effective boundary)', () => {
  for (let raw = 0; raw <= 255; raw++) {
    // Effective upper bound = next row's lower bound minus 1 (or 255 for the last row).
    let row = TABLE[TABLE.length - 1];
    for (let i = 0; i < TABLE.length; i++) {
      const nextLo = i + 1 < TABLE.length ? TABLE[i + 1].lo : 256;
      if (raw >= TABLE[i].lo && raw < nextLo) {
        row = TABLE[i];
        break;
      }
    }
    assert.strictEqual(sMeterLabel(raw), row.label, `raw ${raw} should map to "${row.label}"`);
  }
});

test('individual S1-S9 buckets are now distinct (no longer a combined "S1-S3" range)', () => {
  assert.strictEqual(sMeterLabel(10), 'S1');
  assert.strictEqual(sMeterLabel(20), 'S2');
  assert.strictEqual(sMeterLabel(30), 'S3');
  assert.notStrictEqual(sMeterLabel(10), sMeterLabel(20));
  assert.notStrictEqual(sMeterLabel(20), sMeterLabel(30));
});

test('the low edge (declared start) and a value just below the next row\'s start map correctly', () => {
  for (let i = 0; i < TABLE.length; i++) {
    const row = TABLE[i];
    const nextLo = i + 1 < TABLE.length ? TABLE[i + 1].lo : 256;
    assert.strictEqual(sMeterLabel(row.lo), row.label, `declared start ${row.lo} (${row.label})`);
    assert.strictEqual(sMeterLabel(nextLo - 1), row.label, `value just below next row's start, ${nextLo - 1} (${row.label})`);
  }
});

test('the six "over S9" buckets (+10dB through +60dB) are flagged with over: true, the rest are not', () => {
  const overLabels = S_METER_LEVELS.filter((l) => l.over).map((l) => l.label);
  assert.deepStrictEqual(overLabels, [
    'S9 + 10dB', 'S9 + 20dB', 'S9 + 30dB', 'S9 + 40dB', 'S9 + 50dB', 'S9 + 60dB',
  ]);
});

test('out-of-range raw values are clamped rather than throwing or going out of bounds', () => {
  assert.strictEqual(sMeterLevelIndex(-50), 0);
  assert.strictEqual(sMeterLevelIndex(9999), S_METER_LEVELS.length - 1);
  assert.strictEqual(sMeterLabel(-50), 'S0');
  assert.strictEqual(sMeterLabel(9999), 'S9 + 60dB');
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
