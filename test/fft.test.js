// Run with: node test/fft.test.js
'use strict';

const { isPowerOfTwo, fftInPlace, hannWindow, computeMagnitudeSpectrum } = require('../src/audio/fft');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

function genTone(sampleRate, freqHz, n, amplitude = 1) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

// --- isPowerOfTwo ---

check(isPowerOfTwo(1), 'isPowerOfTwo(1) is true');
check(isPowerOfTwo(2), 'isPowerOfTwo(2) is true');
check(isPowerOfTwo(4096), 'isPowerOfTwo(4096) is true');
check(!isPowerOfTwo(0), 'isPowerOfTwo(0) is false');
check(!isPowerOfTwo(-4), 'isPowerOfTwo(-4) is false');
check(!isPowerOfTwo(100), 'isPowerOfTwo(100) is false');
check(!isPowerOfTwo(3), 'isPowerOfTwo(3) is false');

// --- fftInPlace ---

{
  let threw = false;
  try {
    fftInPlace(new Float64Array(100), new Float64Array(100));
  } catch {
    threw = true;
  }
  check(threw, 'fftInPlace throws on a non-power-of-two length');
}

{
  let threw = false;
  try {
    fftInPlace(new Float64Array(8), new Float64Array(4));
  } catch {
    threw = true;
  }
  check(threw, 'fftInPlace throws when re/im lengths differ');
}

{
  // A DC (constant) signal's entire energy should land in bin 0 after
  // the FFT — a basic sanity check independent of computeMagnitudeSpectrum's
  // own windowing.
  const n = 64;
  const re = new Float64Array(n).fill(1);
  const im = new Float64Array(n);
  fftInPlace(re, im);
  const mag0 = Math.sqrt(re[0] * re[0] + im[0] * im[0]);
  let otherEnergy = 0;
  for (let i = 1; i < n; i++) otherEnergy += Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  check(mag0 > 0.99 * n, `a DC input concentrates its energy in bin 0, got ${mag0.toFixed(2)} (expected ~${n})`);
  check(otherEnergy < 1e-6, `a DC input leaves negligible energy in every other bin, got total ${otherEnergy.toExponential(2)}`);
}

// --- hannWindow ---

{
  const w = hannWindow(1);
  check(w.length === 1 && w[0] === 1, 'hannWindow(1) is the single value 1 (no taper possible)');
}

{
  const w = hannWindow(65);
  check(Math.abs(w[0]) < 1e-9, 'hannWindow tapers to (near) zero at the first sample');
  check(Math.abs(w[w.length - 1]) < 1e-9, 'hannWindow tapers to (near) zero at the last sample');
  check(w[32] > 0.99, 'hannWindow peaks at (near) 1 in the middle');
}

// --- computeMagnitudeSpectrum ---

{
  let threw = false;
  try {
    computeMagnitudeSpectrum(new Float64Array(1000), { fftSize: 1000, sampleRate: 12000 });
  } catch {
    threw = true;
  }
  check(threw, 'computeMagnitudeSpectrum throws when fftSize is not a power of two');
}

{
  let threw = false;
  try {
    computeMagnitudeSpectrum(new Float64Array(4096), { fftSize: 4096, sampleRate: 0 });
  } catch {
    threw = true;
  }
  check(threw, 'computeMagnitudeSpectrum throws on a non-positive sampleRate');
}

{
  const sampleRate = 12000;
  const fftSize = 4096;
  const binHz = sampleRate / fftSize;
  // Pick a tone frequency that lands exactly on a bin center, so the
  // expected peak location is exact rather than spread by leakage.
  const targetBin = 100;
  const freqHz = targetBin * binHz;
  const samples = genTone(sampleRate, freqHz, fftSize, 0.8);

  const { magnitudes, binHz: outBinHz } = computeMagnitudeSpectrum(samples, { fftSize, sampleRate });
  check(Math.abs(outBinHz - binHz) < 1e-9, `computeMagnitudeSpectrum reports the correct bin width, got ${outBinHz}`);
  check(magnitudes.length === fftSize / 2, `computeMagnitudeSpectrum returns fftSize/2 bins, got ${magnitudes.length}`);

  let peakBin = 0;
  for (let i = 1; i < magnitudes.length; i++) {
    if (magnitudes[i] > magnitudes[peakBin]) peakBin = i;
  }
  check(
    Math.abs(peakBin - targetBin) <= 1,
    `a pure tone at a bin-center frequency produces a peak at (or adjacent to) the expected bin, got peak at ${peakBin}, expected ~${targetBin}`
  );

  const peakMag = magnitudes[peakBin];
  const avgOther =
    (magnitudes.reduce((a, b) => a + b, 0) - peakMag) / (magnitudes.length - 1);
  check(
    peakMag > avgOther * 10,
    `the tone's peak stands well above the average of the other bins, got peak ${peakMag.toFixed(2)} vs avg ${avgOther.toFixed(2)}`
  );
}

{
  // Fewer samples than fftSize: should zero-pad rather than throw, and
  // still produce a sensible (if smeared) result.
  const sampleRate = 12000;
  const fftSize = 1024;
  const shortSamples = genTone(sampleRate, 1000, 200, 0.8); // far fewer than fftSize
  let threw = false;
  let result;
  try {
    result = computeMagnitudeSpectrum(shortSamples, { fftSize, sampleRate });
  } catch {
    threw = true;
  }
  check(!threw, 'computeMagnitudeSpectrum does not throw when given fewer samples than fftSize (zero-pads instead)');
  check(result && result.magnitudes.length === fftSize / 2, 'a zero-padded call still returns the expected bin count');
}

{
  // A pure silence (all-zero) input should produce a flat, all-zero
  // spectrum, not NaN/garbage from the windowing or FFT math.
  const fftSize = 512;
  const { magnitudes } = computeMagnitudeSpectrum(new Float64Array(fftSize), { fftSize, sampleRate: 12000 });
  let allZero = true;
  for (const m of magnitudes) {
    if (!(m >= 0) || m > 1e-9) allZero = false;
  }
  check(allZero, 'silence (all-zero input) produces a near-zero spectrum with no NaN/garbage bins');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
