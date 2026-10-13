'use strict';

const { BAUDOT_TABLE, FIGS_CODE, LTRS_CODE, DEFAULT_MARK_HZ, DEFAULT_SPACE_HZ, DEFAULT_BAUD } = require('./rtty-decoder');

/**
 * Audio-FSK (AFSK) RTTY encoder — the transmit counterpart of rtty-decoder.js.
 *
 * Text -> ITA2/Baudot (US-TTY figures case, the same table the decoder
 * reads, so the two can never disagree) -> asynchronous frames of 1 start
 * bit (space) + 5 data bits (least-significant first) + a 1.5-bit stop
 * (mark) at 45.45 baud -> continuous-phase two-tone audio (2125 Hz mark /
 * 2295 Hz space by default, swappable via `reversed` exactly as the
 * decoder's "Reverse" checkbox swaps them).
 *
 * LTRS/FIGS shift codes are sent whenever the next character needs the
 * other case. "Unshift on space" is deliberately NOT used: RttyDecoder
 * doesn't implement it, so a USOS transmitter would be misread by this
 * app's own decoder (digits after a space would come out as letters).
 *
 * Everything this module produces is audio. It does not key the radio's
 * hardware FSK input: the rig has to accept the audio on its modulation
 * input (for example USB/LSB with DATA MODE on); see README.md,
 * "RTTY and JTTY transmit".
 */

const MAX_CHARS = 500;

// char -> { code, shift } where shift is 'LTRS' | 'FIGS' | null (null = same code in both cases)
const CHAR_MAP = (() => {
  const map = new Map();
  for (let code = 0; code < BAUDOT_TABLE.length; code++) {
    if (code === FIGS_CODE || code === LTRS_CODE || code === 0) continue;
    const { ltrs, figs } = BAUDOT_TABLE[code];
    if (ltrs !== null && ltrs === figs) {
      map.set(ltrs, { code, shift: null });
      continue;
    }
    if (ltrs !== null && !map.has(ltrs)) map.set(ltrs, { code, shift: 'LTRS' });
    // BEL (figures-case S) is a control, never sent as text.
    if (figs !== null && figs !== '\x07' && !map.has(figs)) map.set(figs, { code, shift: 'FIGS' });
  }
  return map;
})();

/**
 * Converts text into the list of 5-bit codes to send (including shifts). Assumes the
 * receiver is already in LTRS case at the start (encodeRtty() sends a LTRS code first).
 * Lowercase is folded to uppercase; "\r\n" and "\n" both send CR+LF; characters
 * with no ITA2 equivalent are dropped.
 * @returns {{codes: number[], sent: string, dropped: string}}
 */
function textToBaudot(text) {
  const codes = [];
  let sent = '';
  let dropped = '';
  let shift = 'LTRS'; // encodeRtty() always opens with a LTRS code, so the receiver starts in letters case
  const input = String(text).slice(0, MAX_CHARS).toUpperCase().replace(/\r\n/g, '\n');
  for (const ch of input) {
    const chars = ch === '\n' ? ['\r', '\n'] : [ch];
    for (const c of chars) {
      const entry = CHAR_MAP.get(c);
      if (!entry) {
        dropped += c;
        continue;
      }
      if (entry.shift !== null && entry.shift !== shift) {
        codes.push(entry.shift === 'FIGS' ? FIGS_CODE : LTRS_CODE);
        shift = entry.shift;
      }
      codes.push(entry.code);
      sent += c === '\r' ? '\r' : c;
    }
  }
  return { codes, sent, dropped };
}

/**
 * Generates RTTY transmit audio.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=48000]
 * @param {number} [opts.markHz=2125]
 * @param {number} [opts.spaceHz=2295]
 * @param {number} [opts.baud=45.45]
 * @param {boolean} [opts.reversed=false] - swap which tone is mark (mirrors the decoder's Reverse option)
 * @param {number} [opts.amplitude=0.9]
 * @param {number} [opts.leadMs=250] - mark idle before the first character (also lets the radio settle)
 * @param {number} [opts.tailMs=120] - mark idle after the last character
 * @returns {{samples: Float32Array, sent: string, dropped: string, codes: number[], durationSec: number}}
 *   `samples` is empty if nothing in the text could be sent.
 */
function encodeRtty(
  text,
  {
    sampleRate = 48000,
    markHz = DEFAULT_MARK_HZ,
    spaceHz = DEFAULT_SPACE_HZ,
    baud = DEFAULT_BAUD,
    reversed = false,
    amplitude = 0.9,
    leadMs = 250,
    tailMs = 120,
  } = {}
) {
  const { codes, sent, dropped } = textToBaudot(text);
  if (codes.length === 0) return { samples: new Float32Array(0), sent, dropped, codes, durationSec: 0 };

  const markTone = reversed ? spaceHz : markHz;
  const spaceTone = reversed ? markHz : spaceHz;
  const samplesPerBit = sampleRate / baud;

  // Segment list: [frequency, length in bits]. Lead-in is a LTRS pair (also keeps a
  // receiver's shift state defined) after the idle mark.
  const segs = [];
  const bits = (freq, n) => segs.push([freq, n]);
  bits(markTone, (leadMs / 1000) * baud);
  const frame = (code) => {
    bits(spaceTone, 1); // start
    for (let b = 0; b < 5; b++) bits((code >> b) & 1 ? markTone : spaceTone, 1);
    bits(markTone, 1.5); // stop
  };
  frame(LTRS_CODE);
  for (const code of codes) frame(code);
  bits(markTone, (tailMs / 1000) * baud);

  // Cumulative end sample of each segment (fractional bit lengths accumulate without drift).
  let totalBits = 0;
  const ends = segs.map(([, n]) => (totalBits += n) * samplesPerBit);
  const total = Math.ceil(ends[ends.length - 1]);
  const out = new Float32Array(total);
  const twopi = 2 * Math.PI;
  let phi = 0;
  let seg = 0;
  for (let i = 0; i < total; i++) {
    while (seg < segs.length - 1 && i >= ends[seg]) seg++;
    out[i] = amplitude * Math.sin(phi);
    phi = (phi + (twopi * segs[seg][0]) / sampleRate) % twopi;
  }
  // 5 ms raised-cosine edges so key-up/key-down do not click.
  const nramp = Math.min(Math.round(sampleRate * 0.005), Math.floor(total / 2));
  for (let i = 0; i < nramp; i++) {
    const g = (1 - Math.cos((Math.PI * i) / nramp)) / 2;
    out[i] *= g;
    out[total - 1 - i] *= g;
  }
  return { samples: out, sent, dropped, codes, durationSec: total / sampleRate };
}

module.exports = { encodeRtty, textToBaudot, MAX_CHARS };
