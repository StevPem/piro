// Run with: node test/resample.test.js
'use strict';

const { designLowpassFir, applyFir, resampleLinear, downsamplePcmToFloat, upsampleFloatToPcm } = require('../src/audio/resample');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

function genToneInt16(sampleRate, freqHz, ms, amplitude = 20000) {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
  return out;
}

function genToneFloat(sampleRate, freqHz, ms, amplitude = 0.6) {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

// Goertzel magnitude — a small local copy rather than importing the CW
// decoder's, since this test file should stand alone; the algorithm
// itself is standard and already covered by its own tests elsewhere.
function goertzelMagnitude(samples, sampleRate, targetFreq) {
  const n = samples.length;
  if (n === 0) return 0;
  const k = Math.round((n * targetFreq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q0 = 0,
    q1 = 0,
    q2 = 0;
  for (let i = 0; i < n; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * cosine;
  const imag = q2 * Math.sin(omega);
  return Math.sqrt(real * real + imag * imag) / n;
}

// --- designLowpassFir / applyFir ---

{
  const coeffs = designLowpassFir(1000, 48000, 63);
  check(coeffs.length === 63, 'designLowpassFir returns the requested (odd) tap count');
  const sum = coeffs.reduce((a, b) => a + b, 0);
  check(Math.abs(sum - 1) < 1e-6, 'designLowpassFir normalizes to unity gain at DC');
}

{
  const coeffs = designLowpassFir(1000, 48000, 64); // even count requested
  check(coeffs.length === 65, 'designLowpassFir bumps an even tap count up to the next odd number');
}

{
  // A tone well below the cutoff should pass through with amplitude
  // close to 1; a tone well above it should be strongly attenuated.
  const coeffs = designLowpassFir(1000, 48000, 127);
  const lowTone = genToneFloat(48000, 300, 100);
  const highTone = genToneFloat(48000, 8000, 100);
  const lowOut = applyFir(lowTone, coeffs);
  const highOut = applyFir(highTone, coeffs);
  const lowMag = goertzelMagnitude(lowOut.slice(2000, 3000), 48000, 300);
  const highMag = goertzelMagnitude(highOut.slice(2000, 3000), 48000, 8000);
  const lowMagIn = goertzelMagnitude(lowTone.slice(2000, 3000), 48000, 300);
  check(lowMag > lowMagIn * 0.9, `a tone well below the cutoff passes through mostly unattenuated, got ratio ${(lowMag / lowMagIn).toFixed(2)}`);
  check(highMag < lowMagIn * 0.1, `a tone well above the cutoff is strongly attenuated, got magnitude ${highMag.toFixed(4)} vs passband ${lowMagIn.toFixed(4)}`);
}

// --- resampleLinear ---

{
  const samples = Float32Array.from([0, 1, 2, 3, 4]);
  const same = resampleLinear(samples, 100, 100);
  check(same.length === 5 && same[2] === 2, 'resampleLinear is a no-op when rates match');
}

{
  const upsampled = resampleLinear(Float32Array.from([0, 10]), 100, 400);
  check(upsampled.length === 8, `resampleLinear scales output length by the rate ratio, got ${upsampled.length}`);
  check(Math.abs(upsampled[0] - 0) < 1e-6 && Math.abs(upsampled[upsampled.length - 1] - 10) < 1e-6, 'resampleLinear preserves the first and last sample values');
}

// --- downsamplePcmToFloat / upsampleFloatToPcm: the actual RX/TX paths ---

{
  // A 1kHz tone at 48kHz, downsampled to 12kHz (well within the new
  // 6kHz Nyquist), should survive as a clean 1kHz tone.
  const tone48k = genToneInt16(48000, 1000, 200);
  const float12k = downsamplePcmToFloat(tone48k, 48000, 12000);
  check(float12k.length === Math.round((tone48k.length * 12000) / 48000), 'downsamplePcmToFloat produces the expected output length');
  const mag = goertzelMagnitude(float12k.slice(200, 1800), 12000, 1000);
  check(mag > 0.2, `a 1kHz tone well within the new Nyquist survives downsampling, got magnitude ${mag.toFixed(3)}`);
}

{
  // A real anti-aliasing regression: a tone ABOVE the new 6kHz Nyquist
  // (e.g. 9kHz) would, without a low-pass filter before decimation,
  // alias down into the audible/FT8-relevant band. Confirm it's instead
  // suppressed, not folded down to some other in-band frequency at
  // similar strength.
  const aliasCandidate = genToneInt16(48000, 9000, 200); // would alias to 3kHz at 12kHz w/o filtering
  const float12k = downsamplePcmToFloat(aliasCandidate, 48000, 12000);
  const aliasedMag = goertzelMagnitude(float12k.slice(200, 1800), 12000, 3000); // where naive aliasing would land it
  // Compare against a genuine in-band 3kHz tone processed the same way, as the scale reference.
  const genuine3k = downsamplePcmToFloat(genToneInt16(48000, 3000, 200), 48000, 12000);
  const genuineMag = goertzelMagnitude(genuine3k.slice(200, 1800), 12000, 3000);
  check(
    aliasedMag < genuineMag * 0.15,
    `a tone above the new Nyquist is suppressed by the anti-alias filter rather than aliasing in near full-strength, got ${aliasedMag.toFixed(3)} vs genuine ${genuineMag.toFixed(3)}`
  );
}

{
  // Round trip: upsample 12k -> 48k, then downsample back 48k -> 12k,
  // should recover a recognizable version of the original tone.
  const original = genToneFloat(12000, 1000, 200);
  const pcm48k = upsampleFloatToPcm(original, 12000, 48000);
  check(pcm48k.length === Math.round((original.length * 48000) / 12000) * 2, 'upsampleFloatToPcm produces the expected byte length (16-bit samples)');
  const sampleCount = pcm48k.length / 2;
  const int16 = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) int16[i] = pcm48k.readInt16LE(i * 2);
  const backTo12k = downsamplePcmToFloat(int16, 48000, 12000);
  const mag = goertzelMagnitude(backTo12k.slice(400, 1600), 12000, 1000);
  const origMag = goertzelMagnitude(original.slice(400, 1600), 12000, 1000);
  check(mag > origMag * 0.5, `a full 12k->48k->12k round trip preserves most of the original tone's strength, got ${mag.toFixed(3)} vs original ${origMag.toFixed(3)}`);
}

{
  // Clamping: a full-scale float input must not wrap around in the
  // Int16 conversion.
  const loud = Float32Array.from([1.5, -1.5, 0.9999, -0.9999]);
  const pcm = upsampleFloatToPcm(loud, 12000, 12000); // same rate: no resampling/filtering, isolates the clamp behavior
  check(pcm.readInt16LE(0) === 32767, 'upsampleFloatToPcm clamps an out-of-range positive sample to Int16 max rather than wrapping');
  check(pcm.readInt16LE(2) === -32768 || pcm.readInt16LE(2) === -32767, 'upsampleFloatToPcm clamps an out-of-range negative sample to Int16 min rather than wrapping');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
