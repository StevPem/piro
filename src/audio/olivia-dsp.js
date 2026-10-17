'use strict';

/**
 * Shared building blocks for the Olivia modem (olivia-tx.js, olivia-rx.js).
 *
 * A port of Pawel Jalocha's (SP9VRC) MFSK code as distributed with fldigi
 * (src/include/jalocha/pj_fht.h, pj_gray.h, pj_fft.h, pj_lowpass3.h and the
 * RateConverter class in pj_mfsk.h), GPL-3; see third_party/olivia/README.md.
 * The arithmetic is kept in the same order as the C++ so that test fixtures
 * made with the reference program match closely.
 */

const OLIVIA_SAMPLE_RATE = 8000; // the modem's internal rate, as fldigi
const CARRIER_SEPAR = 2; // FFT bins between neighbouring tones

// Olivia 8/250's tones span +/-110 Hz around the centre; keep them well
// inside the 3 kHz the modem's 1:1 rate converter passes.
const OLIVIA_MIN_CENTRE_HZ = 400;
const OLIVIA_MAX_CENTRE_HZ = 2600;
const OLIVIA_DEFAULT_CENTRE_HZ = 1500;

/** Rounds an audio centre frequency to whole Hz within the usable range (non-numbers give the default). */
function clampOliviaCentre(hz) {
  const n = Number(hz);
  if (!Number.isFinite(n)) return OLIVIA_DEFAULT_CENTRE_HZ;
  return Math.max(OLIVIA_MIN_CENTRE_HZ, Math.min(OLIVIA_MAX_CENTRE_HZ, Math.round(n)));
}

function log2(x) {
  let y = 0;
  for (let v = x >>> 0; v > 1; v >>>= 1) y++;
  return y;
}

/**
 * Derived parameters for one Olivia variant ("tones/bandwidth") at a given
 * audio centre frequency, computed exactly as fldigi does (olivia.cxx and
 * MFSK_Transmitter/MFSK_Receiver::Preset in pj_mfsk.h).
 *
 * @param {object} opts
 * @param {number} [opts.tones=8]
 * @param {number} [opts.bandwidth=250]
 * @param {number} [opts.centreHz=1500] - audio centre of the signal
 * @param {boolean} [opts.intOffset=false] - fldigi's receiver truncates the
 *   centre-to-first-tone offset to an integer, its transmitter does not
 */
function oliviaParams({ tones = 8, bandwidth = 250, centreHz = 1500, intOffset = false } = {}) {
  let t = Math.max(2, Math.min(256, tones));
  let bw = Math.max(125, Math.min(2000, bandwidth));
  const bitsPerSymbol = log2(t);
  t = 1 << bitsPerSymbol;
  const bwShift = log2(Math.floor(bw / 125));
  const symbolLen = 1 << (bitsPerSymbol + 7 - bwShift);
  bw = (1 << bwShift) * 125;
  let fcOffset = (bw * (1.0 - 0.5 / t)) / 2.0;
  if (intOffset) fcOffset = Math.trunc(fcOffset);
  // FirstCarrierMultiplier is a C float; the product is float arithmetic too
  const fcm = Math.fround((centreHz - fcOffset) / 500.0);
  const firstCarrier = Math.floor(Math.fround((symbolLen / 16) * fcm)) + 1;
  const binHz = OLIVIA_SAMPLE_RATE / symbolLen;
  const symbolSepar = symbolLen / 2;
  const symbolsPerBlock = 64; // 2^(7 bits per character - 1)
  return {
    tones: t,
    bandwidth: bw,
    bitsPerSymbol,
    symbolLen,
    symbolSepar,
    firstCarrier,
    binHz,
    baud: OLIVIA_SAMPLE_RATE / symbolSepar,
    symbolsPerBlock,
    blockSec: (symbolsPerBlock * symbolSepar) / OLIVIA_SAMPLE_RATE,
    charsPerSec: (bitsPerSymbol * OLIVIA_SAMPLE_RATE) / (symbolsPerBlock * symbolSepar),
    // actual audio frequencies of the lowest and highest tones, and their middle
    lowToneHz: firstCarrier * binHz,
    highToneHz: (firstCarrier + CARRIER_SEPAR * (t - 1)) * binHz,
    centreActualHz: (firstCarrier + (CARRIER_SEPAR * (t - 1)) / 2) * binHz,
  };
}

function grayCode(binary) {
  return (binary ^ (binary >> 1)) & 0xff;
}

function binaryCode(gray) {
  let g = gray & 0xff;
  g ^= g >> 4;
  g ^= g >> 2;
  g ^= g >> 1;
  return g;
}

/** Forward fast Hadamard transform, in place (pj_fht.h FHT). */
function fht(data, len) {
  for (let step = 1; step < len; step *= 2) {
    for (let ptr = 0; ptr < len; ptr += 2 * step) {
      for (let p2 = ptr; p2 - ptr < step; p2++) {
        const b1 = data[p2];
        const b2 = data[p2 + step];
        data[p2] = b2 + b1;
        data[p2 + step] = b2 - b1;
      }
    }
  }
}

/** Inverse fast Hadamard transform, in place (pj_fht.h IFHT). */
function ifht(data, len) {
  for (let step = len / 2; step; step = Math.floor(step / 2)) {
    for (let ptr = 0; ptr < len; ptr += 2 * step) {
      for (let p2 = ptr; p2 - ptr < step; p2++) {
        const b1 = data[p2];
        const b2 = data[p2 + step];
        data[p2] = b1 - b2;
        data[p2 + step] = b1 + b2;
      }
    }
  }
}

/**
 * Radix-2 complex FFT (pj_fft.h r2FFT), on separate real/imaginary arrays.
 * process() is a forward transform without scaling; separTwoReals() and
 * joinTwoReals() are the two-real-signals-in-one-FFT helpers.
 */
class R2FFT {
  constructor(size) {
    if (size < 4 || (size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two, >= 4');
    this.size = size;
    this.twRe = new Float64Array(size);
    this.twIm = new Float64Array(size);
    const size4 = size / 4;
    let idx;
    for (idx = 0; idx < size4; idx++) {
      const phase = (2 * Math.PI * idx) / size;
      this.twRe[idx] = Math.cos(phase);
      this.twIm[idx] = Math.sin(phase);
    }
    for (; idx < size; idx++) {
      this.twRe[idx] = -this.twIm[idx - size4];
      this.twIm[idx] = this.twRe[idx - size4];
    }
    this.bitRev = new Uint32Array(size);
    for (idx = 0; idx < size; idx++) {
      let ridx = 0;
      for (let mask = size / 2, rmask = 1; mask; mask >>>= 1, rmask <<= 1) if (idx & mask) ridx |= rmask;
      this.bitRev[idx] = ridx;
    }
  }

  process(re, im) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const r = this.bitRev[i];
      if (r > i) {
        let t = re[i];
        re[i] = re[r];
        re[r] = t;
        t = im[i];
        im[i] = im[r];
        im[r] = t;
      }
    }
    for (let bf = 0; bf < n; bf += 2) {
      const r1 = re[bf + 1];
      const i1 = im[bf + 1];
      re[bf + 1] = re[bf] - r1;
      im[bf + 1] = im[bf] - i1;
      re[bf] += r1;
      im[bf] += i1;
    }
    const size2 = n / 2;
    for (let groups = size2 / 2, gs2 = 2; groups; groups >>>= 1, gs2 <<= 1) {
      for (let group = 0, bf = 0; group < groups; group++, bf += gs2) {
        for (let tw = 0; tw < size2; tw += groups, bf++) {
          const wr = this.twRe[tw];
          const wi = this.twIm[tw];
          const j = bf + gs2;
          const xr = re[j] * wr + im[j] * wi;
          const xi = -re[j] * wi + im[j] * wr;
          re[j] = re[bf] - xr;
          im[j] = im[bf] - xi;
          re[bf] = re[bf] + xr;
          im[bf] = im[bf] + xi;
        }
      }
    }
  }

  /** Splits the FFT of (x0 + j*x1) into the spectra of x0 and x1 (half-size each). */
  separTwoReals(re, im, o0r, o0i, o1r, o1i) {
    const n = this.size;
    const half = n / 2;
    o0r[0] = re[0];
    o1r[0] = im[0];
    for (let i = 1; i < half; i++) {
      o0r[i] = re[i] + re[n - i];
      o0i[i] = im[i] - im[n - i];
      o1r[i] = im[i] + im[n - i];
      o1i[i] = -re[i] + re[n - i];
    }
    o0i[0] = re[half];
    o1i[0] = im[half];
  }

  /** The opposite of separTwoReals(), set up so a following process() is an inverse FFT. */
  joinTwoReals(i0r, i0i, i1r, i1i, re, im) {
    const n = this.size;
    const half = n / 2;
    re[0] = 2 * i0r[0];
    im[0] = 2 * i1r[0];
    for (let i = 1; i < half; i++) {
      re[i] = i0r[i] + i1i[i];
      im[i] = -i0i[i] + i1r[i];
      re[n - i] = i0r[i] - i1i[i];
      im[n - i] = i0i[i] + i1r[i];
    }
    re[half] = 2 * i0i[0];
    im[half] = 2 * i1i[0];
  }
}

/**
 * Sample-rate converter (pj_mfsk.h RateConverter): a Blackman-Harris
 * windowed-sinc low-pass, oversampled 16x, with linear interpolation between
 * phases. fldigi runs the modem at 8 kHz in and out, so the rate here is 1:
 * it acts as a 3 kHz low-pass with an 8-sample delay. Kept so the audio
 * matches the reference transmitter and receiver.
 */
class RateConverter {
  constructor({ tapLen = 16, overSampling = 16, upperFreq = 3.0 / 8, outputRate = 1.0 } = {}) {
    this.tapLen = 1 << log2(tapLen);
    this.overSampling = overSampling;
    this.upperFreq = upperFreq;
    this.outputRate = outputRate;
    this.filterLen = this.tapLen * overSampling;
    this.shape = new Float64Array(this.filterLen);
    for (let idx = 0; idx < this.filterLen; idx++) {
      let phase = (Math.PI * (2 * idx - this.filterLen)) / this.filterLen;
      const win = 0.35875 + 0.48829 * Math.cos(phase) + 0.14128 * Math.cos(2 * phase) + 0.01168 * Math.cos(3 * phase);
      let filter = 1.0;
      if (phase !== 0) {
        phase *= this.upperFreq * this.tapLen;
        filter = Math.sin(phase) / phase;
      }
      this.shape[idx] = win * filter;
    }
    this.reset();
  }

  reset() {
    this.wrap = this.tapLen - 1;
    this.tap = new Float64Array(this.tapLen);
    this.tapPtr = 0;
    this.outTime = 0;
    this.outPeriod = this.overSampling / this.outputRate;
    this.outBefore = 0;
    this.outAfter = 0;
    this.outPtr = 0;
  }

  _convolute(shift) {
    let sum = 0;
    let s = this.overSampling - 1 - shift;
    let idx = this.tapPtr;
    for (; s < this.filterLen; s += this.overSampling) {
      sum += this.tap[idx] * this.shape[s];
      idx = (idx + 1) & this.wrap;
    }
    return sum;
  }

  _newInput(v) {
    this.tap[this.tapPtr] = v;
    this.tapPtr = (this.tapPtr + 1) & this.wrap;
  }

  /** @param {ArrayLike<number>} input  @returns {number[]} output samples */
  process(input) {
    const out = [];
    let i = 0;
    const n = input.length;
    for (;;) {
      if (this.outPtr) {
        let idx = Math.floor(this.outTime) + 1;
        if (idx >= this.overSampling) {
          if (i >= n) break;
          this._newInput(input[i++]);
          idx -= this.overSampling;
          this.outTime -= this.overSampling;
        }
        this.outAfter = this._convolute(idx);
        const weight = idx - this.outTime;
        out.push(weight * this.outBefore + (1.0 - weight) * this.outAfter);
        this.outPtr = 0;
      } else {
        let idx = Math.floor(this.outTime + this.outPeriod);
        if (idx >= this.overSampling) {
          if (i >= n) break;
          this._newInput(input[i++]);
          idx -= this.overSampling;
          this.outTime -= this.overSampling;
        }
        this.outBefore = this._convolute(idx);
        this.outTime += this.outPeriod;
        this.outPtr = 1;
      }
    }
    return out;
  }
}

/**
 * pj_lowpass3.h LowPass3_Filter, stored as three numbers at a base offset
 * in a Float64Array so the receiver can keep thousands of them compactly.
 */
function lowPass3(arr, base, inp, weight, feedback = 0.1) {
  const w = weight * 2.0;
  let out1 = arr[base];
  let out2 = arr[base + 1];
  let output = arr[base + 2];
  const dI1 = (inp - out1) * w;
  const d12 = (out1 - out2) * w;
  const d23 = (out2 - output) * w;
  out1 += dI1;
  out2 += d12;
  output += d23;
  out2 += d23 * feedback;
  arr[base] = out1;
  arr[base + 1] = out2;
  arr[base + 2] = output;
}

module.exports = {
  OLIVIA_SAMPLE_RATE,
  OLIVIA_MIN_CENTRE_HZ,
  OLIVIA_MAX_CENTRE_HZ,
  OLIVIA_DEFAULT_CENTRE_HZ,
  clampOliviaCentre,
  CARRIER_SEPAR,
  log2,
  oliviaParams,
  grayCode,
  binaryCode,
  fht,
  ifht,
  R2FFT,
  RateConverter,
  lowPass3,
};
