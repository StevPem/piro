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
      // separators before each chroma channel: 4.5 ms (1500 Hz / 2300 Hz) then 1.5 ms of 1900 Hz
      for (const c of [1, 2]) {
        if (t >= start[c] - 1.5e-3 && t < start[c]) return FREQ_LEADER;
        if (t >= start[c] - m.septr && t < start[c]) return c === 1 ? FREQ_BLACK : FREQ_WHITE;
      }
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
  const head = vis ? visSegments(id) : [];
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

module.exports = { encodeSstv, visSegments, rgbToYuv, FREQ_SYNC, FREQ_BLACK, FREQ_WHITE, FREQ_LEADER };
