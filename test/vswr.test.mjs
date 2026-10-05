// Run with: node test/vswr.test.mjs
//
// Tests the pure functions from src/client/vswr.js directly in Node —
// same .mjs-copy workaround as test/smeter.test.mjs, since this
// project's package.json sets "type": "commonjs" for the Node side.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, '..', 'src', 'client', 'vswr.js');
const tmpPath = path.join(os.tmpdir(), `vswr-test-${process.pid}.mjs`);
fs.copyFileSync(sourcePath, tmpPath);

let rawToVswr, vswrZone;
try {
  ({ rawToVswr, vswrZone } = await import(`file://${tmpPath}`));
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

test('the four documented calibration points from Icom\'s official manual convert exactly', () => {
  assert.strictEqual(rawToVswr(0), 1.0);
  assert.strictEqual(rawToVswr(48), 1.5);
  assert.strictEqual(rawToVswr(80), 2.0);
  assert.strictEqual(rawToVswr(120), 3.0);
});

test('the undocumented ceiling (raw 255) converts to the specified max of 5.0', () => {
  assert.strictEqual(rawToVswr(255), 5.0);
});

test('values between calibration points are linearly interpolated, not rounded to the nearest known point', () => {
  // Midpoint of the 0(1.0) -> 48(1.5) segment.
  assert.strictEqual(rawToVswr(24), 1.25);
  // Midpoint of the 80(2.0) -> 120(3.0) segment.
  assert.strictEqual(rawToVswr(100), 2.5);
});

test('out-of-range raw values are clamped rather than extrapolating past the ends', () => {
  assert.strictEqual(rawToVswr(-50), 1.0);
  assert.strictEqual(rawToVswr(9999), 5.0);
});

test('interpolation is monotonically non-decreasing across the full 0-255 range', () => {
  let previous = rawToVswr(0);
  for (let raw = 1; raw <= 255; raw++) {
    const current = rawToVswr(raw);
    assert.ok(current >= previous, `VSWR decreased from ${previous} to ${current} at raw ${raw}`);
    previous = current;
  }
});

test('vswrZone: green is <= 1.5', () => {
  assert.strictEqual(vswrZone(1.0), 'green');
  assert.strictEqual(vswrZone(1.5), 'green');
});

test('vswrZone: orange is > 1.5 and <= 3', () => {
  assert.strictEqual(vswrZone(1.50001), 'orange');
  assert.strictEqual(vswrZone(2.0), 'orange');
  assert.strictEqual(vswrZone(3.0), 'orange');
});

test('vswrZone: red is > 3', () => {
  assert.strictEqual(vswrZone(3.00001), 'red');
  assert.strictEqual(vswrZone(5.0), 'red');
});

test('every raw value in 0-255 falls into exactly one zone, with no gaps at the boundaries', () => {
  for (let raw = 0; raw <= 255; raw++) {
    const zone = vswrZone(rawToVswr(raw));
    assert.ok(['green', 'orange', 'red'].includes(zone), `raw ${raw} produced an invalid zone: ${zone}`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
