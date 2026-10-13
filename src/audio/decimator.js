'use strict';

const { designLowpassFir } = require('./resample');

/**
 * Streaming sample-rate reducer for the JTTY receiver: S16LE (or Int16)
 * audio at an integer multiple of 12 kHz -> Float32 at 12 kHz, with an
 * anti-alias low-pass in front so energy above 6 kHz (hiss, adjacent
 * signals) cannot fold into the 0-3 kHz band the receiver searches.
 * Unlike resample.js's whole-buffer helpers it carries filter history
 * between calls, so audio can be fed in chunks of any size.
 */
class StreamDecimator {
  /**
   * @param {number} inputRate - must be a multiple of outputRate
   * @param {number} [outputRate=12000]
   * @param {object} [opts]
   * @param {number} [opts.cutoffHz=4500]
   * @param {number} [opts.taps=97]
   */
  constructor(inputRate, outputRate = 12000, { cutoffHz = 4500, taps = 97 } = {}) {
    if (!Number.isInteger(inputRate / outputRate) || inputRate < outputRate) {
      throw new Error(`StreamDecimator needs an input rate that is a whole multiple of ${outputRate} Hz, got ${inputRate}`);
    }
    this.factor = inputRate / outputRate;
    this.coeffs = this.factor === 1 ? null : designLowpassFir(Math.min(cutoffHz, outputRate * 0.375), inputRate, taps);
    this.history = new Float32Array(this.coeffs ? this.coeffs.length - 1 : 0);
    this.skip = 0; // input samples to drop before the next output
  }

  /**
   * @param {Int16Array|Float32Array} input
   * @returns {Float32Array} output samples at the output rate
   */
  process(input) {
    const x = input instanceof Float32Array ? input : Float32Array.from(input, (v) => v / 32768);
    if (!this.coeffs) return x.slice();
    const taps = this.coeffs.length;
    const buf = new Float32Array(this.history.length + x.length);
    buf.set(this.history);
    buf.set(x, this.history.length);
    const out = [];
    // output k is the filter evaluated at buf position (history.length + skip + k * factor)
    for (let pos = this.history.length + this.skip; pos < buf.length; pos += this.factor) {
      let acc = 0;
      for (let t = 0; t < taps; t++) acc += this.coeffs[t] * buf[pos - t];
      out.push(acc);
      this.skip = pos + this.factor - buf.length;
    }
    if (out.length === 0) this.skip = this.skip - x.length;
    this.history = buf.slice(buf.length - this.history.length);
    return Float32Array.from(out);
  }

  reset() {
    this.history = new Float32Array(this.history.length);
    this.skip = 0;
  }
}

module.exports = { StreamDecimator };
