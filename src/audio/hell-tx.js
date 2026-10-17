'use strict';

/**
 * Feld-Hell transmitter: text -> 8 kHz audio, the way fldigi sends it.
 *
 * A port of fldigi's src/feld/feld.cxx transmit side (get_font_data, nco,
 * send_symbol, send_null_column, tx_char, the preamble/postamble in
 * tx_process, initKeyWaveform), GPL-3; see third_party/feldhell/README.md.
 * fldigi's defaults: Feld-Hell, the "hell 12" font, 2 ms raised-cosine
 * pulse shaping, each column sent once.
 *
 * Feld-Hell sends text as pictures. Each character is drawn from a raster
 * font and scanned column by column, bottom row first; each column is 14
 * "half-pixels" (the 7-dot font, each dot two half-pixels high). A single
 * tone is keyed on for ink and off for paper at 245 half-pixels a second
 * (17.5 columns a second, 122.5 baud), so about 2.5 characters a second.
 * The receiver paints the tone's strength as an image; there is no
 * decoding into characters.
 */

const { FONT_ROWS } = require('./hell-font');

const HELL_SAMPLE_RATE = 8000; // fldigi's FeldSampleRate
const COLUMN_RATE = 17.5; // columns per second (Feld-Hell)
const COLUMN_LEN = 14; // half-pixels per column (FELD_COLUMN_LEN)
const PIXEL_RATE = COLUMN_LEN * COLUMN_RATE; // 245 half-pixels per second
const MAXLEN = 512;

/**
 * fldigi's initKeyWaveform(): the amplitude shapes used at the start of an
 * "on" half-pixel after an "off" one and at the end of an "on" one before an
 * "off" one. pulse: 0 = 4 ms, 1 = 2 ms (fldigi's default), 2 = 1 ms, 3 = hard.
 */
function keyShapes(pulse = 1) {
  const on = new Float64Array(MAXLEN).fill(1.0);
  const off = new Float64Array(MAXLEN).fill(0.0);
  for (let i = 0; i < 32; i++) {
    switch (pulse) {
      case 0:
        on[i] = 0.5 * (1.0 - Math.cos((Math.PI * i) / 33));
        break;
      case 1:
        if (i < 16) on[i] = 0.5 * (1.0 - Math.cos((Math.PI * i) / 16));
        break;
      case 2:
        if (i < 8) on[i] = 0.5 * (1.0 - Math.cos((Math.PI * i) / 8));
        break;
      default:
        break;
    }
    off[31 - i] = on[i];
  }
  return { on, off };
}

/**
 * fldigi's get_font_data(): the bits of one column of a character, bit 0 the
 * bottom row, or -1 once there are no more columns with ink (or for a
 * character the font does not have).
 */
function fontColumn(code, col) {
  if (col > 15 || code < 32 || code > 126) return -1;
  const glyph = FONT_ROWS[code - 32];
  const mask = 1 << (15 - col);
  let ordbits = 0;
  for (let i = 0; i < 14; i++) ordbits |= glyph[i];
  let bits = 0;
  for (let row = 0; row < 14; row++) if (glyph[13 - row] & mask) bits |= 1 << row;
  const testval = (1 << (15 - col)) - 1;
  if (bits === 0 && (ordbits & testval) === 0) return -1;
  return bits;
}

class HellModulator {
  constructor({ toneHz, pulse = 1, xmtWidth = 1, sampleRate = HELL_SAMPLE_RATE }) {
    this.toneHz = toneHz;
    this.sampleRate = sampleRate;
    this.xmtWidth = xmtWidth;
    this.upsampleinc = PIXEL_RATE / sampleRate;
    const { on, off } = keyShapes(pulse);
    this.onShape = on;
    this.offShape = off;
    this.txphacc = 0;
    this.txcounter = 0;
    this.prevsymb = 0;
    this.out = [];
    this.symbols = [];
  }

  _nco() {
    const x = Math.sin(this.txphacc);
    this.txphacc += (2.0 * Math.PI * this.toneHz) / this.sampleRate;
    if (this.txphacc > 2 * Math.PI) this.txphacc -= 2 * Math.PI;
    return x;
  }

  sendSymbol(curr, next) {
    this.symbols.push(curr);
    let outlen = 0;
    for (;;) {
      let amp;
      if (this.prevsymb === 0 && curr === 1) amp = this.onShape[outlen];
      else if (curr === 1 && next === 0) amp = this.offShape[outlen];
      else amp = curr;
      this.out.push(amp * this._nco());
      outlen++;
      if (outlen >= MAXLEN) break; // fldigi's OUTBUFSIZE guard; never reached at 8 kHz
      this.txcounter += this.upsampleinc;
      if (this.txcounter < 1.0) continue;
      this.txcounter -= 1.0;
      break;
    }
    this.prevsymb = curr;
  }

  nullColumn() {
    for (let i = 0; i < COLUMN_LEN; i++) this.sendSymbol(0, 0);
  }

  txChar(code) {
    this.nullColumn();
    if (code === 32) {
      this.nullColumn();
      this.nullColumn();
      this.nullColumn();
    } else {
      let bits;
      for (let column = 0; (bits = fontColumn(code, column)) !== -1; column++) {
        for (let w = 0; w < this.xmtWidth; w++) {
          let colbits = bits;
          for (let i = 0; i < COLUMN_LEN; i++) {
            const curr = colbits & 1;
            colbits >>= 1;
            this.sendSymbol(curr, colbits & 1);
          }
        }
      }
    }
    this.nullColumn();
  }
}

/** Characters Feld-Hell can send: the font covers ' '..'~'; line breaks become spaces, as in fldigi. */
function textToHellCodes(text) {
  const codes = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (ch === '\r' || ch === '\n') codes.push(32);
    else codes.push(c >= 32 && c <= 126 ? c : -1); // -1: not in the font (sent as a gap, like fldigi)
  }
  return codes;
}

/**
 * Encodes a whole transmission as fldigi does: three "." characters, the
 * text, three "." and a space.
 *
 * @param {string|number[]} text - a string, or character codes
 * @param {object} [opts]
 * @param {number} [opts.toneHz=1000] - audio frequency of the keyed tone
 * @param {number} [opts.amplitude=1]
 * @param {number} [opts.pulse=1] - 0 = 4 ms, 1 = 2 ms, 2 = 1 ms, 3 = hard keying
 * @param {boolean} [opts.preamble=true] - the ". . ." before and after, as fldigi
 * @returns {{samples: Float32Array, sampleRate: number, symbols: number[], durationSec: number, unsupported: string[]}}
 */
function encodeFeldHell(text, { toneHz = 1000, amplitude = 1, pulse = 1, preamble = true } = {}) {
  const mod = new HellModulator({ toneHz, pulse });
  const codes = typeof text === 'string' ? textToHellCodes(text) : Array.from(text);
  const unsupported = typeof text === 'string' ? [...String(text)].filter((ch) => !/[\x20-\x7e\r\n]/.test(ch)) : [];
  if (preamble) for (let i = 0; i < 3; i++) mod.txChar(46);
  for (const c of codes) mod.txChar(c);
  if (preamble) {
    for (let i = 0; i < 3; i++) mod.txChar(46);
    mod.txChar(32);
  }
  const samples = Float32Array.from(mod.out, (v) => v * amplitude);
  return { samples, sampleRate: HELL_SAMPLE_RATE, symbols: mod.symbols, durationSec: samples.length / HELL_SAMPLE_RATE, unsupported };
}

/** Columns a character occupies on air (its glyph, plus the gap columns either side). */
function charColumns(code) {
  if (code === 32) return 5;
  let n = 0;
  while (fontColumn(code, n) !== -1) n++;
  return n + 2;
}

/** Seconds a message takes on air (preamble and postamble included), without encoding it. */
function hellDurationSec(text) {
  const codes = textToHellCodes(text);
  let cols = 6 * charColumns(46) + charColumns(32); // preamble and postamble
  for (const c of codes) cols += c < 0 ? 2 : charColumns(c);
  return cols / COLUMN_RATE;
}

module.exports = {
  HELL_SAMPLE_RATE,
  COLUMN_RATE,
  COLUMN_LEN,
  PIXEL_RATE,
  keyShapes,
  fontColumn,
  HellModulator,
  encodeFeldHell,
  textToHellCodes,
  charColumns,
  hellDurationSec,
};
