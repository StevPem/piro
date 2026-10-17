'use strict';

/**
 * Olivia receiver: 8 kHz audio -> decoded characters, as fldigi does it.
 *
 * A port of MFSK_InputProcessor, MFSK_Demodulator, MFSK_SoftDecoder and
 * MFSK_Receiver from Pawel Jalocha's MFSK code in fldigi
 * (src/include/jalocha/pj_mfsk.h), GPL-3; see third_party/olivia/README.md.
 *
 * Signal path:
 *   1. RateConverter at 1:1 (a 3 kHz low-pass), as fldigi runs it;
 *   2. input processor: 8192-sample overlapped FFT windows that flatten the
 *      spectrum and clip strong narrow carriers and impulses, so a
 *      whistle or a crash does not swamp the decoder;
 *   3. demodulator: a 512-point FFT every half symbol (two "slices" per
 *      symbol), keeping the tone energies over the search width;
 *   4. for every slice and every frequency offset within +/- syncMargin FFT
 *      bins (+/-125 Hz for 8/250), a soft decoder that undoes the Walsh /
 *      scrambling code over the last 64 symbols; its peak gives a character
 *      and a signal/noise measure;
 *   5. the synchroniser integrates signal and noise for each of the
 *      128 block phases x 17 offsets over syncIntegLen blocks, picks the best
 *      and, once per block, outputs that block's characters when its S/N is
 *      at least syncThreshold.
 *
 * One addition over fldigi (opts.blockSnrMin, on by default): a block is
 * only output if its own decoder S/N, before integration, is also at least
 * blockSnrMin. The integrated figure lags by a few blocks, so without this
 * fldigi prints a handful of junk characters just before and after every
 * transmission (decoded from the start/stop tones and the noise), and on
 * plain noise about one a second. In tests real blocks measured 7 or more
 * even at -13 dB S/N, while junk blocks never exceeded 3.1. With the default
 * 4.5 there were no false characters in 1000 s of noise and text still
 * copied fully at -14 dB (2.5 kHz bandwidth), as with fldigi.
 * blockSnrMin = 0 restores fldigi's behaviour exactly.
 *
 * A second addition (opts.dropControlBlocks, also on by default): a block
 * holding a control code that text never contains (see hasStrayControl())
 * is dropped. That catches most of the junk a neighbouring Olivia signal
 * produces when its tones only partly overlap the search window, which
 * otherwise passes both S/N checks; in tests it cut such junk from ~26
 * characters a transmission to ~3, with no loss of weak-signal copy.
 */

const { OLIVIA_SAMPLE_RATE, CARRIER_SEPAR, oliviaParams, binaryCode, fht, R2FFT, RateConverter, lowPass3 } = require('./olivia-dsp');

const SCRAMBLING_CODE = 0xe257e6d0291574ecn;
const SCRAMBLE_SHIFT = 13;
const SLICES_PER_SYMBOL = 2;
const SYMBOLS_PER_BLOCK = 64;

// fldigi's defaults (Olivia settings tab): tune margin 8 tone spacings...
const DEFAULT_SYNC_MARGIN = 8;
// ...integration over 4 FEC blocks...
const DEFAULT_SYNC_INTEG_LEN = 4;
// ...and with the squelch off fldigi passes 0, which Preset() raises to 3.
const MIN_SYNC_THRESHOLD = 3.0;
// PiRO keeps fldigi's integrated threshold (raising it to 4 costs 1-2 dB of
// sensitivity) and adds the per-block check; see the module comment.
const DEFAULT_SYNC_THRESHOLD = MIN_SYNC_THRESHOLD;
const DEFAULT_BLOCK_SNR_MIN = 4.5;

/** pj_mfsk.h BoxFilter: running sum over the last `len` inputs. */
class BoxFilter {
  constructor(len) {
    this.len = len;
    this.tap = new Float64Array(len);
    this.ptr = 0;
    this.output = 0;
  }

  process(v) {
    this.output -= this.tap[this.ptr];
    this.output += v;
    this.tap[this.ptr] = v;
    this.ptr += 1;
    if (this.ptr >= this.len) this.ptr -= this.len;
  }
}

/** MFSK_InputProcessor: spectral flattening and peak limiting on 16-symbol windows. */
class InputProcessor {
  constructor(windowLen) {
    this.windowLen = windowLen;
    this.wrap = windowLen - 1;
    this.inpTap = new Float64Array(windowLen);
    this.inpPtr = 0;
    this.outTap = new Float64Array(windowLen);
    this.outPtr = 0;
    this.fft = new R2FFT(windowLen);
    this.re = new Float64Array(windowLen);
    this.im = new Float64Array(windowLen);
    this.sliceSepar = windowLen / 2;
    this.shape = new Float64Array(windowLen);
    const scale = 2.0 / windowLen;
    for (let i = 0; i < windowLen; i++) this.shape[i] = scale * Math.sqrt(1.0 - this.fft.twRe[i]);
    this.spectraLen = windowLen / 2;
    this.s = [0, 1].map(() => ({ re: new Float64Array(this.spectraLen), im: new Float64Array(this.spectraLen) }));
    this.output = new Float64Array(windowLen);
    this.energy = new Float64Array(this.spectraLen);
  }

  reset() {
    this.inpTap.fill(0);
    this.inpPtr = 0;
    this.outTap.fill(0);
    this.outPtr = 0;
  }

  _limitSpectraPeaks(sp, len, threshold) {
    const f = new BoxFilter(len);
    const maxFreq = 3 * (this.spectraLen / 4);
    const e = this.energy;
    let freq;
    for (freq = 0; freq < len; freq++) f.process(e[freq]);
    for (let idx = len / 2; freq < maxFreq; freq++, idx++) {
      f.process(e[freq]);
      const signal = e[idx];
      const limit = (f.output / len) * threshold;
      if (signal > limit) {
        const k = Math.sqrt(limit / signal);
        sp.re[idx] *= k;
        sp.im[idx] *= k;
        e[idx] = limit;
      }
    }
  }

  _averageEnergy(len) {
    const f = new BoxFilter(len);
    const maxFreq = 3 * (this.spectraLen / 4);
    const scale = 1.0 / len;
    const len2 = Math.floor(len / 2);
    const e = this.energy;
    let idx;
    let freq;
    for (freq = 0; freq < len; freq++) f.process(e[freq]);
    for (idx = 0; idx < len2; idx++) e[idx] = f.output * scale;
    for (; freq < maxFreq; freq++, idx++) {
      f.process(e[freq]);
      e[idx] = f.output * scale;
    }
    for (; idx < this.spectraLen; idx++) e[idx] = f.output * scale;
  }

  _processSpectra(sp) {
    const e = this.energy;
    for (let f = 0; f < this.spectraLen; f++) e[f] = sp.re[f] * sp.re[f] + sp.im[f] * sp.im[f];
    const lim = this.windowLen / 64;
    this._limitSpectraPeaks(sp, lim, 4.0);
    this._limitSpectraPeaks(sp, lim, 4.0);
    this._limitSpectraPeaks(sp, lim, 4.0);
    this._averageEnergy(Math.floor(this.windowLen / 96));
    this._averageEnergy(this.windowLen / 64);
    for (let f = 0; f < this.spectraLen; f++) {
      let corr = e[f];
      if (corr <= 0) continue;
      corr = 1.0 / Math.sqrt(corr);
      sp.re[f] *= corr;
      sp.im[f] *= corr;
    }
  }

  _inpTap(input, offset) {
    for (let i = 0; i < this.sliceSepar; i++) {
      this.inpTap[this.inpPtr] = input[offset + i];
      this.inpPtr = (this.inpPtr + 1) & this.wrap;
    }
  }

  _inpWindow(dst) {
    for (let t = 0; t < this.windowLen; t++) {
      dst[t] = this.inpTap[this.inpPtr] * this.shape[t];
      this.inpPtr = (this.inpPtr + 1) & this.wrap;
    }
  }

  _outWindow(src) {
    for (let t = 0; t < this.windowLen; t++) {
      this.outTap[this.outPtr] += src[t] * this.shape[t];
      this.outPtr = (this.outPtr + 1) & this.wrap;
    }
  }

  _outTap(offset) {
    for (let i = 0; i < this.sliceSepar; i++) {
      this.output[offset + i] = this.outTap[this.outPtr];
      this.outTap[this.outPtr] = 0;
      this.outPtr = (this.outPtr + 1) & this.wrap;
    }
  }

  _limitOutputPeaks(threshold) {
    let rms = 0;
    for (let i = 0; i < this.windowLen; i++) rms += this.output[i] * this.output[i];
    rms = Math.sqrt(rms / this.windowLen);
    const limit = rms * threshold;
    for (let i = 0; i < this.windowLen; i++) {
      const v = this.output[i];
      if (v > limit) this.output[i] = limit;
      else if (v < -limit) this.output[i] = -limit;
    }
  }

  /** Consumes windowLen input samples; fills this.output with windowLen processed samples. */
  process(input) {
    this._inpTap(input, 0);
    this._inpWindow(this.re);
    this._inpTap(input, this.sliceSepar);
    this._inpWindow(this.im);
    this.fft.process(this.re, this.im);
    const [s0, s1] = this.s;
    this.fft.separTwoReals(this.re, this.im, s0.re, s0.im, s1.re, s1.im);
    this._processSpectra(s0);
    this._processSpectra(s1);
    this.fft.joinTwoReals(s0.re, s0.im, s1.re, s1.im, this.re, this.im);
    this.fft.process(this.re, this.im);
    this._outWindow(this.re);
    this._outTap(0);
    this._outWindow(this.im);
    this._outTap(this.sliceSepar);
    this._limitOutputPeaks(2.5);
    this._limitOutputPeaks(2.5);
  }
}

/** MFSK_Demodulator (no equaliser, normal sideband). */
class Demodulator {
  constructor(p, decodeMargin) {
    this.symbolLen = p.symbolLen;
    this.carriers = p.tones;
    this.bitsPerSymbol = p.bitsPerSymbol;
    this.firstCarrier = p.firstCarrier;
    this.wrap = this.symbolLen - 1;
    this.inpTap = new Float64Array(this.symbolLen);
    this.inpPtr = 0;
    this.fft = new R2FFT(this.symbolLen);
    this.re = new Float64Array(this.symbolLen);
    this.im = new Float64Array(this.symbolLen);
    this.symbolSepar = this.symbolLen / 2;
    this.symbolSepar2 = this.symbolSepar / 2;
    // MFSK_SymbolFreqShape = {1.0, 1.0}: a raised cosine
    this.shape = new Float64Array(this.symbolLen);
    for (let t = 0; t < this.symbolLen; t++) this.shape[t] = (1.0 - this.fft.twRe[t]) * (1.0 / this.symbolLen);
    this.spectraLen = this.symbolLen / 2;
    this.s = [0, 1].map(() => ({ re: new Float64Array(this.spectraLen), im: new Float64Array(this.spectraLen) }));
    this.decodeMargin = Math.min(decodeMargin, this.firstCarrier);
    this.decodeWidth = this.carriers * CARRIER_SEPAR - 1 + 2 * this.decodeMargin;
    this.energy = [new Float64Array(this.decodeWidth), new Float64Array(this.decodeWidth)];
    if (this.firstCarrier - this.decodeMargin + this.decodeWidth > this.spectraLen) {
      throw new Error('Olivia: the signal is too close to the top of the audio band');
    }
  }

  process(input, offset) {
    let i = 0;
    for (; i < this.symbolSepar2; i++) {
      this.inpTap[this.inpPtr] = input[offset + i];
      this.inpPtr = (this.inpPtr + 1) & this.wrap;
    }
    for (let t = 0; t < this.symbolLen; t++) {
      this.re[t] = this.inpTap[this.inpPtr] * this.shape[t];
      this.inpPtr = (this.inpPtr + 1) & this.wrap;
    }
    for (; i < this.symbolSepar; i++) {
      this.inpTap[this.inpPtr] = input[offset + i];
      this.inpPtr = (this.inpPtr + 1) & this.wrap;
    }
    for (let t = 0; t < this.symbolLen; t++) {
      this.im[t] = this.inpTap[this.inpPtr] * this.shape[t];
      this.inpPtr = (this.inpPtr + 1) & this.wrap;
    }
    this.fft.process(this.re, this.im);
    const [s0, s1] = this.s;
    this.fft.separTwoReals(this.re, this.im, s0.re, s0.im, s1.re, s1.im);
    let freq = this.firstCarrier - this.decodeMargin;
    for (let idx = 0; idx < this.decodeWidth; idx++, freq++) {
      this.energy[0][idx] = s0.re[freq] * s0.re[freq] + s0.im[freq] * s0.im[freq];
      this.energy[1][idx] = s1.re[freq] * s1.re[freq] + s1.im[freq] * s1.im[freq];
    }
  }

  /** Soft bits (bitsPerSymbol of them) for one slice at one frequency offset. */
  softDecode(out, slice, freqOffset) {
    const bps = this.bitsPerSymbol;
    for (let b = 0; b < bps; b++) out[b] = 0;
    const e = this.energy[slice];
    const base = this.decodeMargin + freqOffset;
    let total = 0;
    for (let idx = 0, f = 0; idx < this.carriers; idx++, f += CARRIER_SEPAR) {
      const symb = binaryCode(idx);
      let en = e[base + f];
      en *= en;
      total += en;
      for (let b = 0, mask = 1; b < bps; b++, mask <<= 1) {
        if (symb & mask) out[b] -= en;
        else out[b] += en;
      }
    }
    if (total > 0) for (let b = 0; b < bps; b++) out[b] /= total;
  }
}

/** MFSK_SoftDecoder: the last 64 symbols' soft bits -> one block of characters. */
class SoftDecoder {
  constructor(bitsPerSymbol) {
    this.bps = bitsPerSymbol;
    this.inputLen = SYMBOLS_PER_BLOCK * bitsPerSymbol;
    this.input = new Float64Array(this.inputLen);
    this.inputPtr = 0;
    this.fhtBuf = new Float64Array(SYMBOLS_PER_BLOCK);
    this.outputBlock = new Uint8Array(bitsPerSymbol);
    this.signal = 0;
    this.noiseEnergy = 0;
  }

  reset() {
    this.input.fill(0);
    this.inputPtr = 0;
  }

  push(symbol) {
    for (let b = 0; b < this.bps; b++) this.input[this.inputPtr++] = symbol[b];
    if (this.inputPtr >= this.inputLen) this.inputPtr -= this.inputLen;
  }

  _decodeCharacter(freqBit) {
    let ptr = this.inputPtr;
    let rotate = freqBit;
    const wrap = SYMBOLS_PER_BLOCK - 1;
    let codeBit = (freqBit * SCRAMBLE_SHIFT) & wrap;
    const buf = this.fhtBuf;
    for (let t = 0; t < SYMBOLS_PER_BLOCK; t++) {
      let bit = this.input[ptr + rotate];
      if ((SCRAMBLING_CODE_BITS[codeBit])) bit = -bit;
      buf[t] = bit;
      codeBit = (codeBit + 1) & wrap;
      rotate += 1;
      if (rotate >= this.bps) rotate -= this.bps;
      ptr += this.bps;
      if (ptr >= this.inputLen) ptr -= this.inputLen;
    }
    fht(buf, SYMBOLS_PER_BLOCK);
    let peak = 0;
    let peakPos = 0;
    let sqrSum = 0;
    for (let t = 0; t < SYMBOLS_PER_BLOCK; t++) {
      const s = buf[t];
      sqrSum += s * s;
      if (Math.abs(s) > Math.abs(peak)) {
        peak = s;
        peakPos = t;
      }
    }
    let ch = peakPos;
    if (peak < 0) ch += SYMBOLS_PER_BLOCK;
    sqrSum -= peak * peak;
    this.outputBlock[freqBit] = ch;
    // fldigi accumulates these in single-precision floats
    this.noiseEnergy = Math.fround(this.noiseEnergy + Math.fround(Math.fround(sqrSum) / (SYMBOLS_PER_BLOCK - 1)));
    this.signal = Math.fround(this.signal + Math.abs(peak));
  }

  process() {
    this.signal = 0;
    this.noiseEnergy = 0;
    for (let fb = 0; fb < this.bps; fb++) this._decodeCharacter(fb);
    this.signal = Math.fround(this.signal / this.bps);
    this.noiseEnergy = Math.fround(this.noiseEnergy / this.bps);
  }
}

/**
 * True if a decoded block holds a control code Olivia text never carries:
 * anything below 32 except NUL (the idle/padding character), backspace,
 * tab, LF and CR. A block decoded from noise or from a neighbouring signal
 * that only partly overlaps the search window usually has one.
 */
function hasStrayControl(block) {
  for (const c of block) if (c > 0 && c < 32 && c !== 8 && c !== 9 && c !== 10 && c !== 13) return true;
  return false;
}

const SCRAMBLING_CODE_BITS = Uint8Array.from({ length: 64 }, (_, i) => Number((SCRAMBLING_CODE >> BigInt(i)) & 1n));

/**
 * MFSK_Receiver. Feed 8 kHz audio with process(); decoded bytes come back
 * from each call (and from flush()). Bytes include NUL (Olivia's idle
 * character) and whatever noise decodes to below the squelch; see
 * OliviaTextDecoder for turning them into text.
 */
class OliviaReceiver {
  /**
   * @param {object} [opts]
   * @param {number} [opts.tones=8]
   * @param {number} [opts.bandwidth=250]
   * @param {number} [opts.centreHz=1500]
   * @param {number} [opts.syncMargin=8] - search width each side, in FFT bins (tone spacing / 2)
   * @param {number} [opts.syncIntegLen=4] - synchroniser integration, in blocks
   * @param {number} [opts.syncThreshold=3] - minimum integrated S/N to output a block (at least 3, fldigi's floor)
   * @param {number} [opts.blockSnrMin=4.5] - minimum S/N of the block itself (0 = off, as fldigi)
   * @param {boolean} [opts.dropControlBlocks=true] - drop blocks containing control codes text never uses (false = as fldigi)
   */
  constructor({
    tones = 8,
    bandwidth = 250,
    centreHz = 1500,
    syncMargin = DEFAULT_SYNC_MARGIN,
    syncIntegLen = DEFAULT_SYNC_INTEG_LEN,
    syncThreshold = DEFAULT_SYNC_THRESHOLD,
    blockSnrMin = DEFAULT_BLOCK_SNR_MIN,
    dropControlBlocks = true,
  } = {}) {
    this.p = oliviaParams({ tones, bandwidth, centreHz, intOffset: true });
    this.centreHz = centreHz;
    this.syncIntegLen = Math.max(2, syncIntegLen);
    this.syncThreshold = Math.max(MIN_SYNC_THRESHOLD, syncThreshold);
    this.blockSnrMin = Math.max(0, blockSnrMin);
    this.dropControlBlocks = !!dropControlBlocks;
    this.bps = this.p.bitsPerSymbol;
    this.converter = new RateConverter({ outputRate: 1.0 });
    this.demod = new Demodulator(this.p, Math.max(2, syncMargin));
    this.syncMargin = this.demod.decodeMargin;
    this.inputProc = new InputProcessor(16 * this.p.symbolLen);
    this.freqOffsets = 2 * this.syncMargin + 1;
    this.blockPhases = SLICES_PER_SYMBOL * SYMBOLS_PER_BLOCK;
    this.decoders = Array.from({ length: SLICES_PER_SYMBOL * this.freqOffsets }, () => new SoftDecoder(this.bps));
    // decode pipe: per block phase, syncIntegLen rows x freqOffsets entries x bps bytes
    this.pipeRow = this.freqOffsets * this.bps;
    this.pipe = Array.from({ length: this.blockPhases }, () => ({
      data: new Uint8Array(this.syncIntegLen * this.pipeRow),
      // each entry's own decoder signal and noise energy, for blockSnrMin
      stats: new Float64Array(this.syncIntegLen * this.freqOffsets * 2),
      ptr: 0,
    }));
    // integrators (3 numbers each), blockPhases rows x freqOffsets
    this.syncSignal = new Float64Array(this.blockPhases * this.freqOffsets * 3);
    this.syncNoise = new Float64Array(this.blockPhases * this.freqOffsets * 3);
    this.syncWeight = 1.0 / this.syncIntegLen;
    this.symbol = new Float64Array(8);
    this.inputBuffer = [];
    this._resetSync();
  }

  _resetSync() {
    this.blockPhase = 0;
    this.bestSignal = 0;
    this.bestBlockPhase = 0;
    this.bestFreqOffset = 0;
    this.snr = 0;
    this.blockSnr = 0;
    // S/N and offset as they were when the most recent block was output
    // (the live figures move on, e.g. while flush() pushes silence through)
    this.lastOutput = { snr: 0, blockSnr: 0, freqOffsetHz: 0 };
  }

  reset() {
    this.converter.reset();
    this.inputBuffer = [];
    this.inputProc.reset();
    for (const d of this.decoders) d.reset();
    for (const p of this.pipe) {
      p.data.fill(0);
      p.stats.fill(0);
      p.ptr = 0;
    }
    this.syncSignal.fill(0);
    this.syncNoise.fill(0);
    this._resetSync();
  }

  /** Frequency offset of the best signal from the set centre, in Hz. */
  get freqOffsetHz() {
    return (this.bestFreqOffset - Math.floor(this.freqOffsets / 2)) * this.p.binHz;
  }

  /** Signal-to-noise figure of the synchroniser (fldigi's "S/N" before its dB conversion). */
  get signalToNoise() {
    return this.snr;
  }

  /** Search range each side of the centre, in Hz. */
  get tuneMarginHz() {
    return this.syncMargin * this.p.binHz;
  }

  /**
   * @param {ArrayLike<number>} samples - 8 kHz audio, nominally within [-1, 1]
   * @returns {number[]} decoded bytes
   */
  process(samples) {
    const conv = this.converter.process(samples);
    for (const v of conv) this.inputBuffer.push(v);
    const out = [];
    this._processInputBuffer(out);
    return out;
  }

  /** Pushes silence through so characters still in the pipeline come out. */
  flush() {
    const out = [];
    this._processInputBuffer(out);
    const wl = this.inputProc.windowLen;
    while (this.inputBuffer.length < wl) this.inputBuffer.push(0);
    this.inputBuffer.length = wl;
    this._processInputBuffer(out);
    const flushLen = this.p.symbolSepar * SYMBOLS_PER_BLOCK * this.syncIntegLen * 2;
    for (let i = 0; i < flushLen; i += wl) {
      this.inputBuffer = new Array(wl).fill(0);
      this._processInputBuffer(out);
    }
    return out;
  }

  _processInputBuffer(out) {
    const wl = this.inputProc.windowLen;
    while (this.inputBuffer.length >= wl) {
      this.inputProc.process(this.inputBuffer);
      this.inputBuffer = this.inputBuffer.slice(wl);
      for (let idx = 0; idx < wl; idx += this.p.symbolSepar) this._processSymbol(this.inputProc.output, idx, out);
    }
  }

  _processSymbol(input, offset, out) {
    this.demod.process(input, offset);
    const fo = this.freqOffsets;
    const half = Math.floor(fo / 2);
    let dec = 0;
    for (let slice = 0; slice < SLICES_PER_SYMBOL; slice++) {
      const rowBase = this.blockPhase * fo;
      const pipe = this.pipe[this.blockPhase];
      const pipeBase = pipe.ptr * this.pipeRow;
      let bestSliceOffset = 0;
      let bestSliceSignal = 0;
      for (let offs = 0; offs < fo; offs++, dec++) {
        this.demod.softDecode(this.symbol, slice, offs - half);
        const d = this.decoders[dec];
        d.push(this.symbol);
        d.process();
        pipe.data.set(d.outputBlock, pipeBase + offs * this.bps);
        const sk = (pipe.ptr * fo + offs) * 2;
        pipe.stats[sk] = d.signal;
        pipe.stats[sk + 1] = d.noiseEnergy;
        const k = (rowBase + offs) * 3;
        lowPass3(this.syncNoise, k, d.noiseEnergy, this.syncWeight);
        lowPass3(this.syncSignal, k, d.signal, this.syncWeight);
        const signal = this.syncSignal[k + 2];
        if (signal > bestSliceSignal) {
          bestSliceSignal = signal;
          bestSliceOffset = offs;
        }
      }
      pipe.ptr = (pipe.ptr + 1) % this.syncIntegLen;

      if (this.blockPhase === this.bestBlockPhase) {
        this.bestSignal = bestSliceSignal;
        this.bestFreqOffset = bestSliceOffset;
      } else if (bestSliceSignal > this.bestSignal) {
        this.bestSignal = bestSliceSignal;
        this.bestBlockPhase = this.blockPhase;
        this.bestFreqOffset = bestSliceOffset;
      }

      let dist = this.blockPhase - this.bestBlockPhase;
      if (dist < 0) dist += this.blockPhases;
      if (dist === this.blockPhases / 2) {
        // fldigi reads the noise integrator just past the end of the row it
        // has been walking through (the next block phase's lowest offset):
        // its noise reference is effectively a far-off bin. Kept as is for
        // matching behaviour; the one out-of-range case wraps to the start.
        const nIdx = ((rowBase + fo) % (this.blockPhases * fo)) * 3;
        const bestNoise = Math.sqrt(this.syncNoise[nIdx + 2]);
        this.snr = bestNoise === 0 ? 0 : this.bestSignal / bestNoise;
        if (this.snr >= this.syncThreshold) {
          const bp = this.pipe[this.bestBlockPhase];
          const sk = (bp.ptr * fo + this.bestFreqOffset) * 2;
          const ownNoise = Math.sqrt(bp.stats[sk + 1]);
          this.blockSnr = ownNoise > 0 ? bp.stats[sk] / ownNoise : 0;
          const at = bp.ptr * this.pipeRow + this.bestFreqOffset * this.bps;
          const block = bp.data.subarray(at, at + this.bps);
          if (this.blockSnr >= this.blockSnrMin && !(this.dropControlBlocks && hasStrayControl(block))) {
            for (let b = 0; b < this.bps; b++) out.push(block[b]);
            this.lastOutput = { snr: this.snr, blockSnr: this.blockSnr, freqOffsetHz: this.freqOffsetHz };
          }
        }
        if (this.snr > 100) this.snr = 0.0;
      }
      this.blockPhase++;
    }
    if (this.blockPhase >= this.blockPhases) this.blockPhase -= this.blockPhases;
  }
}

/**
 * Turns the receiver's bytes into text the way fldigi shows it: NUL and
 * other control codes below 8 are dropped, and 127 + c means c + 128 (the
 * 8-bit escape). Returns a string per call; CR/LF and backspace are kept.
 */
class OliviaTextDecoder {
  constructor() {
    this.escape = false;
  }

  push(bytes) {
    let s = '';
    for (const b of bytes) {
      let c = b;
      if (this.escape) {
        this.escape = false;
        c += 128;
      } else if (c === 127) {
        this.escape = true;
        continue;
      }
      if (c > 7) s += String.fromCharCode(c);
    }
    return s;
  }
}

module.exports = {
  OliviaReceiver,
  hasStrayControl,
  OliviaTextDecoder,
  DEFAULT_SYNC_MARGIN,
  DEFAULT_SYNC_INTEG_LEN,
  DEFAULT_SYNC_THRESHOLD,
  DEFAULT_BLOCK_SNR_MIN,
  MIN_SYNC_THRESHOLD,
  OLIVIA_SAMPLE_RATE,
};
