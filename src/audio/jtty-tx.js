'use strict';

/**
 * JTTY transmit chain: 34-bit frames -> CRC-12 -> tail-biting K=10 rate-1/2
 * convolutional code -> 4-tone symbols (13 sync + 46 coded per frame) ->
 * Gaussian-filtered 4-FSK waveform.
 *
 * A port of lib/jtty/{tbcc.f90 (tbcc_encode, encode_crc12),
 * jtty_tbcc_code_profile.f90, genjtty.f90, gen_jttywave.f90} and
 * lib/gfsk_pulse.f90 from WSJT-X (GPL-3.0, (c) the WSJT
 * Development Group); see third_party/jtty/README.md. The text -> frames
 * half lives in jtty-codec.js.
 *
 * Modulation: non-slotted 4-GFSK, 12000/384 = 31.25 baud, tone spacing
 * equal to the baud rate (modulation index 1), Gaussian BT = 2.0. A frame
 * is 59 symbols = 1.888 s; messages are 1-16 frames, sent back to back
 * as one continuous-phase waveform with a short raised-cosine ramp at the
 * very start and end.
 */

const { packText } = require('./jtty-codec');

const JTTY_BASE_RATE = 12000; // reference sample rate
const JTTY_NSPS_BASE = 384; // samples per symbol at JTTY_BASE_RATE
const JTTY_BAUD = JTTY_BASE_RATE / JTTY_NSPS_BASE; // 31.25
const JTTY_BT = 2.0;
const SYNC_SYMBOLS = 13;
const CODED_SYMBOLS = 46;
const FRAME_SYMBOLS = SYNC_SYMBOLS + CODED_SYMBOLS; // 59
const PAYLOAD_BITS = 34;
const CRC_BITS = 12;
const TOTAL_K = PAYLOAD_BITS + CRC_BITS; // 46

// The 13-symbol 4-FSK sync sequence (peak ACF sidelobe 2/13).
const IS13 = Object.freeze([0, 2, 2, 3, 0, 0, 3, 2, 1, 3, 1, 2, 0]);

// TBCC profile 1167/1545 with outer CRC polynomial 0x80F (the only profile
// JTTY defines): memory 9, constraint length 10, generators octal 1167 and 1545.
const PROFILE = Object.freeze({
  memoryNu: 9,
  stateCount: 512,
  registerMask: 0x3ff,
  g0: parseInt('1167', 8),
  g1: parseInt('1545', 8),
  crcPoly: 0x80f,
  crcTopBit: 0x800,
  crcMask: 0xfff,
});

function parity(v) {
  let x = v;
  let p = 0;
  while (x > 0) {
    p ^= x & 1;
    x >>>= 1;
  }
  return p;
}

/** Appends the 12-bit CRC (poly 0x80F, MSB first) to a 34-element 0/1 payload; returns 46 info bits. */
function appendCrc12(payload) {
  const info = new Array(TOTAL_K);
  let crc = 0;
  for (let i = 0; i < PAYLOAD_BITS; i++) {
    info[i] = payload[i];
    crc ^= payload[i] << (CRC_BITS - 1);
    crc = crc & PROFILE.crcTopBit ? (crc << 1) ^ PROFILE.crcPoly : crc << 1;
    crc &= PROFILE.crcMask;
  }
  for (let i = 1; i <= CRC_BITS; i++) info[PAYLOAD_BITS + i - 1] = (crc >> (CRC_BITS - i)) & 1;
  return info;
}

/**
 * Encodes a 34-bit payload (array of 0/1, or a '0'/'1' string) into the 46
 * coded tone symbols (0-3) of one frame. Gray-coded mapping of the two
 * parity bits: 00/01/11/10 -> tone 0/1/2/3.
 */
function tbccEncode(payload) {
  const bits = typeof payload === 'string' ? Array.from(payload, (c) => c.charCodeAt(0) - 48) : payload;
  if (bits.length !== PAYLOAD_BITS) throw new Error(`JTTY payload must be ${PAYLOAD_BITS} bits`);
  const info = appendCrc12(bits);
  const nu = PROFILE.memoryNu;
  const tones = new Array(TOTAL_K);

  // Tail-biting start: preload the register with the frame's own last nu bits.
  let state = 0;
  for (let t = 0; t < nu; t++) {
    state = ((state << 1) | info[TOTAL_K - nu + t]) & (PROFILE.stateCount - 1);
  }
  for (let t = 0; t < TOTAL_K; t++) {
    const bit = info[t];
    const reg = ((state << 1) | bit) & PROFILE.registerMask;
    const b0 = parity(reg & PROFILE.g0);
    const b1 = parity(reg & PROFILE.g1);
    state = ((state << 1) | bit) & (PROFILE.stateCount - 1);
    tones[t] = b0 === 0 ? (b1 === 0 ? 0 : 1) : b1 === 1 ? 2 : 3;
  }
  return tones;
}

/** Frames ('0'/'1' strings) -> the full channel-symbol (tone) sequence, 59 per frame. */
function framesToTones(frames) {
  const tones = [];
  for (const frame of frames) {
    for (const t of IS13) tones.push(t);
    for (const t of tbccEncode(frame.slice(0, PAYLOAD_BITS))) tones.push(t);
  }
  return tones;
}

// ---------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------

/** erf() to double precision: power series for small |x|, continued fraction for the tail. */
function erf(x) {
  if (x < 0) return -erf(-x);
  if (x > 6) return 1;
  if (x < 2.5) {
    let term = x;
    let sum = x;
    const x2 = 2 * x * x;
    for (let n = 1; n < 200; n++) {
      term *= x2 / (2 * n + 1);
      sum += term;
      if (term < 1e-17 * sum) break;
    }
    return (2 / Math.sqrt(Math.PI)) * Math.exp(-x * x) * sum;
  }
  let t = x;
  for (let k = 80; k >= 1; k--) t = x + k / 2 / t;
  return 1 - Math.exp(-x * x) / (Math.sqrt(Math.PI) * t);
}

/** Gaussian frequency pulse, lib/gfsk_pulse.f90. */
function gfskPulse(b, t) {
  const c = Math.PI * Math.sqrt(2 / Math.log(2));
  return 0.5 * (erf(c * b * (t + 0.5)) - erf(c * b * (t - 0.5)));
}

/**
 * gen_jttywave(): Gaussian-filtered 4-FSK waveform for a tone sequence.
 *
 * @param {ArrayLike<number>} itone - symbols 0-3
 * @param {object} opts
 * @param {number} [opts.sampleRate=12000]
 * @param {number} [opts.nsps] - samples per symbol; defaults to 384 * sampleRate / 12000 (must be an integer)
 * @param {number} opts.f0 - frequency of the lowest tone (tone 0), Hz
 * @param {number} [opts.bt=2.0]
 * @param {boolean} [opts.complex=false] - return the analytic waveform {re, im} (used by the receiver to subtract decoded signals)
 * @returns {Float32Array|{re: Float32Array, im: Float32Array}} unit-amplitude waveform
 */
function genJttyWave(itone, { sampleRate = JTTY_BASE_RATE, nsps, f0, bt = JTTY_BT, complex = false } = {}) {
  const nsym = itone.length;
  const sps = nsps ?? (JTTY_NSPS_BASE * sampleRate) / JTTY_BASE_RATE;
  if (!Number.isInteger(sps) || sps < 8) throw new Error('JTTY needs an integer number of samples per symbol');
  if (nsym === 0) return complex ? { re: new Float32Array(0), im: new Float32Array(0) } : new Float32Array(0);
  const twopi = 2 * Math.PI;
  const nwave = nsym * sps;

  // Frequency-smoothing pulse, 3 symbols long.
  const pulse = new Float64Array(3 * sps);
  for (let i = 1; i <= 3 * sps; i++) pulse[i - 1] = gfskPulse(bt, (i - 1.5 * sps) / sps);

  // Smoothed frequency waveform; first and last symbols extended by dummy symbols.
  const dphi = new Float64Array((nsym + 2) * sps);
  const dphiPeak = twopi / sps; // modulation index 1
  for (let j = 0; j < nsym; j++) {
    const ib = j * sps;
    const v = dphiPeak * itone[j];
    if (v === 0) continue;
    for (let k = 0; k < 3 * sps; k++) dphi[ib + k] += v * pulse[k];
  }
  {
    const v = dphiPeak * itone[0];
    for (let k = 0; k < 2 * sps; k++) dphi[k] += v * pulse[sps + k];
    const w = dphiPeak * itone[nsym - 1];
    for (let k = 0; k < 2 * sps; k++) dphi[nsym * sps + k] += w * pulse[k];
  }

  const carrier = (twopi * f0) / sampleRate;
  const wave = new Float32Array(nwave);
  const waveIm = complex ? new Float32Array(nwave) : null;
  let phi = 0;
  for (let k = 0; k < nwave; k++) {
    if (complex) {
      wave[k] = Math.cos(phi);
      waveIm[k] = Math.sin(phi);
    } else {
      wave[k] = Math.sin(phi);
    }
    phi = (phi + dphi[sps + k] + carrier) % twopi;
  }

  // Raised-cosine envelope on the first and last nsps/8 samples.
  const nramp = Math.round(sps / 8);
  const k1 = nwave - nramp;
  for (let i = 0; i < nramp; i++) {
    const c = Math.cos((twopi * i) / (2 * nramp));
    wave[i] *= (1 - c) / 2;
    wave[k1 + i] *= (1 + c) / 2;
    if (complex) {
      waveIm[i] *= (1 - c) / 2;
      waveIm[k1 + i] *= (1 + c) / 2;
    }
  }
  return complex ? { re: wave, im: waveIm } : wave;
}

/**
 * Text -> JTTY transmit audio.
 *
 * @param {string} text - operator text (any case; normalized like the reference encoder)
 * @param {object} [opts]
 * @param {number} [opts.f0=1400] - audio frequency of the lowest tone, Hz; the signal occupies f0 .. f0 + 93.75 Hz
 * @param {number} [opts.sampleRate=12000] - output rate; any rate that is a whole multiple of 31.25 baud x 384/12000... i.e. 384*rate/12000 integer (12000, 24000, 48000, ...)
 * @param {number} [opts.amplitude=0.9]
 * @param {'unknown'|'field-day'|'rtty-roundup'} [opts.profile='unknown']
 * @returns {{message: string, nframes: number, tones: number[], samples: Float32Array, durationSec: number}}
 *   message is the canonical text actually sent; nframes === -1 means the text cannot be encoded, 0 means it was empty.
 */
function encodeJtty(text, { f0 = 1400, sampleRate = JTTY_BASE_RATE, amplitude = 0.9, profile } = {}) {
  const packed = packText(text, { profile });
  if (packed.nframes <= 0) {
    return { message: packed.message, nframes: packed.nframes, tones: [], samples: new Float32Array(0), durationSec: 0 };
  }
  const tones = framesToTones(packed.frames);
  const samples = genJttyWave(tones, { sampleRate, f0 });
  for (let i = 0; i < samples.length; i++) samples[i] *= amplitude;
  return {
    message: packed.message,
    nframes: packed.nframes,
    tones,
    samples,
    durationSec: tones.length / JTTY_BAUD,
  };
}

/** True if `sampleRate` gives a whole number of samples per JTTY symbol. */
function sampleRateSupported(sampleRate) {
  return Number.isInteger((JTTY_NSPS_BASE * sampleRate) / JTTY_BASE_RATE);
}

module.exports = {
  JTTY_BASE_RATE,
  JTTY_BAUD,
  JTTY_BT,
  FRAME_SYMBOLS,
  SYNC_SYMBOLS,
  CODED_SYMBOLS,
  PAYLOAD_BITS,
  TOTAL_K,
  IS13,
  PROFILE,
  appendCrc12,
  tbccEncode,
  framesToTones,
  erf,
  gfskPulse,
  genJttyWave,
  encodeJtty,
  sampleRateSupported,
};
