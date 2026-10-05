// Run with: node test/scope-display.test.mjs
//
// Tests the pure functions from src/client/scope.js directly in Node (no
// DOM needed for these) — amplitudeToColor() (waterfall color mapping),
// tuningMarkerX() (tuning-line pixel position), frequencyAtFraction() (its
// inverse, used for click-to-tune), and scopeDivisions() (the 50kHz-grid
// tick frequencies). The rest of ScopeDisplay (actual canvas drawing,
// click event wiring) needs a real browser; see docs/ui-notes.md's
// testing-boundary note.
//
// src/client/scope.js is plain ESM (served to browsers as-is via
// <script type="module">), but this project's package.json sets
// "type": "commonjs" for the Node side, so a .js import here would be
// parsed as CommonJS. Sidestepped by importing a temporary .mjs copy,
// which Node always treats as ESM regardless of package.json.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, '..', 'src', 'client', 'scope.js');
const tmpPath = path.join(os.tmpdir(), `scope-display-test-${process.pid}.mjs`);
fs.copyFileSync(sourcePath, tmpPath);

let amplitudeToColor;
let tuningMarkerX;
let frequencyAtFraction;
let scopeDivisions;
let snapToNearestKHz;
let snapTo50Hz;
let RTTY_SHIFT_HZ;
try {
  ({ amplitudeToColor, tuningMarkerX, frequencyAtFraction, scopeDivisions, snapToNearestKHz, snapTo50Hz, RTTY_SHIFT_HZ } =
    await import(`file://${tmpPath}`));
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

test('amplitude 0 maps to Turbo\'s dark end (near-black, slightly blue/purple by the colormap\'s own design)', () => {
  // Google's own published polynomial approximation of the Turbo colormap
  // (see scope.js's doc comment) evaluated at t=0 — not eyeballed, computed
  // directly from the published coefficients.
  const [r, g, b] = amplitudeToColor(0);
  assert.deepStrictEqual([r, g, b], [35, 23, 27]);
});

test('amplitude 255 maps to Turbo\'s hot end (dark red)', () => {
  const [r, g, b] = amplitudeToColor(255);
  assert.deepStrictEqual([r, g, b], [144, 13, 0]);
});

test('amplitude 126 (S9, matching the S-meter\'s confirmed threshold) is no longer a special-cased pin point under Turbo', () => {
  // Per explicit request, switching to Google's Turbo colormap dropped the
  // old palette's "pin to solid red at/above S9" behavior in favor of the
  // standard, textbook way a sequential colormap is normally applied: the
  // full 0-255 amplitude range maps linearly across Turbo's full [0,1]
  // domain, with no special threshold. S9 (126) is just an ordinary point
  // partway along that ramp now.
  const [r, g, b] = amplitudeToColor(126);
  assert.deepStrictEqual([r, g, b], [145, 251, 82]);
});

test('a signal well above S9 renders visibly further along the ramp than S9 itself, not the same pinned color', () => {
  const s9 = amplitudeToColor(126);
  for (const v of [150, 180, 200, 230, 255]) {
    assert.notDeepStrictEqual(amplitudeToColor(v), s9, `amplitude ${v} should render differently from S9 — no more pinning`);
  }
});

test('amplitudes progress through Turbo\'s blue/cyan/green/yellow/red stops as a continuous ramp', () => {
  const low = amplitudeToColor(30);
  const mid = amplitudeToColor(90);
  const nearPeak = amplitudeToColor(120);
  assert.notDeepStrictEqual(low, mid);
  assert.notDeepStrictEqual(mid, nearPeak);
  assert.notDeepStrictEqual(nearPeak, amplitudeToColor(126), 'raw 120 should render distinctly from raw 126, not identically');
});

test('amplitude is clamped for out-of-range input', () => {
  const low = amplitudeToColor(-50);
  const high = amplitudeToColor(500);
  assert.deepStrictEqual(low, amplitudeToColor(0));
  assert.deepStrictEqual(high, amplitudeToColor(255));
});

test('mid-range amplitude interpolates between stops, not a flat color', () => {
  const a = amplitudeToColor(60);
  const b = amplitudeToColor(70);
  assert.notDeepStrictEqual(a, b, 'nearby amplitudes should produce visibly different colors');
});

test('color channels always stay within 0-255', () => {
  for (let v = 0; v <= 255; v += 5) {
    const [r, g, b] = amplitudeToColor(v);
    for (const c of [r, g, b]) {
      assert.ok(c >= 0 && c <= 255, `channel out of range at amplitude ${v}: ${c}`);
    }
  }
});

test('tuningMarkerX places the marker proportionally within the range', () => {
  // Tuned to the midpoint of a 14.000-14.350 MHz range, 400px wide -> center.
  assert.strictEqual(tuningMarkerX(14175000, 14000000, 14350000, 400), 200);
});

test('tuningMarkerX at the low/high edges maps to 0/width', () => {
  assert.strictEqual(tuningMarkerX(14000000, 14000000, 14350000, 400), 0);
  assert.strictEqual(tuningMarkerX(14350000, 14000000, 14350000, 400), 400);
});

test('tuningMarkerX returns null when the tuned frequency is outside the displayed range', () => {
  assert.strictEqual(tuningMarkerX(13999999, 14000000, 14350000, 400), null);
  assert.strictEqual(tuningMarkerX(14350001, 14000000, 14350000, 400), null);
});

test('tuningMarkerX returns null when no frequency is set yet', () => {
  assert.strictEqual(tuningMarkerX(null, 14000000, 14350000, 400), null);
  assert.strictEqual(tuningMarkerX(undefined, 14000000, 14350000, 400), null);
});

test('tuningMarkerX returns null for a degenerate (zero or negative) range', () => {
  assert.strictEqual(tuningMarkerX(14000000, 14000000, 14000000, 400), null);
  assert.strictEqual(tuningMarkerX(14000000, 14350000, 14000000, 400), null);
});

test('tuningMarkerX returns null when lo/hi are missing (e.g. before the first scope line)', () => {
  assert.strictEqual(tuningMarkerX(14000000, null, 14350000, 400), null);
  assert.strictEqual(tuningMarkerX(14000000, 14000000, null, 400), null);
});

test('RTTY_SHIFT_HZ is the standard amateur 170Hz mark/space shift, matching rtty-decoder.js\'s own default markHz/spaceHz gap', () => {
  assert.strictEqual(RTTY_SHIFT_HZ, 170);
});

test('the RTTY trace canvas\'s offset marker (tuned frequency minus RTTY_SHIFT_HZ) places correctly via the same tuningMarkerX used for the tuned-frequency marker itself', () => {
  // Tuned to 14,175,170 Hz -> the shifted marker lands exactly on
  // 14,175,000 Hz, the range's midpoint in this 400px-wide example (see
  // the "places the marker proportionally" test above).
  assert.strictEqual(tuningMarkerX(14175170 - RTTY_SHIFT_HZ, 14000000, 14350000, 400), 200);
});

test('frequencyAtFraction is the inverse of tuningMarkerX: click at the center gives the midpoint frequency', () => {
  assert.strictEqual(frequencyAtFraction(0.5, 14000000, 14350000), 14175000);
});

test('frequencyAtFraction at fraction 0/1 gives the low/high edges', () => {
  assert.strictEqual(frequencyAtFraction(0, 14000000, 14350000), 14000000);
  assert.strictEqual(frequencyAtFraction(1, 14000000, 14350000), 14350000);
});

test('frequencyAtFraction clamps out-of-bounds fractions rather than extrapolating', () => {
  assert.strictEqual(frequencyAtFraction(-0.5, 14000000, 14350000), 14000000);
  assert.strictEqual(frequencyAtFraction(1.5, 14000000, 14350000), 14350000);
});

test('frequencyAtFraction returns null before any scope line has arrived (lo/hi unknown)', () => {
  assert.strictEqual(frequencyAtFraction(0.5, null, null), null);
  assert.strictEqual(frequencyAtFraction(0.5, 14000000, null), null);
});

test('frequencyAtFraction returns null for a degenerate range', () => {
  assert.strictEqual(frequencyAtFraction(0.5, 14000000, 14000000), null);
  assert.strictEqual(frequencyAtFraction(0.5, 14350000, 14000000), null);
});

test('frequencyAtFraction and tuningMarkerX round-trip: marker position -> click there -> same frequency', () => {
  const lo = 7000000;
  const hi = 7300000;
  const width = 640;
  const freq = 7175000;
  const x = tuningMarkerX(freq, lo, hi, width);
  const fraction = x / width;
  const recovered = frequencyAtFraction(fraction, lo, hi);
  assert.strictEqual(Math.round(recovered), freq);
});

test('scopeDivisions returns every 50kHz-aligned tick within a typical 250kHz range', () => {
  // 14.070-14.320 MHz (250kHz span centered on 14.195): 50kHz-aligned
  // points within that range are 14.100, 14.150, 14.200, 14.250, 14.300.
  const divisions = scopeDivisions(14070000, 14320000, 50000);
  assert.deepStrictEqual(divisions, [14100000, 14150000, 14200000, 14250000, 14300000]);
});

test('scopeDivisions ticks land on round multiples of the step, not offsets from lo', () => {
  const divisions = scopeDivisions(14070000, 14320000, 50000);
  for (const f of divisions) {
    assert.strictEqual(f % 50000, 0, `${f} is not a multiple of 50000`);
  }
});

test('scopeDivisions includes an edge exactly on lo or hi', () => {
  const divisions = scopeDivisions(14100000, 14300000, 50000);
  assert.strictEqual(divisions[0], 14100000);
  assert.strictEqual(divisions[divisions.length - 1], 14300000);
});

test('scopeDivisions returns an empty array before any range is known, or for a degenerate range', () => {
  assert.deepStrictEqual(scopeDivisions(null, null, 50000), []);
  assert.deepStrictEqual(scopeDivisions(14000000, 14000000, 50000), []);
  assert.deepStrictEqual(scopeDivisions(14350000, 14000000, 50000), []);
});

test('scopeDivisions respects a custom step size', () => {
  const divisions = scopeDivisions(14000000, 14100000, 25000);
  assert.deepStrictEqual(divisions, [14000000, 14025000, 14050000, 14075000, 14100000]);
});

test('snapToNearestKHz rounds down when closer to the lower kHz', () => {
  assert.strictEqual(snapToNearestKHz(7100499), 7100000);
});

test('snapToNearestKHz rounds up when closer to the higher kHz', () => {
  assert.strictEqual(snapToNearestKHz(7100500), 7101000);
});

test('snapToNearestKHz leaves an already-round frequency unchanged', () => {
  assert.strictEqual(snapToNearestKHz(7100000), 7100000);
});

test('snapToNearestKHz matches the example from the request: near 7.100 MHz snaps exactly to it', () => {
  assert.strictEqual(snapToNearestKHz(7100420), 7100000);
  assert.strictEqual(snapToNearestKHz(7099600), 7100000);
});

test('snapTo50Hz rounds down when closer to the lower 50Hz step', () => {
  assert.strictEqual(snapTo50Hz(1524), 1500);
});

test('snapTo50Hz rounds up when closer to the higher 50Hz step', () => {
  assert.strictEqual(snapTo50Hz(1526), 1550);
});

test('snapTo50Hz leaves an already-round frequency unchanged', () => {
  assert.strictEqual(snapTo50Hz(1500), 1500);
});

test('snapTo50Hz rounds an exact half-step up (matches Math.round\'s convention)', () => {
  assert.strictEqual(snapTo50Hz(1525), 1550);
});

test('snapTo50Hz handles 0Hz (the bottom of the FT8 audio passband)', () => {
  assert.strictEqual(snapTo50Hz(0), 0);
  assert.strictEqual(snapTo50Hz(24), 0);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
