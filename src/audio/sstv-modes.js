'use strict';

/**
 * SSTV mode table and line layout, from slowrx (modespec.c and the
 * channel layout in GetVideo(), video.c), ISC licence; see
 * third_party/sstv/README.md. Times are in seconds.
 *
 * Portions copyright (c) 2007-2013, Oona Räisänen (OH2EIQ); used under the
 * ISC licence, whose full notice is in third_party/sstv/README.md.
 *
 *   sync    duration of the line sync pulse (1200 Hz)
 *   porch   duration of the porch after the sync pulse
 *   septr   duration of the separator between colour channels
 *   pixel   duration of one pixel
 *   line    time from one sync pulse to the next (for the PD modes, one
 *           "frame" carrying two image lines)
 *   width, lines   picture size; lineHeight 2 means each line is drawn twice
 *   color   'GBR' | 'RGB' | 'YUV' | 'BW': what the channels carry
 */

const MODES = {
  M1: { name: 'Martin M1', sync: 4.862e-3, porch: 0.572e-3, septr: 0.572e-3, pixel: 0.4576e-3, line: 446.446e-3, width: 320, lines: 256, lineHeight: 1, color: 'GBR' },
  M2: { name: 'Martin M2', sync: 4.862e-3, porch: 0.572e-3, septr: 0.572e-3, pixel: 0.2288e-3, line: 226.7986e-3, width: 320, lines: 256, lineHeight: 1, color: 'GBR' },
  M3: { name: 'Martin M3', sync: 4.862e-3, porch: 0.572e-3, septr: 0.572e-3, pixel: 0.2288e-3, line: 446.446e-3, width: 320, lines: 128, lineHeight: 2, color: 'GBR' },
  M4: { name: 'Martin M4', sync: 4.862e-3, porch: 0.572e-3, septr: 0.572e-3, pixel: 0.2288e-3, line: 226.7986e-3, width: 320, lines: 128, lineHeight: 2, color: 'GBR' },
  S1: { name: 'Scottie S1', sync: 9e-3, porch: 1.5e-3, septr: 1.5e-3, pixel: 0.432e-3, line: 428.38e-3, width: 320, lines: 256, lineHeight: 1, color: 'GBR' },
  S2: { name: 'Scottie S2', sync: 9e-3, porch: 1.5e-3, septr: 1.5e-3, pixel: 0.2752e-3, line: 277.692e-3, width: 320, lines: 256, lineHeight: 1, color: 'GBR' },
  SDX: { name: 'Scottie DX', sync: 9e-3, porch: 1.5e-3, septr: 1.5e-3, pixel: 1.08053e-3, line: 1050.3e-3, width: 320, lines: 256, lineHeight: 1, color: 'GBR' },
  // Robot 72: Y 138 ms, then R-Y and B-Y 69 ms each, each after a 4.5 ms separator and 1.5 ms porch
  // (N7CXI). slowrx has 92 ms for all three; see third_party/sstv/README.md.
  R72: { name: 'Robot 72', sync: 9e-3, porch: 3e-3, septr: 6e-3, pixel: 0.215625e-3, line: 300e-3, width: 320, lines: 240, lineHeight: 1, color: 'YUV' },
  R36: { name: 'Robot 36', sync: 9e-3, porch: 3e-3, septr: 6e-3, pixel: 0.1375e-3, line: 150e-3, width: 320, lines: 240, lineHeight: 1, color: 'YUV' },
  R24: { name: 'Robot 24', sync: 9e-3, porch: 3e-3, septr: 6e-3, pixel: 0.1375e-3, line: 150e-3, width: 320, lines: 240, lineHeight: 1, color: 'YUV' },
  R24BW: { name: 'Robot 24 B/W', sync: 7e-3, porch: 0, septr: 0, pixel: 0.291e-3, line: 100e-3, width: 320, lines: 240, lineHeight: 1, color: 'BW' },
  R12BW: { name: 'Robot 12 B/W', sync: 7e-3, porch: 0, septr: 0, pixel: 0.291e-3, line: 100e-3, width: 320, lines: 120, lineHeight: 2, color: 'BW' },
  R8BW: { name: 'Robot 8 B/W', sync: 7e-3, porch: 0, septr: 0, pixel: 0.1871875e-3, line: 66.9e-3, width: 320, lines: 120, lineHeight: 2, color: 'BW' },
  W2120: { name: 'Wraase SC-2 120', sync: 5.5225e-3, porch: 0.5e-3, septr: 0, pixel: 0.489039081e-3, line: 475.530018e-3, width: 320, lines: 256, lineHeight: 1, color: 'RGB' },
  W2180: { name: 'Wraase SC-2 180', sync: 5.5225e-3, porch: 0.5e-3, septr: 0, pixel: 0.734532e-3, line: 711.0225e-3, width: 320, lines: 256, lineHeight: 1, color: 'RGB' },
  PD50: { name: 'PD-50', sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.286e-3, line: 388.16e-3, width: 320, lines: 256, lineHeight: 1, color: 'YUV' },
  PD90: { name: 'PD-90', sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.532e-3, line: 703.04e-3, width: 320, lines: 256, lineHeight: 1, color: 'YUV' },
  PD120: { name: 'PD-120', sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.19e-3, line: 508.48e-3, width: 640, lines: 496, lineHeight: 1, color: 'YUV' },
  PD160: { name: 'PD-160', sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.382e-3, line: 804.416e-3, width: 512, lines: 400, lineHeight: 1, color: 'YUV' },
  PD180: { name: 'PD-180', sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.286e-3, line: 754.24e-3, width: 640, lines: 496, lineHeight: 1, color: 'YUV' },
  PD240: { name: 'PD-240', sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.382e-3, line: 1000e-3, width: 640, lines: 496, lineHeight: 1, color: 'YUV' },
  PD290: { name: 'PD-290', sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.286e-3, line: 937.28e-3, width: 800, lines: 616, lineHeight: 1, color: 'YUV' },
  P3: { name: 'Pasokon P3', sync: 5.208e-3, porch: 1.042e-3, septr: 1.042e-3, pixel: 0.2083e-3, line: 409.375e-3, width: 640, lines: 496, lineHeight: 1, color: 'RGB' },
  P5: { name: 'Pasokon P5', sync: 7.813e-3, porch: 1.563e-3, septr: 1.563e-3, pixel: 0.3125e-3, line: 614.065e-3, width: 640, lines: 496, lineHeight: 1, color: 'RGB' },
  P7: { name: 'Pasokon P7', sync: 10.417e-3, porch: 2.083e-3, septr: 2.083e-3, pixel: 0.4167e-3, line: 818.747e-3, width: 640, lines: 496, lineHeight: 1, color: 'RGB' },
};

/** 7-bit VIS code -> mode id (slowrx's VISmap; KB4YZ's list). */
const VIS_CODES = {
  0x02: 'R8BW', 0x04: 'R24', 0x06: 'R12BW', 0x08: 'R36', 0x0a: 'R24BW', 0x0c: 'R72',
  0x20: 'M4', 0x24: 'M3', 0x28: 'M2', 0x2c: 'M1',
  0x37: 'W2180', 0x38: 'S2', 0x3c: 'S1', 0x3f: 'W2120', 0x4c: 'SDX',
  0x5d: 'PD50', 0x5e: 'PD290', 0x5f: 'PD120', 0x60: 'PD180', 0x61: 'PD240', 0x62: 'PD160', 0x63: 'PD90',
  0x71: 'P3', 0x72: 'P5', 0x73: 'P7',
};
const VIS_OF_MODE = Object.fromEntries(Object.entries(VIS_CODES).map(([code, id]) => [id, Number(code)]));

const isPd = (id) => id.startsWith('PD');
const isScottie = (id) => id === 'S1' || id === 'S2' || id === 'SDX';
const isRobotColour = (id) => id === 'R36' || id === 'R24';

/** Channels per line: 1 (B/W), 2 (Robot 36/24: Y and one alternating chroma), 4 (PD: Y, R-Y, B-Y, Y), else 3. */
function numChannels(id) {
  if (MODES[id].color === 'BW') return 1;
  if (isRobotColour(id)) return 2;
  if (isPd(id)) return 4;
  return 3;
}

/** Start and length (s) of each channel, from the start of the line (slowrx GetVideo()). */
function channelLayout(id) {
  const m = MODES[id];
  const start = [0, 0, 0, 0];
  const len = [0, 0, 0, 0];
  if (id === 'R72') {
    len[0] = m.pixel * m.width * 2;
    len[1] = len[2] = m.pixel * m.width;
    start[0] = m.sync + m.porch;
    start[1] = start[0] + len[0] + m.septr;
    start[2] = start[1] + len[1] + m.septr;
  } else if (isRobotColour(id)) {
    len[0] = m.pixel * m.width * 2;
    len[1] = len[2] = m.pixel * m.width;
    start[0] = m.sync + m.porch;
    start[1] = start[0] + len[0] + m.septr;
    start[2] = start[1];
  } else if (isScottie(id)) {
    len[0] = len[1] = len[2] = m.pixel * m.width;
    start[0] = m.septr;
    start[1] = start[0] + len[0] + m.septr;
    start[2] = start[1] + len[1] + m.sync + m.porch;
  } else if (isPd(id)) {
    len[0] = len[1] = len[2] = len[3] = m.pixel * m.width;
    start[0] = m.sync + m.porch;
    start[1] = start[0] + len[0] + m.septr;
    start[2] = start[1] + len[1] + m.septr;
    start[3] = start[2] + len[2] + m.septr;
  } else {
    len[0] = len[1] = len[2] = m.pixel * m.width;
    start[0] = m.sync + m.porch;
    start[1] = start[0] + len[0] + m.septr;
    start[2] = start[1] + len[1] + m.septr;
  }
  return { start, len };
}

/** Line (sync-to-sync) periods in one picture: half the lines for PD, which sends two per period. */
function linePeriods(id) {
  return isPd(id) ? MODES[id].lines / 2 : MODES[id].lines;
}

/** Seconds of video after the VIS header. */
function videoSeconds(id) {
  return MODES[id].line * linePeriods(id);
}

/**
 * slowrx's pixel grid: for every pixel sample, the time (in samples from the
 * start of the video, at `rate`, plus `skip`) to read it and where it goes.
 * Returned as parallel typed arrays, in time order.
 */
function pixelGrid(id, rate, skip = 0) {
  const m = MODES[id];
  const nch = numChannels(id);
  const { start, len } = channelLayout(id);
  const t = [];
  const xs = [];
  const ys = [];
  const chs = [];
  const push = (time, x, y, ch) => {
    t.push(time);
    xs.push(x);
    ys.push(y);
    chs.push(ch);
  };
  if (nch === 4) {
    for (let y = 0; y < m.lines; y += 2) {
      for (let ch = 0; ch < 4; ch++) {
        for (let x = 0; x < m.width; x++) {
          const time = Math.round(rate * ((y / 2) * m.line + start[ch] + m.pixel * (x + 0.5))) + skip;
          if (ch === 0) push(time, x, y, 0);
          else if (ch === 1 || ch === 2) {
            push(time, x, y, ch);
            push(time, x, y + 1, ch);
          } else push(time, x, y + 1, 0);
        }
      }
    }
  } else {
    for (let y = 0; y < m.lines; y++) {
      for (let c = 0; c < nch; c++) {
        for (let x = 0; x < m.width; x++) {
          const ch = isRobotColour(id) ? (c === 1 ? (y % 2 === 0 ? 1 : 2) : 0) : c;
          const time = Math.round(rate * (y * m.line + start[c] + ((x - 0.5) / m.width) * len[ch])) + skip;
          push(time, x, y, ch);
        }
      }
    }
  }
  return { time: Int32Array.from(t), x: Uint16Array.from(xs), y: Uint16Array.from(ys), ch: Uint8Array.from(chs) };
}

const clip = (a) => (a < 0 ? 0 : a > 255 ? 255 : Math.round(a));

/** One output pixel from the stored channel values (slowrx's colour conversion). */
function toRgb(color, c0, c1, c2, out, o) {
  switch (color) {
    case 'RGB':
      out[o] = c0;
      out[o + 1] = c1;
      out[o + 2] = c2;
      break;
    case 'GBR':
      out[o] = c2;
      out[o + 1] = c0;
      out[o + 2] = c1;
      break;
    case 'YUV':
      out[o] = clip((100 * c0 + 140 * c1 - 17850) / 100);
      out[o + 1] = clip((100 * c0 - 71 * c1 - 33 * c2 + 13260) / 100);
      out[o + 2] = clip((100 * c0 + 178 * c2 - 22695) / 100);
      break;
    default:
      out[o] = out[o + 1] = out[o + 2] = c0;
  }
}

module.exports = { MODES, VIS_CODES, VIS_OF_MODE, numChannels, channelLayout, linePeriods, videoSeconds, pixelGrid, toRgb, clip, isPd, isScottie, isRobotColour };
