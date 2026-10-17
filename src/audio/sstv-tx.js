'use strict';

/**
 * SSTV encoder: an RGB picture -> audio, in any mode of sstv-modes.js.
 *
 * Written for PiRO's tests (it produces exactly the line layout the
 * receiver, after slowrx, expects) and as the basis of a later transmit
 * feature. Frequencies: 1200 Hz sync, 1500 Hz black to 2300 Hz white, the
 * standard VIS header (1900 Hz leader, 1200 Hz break, start bit, seven data
 * bits least significant first at 1100 Hz for 1 and 1300 Hz for 0, even
 * parity, stop bit, 30 ms each). Continuous phase.
 */

const { MODES, VIS_OF_MODE, channelLayout, linePeriods, isPd, isScottie, isRobotColour } = require('./sstv-modes');

const FREQ_SYNC = 1200;
const FREQ_BLACK = 1500;
const FREQ_LEADER = 1900;
const FREQ_WHITE = 2300;
const FREQ_VIS_1 = 1100;
const FREQ_VIS_0 = 1300;

const lumToFreq = (v) => FREQ_BLACK + ((FREQ_WHITE - FREQ_BLACK) * v) / 255;
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** The inverse of slowrx's YUV conversion (sstv-modes.js toRgb()). */
function rgbToYuv(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return [clamp255(y), clamp255((r - y) / 1.4 + 127.5), clamp255((b - y) / 1.78 + 127.5)];
}

/** VIS header segments: [freq, seconds]. */
function visSegments(id) {
  const code = VIS_OF_MODE[id];
  if (code === undefined) throw new Error(`No VIS code for ${id}`);
  const segs = [
    [FREQ_LEADER, 0.3],
    [FREQ_SYNC, 0.01],
    [FREQ_LEADER, 0.3],
    [FREQ_SYNC, 0.03],
  ];
  let ones = 0;
  for (let b = 0; b < 7; b++) {
    const bit = (code >> b) & 1;
    ones += bit;
    segs.push([bit ? FREQ_VIS_1 : FREQ_VIS_0, 0.03]);
  }
  let parity = ones % 2;
  if (id === 'R12BW') parity ^= 1; // slowrx: Robot 12 B/W uses odd parity
  segs.push([parity ? FREQ_VIS_1 : FREQ_VIS_0, 0.03]);
  segs.push([FREQ_SYNC, 0.03]);
  return segs;
}

/**
 * Channel values for one picture, as the receiver stores them: an array per
 * channel of `width * lines` bytes (Y/V/U for YUV modes; G/B/R for GBR; R/G/B for RGB).
 */
function channelPlanes(id, rgb, width, height) {
  const m = MODES[id];
  const W = m.width;
  const H = m.lines;
  const planes = [new Float64Array(W * H), new Float64Array(W * H), new Float64Array(W * H)];
  for (let y = 0; y < H; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / W));
      const o = (sy * width + sx) * 3;
      const r = rgb[o];
      const g = rgb[o + 1];
      const b = rgb[o + 2];
      const i = y * W + x;
      if (m.color === 'YUV') {
        const [Y, V, U] = rgbToYuv(r, g, b);
        planes[0][i] = Y;
        planes[1][i] = V;
        planes[2][i] = U;
      } else if (m.color === 'GBR') {
        planes[0][i] = g;
        planes[1][i] = b;
        planes[2][i] = r;
      } else if (m.color === 'RGB') {
        planes[0][i] = r;
        planes[1][i] = g;
        planes[2][i] = b;
      } else planes[0][i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  return planes;
}

/** Frequency at time t (s) within line period `p` of a picture. */
function lineSampler(id, planes) {
  const m = MODES[id];
  const W = m.width;
  const { start, len } = channelLayout(id);
  const syncAt = isScottie(id) ? start[1] + len[1] : 0;
  return (p, t) => {
    if (t >= syncAt && t < syncAt + m.sync) return FREQ_SYNC;
    if (isPd(id)) {
      for (let c = 0; c < 4; c++) {
        if (t >= start[c] && t < start[c] + len[c]) {
          const x = Math.min(W - 1, Math.floor((t - start[c]) / m.pixel));
          const y0 = 2 * p;
          if (c === 0) return lumToFreq(planes[0][y0 * W + x]);
          if (c === 3) return lumToFreq(planes[0][(y0 + 1) * W + x]);
          const pl = planes[c]; // 1: V (R-Y), 2: U (B-Y), averaged over the two lines
          return lumToFreq((pl[y0 * W + x] + pl[(y0 + 1) * W + x]) / 2);
        }
      }
      return FREQ_BLACK;
    }
    if (isRobotColour(id)) {
      const y = p;
      if (t >= start[0] && t < start[0] + len[0]) return lumToFreq(planes[0][y * W + Math.min(W - 1, Math.floor(((t - start[0]) / len[0]) * W))]);
      const ch = y % 2 === 0 ? 1 : 2;
      if (t >= start[1] && t < start[1] + len[ch]) return lumToFreq(planes[ch][y * W + Math.min(W - 1, Math.floor(((t - start[1]) / len[ch]) * W))]);
      // separator: 4.5 ms (1500 Hz before R-Y, 2300 Hz before B-Y), then a 1.5 ms 1900 Hz porch
      const sepEnd = start[1];
      if (t >= sepEnd - 1.5e-3 && t < sepEnd) return FREQ_LEADER;
      if (t >= start[0] + len[0] && t < sepEnd) return y % 2 === 0 ? FREQ_BLACK : FREQ_WHITE;
      return FREQ_BLACK;
    }
    const nch = m.color === 'BW' ? 1 : 3;
    for (let c = 0; c < nch; c++) {
      if (t >= start[c] && t < start[c] + len[c]) {
        return lumToFreq(planes[c][p * W + Math.min(W - 1, Math.floor(((t - start[c]) / len[c]) * W))]);
      }
    }
    if (id === 'R72') {
      // before R-Y: 4.5 ms of 1500 Hz then a 1.5 ms 1900 Hz porch; before B-Y: 4.5 ms of 2300 Hz then 1.5 ms of 1500 Hz (N7CXI)
      if (t >= start[1] - 1.5e-3 && t < start[1]) return FREQ_LEADER;
      if (t >= start[2] - m.septr && t < start[2] - 1.5e-3) return FREQ_WHITE;
    }
    return FREQ_BLACK;
  };
}

/**
 * @param {Uint8Array|number[]} rgb - picture, 3 bytes per pixel, row by row
 * @param {number} width
 * @param {number} height - the picture is scaled (nearest pixel) to the mode's size
 * @param {string} id - mode id (see sstv-modes.js MODES)
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=12000]
 * @param {number} [opts.amplitude=1]
 * @param {boolean} [opts.vis=true] - send the VIS header
 * @param {number} [opts.clockError=0] - fractional timing error (e.g. 1e-3 sends 0.1% slow), to imitate a sender's sound card
 * @param {number} [opts.freqOffsetHz=0] - shift every tone, to imitate mistuning
 * @param {number} [opts.periods] - send only this many line periods (tests)
 * @returns {{samples: Float32Array, sampleRate: number, videoStart: number, durationSec: number}}
 */
function encodeSstv(rgb, width, height, id, { sampleRate = 12000, amplitude = 1, vis = true, clockError = 0, freqOffsetHz = 0, periods: maxPeriods } = {}) {
  const m = MODES[id];
  if (!m) throw new Error(`Unknown SSTV mode ${id}`);
  const planes = channelPlanes(id, rgb, width, height);
  const sample = lineSampler(id, planes);
  // Scottie modes start with an extra 9 ms sync pulse before the first line (N7CXI)
  const head = [...(vis ? visSegments(id) : []), ...(isScottie(id) ? [[FREQ_SYNC, MODES[id].sync]] : [])];
  const headSec = head.reduce((s, [, d]) => s + d, 0);
  const periods = Math.min(linePeriods(id), maxPeriods ?? Infinity);
  const videoSec = periods * m.line;
  const scale = 1 + clockError;
  const total = Math.ceil((headSec + videoSec) * scale * sampleRate);
  const out = new Float32Array(total);
  let phase = 0;
  let segIdx = 0;
  let segEnd = head.length ? head[0][1] : 0;
  for (let n = 0; n < total; n++) {
    const t = n / sampleRate / scale; // the sender's own time
    let f;
    if (t < headSec) {
      while (t >= segEnd && segIdx < head.length - 1) segEnd += head[++segIdx][1];
      f = head[segIdx][0];
    } else {
      const tv = t - headSec;
      const p = Math.min(periods - 1, Math.floor(tv / m.line));
      f = sample(p, tv - p * m.line);
    }
    out[n] = amplitude * Math.sin(phase);
    phase += (2 * Math.PI * (f + freqOffsetHz)) / sampleRate;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  }
  return { samples: out, sampleRate, videoStart: Math.round(headSec * scale * sampleRate), durationSec: total / sampleRate };
}

const FSK_ONE = 1900;
const FSK_ZERO = 2100;
const FSK_BIT_SEC = 0.022;

/**
 * The FSK ID many SSTV programs (MMSSTV, PySSTV) send after a picture and
 * slowrx reads: 6-bit characters (ASCII - 0x20), least significant bit first,
 * 22 ms per bit, 1900 Hz for 1 and 2100 Hz for 0, framed as 0x20 0x2A, the
 * text, 0x01. Up to 10 characters (slowrx reads no more).
 * @returns {Array<[number, number]>} [freq, seconds] segments
 */
function fskIdSegments(text) {
  const t = String(text).toUpperCase().replace(/[^\x20-\x5f]/g, '').slice(0, 10);
  const bytes = [0x20, 0x2a, ...[...t].map((c) => c.charCodeAt(0) - 0x20), 0x01];
  const segs = [];
  for (const b of bytes) for (let i = 0; i < 6; i++) segs.push([(b >> i) & 1 ? FSK_ONE : FSK_ZERO, FSK_BIT_SEC]);
  return segs;
}

/** Morse code for the CW ID, from the CW decoder's own table (so the two agree). */
const MORSE = (() => {
  const { MORSE_TABLE } = require('./cw-decoder');
  return Object.fromEntries(Object.entries(MORSE_TABLE).map(([code, ch]) => [ch, code]));
})();

/**
 * A CW identification as keyed audio: [amplitude (0/1), freq, seconds]
 * segments at `wpm` (PARIS timing: a dot is 1.2 / wpm seconds).
 */
function cwSegments(text, { wpm = 20, toneHz = 800 } = {}) {
  const dot = 1.2 / wpm;
  const segs = [];
  const words = String(text).toUpperCase().trim().split(/\s+/);
  words.forEach((word, wi) => {
    if (wi > 0) segs.push([0, toneHz, 6 * dot]); // 7 dots between words (1 already after the last element)
    [...word].forEach((ch, ci) => {
      const code = MORSE[ch];
      if (!code) return;
      if (ci > 0) segs.push([0, toneHz, 2 * dot]); // 3 between letters (1 already after the last element)
      for (const el of code) {
        segs.push([1, toneHz, el === '-' ? 3 * dot : dot]);
        segs.push([0, toneHz, dot]);
      }
    });
  });
  return segs;
}

/** Continuous-phase synthesis of [freq, seconds] segments (or [amp, freq, seconds] with 5 ms keying edges). */
function synth(segs, sampleRate, amplitude, keyed = false) {
  const total = Math.round(segs.reduce((n, sg) => n + sg[sg.length - 1], 0) * sampleRate);
  const out = new Float32Array(total);
  const ramp = Math.round(0.005 * sampleRate);
  let phase = 0;
  let pos = 0;
  let t = 0;
  for (const sg of segs) {
    const [amp, f, dur] = keyed ? sg : [1, sg[0], sg[1]];
    t += dur;
    const end = Math.min(total, Math.round(t * sampleRate));
    const n = end - pos;
    for (let i = 0; i < n; i++) {
      let g = amp;
      if (keyed && amp) g = Math.min(1, (i + 0.5) / ramp, (n - i - 0.5) / ramp);
      out[pos + i] = amplitude * g * Math.sin(phase);
      phase += (2 * Math.PI * f) / sampleRate;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
    pos = end;
  }
  return out;
}

/**
 * A whole SSTV transmission: the picture, then (optionally) the FSK ID and
 * a CW ID ("DE <callsign>") after a short pause.
 * @param {object} [opts] - as encodeSstv(), plus:
 * @param {string} [opts.callsign]
 * @param {boolean} [opts.fskId=true]
 * @param {boolean} [opts.cwId=true]
 * @param {number} [opts.cwWpm=20]
 * @param {number} [opts.cwToneHz=800]
 */
function encodeSstvTransmission(rgb, width, height, id, opts = {}) {
  const { sampleRate = 12000, amplitude = 1, callsign, fskId = true, cwId = true, cwWpm = 20, cwToneHz = 800 } = opts;
  const parts = [encodeSstv(rgb, width, height, id, { ...opts, sampleRate, amplitude }).samples];
  const call = String(callsign || '').trim();
  if (call && fskId) parts.push(synth(fskIdSegments(call), sampleRate, amplitude));
  if (call && cwId) {
    parts.push(new Float32Array(Math.round(0.3 * sampleRate)));
    parts.push(synth(cwSegments(`DE ${call}`, { wpm: cwWpm, toneHz: cwToneHz }), sampleRate, amplitude, true));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const samples = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    samples.set(p, o);
    o += p.length;
  }
  return { samples, sampleRate, durationSec: total / sampleRate };
}

module.exports = { encodeSstv, encodeSstvTransmission, fskIdSegments, cwSegments, visSegments, rgbToYuv, FREQ_SYNC, FREQ_BLACK, FREQ_WHITE, FREQ_LEADER };
