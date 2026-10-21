'use strict';

/**
 * Feld-Hell receiver: 8 kHz audio -> columns of pixel brightness.
 *
 * After fldigi's src/feld/feld.cxx receive side (GPL-3; see
 * third_party/feldhell/README.md): the tone is mixed down to 0 Hz and
 * low-pass filtered, and its peak amplitude is sampled `rows` times per
 * column at 17.5 columns a second, scaled by a slowly decaying peak hold
 * (fldigi's display AGC). Each finished column is handed back as `rows`
 * ink values, 0 (no signal) to 255 (full signal), earliest first, which on
 * the page is bottom to top, since Feld-Hell scans each column upwards.
 * The operator reads the picture; hell-ocr.js also reads it as text.
 *
 * One difference from fldigi, for a Raspberry Pi: fldigi filters at 8 kHz
 * with an FFT filter after a Hilbert transform. Here the mixer output is
 * low-passed and decimated to 2 kHz in one FIR step (only every fourth
 * output is computed), which is far cheaper and gives the same picture:
 * the -2f image of the real-input mixer is far outside the filter.
 */

const { HELL_SAMPLE_RATE, COLUMN_RATE } = require('./hell-tx');

const DECIMATE = 4; // 8 kHz -> 2 kHz
const DEFAULT_ROWS = 20; // fldigi's HellRcvHeight default
const DEFAULT_CUTOFF_HZ = 150; // the keying's main lobe is +/-122.5 Hz
const FIR_TAPS = 161;
const MIN_TONE_HZ = 300;
const MAX_TONE_HZ = 2700;
const DEFAULT_TONE_HZ = 1000;

/** A receive/transmit tone inside the passband, to the nearest Hz. */
function clampHellTone(hz) {
  return Math.round(Math.max(MIN_TONE_HZ, Math.min(MAX_TONE_HZ, hz)));
}

function lowpass(cutoffHz, rate, taps) {
  const h = new Float64Array(taps);
  const c = (taps - 1) / 2;
  const fc = cutoffHz / rate;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - c;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)); // Blackman
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

class HellReceiver {
  /**
   * @param {object} [opts]
   * @param {number} [opts.toneHz=1000] - audio frequency of the signal
   * @param {number} [opts.rows=20] - pixels per column
   * @param {number} [opts.columnRate=17.5] - columns per second (Feld-Hell); a small trim corrects sloping text
   * @param {'slow'|'medium'|'fast'} [opts.agc='medium'] - fldigi's AGC settings (only the level metric uses it)
   */
  constructor({ toneHz = 1000, rows = DEFAULT_ROWS, columnRate = COLUMN_RATE, agc = 'medium' } = {}) {
    this.rows = rows;
    this.sampleRate = HELL_SAMPLE_RATE;
    this.setTone(toneHz);
    this.columnRate = columnRate;
    this.h = lowpass(DEFAULT_CUTOFF_HZ, HELL_SAMPLE_RATE, FIR_TAPS);
    this.bufRe = new Float64Array(FIR_TAPS);
    this.bufIm = new Float64Array(FIR_TAPS);
    this.bufPos = 0;
    this.phase = 0;
    this.decim = 0;
    this.rxcounter = 0;
    this.peakval = 0;
    this.peakhold = 0;
    this.col = new Uint8Array(rows);
    this.colPtr = 0;
    // signal level for a meter: fldigi's slow average of |z| with its AGC decay
    this.agcDecay = { slow: 0.01, medium: 0.075, fast: 0.2 }[agc] ?? 0.075;
    this.avg = 0;
    this.level = 0;
  }

  setTone(toneHz) {
    this.toneHz = Math.max(MIN_TONE_HZ, Math.min(MAX_TONE_HZ, toneHz));
    this.phaseInc = (2 * Math.PI * this.toneHz) / this.sampleRate;
  }

  /** Pixels per output sample at 2 kHz (fldigi's downsampleinc). */
  get _inc() {
    return (this.rows * this.columnRate) / (this.sampleRate / DECIMATE);
  }

  /**
   * @param {ArrayLike<number>} samples - 8 kHz audio
   * @returns {Uint8Array[]} finished columns, each `rows` values, earliest (bottom) first
   */
  process(samples) {
    const out = [];
    const h = this.h;
    const n = FIR_TAPS;
    const inc = this._inc;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      this.bufRe[this.bufPos] = x * Math.cos(this.phase);
      this.bufIm[this.bufPos] = -x * Math.sin(this.phase);
      this.phase += this.phaseInc;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      this.bufPos = (this.bufPos + 1) % n;
      if (++this.decim < DECIMATE) continue;
      this.decim = 0;
      let re = 0;
      let im = 0;
      for (let k = 0, p = this.bufPos; k < n; k++) {
        re += h[k] * this.bufRe[p];
        im += h[k] * this.bufIm[p];
        if (++p === n) p = 0;
      }
      const mag = 2 * Math.hypot(re, im); // x2: the mixer halves a real tone's amplitude
      if (mag > this.peakval) this.peakval = mag;
      this.avg += (mag - this.avg) * 0.01;
      this.rxcounter += inc;
      if (this.rxcounter < 1.0) continue;
      this.rxcounter -= 1.0;
      const v = this.peakval;
      this.peakval = 0;
      if (v > this.peakhold) this.peakhold = v;
      else this.peakhold *= 1.0 - 0.02 / this.rows;
      this.col[this.colPtr++] = this.peakhold > 0 ? Math.max(0, Math.min(255, Math.round((255 * v) / this.peakhold))) : 0;
      if (this.avg > this.level) this.level = this.avg;
      else this.level *= 1.0 - this.agcDecay / this.rows;
      if (this.colPtr >= this.rows) {
        out.push(this.col);
        this.col = new Uint8Array(this.rows);
        this.colPtr = 0;
      }
    }
    return out;
  }
}

module.exports = { HellReceiver, clampHellTone, DEFAULT_ROWS, DEFAULT_TONE_HZ, MIN_TONE_HZ, MAX_TONE_HZ };
