'use strict';

// Synthetic radio receive audio at 48 kHz for tests: SSB receiver noise
// and a synthetic voice. Used by voice-squelch.test.js and
// audio-bridge.test.js.

const R = 48000;

// mulberry32: repeatable noise
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

function biquad(type, f) {
  const w = (2 * Math.PI * f) / R;
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const b = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + al;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = (b[0] * x + b[1] * x1 + b[2] * x2 + 2 * c * y1 - (1 - al) * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

function scaleTo(x, rms) {
  let s = 0;
  for (const v of x) s += v * v;
  const k = rms / Math.sqrt(s / x.length || 1);
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
}

/** SSB receiver noise: white noise through a 300-2700 Hz band. */
function bandNoise(sec, rms) {
  const n = Math.round(sec * R);
  const out = new Float32Array(n);
  const f = [biquad('hp', 300), biquad('hp', 300), biquad('lp', 2700), biquad('lp', 2700)];
  for (let i = 0; i < n; i++) {
    let v = gauss();
    for (const g of f) v = g(v);
    out[i] = v;
  }
  return scaleTo(out, rms);
}

/** A synthetic voice: 30 harmonics of a wandering pitch, formant-shaped, in syllables; `shift` Hz of SSB mistuning. */
function voice(sec, rms, { shift = 0, f0 = 130 } = {}) {
  const n = Math.round(sec * R);
  const out = new Float32Array(n);
  const formants = [
    [600, 120],
    [1200, 150],
    [2400, 200],
  ];
  const ph = new Float64Array(31);
  for (let i = 0; i < n; i++) {
    const t = i / R;
    const pitch = f0 * (1 + 0.15 * Math.sin(2 * Math.PI * 0.7 * t) + 0.05 * Math.sin(2 * Math.PI * 3.1 * t));
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t + Math.sin(2 * Math.PI * 0.9 * t)));
    let v = 0;
    for (let k = 1; k <= 30; k++) {
      const fk = k * pitch + shift;
      if (fk > 3000 || fk < 200) continue;
      ph[k] += (2 * Math.PI * fk) / R;
      let a = 0;
      for (const [fc, bw] of formants) a += 1 / (1 + ((fk - fc) / bw) ** 2);
      v += a * Math.sin(ph[k]);
    }
    out[i] = v * syllable;
  }
  return scaleTo(out, rms);
}

function toPcm(f) {
  const b = Buffer.alloc(f.length * 2);
  for (let i = 0; i < f.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767))), 2 * i);
  return b;
}

module.exports = { R, rng, rand, gauss, bandNoise, voice, toPcm, scaleTo };
