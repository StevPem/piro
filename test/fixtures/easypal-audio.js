'use strict';

/**
 * Helpers for the EasyPal (HamDRM) fixtures and tests: 8-bit mu-law storage
 * (12 kHz audio, made by third_party/qsstv-drm/make-fixtures.js) and some
 * radio trouble to add: noise, a mistuning, a gap.
 */

const fs = require('fs');
const path = require('path');
const { fftInPlace } = require('../../src/audio/fft');

const MU = 255;
const LN = Math.log(1 + MU);

/** Float32 audio (-1..1) to 8-bit mu-law (one byte per sample, 128 = 0). */
function encodeMuLaw(x) {
  const out = Buffer.alloc(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    const y = (Math.sign(v) * Math.log(1 + MU * Math.abs(v))) / LN;
    out[i] = Math.round(y * 127) + 128;
  }
  return out;
}

function decodeMuLaw(buf) {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const y = (buf[i] - 128) / 127;
    out[i] = (Math.sign(y) * (Math.exp(Math.abs(y) * LN) - 1)) / MU;
  }
  return out;
}

/** A fixture's audio (12 kHz) and what it should give. */
function loadFixture(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'easypal-fixtures.json'), 'utf8'))[name];
  const audio = decodeMuLaw(fs.readFileSync(path.join(__dirname, `easypal-${name}.ulaw`)));
  const file = fs.readFileSync(path.join(__dirname, meta.source));
  return { meta, audio, file };
}

/** A repeatable random number generator (0..1). */
function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Adds white noise for the given S/N in a 2.5 kHz bandwidth (12 kHz audio). */
function addNoise(x, snrDb, seed = 1) {
  const r = rng(seed);
  let p = 0;
  let n = 0;
  for (const v of x) {
    if (v !== 0) {
      p += v * v;
      n++;
    }
  }
  p /= n || 1;
  const sigma = Math.sqrt(((p / 10 ** (snrDb / 10)) * 6000) / 2500);
  const y = Float32Array.from(x);
  for (let i = 0; i < y.length; i++) {
    let u = 0;
    while (!u) u = r();
    y[i] += sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  }
  return y;
}

/** Moves the whole signal up by `hz` (an SSB mistuning). */
function shiftFrequency(x, hz, rate = 12000) {
  let n = 1;
  while (n < x.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  fftInPlace(re, im);
  for (let k = 1; k < n / 2; k++) {
    re[k] *= 2;
    im[k] *= 2;
  }
  for (let k = n / 2 + 1; k < n; k++) re[k] = im[k] = 0;
  for (let k = 0; k < n; k++) im[k] = -im[k];
  fftInPlace(re, im);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = (2 * Math.PI * hz * i) / rate;
    y[i] = (re[i] * Math.cos(a) + im[i] * Math.sin(a)) / n;
  }
  return y;
}

module.exports = { encodeMuLaw, decodeMuLaw, loadFixture, addNoise, shiftFrequency, rng };
