'use strict';

/**
 * Olivia transmitter: text -> 8 kHz audio, the way fldigi sends it.
 *
 * A port of MFSK_Encoder, MFSK_Modulator and MFSK_Transmitter from Pawel
 * Jalocha's MFSK code in fldigi (src/include/jalocha/pj_mfsk.h), and of the
 * transmit sequence in fldigi's src/olivia/olivia.cxx (start tones, one NUL,
 * the text, stop tones). GPL-3; see third_party/olivia/README.md.
 *
 * How Olivia works, for the 8/250 variant: each character is 7 bits. A block
 * of 64 symbols carries 3 characters (one per bit of the 3-bit symbol): each
 * character becomes one 64-chip Walsh function (an inverse Hadamard
 * transform of a one-hot vector), scrambled with a fixed 64-bit code and
 * spread diagonally across the symbol bits. Each symbol is sent as one of
 * 8 tones (Gray-coded), 31.25 Hz apart, at 31.25 baud, with raised-cosine
 * shaped, half-overlapping symbols and a random +/-90 degree phase step
 * between symbols. One block takes 2.048 s, so text goes at ~1.46 chars/s.
 */

const { OLIVIA_SAMPLE_RATE, CARRIER_SEPAR, oliviaParams, grayCode, ifht, RateConverter } = require('./olivia-dsp');

const SCRAMBLING_CODE = 0xe257e6d0291574ecn; // Olivia's (Contestia uses another)
const SCRAMBLE_SHIFT = 13; // per-character offset into the scrambling code
const BITS_PER_CHAR = 7;
const SYMBOLS_PER_BLOCK = 1 << (BITS_PER_CHAR - 1); // 64

// fldigi's start/stop tones: 16 x 512 samples at 8 kHz, as four quarters
// alternating between the low and high band edges, with 32 ms ramps.
const TONE_DURATION = 512 * 16;
const SR4 = TONE_DURATION / 4;

/** fldigi's stdlib rand() is replaced by this in tests (same LCG as the reference tool). */
function makeTestRand(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 16) & 0x7fff;
  };
}

/** MFSK_Encoder: 3 characters -> one block of 64 symbols. */
class OliviaEncoder {
  constructor(bitsPerSymbol) {
    this.bitsPerSymbol = bitsPerSymbol;
    this.fhtBuffer = new Int32Array(SYMBOLS_PER_BLOCK);
    this.outputBlock = new Uint8Array(SYMBOLS_PER_BLOCK);
  }

  _encodeCharacter(ch) {
    const c = ch & ((SYMBOLS_PER_BLOCK << 1) - 1);
    this.fhtBuffer.fill(0);
    if (c < SYMBOLS_PER_BLOCK) this.fhtBuffer[c] = 1;
    else this.fhtBuffer[c - SYMBOLS_PER_BLOCK] = -1;
    ifht(this.fhtBuffer, SYMBOLS_PER_BLOCK);
  }

  _scramble(codeOffset) {
    const wrap = SYMBOLS_PER_BLOCK - 1;
    let bit = codeOffset & wrap;
    for (let t = 0; t < SYMBOLS_PER_BLOCK; t++) {
      if ((SCRAMBLING_CODE >> BigInt(bit)) & 1n) this.fhtBuffer[t] = -this.fhtBuffer[t];
      bit = (bit + 1) & wrap;
    }
  }

  /** @param {ArrayLike<number>} chars - bitsPerSymbol character codes */
  encodeBlock(chars) {
    const bps = this.bitsPerSymbol;
    this.outputBlock.fill(0);
    for (let freqBit = 0; freqBit < bps; freqBit++) {
      this._encodeCharacter(chars[freqBit]);
      this._scramble(freqBit * SCRAMBLE_SHIFT);
      let rotate = 0;
      for (let t = 0; t < SYMBOLS_PER_BLOCK; t++) {
        if (this.fhtBuffer[t] < 0) {
          let bit = freqBit + rotate;
          if (bit >= bps) bit -= bps;
          this.outputBlock[t] |= 1 << bit;
        }
        rotate += 1;
        if (rotate >= bps) rotate -= bps;
      }
    }
    return this.outputBlock;
  }
}

/** MFSK_Modulator: symbols -> shaped tones, SymbolSepar samples per symbol. */
class OliviaModulator {
  constructor(p, rand) {
    this.symbolLen = p.symbolLen;
    this.symbolSepar = p.symbolSepar;
    this.firstCarrier = p.firstCarrier;
    this.rand = rand;
    this.cos = new Float64Array(this.symbolLen);
    for (let i = 0; i < this.symbolLen; i++) this.cos[i] = Math.cos((2 * Math.PI * i) / this.symbolLen);
    this.outTap = new Float64Array(this.symbolLen);
    this.tapPtr = 0;
    this.wrap = this.symbolLen - 1;
    this.symbolPhase = 0;
    this.lastTone = 0;
  }

  send(symbol) {
    const tone = grayCode(symbol);
    this.lastTone = tone;
    const freq = this.firstCarrier + CARRIER_SEPAR * tone;
    let shift = this.symbolSepar / 2 - this.symbolLen / 2;
    this.symbolPhase = (this.symbolPhase + freq * shift) & this.wrap;
    this._addSymbol(freq, this.symbolPhase);
    shift = this.symbolSepar / 2 + this.symbolLen / 2;
    this.symbolPhase = (this.symbolPhase + freq * shift) & this.wrap;
    let differ = this.symbolLen / 4;
    if (this.rand() & 1) differ = -differ;
    this.symbolPhase = (this.symbolPhase + differ) & this.wrap;
  }

  _addSymbol(freq, phase) {
    let ph = phase;
    for (let t = 0; t < this.symbolLen; t++) {
      const shape = 1.0 - this.cos[t];
      this.outTap[this.tapPtr] += this.cos[ph] * shape;
      ph = (ph + freq) & this.wrap;
      this.tapPtr = (this.tapPtr + 1) & this.wrap;
    }
  }

  output() {
    const out = new Float64Array(this.symbolSepar);
    for (let i = 0; i < this.symbolSepar; i++) {
      out[i] = this.outTap[this.tapPtr];
      this.outTap[this.tapPtr] = 0;
      this.tapPtr = (this.tapPtr + 1) & this.wrap;
    }
    return out;
  }
}

/** MFSK_Transmitter: a character queue, block encoding and the running/stop state. */
class OliviaTransmitter {
  constructor(p, rand) {
    this.p = p;
    this.bitsPerSymbol = p.bitsPerSymbol;
    this.encoder = new OliviaEncoder(p.bitsPerSymbol);
    this.modulator = new OliviaModulator(p, rand);
    this.converter = new RateConverter({ outputRate: 1.0 });
    this.input = [];
    this.symbolPtr = 0;
    this.running = false;
    this.stopReq = false;
  }

  start() {
    this.running = true;
  }

  stop() {
    this.stopReq = true;
  }

  putChar(c) {
    this.input.push(c & 0xff);
  }

  get readReady() {
    return this.input.length;
  }

  /** True once stopped (fldigi's DoPostambleYet()). */
  get finished() {
    return !this.running && !this.stopReq;
  }

  /** One symbol period of audio; also reports the symbol sent, if any. */
  output() {
    let symbol = null;
    if (this.symbolPtr === 0) {
      if (this.stopReq && this.input.length === 0) {
        this.running = false;
        this.stopReq = false;
      } else if (this.running) {
        const block = new Uint8Array(this.bitsPerSymbol);
        for (let i = 0; i < this.bitsPerSymbol && this.input.length; i++) block[i] = this.input.shift();
        this.encoder.encodeBlock(block);
      }
    }
    if (this.running) {
      symbol = this.encoder.outputBlock[this.symbolPtr];
      this.modulator.send(symbol);
      this.symbolPtr += 1;
      if (this.symbolPtr >= SYMBOLS_PER_BLOCK) this.symbolPtr = 0;
    }
    const conv = this.converter.process(this.modulator.output());
    let max = 0;
    for (const v of conv) if (Math.abs(v) > max) max = Math.abs(v);
    const audio = new Float64Array(conv.length);
    if (max > 0) for (let i = 0; i < conv.length; i++) audio[i] = conv[i] / max;
    return { audio, symbol };
  }
}

function startStopTones(centreHz, bandwidth) {
  const amp = new Float64Array(SR4).fill(1.0);
  for (let i = 0; i < SR4 / 8; i++) amp[i] = amp[SR4 - 1 - i] = 0.5 * (1.0 - Math.cos((Math.PI * i) / (SR4 / 8)));
  const buf = new Float64Array(TONE_DURATION);
  const tone = (f, offsets) => {
    let ph = 0;
    for (let i = 0; i < SR4; i++) {
      ph += (2.0 * Math.PI * f) / OLIVIA_SAMPLE_RATE;
      if (ph > Math.PI) ph -= 2.0 * Math.PI;
      const v = Math.cos(ph) * amp[i];
      for (const o of offsets) buf[o + i] = v;
    }
  };
  tone(centreHz - bandwidth / 2, [0, 2 * SR4]);
  tone(centreHz + bandwidth / 2, [SR4, 3 * SR4]);
  return buf;
}

/**
 * Turns text into the byte stream Olivia sends: 7-bit ASCII, with
 * characters 128-255 escaped as 127 + (code & 127), like fldigi with its
 * default "8-bit extended characters" setting. Anything else becomes '.'.
 * Line breaks are sent as CR LF.
 */
function textToOliviaBytes(text) {
  const out = [];
  const s = String(text).replace(/\r\n?|\n/g, '\n');
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\n') out.push(13, 10);
    else if (c < 128) out.push(c);
    else if (c <= 255) out.push(127, c & 127);
    else out.push(46);
  }
  return out;
}

/**
 * Encodes a whole transmission as fldigi does: start tones, one NUL, the
 * text, padding to a whole block, stop tones and a short silence.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.tones=8]
 * @param {number} [opts.bandwidth=250]
 * @param {number} [opts.centreHz=1500]
 * @param {boolean} [opts.startTones=true]
 * @param {() => number} [opts.rand] - phase-step coin (default Math.random);
 *   tests pass makeTestRand() to reproduce the reference audio exactly
 * @param {number} [opts.amplitude=1]
 * @returns {{samples: Float32Array, sampleRate: number, symbols: number[], tones: number[],
 *   bytes: number[], durationSec: number, params: object}}
 */
function encodeOlivia(text, { tones = 8, bandwidth = 250, centreHz = 1500, startTones = true, rand, amplitude = 1 } = {}) {
  const p = oliviaParams({ tones, bandwidth, centreHz });
  const coin = rand ?? (() => (Math.random() < 0.5 ? 0 : 1));
  const tx = new OliviaTransmitter(p, coin);
  const bytes = typeof text === 'string' ? textToOliviaBytes(text) : Array.from(text);
  const chunks = [];
  const symbols = [];
  const toneList = [];
  tx.start();
  if (startTones) chunks.push(startStopTones(centreHz, p.bandwidth));
  tx.putChar(0);
  let next = 0;
  let stop = false;
  let post = false;
  for (;;) {
    if (stop || tx.readReady < tx.bitsPerSymbol) {
      if (!stop) {
        if (next >= bytes.length) stop = true;
        else tx.putChar(bytes[next++]);
      }
      if (stop) tx.stop();
    }
    const { audio, symbol } = tx.output();
    if (symbol !== null) {
      symbols.push(symbol);
      toneList.push(tx.modulator.lastTone);
    }
    chunks.push(audio);
    if (stop && tx.finished && !post) {
      post = true;
      if (startTones) chunks.push(startStopTones(centreHz, p.bandwidth));
      chunks.push(new Float64Array(512));
    }
    if (!tx.running) break;
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) samples[off + i] = c[i] * amplitude;
    off += c.length;
  }
  return { samples, sampleRate: OLIVIA_SAMPLE_RATE, symbols, tones: toneList, bytes, durationSec: total / OLIVIA_SAMPLE_RATE, params: p };
}

/** Seconds a message of `byteCount` bytes takes (start/stop tones included), without encoding it. */
function oliviaDurationSec(byteCount, { tones = 8, bandwidth = 250, startTones = true } = {}) {
  const p = oliviaParams({ tones, bandwidth });
  // fldigi's first block carries the leading NUL and one character only (the
  // queue holds two when the first block is encoded), the rest are full.
  const blocks = byteCount === 0 ? 1 : 1 + Math.ceil((byteCount - 1) / p.bitsPerSymbol);
  const tonesSec = startTones ? (2 * TONE_DURATION) / OLIVIA_SAMPLE_RATE : 0;
  return tonesSec + blocks * p.blockSec + (p.symbolSepar + 512) / OLIVIA_SAMPLE_RATE;
}

module.exports = {
  OliviaEncoder,
  OliviaModulator,
  OliviaTransmitter,
  encodeOlivia,
  oliviaDurationSec,
  textToOliviaBytes,
  makeTestRand,
  SCRAMBLING_CODE,
  SYMBOLS_PER_BLOCK,
};
