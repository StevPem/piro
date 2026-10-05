'use strict';

/**
 * Sample-rate conversion between this app's audio pipeline (48kHz,
 * S16_LE PCM, matching the radio's USB codec) and ft8ts's expected
 * 12kHz Float32 audio. Used by both directions of src/audio/ft8-bridge.js.
 *
 * Downsampling (RX, 48k -> 12k) needs a real anti-aliasing low-pass
 * filter before decimation, not just dropping samples: without it,
 * energy already present above the new 6kHz Nyquist limit (there's
 * plenty in real radio RX audio — hiss, adjacent-channel QRM, the
 * radio's own AGC/filter skirts) folds back down into the 0-6kHz band
 * FT8 actually lives in, contaminating exactly the audio the decoder
 * depends on. Upsampling (TX, 12k -> 48k) is filtered too, to remove the
 * spectral images linear interpolation alone would otherwise introduce
 * above the original 6kHz Nyquist — less critical than the RX direction
 * (that energy is out of FT8's own passband either way) but cheap
 * correctness to keep given the filter already exists for the other
 * direction, and it keeps the transmitted audio cleaner into the radio's
 * mic input.
 */

/**
 * Windowed-sinc low-pass FIR design (Hamming window) — a standard,
 * well-understood filter choice, not a novel one; kept simple and small
 * (odd tap count, symmetric) since this only ever runs on short
 * (~15 second) buffers a few times a minute, not a tight real-time loop.
 */
function designLowpassFir(cutoffHz, sampleRate, numTaps) {
  if (numTaps % 2 === 0) numTaps += 1; // symmetric FIR needs an odd tap count for a well-defined center tap
  const coeffs = new Float32Array(numTaps);
  const center = (numTaps - 1) / 2;
  const fc = cutoffHz / sampleRate; // normalized cutoff (cycles/sample)
  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const n = i - center;
    // sinc(2*fc*n), with the n===0 limit handled explicitly
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (numTaps - 1)); // Hamming
    const tap = sinc * window;
    coeffs[i] = tap;
    sum += tap;
  }
  // Normalize so the filter has unity gain at DC.
  for (let i = 0; i < numTaps; i++) coeffs[i] /= sum;
  return coeffs;
}

/**
 * Applies an FIR filter via direct convolution, returning a same-length
 * output (samples outside the input's bounds are treated as zero). Edge
 * samples are therefore slightly less accurate than the interior — an
 * accepted simplification, since in practice both call sites here filter
 * whole-slot buffers whose very start/end fall in FT8's own built-in
 * dead time (before/after the ~12.64s active transmission within each
 * 15s slot), not in audio content that matters.
 */
function applyFir(samples, coeffs) {
  const n = samples.length;
  const taps = coeffs.length;
  const half = (taps - 1) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const j = i + k - half;
      if (j >= 0 && j < n) acc += coeffs[k] * samples[j];
    }
    out[i] = acc;
  }
  return out;
}

/** Linear-interpolation resample to an arbitrary target length. Assumes the input has already been low-pass filtered if downsampling. */
function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(samples);
  const inLen = samples.length;
  const outLen = Math.round((inLen * toRate) / fromRate);
  const out = new Float32Array(outLen);
  const ratio = (inLen - 1) / Math.max(1, outLen - 1);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inLen - 1);
    const frac = srcPos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

const DEFAULT_FIR_TAPS = 63;

/**
 * RX path: raw S16_LE PCM (as captured from ALSA, `fromRate` — normally
 * 48000) -> low-pass filtered -> resampled -> Float32 in [-1, 1] at
 * `toRate` (normally 12000, ft8ts's expected rate).
 */
function downsamplePcmToFloat(int16Samples, fromRate, toRate) {
  const float = new Float32Array(int16Samples.length);
  for (let i = 0; i < int16Samples.length; i++) float[i] = int16Samples[i] / 32768;
  if (toRate >= fromRate) return resampleLinear(float, fromRate, toRate);
  const cutoffHz = toRate / 2 / 1.1; // a little inside the new Nyquist for a clean rolloff margin
  const filtered = applyFir(float, designLowpassFir(cutoffHz, fromRate, DEFAULT_FIR_TAPS));
  return resampleLinear(filtered, fromRate, toRate);
}

/**
 * TX path: Float32 samples in [-1, 1] at `fromRate` (normally 12000, an
 * ft8ts-encoded waveform) -> resampled -> low-pass filtered (removes
 * upsampling images) -> S16_LE PCM Buffer at `toRate` (normally 48000,
 * for AlsaPlayback).
 */
function upsampleFloatToPcm(floatSamples, fromRate, toRate) {
  const resampled = resampleLinear(floatSamples, fromRate, toRate);
  const filtered =
    toRate > fromRate
      ? applyFir(resampled, designLowpassFir(fromRate / 2 / 1.1, toRate, DEFAULT_FIR_TAPS))
      : resampled;
  const buf = Buffer.alloc(filtered.length * 2);
  for (let i = 0; i < filtered.length; i++) {
    const clamped = Math.max(-1, Math.min(1, filtered[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return buf;
}

module.exports = {
  designLowpassFir,
  applyFir,
  resampleLinear,
  downsamplePcmToFloat,
  upsampleFloatToPcm,
};
