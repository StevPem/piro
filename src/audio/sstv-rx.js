'use strict';

/**
 * SSTV receiver: audio -> pictures, ported from slowrx by Oona Räisänen
 * OH2EIQ (ISC licence; https://github.com/windytan/slowrx: vis.c,
 * video.c, sync.c). See third_party/sstv/README.md.
 *
 * Portions copyright (c) 2007-2013, Oona Räisänen (OH2EIQ); used under the
 * ISC licence, whose full notice is in third_party/sstv/README.md.
 *
 * Same method as slowrx, at 12 kHz instead of 44.1 kHz:
 *
 *  1. Listen for the VIS header. Every 10 ms the strongest tone in a 20 ms
 *     window is found (Hann window, DFT with Gaussian peak interpolation).
 *     The last 450 ms of tones are checked for the end of the 1900 Hz leader,
 *     the 1200 Hz start bit, eight bits at 1100/1300 Hz and the stop bit,
 *     each within 25 Hz of where they should be *relative to the leader*,
 *     so a mistuned signal is still recognised and its offset ("header
 *     shift") is used for everything after.
 *  2. Receive the video. The instantaneous frequency is estimated every two
 *     samples from a short DFT whose window gets longer as the S/N drops
 *     (slowrx's adaptive noise reduction), turned into brightness, stored,
 *     and read out at each pixel's time. A separate test every four samples
 *     records where the 1200 Hz sync pulses are.
 *  3. When the picture ends, fix the slant: draw the recorded sync pulses as
 *     an image (one row per line), find the angle of the sync line with a
 *     Hough transform, correct the sample rate accordingly (up to three
 *     times), find the sync pulses' falling edge for the horizontal
 *     position, and redraw the whole picture from the stored brightness.
 *
 * The picture is handed out line by line as it arrives (uncorrected), and
 * once more, slant-corrected, when it ends.
 */

const { MODES, VIS_CODES, numChannels, channelLayout, linePeriods, pixelGrid, toRgb, clip, isScottie, isRobotColour, isPd } = require('./sstv-modes');

const SSTV_SAMPLE_RATE = 12000;
const R44 = SSTV_SAMPLE_RATE / 44100; // slowrx's sample counts, scaled

// slowrx sizes, in samples at 44.1 kHz, scaled to 12 kHz
const VIDEO_DFT_LEN = Math.round(1024 * R44); // 279: 43 Hz bins, as slowrx's 1024-point FFT
const VIS_DFT_LEN = Math.round(2048 * R44); // 557: 21.5 Hz bins
const HANN_LENS = [48, 64, 96, 128, 256, 512, 1024].map((n) => Math.round(n * R44));
const VIS_HOP = Math.round(0.01 * SSTV_SAMPLE_RATE); // 10 ms
const VIS_WIN = 2 * VIS_HOP; // 20 ms
const FREQ_STEP = 2; // slowrx: every 6 samples at 44.1 kHz
const SYNC_STEP = 4; // slowrx: every 13 samples
const SYNC_WIN = HANN_LENS[1];
const SNR_STEP = Math.round(256 * R44);
const LOOKAHEAD = VIDEO_DFT_LEN; // samples needed beyond the one being processed
const MIN_SLANT = 30;
const MAX_SLANT = 150;

const RING = 1 << 16;
const MASK = RING - 1;

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** slowrx GetBin(): the DFT bin a frequency falls in. */
const getBin = (f, n) => Math.floor((f / SSTV_SAMPLE_RATE) * n);

/** Power at selected bins of an n-point DFT of a short windowed segment (zero-padded to n). */
class Dft {
  constructor(n) {
    this.n = n;
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.seg = new Float64Array(n);
  }

  /** Loads `len` windowed samples centred on absolute index `centre` of the ring. */
  load(ring, centre, len, win) {
    const from = centre - (len >> 1);
    for (let i = 0; i < len; i++) this.seg[i] = ring[(from + i) & MASK] * win[i];
    this.len = len;
  }

  power(k) {
    const n = this.n;
    let re = 0;
    let im = 0;
    let idx = 0;
    for (let i = 0; i < this.len; i++) {
      const v = this.seg[i];
      re += v * this.cos[idx];
      im -= v * this.sin[idx];
      idx += k;
      if (idx >= n) idx -= n;
    }
    return re * re + im * im;
  }
}

/** Gaussian interpolation of a spectral peak (slowrx), in bins; null if it can't be done. */
function gaussPeak(pm1, p0, pp1) {
  if (!(pm1 > 0 && p0 > 0 && pp1 > 0)) return null;
  const v = Math.log(pp1 / pm1) / (2 * Math.log((p0 * p0) / (pp1 * pm1)));
  return Number.isFinite(v) ? v : null;
}

class SstvReceiver {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.adaptive=true] - slowrx's S/N-adaptive window
   * @param {number} [opts.lostSyncLines=12] - end a picture early when no sync pulse has been seen for this many lines (0: never)
   */
  constructor({ adaptive = true, lostSyncLines = 12 } = {}) {
    this.adaptive = adaptive;
    this.lostSyncLines = lostSyncLines;
    this.ring = new Float64Array(RING);
    this.written = 0; // absolute count of samples received
    this.pos = 0; // next absolute sample to process
    this.vdft = new Dft(VIDEO_DFT_LEN);
    this.visDft = new Dft(VIS_DFT_LEN);
    this.hanns = HANN_LENS.map(hann);
    this.visHann = hann(VIS_WIN);
    this.snr = 0;
    this._listen();
  }

  get state() {
    return this.pic ? 'receiving' : 'listening';
  }

  _listen() {
    this.pic = null;
    this.hedr = new Float64Array(45);
    this.hedrPtr = 0;
    this.nextHop = Math.max(this.pos, VIS_WIN);
  }

  /**
   * @param {ArrayLike<number>} samples - 12 kHz audio (any scale)
   * @returns {object[]} events: {type:'start', mode, name, width, lines, lineHeight, shiftHz},
   *   {type:'line', y, rgb}, {type:'end', mode, width, lines, rgb, rate, skip, slantDeg, complete}
   */
  process(samples) {
    const events = [];
    // in pieces, so a long buffer never overruns the ring before it is processed
    const piece = RING - 4 * LOOKAHEAD;
    for (let from = 0; from < samples.length; from += piece) {
      const to = Math.min(samples.length, from + piece);
      for (let i = from; i < to; i++) this.ring[(this.written + i - from) & MASK] = samples[i];
      this.written += to - from;
      while (this.pos + LOOKAHEAD < this.written) {
        if (this.pic) this._videoSample(events);
        else this._visSample(events);
        this.pos++;
      }
    }
    return events;
  }

  /** Ends a picture in progress now (e.g. we are about to transmit). */
  flush() {
    const events = [];
    if (this.pic) this._finish(events, false);
    return events;
  }

  // ---- VIS ----------------------------------------------------------

  _visSample(events) {
    if (this.pos < this.nextHop) return;
    this.nextHop += VIS_HOP;
    const d = this.visDft;
    d.load(this.ring, this.pos, VIS_WIN, this.visHann);
    const lo = getBin(500, VIS_DFT_LEN);
    const hi = getBin(3300, VIS_DFT_LEN);
    let maxBin = lo;
    let maxP = -1;
    const pw = new Float64Array(hi + 2);
    for (let k = lo - 1; k <= hi; k++) pw[k] = d.power(k);
    for (let k = lo; k < hi; k++) {
      if (pw[k] > maxP) {
        maxP = pw[k];
        maxBin = k;
      }
    }
    const prev = this.hedr[(this.hedrPtr + 44) % 45];
    let f = prev;
    if (maxBin > lo && maxBin < hi) {
      const g = gaussPeak(pw[maxBin - 1], pw[maxBin], pw[maxBin + 1]);
      if (g !== null) f = ((maxBin + g) / VIS_DFT_LEN) * SSTV_SAMPLE_RATE;
    }
    this.hedr[this.hedrPtr] = f;
    this.hedrPtr = (this.hedrPtr + 1) % 45;
    const tone = new Float64Array(45);
    for (let i = 0; i < 45; i++) tone[i] = this.hedr[(this.hedrPtr + i) % 45];

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const ref = tone[j];
        const near = (v, off, tol) => v > ref + off - tol && v < ref + off + tol;
        if (!(near(tone[3 + i], 0, 25) && near(tone[6 + i], 0, 25) && near(tone[9 + i], 0, 25) && near(tone[12 + i], 0, 25))) continue;
        if (!(near(tone[15 + i], -700, 25) && near(tone[42 + i], -700, 25))) continue;
        let vis = 0;
        let ok = true;
        const bits = [];
        for (let k = 0; k < 8; k++) {
          const v = tone[18 + i + 3 * k];
          if (near(v, -600, 25)) bits.push(0);
          else if (near(v, -800, 25)) bits.push(1);
          else {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        for (let k = 0; k < 7; k++) vis |= bits[k] << k;
        let parity = bits.slice(0, 7).reduce((a, b) => a ^ b, 0);
        const id = VIS_CODES[vis];
        if (id === 'R12BW') parity ^= 1;
        if (parity !== bits[7] || !id) continue;
        this._start(id, Math.round(ref - 1900), events);
        return;
      }
    }
  }

  // ---- video --------------------------------------------------------

  _start(id, shiftHz, events) {
    const m = MODES[id];
    // slowrx: skip the rest of the stop bit (20 ms) before the video
    const video0 = this.pos + Math.round(0.02 * SSTV_SAMPLE_RATE);
    const length = Math.floor(m.line * linePeriods(id) * SSTV_SAMPLE_RATE);
    const grid = pixelGrid(id, SSTV_SAMPLE_RATE, 0);
    // the last grid entry that writes each row, so rows go out when complete
    const rowLast = new Int32Array(m.lines).fill(-1);
    for (let k = 0; k < grid.time.length; k++) rowLast[grid.y[k]] = k;
    let gridIdx = 0;
    while (gridIdx < grid.time.length && grid.time[gridIdx] < 0) gridIdx++;
    const s = shiftHz;
    this.pic = {
      id,
      m,
      shiftHz,
      video0,
      length,
      lum: new Uint8Array(length + 1),
      hasSync: new Uint8Array(Math.ceil(length / SYNC_STEP) + 2),
      img: [new Uint8Array(m.width * m.lines), new Uint8Array(m.width * m.lines), new Uint8Array(m.width * m.lines)],
      grid,
      gridIdx,
      rowLast,
      n: -1,
      freq: 1500 + s,
      lastSyncAt: 0,
      bins: {
        lo: getBin(1500 + s, VIDEO_DFT_LEN),
        hi: getBin(2300 + s, VIDEO_DFT_LEN),
        mid: getBin(1900 + s, VIDEO_DFT_LEN),
        sync: getBin(1200 + s, VIDEO_DFT_LEN),
        n400: getBin(400 + s, VIDEO_DFT_LEN),
        n800: getBin(800 + s, VIDEO_DFT_LEN),
        n2700: getBin(2700 + s, VIDEO_DFT_LEN),
        n3400: getBin(3400 + s, VIDEO_DFT_LEN),
      },
    };
    this.snr = 0;
    events.push({ type: 'start', mode: id, name: m.name, width: m.width, lines: m.lines, lineHeight: m.lineHeight, shiftHz });
  }

  _videoSample(events) {
    const P = this.pic;
    if (this.pos < P.video0) return;
    const n = this.pos - P.video0;
    P.n = n;
    const d = this.vdft;
    const b = P.bins;

    if (n % SYNC_STEP === 0) {
      d.load(this.ring, this.pos, SYNC_WIN, this.hanns[1]);
      let praw = 0;
      for (let k = b.lo; k <= b.hi; k++) praw += d.power(k);
      let psync = 0;
      for (let k = b.sync - 1; k <= b.sync + 1; k++) psync += d.power(k) * (1 - 0.5 * Math.abs(b.sync - k));
      praw /= b.hi - b.lo;
      psync /= 2;
      const has = psync > 2 * praw;
      P.hasSync[n / SYNC_STEP] = has ? 1 : 0;
      if (has) P.lastSyncAt = n;
    }

    if (n % SNR_STEP === 0) {
      d.load(this.ring, this.pos, VIDEO_DFT_LEN, this.hanns[6]);
      let pv = 0;
      for (let k = b.lo; k <= b.hi; k++) pv += d.power(k);
      let pn = 0;
      for (let k = b.n400; k <= b.n800; k++) pn += d.power(k);
      for (let k = b.n2700; k <= b.n3400; k++) pn += d.power(k);
      const vBins = getBin(2300, VIDEO_DFT_LEN) - getBin(1500, VIDEO_DFT_LEN) + 1;
      const nBins = getBin(800, VIDEO_DFT_LEN) - getBin(400, VIDEO_DFT_LEN) + 1 + getBin(3400, VIDEO_DFT_LEN) - getBin(2700, VIDEO_DFT_LEN) + 1;
      const rBins = getBin(3400, VIDEO_DFT_LEN) - getBin(400, VIDEO_DFT_LEN);
      const pnoise = pn * (rBins / nBins);
      const psignal = pv - pn * (vBins / nBins);
      this.snr = pnoise > 0 && psignal / pnoise >= 0.01 ? 10 * Math.log10(psignal / pnoise) : -20;
    }

    if (n % FREQ_STEP === 0) {
      let wi = 0;
      if (this.adaptive) {
        const s = this.snr;
        wi = s >= 20 ? 0 : s >= 10 ? 1 : s >= 9 ? 2 : s >= 3 ? 3 : s >= -5 ? 4 : s >= -10 ? 5 : 6;
      }
      if (P.id === 'SDX' && wi < 6) wi++;
      d.load(this.ring, this.pos, HANN_LENS[wi], this.hanns[wi]);
      const lo = b.lo - 1;
      const hi = b.hi + 1;
      const pw = this._pw || (this._pw = new Float64Array(VIDEO_DFT_LEN));
      let maxBin = lo;
      for (let k = lo; k <= hi; k++) {
        pw[k] = d.power(k);
        if (pw[k] > pw[maxBin]) maxBin = k;
      }
      let f = null;
      if (maxBin > lo && maxBin < hi) {
        const g = gaussPeak(pw[maxBin - 1], pw[maxBin], pw[maxBin + 1]);
        f = ((maxBin + (g ?? 0)) / VIDEO_DFT_LEN) * SSTV_SAMPLE_RATE;
      } else f = (maxBin > b.mid ? 2300 : 1500) + P.shiftHz;
      P.freq = f;
    }

    const lum = clip((P.freq - (1500 + P.shiftHz)) / 3.1372549);
    P.lum[n] = lum;

    // pixels due at this sample
    const g = P.grid;
    while (P.gridIdx < g.time.length && g.time[P.gridIdx] === n) {
      const k = P.gridIdx;
      const x = g.x[k];
      const y = g.y[k];
      const ch = g.ch[k];
      P.img[ch][y * P.m.width + x] = lum;
      if (ch > 0 && isRobotColour(P.id) && y + 1 < P.m.lines) P.img[ch][(y + 1) * P.m.width + x] = lum;
      if (P.rowLast[y] === k) events.push({ type: 'line', y, rgb: this._row(P, y) });
      P.gridIdx++;
    }

    const lost = this.lostSyncLines > 0 && n - P.lastSyncAt > this.lostSyncLines * P.m.line * SSTV_SAMPLE_RATE;
    if (n + 1 >= P.length || lost) this._finish(events, !lost);
  }

  _row(P, y, img = P.img) {
    const W = P.m.width;
    const out = new Uint8Array(W * 3);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      toRgb(P.m.color, img[0][i], img[1][i], img[2][i], out, x * 3);
    }
    return out;
  }

  _finish(events, complete) {
    const P = this.pic;
    const recorded = Math.max(0, P.n + 1);
    const { rate, skip, slantDeg } = findSync(P.id, P.hasSync, recorded);
    // redraw from the stored brightness at the corrected rate
    const g = pixelGrid(P.id, rate, skip);
    const W = P.m.width;
    const img = [new Uint8Array(W * P.m.lines), new Uint8Array(W * P.m.lines), new Uint8Array(W * P.m.lines)];
    for (let k = 0; k < g.time.length; k++) {
      const t = g.time[k];
      if (t < 0 || t >= recorded) continue;
      const v = P.lum[t];
      img[g.ch[k]][g.y[k] * W + g.x[k]] = v;
      if (g.ch[k] > 0 && isRobotColour(P.id) && g.y[k] + 1 < P.m.lines) img[g.ch[k]][(g.y[k] + 1) * W + g.x[k]] = v;
    }
    const rgb = new Uint8Array(W * P.m.lines * 3);
    for (let y = 0; y < P.m.lines; y++) rgb.set(this._row(P, y, img), y * W * 3);
    const linesReceived = Math.min(P.m.lines, Math.ceil((recorded / (P.m.line * SSTV_SAMPLE_RATE)) * (isPd(P.id) ? 2 : 1)));
    events.push({ type: 'end', mode: P.id, name: P.m.name, width: W, lines: P.m.lines, lineHeight: P.m.lineHeight, rgb, rate, skip, slantDeg, complete, linesReceived, shiftHz: P.shiftHz });
    this._listen();
  }
}

/**
 * slowrx FindSync(): slant (sample-rate) and phase correction from the
 * recorded sync pulses. Returns the corrected rate, the number of samples
 * to skip at the start, and the last slant angle found (90 = straight).
 */
function findSync(id, hasSync, recorded) {
  const m = MODES[id];
  const frames = Math.min(linePeriods(id), Math.floor(recorded / (m.line * SSTV_SAMPLE_RATE)));
  const lineWidth = Math.floor((m.line / m.sync) * 4);
  const syncAt = (t, rate) => hasSync[Math.floor((t * rate) / SYNC_STEP)] === 1;
  let rate = SSTV_SAMPLE_RATE;
  let slantDeg = 90;
  const nq = (MAX_SLANT - MIN_SLANT) * 2;
  const sinT = new Float64Array(nq);
  const cosT = new Float64Array(nq);
  for (let q = 0; q < nq; q++) {
    const a = (((MIN_SLANT * 2 + q) / 2) * Math.PI) / 180;
    sinT[q] = Math.sin(a);
    cosT[q] = Math.cos(a);
  }
  if (frames >= 2) {
    for (let retries = 0; ; retries++) {
      const acc = new Uint16Array(lineWidth * nq);
      let best = -1;
      let qMost = -1;
      for (let y = 0; y < frames; y++) {
        for (let x = 0; x < lineWidth; x++) {
          const t = (y + x / lineWidth) * m.line;
          if (Math.floor((t * rate) / SYNC_STEP) >= Math.ceil(recorded / SYNC_STEP)) continue;
          if (!syncAt(t, rate)) continue;
          for (let q = 0; q < nq; q++) {
            const d = lineWidth + Math.round(-x * sinT[q] + y * cosT[q]);
            if (d > 0 && d < lineWidth) {
              const v = ++acc[d * nq + q];
              if (v > best) {
                best = v;
                qMost = q;
              }
            }
          }
        }
      }
      if (qMost < 0) {
        rate = SSTV_SAMPLE_RATE; // no sync signal
        break;
      }
      slantDeg = (MIN_SLANT * 2 + qMost) / 2;
      rate += (Math.tan(((90 - slantDeg) * Math.PI) / 180) / lineWidth) * rate;
      if (slantDeg > 89 && slantDeg < 91) break;
      if (retries === 3) {
        rate = SSTV_SAMPLE_RATE; // still slanted: give up
        break;
      }
    }
  }

  // horizontal position: the falling edge of the sync pulse, averaged over all lines
  const xAcc = new Uint32Array(700);
  for (let y = 0; y < frames; y++) {
    for (let x = 0; x < 700; x++) {
      const t = y * m.line + (x / 700) * m.line;
      if (syncAt(t, rate)) xAcc[x]++;
    }
  }
  let maxConv = 0;
  let xmax = 0;
  for (let x = 0; x < 700 - 8; x++) {
    let c = 0;
    for (let i = 0; i < 8; i++) c += xAcc[x + i] * (i < 4 ? 1 : -1);
    if (c > maxConv) {
      maxConv = c;
      xmax = x + 4;
    }
  }
  // Where the sync pulse ends within a line (slowrx assumes the line start,
  // with a special case for Scottie; this places it from the layout).
  const { start, len } = channelLayout(id);
  const syncEnd = (isScottie(id) ? start[1] + len[1] : 0) + m.sync;
  let s = (xmax / 700) * m.line - syncEnd;
  while (s > m.line / 2) s -= m.line;
  while (s <= -m.line / 2) s += m.line;
  const skip = maxConv > 0 ? Math.round(s * rate) : 0;
  return { rate, skip, slantDeg };
}

module.exports = { SstvReceiver, findSync, SSTV_SAMPLE_RATE, numChannels };
