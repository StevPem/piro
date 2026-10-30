'use strict';

/**
 * JS8 transmit audio: 79 tones of continuous-phase 8-FSK, as JS8Call's
 * Modulator (JS8_Mode/Modulator.cpp, GPL-3.0) makes them, including its
 * short fade over the end of the last symbol.
 */

const { NN } = require('./js8-codec');

const NSPS_12K = 1920; // Normal speed: samples a symbol at 12 kHz
const TONE_SPACING_HZ = 12000 / NSPS_12K; // 6.25 Hz
const START_DELAY_MS = 500; // the signal starts 0.5 s after the slot boundary

/**
 * Float audio (peak `amplitude`) for `tones` with tone 0 at `f0` Hz.
 * `sampleRate` must make a whole number of samples per symbol.
 */
function synthesize(tones, f0, { sampleRate = 12000, amplitude = 0.5 } = {}) {
  const nsps = (NSPS_12K * sampleRate) / 12000;
  if (!Number.isInteger(nsps)) throw new Error(`JS8 needs a sample rate that is a multiple of 25 Hz (got ${sampleRate})`);
  const total = NN * nsps;
  const fadeFrom = Math.floor((NN - 0.017) * nsps);
  const out = new Float32Array(total);
  let phi = 0;
  let amp = amplitude;
  for (let i = 0; i < total; i++) {
    const sym = Math.floor(i / nsps);
    const dphi = (2 * Math.PI * (f0 + tones[sym] * TONE_SPACING_HZ)) / sampleRate;
    phi += dphi;
    if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
    if (i > fadeFrom) amp *= 0.98;
    out[i] = amp * Math.sin(phi);
  }
  return out;
}

module.exports = { synthesize, TONE_SPACING_HZ, START_DELAY_MS, NSPS_12K };
