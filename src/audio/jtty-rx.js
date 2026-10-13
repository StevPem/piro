'use strict';

/**
 * JTTY receiver: streaming decoder for WSJT-X's 4-GFSK JTTY mode.
 *
 * Feed it 12 kHz mono audio with push(); decoded messages are reported
 * through the `onMessage` callback as they grow, frame by frame, then
 * complete (JTTY is not slotted, so signals can start at any time).
 *
 * A port of the single-channel receive path of lib/jtty/{rjtty_sub.f90,
 * jtty_mdecode.f90 (jtty_mdecode, jtty_mdecode_step), jtty_peakup.f90,
 * subtract_jtty.f90, gen_syncwave.f90, ana64a.f90, twkfreq.f90,
 * jtty_payload_correlators.f90} from WSJT-X (GPL-3.0, (c) the WSJT
 * Development Group); see third_party/jtty/README.md. The error-correction
 * stage is in jtty-tbcc-decode.js and the source grammar in jtty-codec.js.
 *
 * How it works, per quarter-frame step (0.472 s) over a 1.25-frame window:
 *   1. analytic signal at 6 kHz;
 *   2. 13-symbol sync correlation over every start time in the quarter
 *      frame and every frequency in the search band (an FFT per start time);
 *   3. the strongest peaks are refined (time to ~0.7 ms, frequency to a
 *      fraction of a hertz), checked against the sync tones, and the 46
 *      coded symbols are correlated against the four tones and decoded;
 *   4. a decoded frame is re-encoded and subtracted so a weaker signal
 *      underneath can be found by a second pass;
 *   5. frames are chained into messages by frequency and one-frame timing.
 *
 * Not ported: the extra fixed 1350/1650 Hz search channels and the
 * "retro re-sweep" of earlier windows after a subtraction. The search band
 * is one configurable range (default 1000-2000 Hz) instead.
 */

const { IS13, tbccEncode, genJttyWave } = require('./jtty-tx');
const { unpackAtom, renderAtom, ATOM } = require('./jtty-codec');
const { tbccDecode } = require('./jtty-tbcc-decode');

const FS = 6000; // analytic-signal sample rate
const INPUT_RATE = 12000;
const NSPS = 384; // samples per symbol at 12 kHz
const NSS = NSPS / 2; // samples per symbol at 6 kHz
const BAUD = FS / NSS; // 31.25
const NSYNC_SYM = 13;
const NCHAN_SYM = 46;
const NFRAME_SYM = 59;
const NFRAME6 = NFRAME_SYM * NSS; // 11328
const NFRAME12 = NFRAME_SYM * NSPS; // 22656
const NCHUNK12 = NFRAME12 + NFRAME12 / 4; // 28320: one window
const NCHUNK6 = NCHUNK12 / 2;
const STEP12 = NFRAME12 / 4; // 5664: window advance
const NANA = 32768; // next power of two above the window
const NFFT = 8192; // sync search FFT, df = 0.732 Hz
const NH2 = NFFT / 2;
const DF2 = FS / NFFT;
const NTSTEP = NFRAME6 / 4; // start times searched per window, in 6 kHz samples
const FINE_GRID = 12; // search resolution in 6 kHz samples (2 ms), as WSJT-X
const COARSE_GRID = 24;
const ECONOMY_GRID = 48; // 'economy' mode: a quarter of the sync-search FFTs // 'light' mode: half the sync-search FFTs (peak refinement still reaches 0.7 ms)
const NFZ = Math.round(10 / DF2); // 14: frequency zone blanked around a peak
const FRAME_PERIOD = NFRAME12 / INPUT_RATE; // 1.888 s

const DEFAULT_SMIN = 4.6;
const SNR_LEAKAGE_FLOOR_DB = -17.0;
const MAX_ACTIVE_MESSAGES = 30;
const MAX_RECENT_FRAMES = MAX_ACTIVE_MESSAGES * 16;
const MAX_CONTINUATION_GAP = 3;
const MAX_RETRO_STEPS = 3; // only used to keep the reference's pruning arithmetic
const FRAME_HISTORY_TIME_TOLERANCE = 0.05;
const NEAR_SIMULTANEOUS_FREQ_TOLERANCE = 12.0;
const FRAME_HISTORY_FREQ_TOLERANCE = 3.0;
const CONTINUATION_TIME_TOLERANCE = 0.1;
const MAX_MESSAGE_CHARS = 80;
const MAX_CANDIDATES = 100;
const SUBTRACT_FILTER = 2 * NSS;

const db = (x) => 10 * Math.log10(x);
// Fortran NINT: round half away from zero
const nint = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

// ---------------------------------------------------------------------
// FFT helpers (fft.js is a plain radix-2 with per-call trig; the search
// below runs hundreds of 8192-point transforms per window, so use tables)
// ---------------------------------------------------------------------

const plans = new Map();
function fftPlan(n) {
  let plan = plans.get(n);
  if (plan) return plan;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  // contiguous twiddles per stage (len = 8, 16, ..., n); the first two stages need none
  const stages = [];
  for (let len = 8; len <= n; len <<= 1) {
    const half = len >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / len);
      sin[k] = Math.sin((2 * Math.PI * k) / len);
    }
    stages.push({ len, half, cos, sin });
  }
  plan = { rev, stages };
  plans.set(n, plan);
  return plan;
}

/** In-place complex FFT. sign -1: forward (e^-i), +1: inverse (unnormalised), like four2a. */
function fft(re, im, n, sign) {
  const { rev, stages } = fftPlan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  // stages of length 2 and 4 fused: trivial twiddles (1, -+i)
  for (let s = 0; s < n; s += 4) {
    const r0 = re[s] + re[s + 1];
    const i0 = im[s] + im[s + 1];
    const r1 = re[s] - re[s + 1];
    const i1 = im[s] - im[s + 1];
    const r2 = re[s + 2] + re[s + 3];
    const i2 = im[s + 2] + im[s + 3];
    const r3 = re[s + 2] - re[s + 3];
    const i3 = im[s + 2] - im[s + 3];
    re[s] = r0 + r2;
    im[s] = i0 + i2;
    re[s + 2] = r0 - r2;
    im[s + 2] = i0 - i2;
    if (sign < 0) {
      // multiply (r3, i3) by -i
      re[s + 1] = r1 + i3;
      im[s + 1] = i1 - r3;
      re[s + 3] = r1 - i3;
      im[s + 3] = i1 + r3;
    } else {
      re[s + 1] = r1 - i3;
      im[s + 1] = i1 + r3;
      re[s + 3] = r1 + i3;
      im[s + 3] = i1 - r3;
    }
  }
  const sg = sign < 0 ? -1 : 1;
  for (let st = 0; st < stages.length; st++) {
    const { len, half, cos, sin } = stages[st];
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k];
        const wi = sg * sin[k];
        const a = start + k;
        const b = a + half;
        const br = re[b];
        const bi = im[b];
        const xr = br * wr - bi * wi;
        const xi = br * wi + bi * wr;
        const ar = re[a];
        const ai = im[a];
        re[b] = ar - xr;
        im[b] = ai - xi;
        re[a] = ar + xr;
        im[a] = ai + xi;
      }
    }
  }
}

// ---------------------------------------------------------------------
// Fixed waveforms and filters
// ---------------------------------------------------------------------

/** 13-symbol sync waveform (continuous phase), gen_syncwave.f90. */
const SYNC = (() => {
  const re = new Float64Array(NSYNC_SYM * NSS);
  const im = new Float64Array(NSYNC_SYM * NSS);
  let k = 0;
  let phi = 0;
  for (let i = 0; i < NSYNC_SYM; i++) {
    const dphi = (2 * Math.PI * BAUD * IS13[i]) / FS;
    for (let j = 0; j < NSS; j++) {
      re[k] = Math.cos(phi);
      im[k] = Math.sin(phi);
      k++;
      phi += dphi;
    }
  }
  return { re, im };
})();

/** Tone reference waveforms: tone i is exp(i 2 pi i j / NSS). */
const TONES = (() => {
  const re = [];
  const im = [];
  for (let t = 0; t < 4; t++) {
    const r = new Float64Array(NSS);
    const m = new Float64Array(NSS);
    for (let j = 0; j < NSS; j++) {
      r[j] = Math.cos((2 * Math.PI * t * j) / NSS);
      m[j] = Math.sin((2 * Math.PI * t * j) / NSS);
    }
    re.push(r);
    im.push(m);
  }
  return { re, im };
})();

/** Frequency response of the 2-symbol raised-cosine low-pass used when subtracting (subtract_jtty.f90). */
let subtractFilter = null;
function getSubtractFilter() {
  if (subtractFilter) return subtractFilter;
  const nfilt = SUBTRACT_FILTER;
  const re = new Float64Array(NANA);
  const im = new Float64Array(NANA);
  let sumw = 0;
  const w = [];
  for (let j = -nfilt / 2; j <= nfilt / 2; j++) {
    const v = Math.cos((Math.PI * j) / nfilt) ** 2;
    w.push(v);
    sumw += v;
  }
  // zero-phase: the centre tap (j = 0) goes to index 0, negative taps wrap to the end
  for (let j = -nfilt / 2; j <= nfilt / 2; j++) {
    const idx = (j + NANA) % NANA;
    re[idx] = w[j + nfilt / 2] / sumw;
  }
  fft(re, im, NANA, -1);
  for (let i = 0; i < NANA; i++) {
    re[i] /= NANA;
    im[i] /= NANA;
  }
  subtractFilter = { re, im };
  return subtractFilter;
}

// ---------------------------------------------------------------------
// Signal processing steps
// ---------------------------------------------------------------------

/** ana64a.f90: real audio at 12 kHz -> analytic signal at 6 kHz (arrays of NANA, valid [0, NCHUNK6)). */
function analytic(x) {
  const re = new Float64Array(NANA);
  const im = new Float64Array(NANA);
  const fac = 2 / NANA;
  for (let i = 0; i < NCHUNK12; i++) re[i] = fac * x[i];
  fft(re, im, NANA, -1);
  const nfft2 = NANA / 2;
  for (let i = nfft2 / 2 + 1; i < nfft2; i++) {
    re[i] = 0;
    im[i] = 0;
  }
  re[0] *= 0.5;
  im[0] *= 0.5;
  const ore = re.slice(0, nfft2);
  const oim = im.slice(0, nfft2);
  fft(ore, oim, nfft2, +1);
  const cre = new Float64Array(NANA);
  const cim = new Float64Array(NANA);
  cre.set(ore.subarray(0, NCHUNK6));
  cim.set(oim.subarray(0, NCHUNK6));
  return { re: cre, im: cim };
}

/** twkfreq.f90 (constant-frequency case): out[n] = exp(i 2 pi f (n+1)/FS) in[n]. */
function shiftFrequency(inRe, inIm, outRe, outIm, npts, hz) {
  const dphi = (hz * 2 * Math.PI) / FS;
  const sr = Math.cos(dphi);
  const si = Math.sin(dphi);
  let wr = 1;
  let wi = 0;
  for (let n = 0; n < npts; n++) {
    const t = wr * sr - wi * si;
    wi = wr * si + wi * sr;
    wr = t;
    outRe[n] = wr * inRe[n] - wi * inIm[n];
    outIm[n] = wr * inIm[n] + wi * inRe[n];
    if ((n & 1023) === 1023) {
      const norm = 1 / Math.hypot(wr, wi);
      wr *= norm;
      wi *= norm;
    }
  }
}

/**
 * jtty_peakup.f90: refine a coarse sync candidate in time (+-4 ms, 0.67 ms
 * steps) and frequency (+-2.5 Hz in 0.5 Hz steps, then a phase-slope fit
 * across the 13 sync symbols for the sub-0.5 Hz remainder).
 */
function peakup(c0, work, xdt0, f0) {
  const npsync = NSYNC_SYM * NSS;
  const hop = 4;
  const dt = 1 / FS;
  const qre = new Float64Array(NSYNC_SYM);
  const qim = new Float64Array(NSYNC_SYM);
  for (let i = 0; i < NSYNC_SYM; i++) {
    const s = i * NSS;
    // qstep = csync(s+hop) * conj(csync(s))
    qre[i] = SYNC.re[s + hop] * SYNC.re[s] + SYNC.im[s + hop] * SYNC.im[s];
    qim[i] = SYNC.im[s + hop] * SYNC.re[s] - SYNC.re[s + hop] * SYNC.im[s];
  }
  const ia = Math.max(0, nint((xdt0 - 0.004) / dt));
  const ib = Math.min(NCHUNK6 - npsync, nint((xdt0 + 0.004) / dt));

  let pmax = 0;
  let fpk = 0;
  let xdtpk = 0;
  const zbr = new Float64Array(NSYNC_SYM);
  const zbi = new Float64Array(NSYNC_SYM);
  const zr = new Float64Array(NSYNC_SYM);
  const zi = new Float64Array(NSYNC_SYM);
  work.re.fill(0, 0, NCHUNK6);
  work.im.fill(0, 0, NCHUNK6);

  for (let idf = -5; idf <= 5; idf++) {
    const shift = -f0 + 0.5 * idf;
    shiftFrequency(c0.re, c0.im, work.re, work.im, ib + npsync, shift);
    if (ia > ib) continue;
    const cr = work.re;
    const ci = work.im;
    for (let i = 0; i < NSYNC_SYM; i++) {
      let sr = 0;
      let si = 0;
      const s0 = i * NSS;
      for (let n = 0; n < NSS; n++) {
        const a = SYNC.re[s0 + n];
        const b = SYNC.im[s0 + n];
        const xr = cr[ia + s0 + n];
        const xi = ci[ia + s0 + n];
        sr += a * xr + b * xi; // conj(csync) * c1
        si += a * xi - b * xr;
      }
      zr[i] = sr;
      zi[i] = si;
    }
    for (let i0 = ia; i0 <= ib; i0 += hop) {
      let p = 0;
      for (let i = 0; i < NSYNC_SYM; i++) p += zr[i] * zr[i] + zi[i] * zi[i];
      if (p > pmax) {
        pmax = p;
        fpk = -shift;
        xdtpk = i0 * dt;
        zbr.set(zr);
        zbi.set(zi);
      }
      if (i0 + hop <= ib) {
        for (let i = 0; i < NSYNC_SYM; i++) {
          const s0 = i * NSS;
          let rr = 0;
          let ri = 0;
          for (let r = 0; r < hop; r++) {
            const a = SYNC.re[s0 + r];
            const b = SYNC.im[s0 + r];
            const xr = cr[i0 + s0 + r];
            const xi = ci[i0 + s0 + r];
            rr += a * xr + b * xi;
            ri += a * xi - b * xr;
          }
          // zcur = qstep * (zcur - removed)
          const dr = zr[i] - rr;
          const di = zi[i] - ri;
          let nr = qre[i] * dr - qim[i] * di;
          let ni = qre[i] * di + qim[i] * dr;
          let ar = 0;
          let ai = 0;
          for (let r = 0; r < hop; r++) {
            const a = SYNC.re[s0 + NSS - hop + r];
            const b = SYNC.im[s0 + NSS - hop + r];
            const xr = cr[i0 + s0 + NSS + r];
            const xi = ci[i0 + s0 + NSS + r];
            ar += a * xr + b * xi;
            ai += a * xi - b * xr;
          }
          nr += ar;
          ni += ai;
          zr[i] = nr;
          zi[i] = ni;
        }
      }
    }
  }

  // Stage 2: remove the near-linear phase ramp across the 13 sync symbols.
  if (pmax > 0) {
    const tsym = NSS / FS;
    const uw = new Float64Array(NSYNC_SYM);
    let prev = Math.atan2(zbi[0], zbr[0]);
    uw[0] = prev;
    for (let i = 1; i < NSYNC_SYM; i++) {
      const ph = Math.atan2(zbi[i], zbr[i]);
      let dphi = ph - prev;
      while (dphi > Math.PI) dphi -= 2 * Math.PI;
      while (dphi < -Math.PI) dphi += 2 * Math.PI;
      uw[i] = uw[i - 1] + dphi;
      prev = ph;
    }
    const xm = 6;
    let ym = 0;
    for (let i = 0; i < NSYNC_SYM; i++) ym += uw[i];
    ym /= 13;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < NSYNC_SYM; i++) {
      sxy += (i - xm) * (uw[i] - ym);
      sxx += (i - xm) ** 2;
    }
    const slope = sxy / sxx;
    const intercept = ym - slope * xm;
    let resid = 0;
    for (let i = 0; i < NSYNC_SYM; i++) resid += (uw[i] - (slope * i + intercept)) ** 2;
    const residRms = Math.sqrt(resid / 13);
    const dfhz = slope / (2 * Math.PI * tsym);
    if (residRms < 1.0 && Math.abs(dfhz) <= 0.5) {
      let tr = 0;
      let ti = 0;
      for (let i = 0; i < NSYNC_SYM; i++) {
        const c = Math.cos(-slope * i);
        const s = Math.sin(-slope * i);
        tr += zbr[i] * c - zbi[i] * s;
        ti += zbr[i] * s + zbi[i] * c;
      }
      fpk += dfhz;
      pmax = tr * tr + ti * ti;
    }
  }
  return { xdt: xdtpk, f1: fpk, power: pmax };
}

/**
 * Correlates the 46 coded symbols with the four tones, from a frequency-
 * shifted analytic signal `c1`; payloadStart is a 6 kHz sample index.
 */
function correlatePayload(c1, payloadStart) {
  const zRe = new Float64Array(4 * NCHAN_SYM);
  const zIm = new Float64Array(4 * NCHAN_SYM);
  const half = new Float64Array(4 * NCHAN_SYM);
  const avail = Math.min(NCHAN_SYM, Math.floor((NCHUNK6 - payloadStart) / NSS));
  const h = NSS / 2;
  for (let sym = 0; sym < avail; sym++) {
    const first = payloadStart + sym * NSS;
    for (let t = 0; t < 4; t++) {
      const tr = TONES.re[t];
      const ti = TONES.im[t];
      let fr = 0;
      let fi = 0;
      let energy = 0;
      for (let seg = 0; seg < 2; seg++) {
        let hr = 0;
        let hi = 0;
        for (let o = seg * h; o < (seg + 1) * h; o++) {
          const xr = c1.re[first + o];
          const xi = c1.im[first + o];
          hr += tr[o] * xr + ti[o] * xi; // x * conj(ref)
          hi += tr[o] * xi - ti[o] * xr;
        }
        fr += hr;
        fi += hi;
        energy += hr * hr + hi * hi;
      }
      zRe[t * NCHAN_SYM + sym] = fr;
      zIm[t * NCHAN_SYM + sym] = fi;
      half[t * NCHAN_SYM + sym] = Math.sqrt(energy);
    }
  }
  return { zRe, zIm, half };
}

/** subtract_jtty.f90: remove a decoded frame from the analytic signal in place. */
function subtractFrame(c0, tones59, f1, xdt) {
  const nframe = NFRAME_SYM * NSS;
  const cref = genJttyWave(tones59, { sampleRate: FS, nsps: NSS, f0: f1, complex: true });
  const nstart = nint(xdt * FS);
  const re = new Float64Array(NANA);
  const im = new Float64Array(NANA);
  for (let i = 0; i < nframe; i++) {
    const j = nstart + i;
    if (j >= 0 && j < NCHUNK6) {
      // c0 * conj(cref)
      re[i] = c0.re[j] * cref.re[i] + c0.im[j] * cref.im[i];
      im[i] = c0.im[j] * cref.re[i] - c0.re[j] * cref.im[i];
    }
  }
  fft(re, im, NANA, -1);
  const { re: hr, im: hi } = getSubtractFilter();
  for (let i = 0; i < NANA; i++) {
    const a = re[i] * hr[i] - im[i] * hi[i];
    im[i] = re[i] * hi[i] + im[i] * hr[i];
    re[i] = a;
  }
  fft(re, im, NANA, +1);
  for (let i = 0; i < nframe; i++) {
    const j = nstart + i;
    if (j >= 0 && j < NCHUNK6) {
      c0.re[j] -= re[i] * cref.re[i] - im[i] * cref.im[i];
      c0.im[j] -= re[i] * cref.im[i] + im[i] * cref.re[i];
    }
  }
}

// ---------------------------------------------------------------------
// Frame text
// ---------------------------------------------------------------------

/**
 * unpack_jtty() for one frame given as 34 bits (0/1 array).
 * @returns {{valid: boolean, text: string, trailingSep: boolean, isLast: boolean}}
 */
function unpackPayload(bits) {
  const frame = bits.join('');
  const un = unpackAtom(frame);
  if (!un.valid) return { valid: false, text: '', trailingSep: false, isLast: false };
  const rendered = renderAtom(un.atom);
  if (rendered === null) return { valid: false, text: '', trailingSep: false, isLast: false };
  if (un.atom.kind === ATOM.TEXT5) {
    return { valid: true, text: rendered.replace(/ /g, '~'), trailingSep: false, isLast: !!un.eom };
  }
  return { valid: true, text: rendered, trailingSep: true, isLast: !!un.eom };
}

/** display_message_text(): ~~~~~ -> " ... ", ~ -> space, and drop one leading space. */
function displayText(decoded) {
  let msg = decoded.replace(/~~~~~/g, ' ... ').replace(/~/g, ' ');
  if (msg.startsWith(' ')) msg = msg.slice(1);
  return msg.replace(/\s+$/, '');
}

// ---------------------------------------------------------------------
// The receiver
// ---------------------------------------------------------------------

class JttyReceiver {
  /**
   * @param {object} [opts]
   * @param {(update: object) => void} [opts.onMessage] - called with {id, freqHz, snr, text, status: 'growing'|'complete'|'expired', startTime, latestTime}
   * @param {number} [opts.lowHz=1000] - lower edge of the search band (audio Hz)
   * @param {number} [opts.highHz=2000] - upper edge of the search band
   * @param {number} [opts.smin=4.6] - minimum sync SNR (dB) to attempt a decode
   */
  constructor({ onMessage, onDebug, lowHz = 1000, highHz = 2000, smin = DEFAULT_SMIN, light = false } = {}) {
    this.setLight(light);
    this.onMessage = onMessage || (() => {});
    this.onDebug = onDebug || null;
    this.setBand(lowHz, highHz);
    this.smin = smin;
    this.reset();
  }

  /**
   * Search effort. Start times are searched on a 2 ms grid (level 0, as WSJT-X), 4 ms (1, light: ~40% less CPU)
   * or 8 ms (2, economy: ~60% less CPU). In a noise test economy decoded as many weak signals as light
   * and within one in 24 of full, because the peak refinement recovers the timing.
   */
  setLight(light) {
    // false/0 = full, true/1 = light, 2 = economy
    this.level = light === true ? 1 : Number(light) || 0;
    this.light = this.level > 0;
    this.grid = this.level >= 2 ? ECONOMY_GRID : this.level === 1 ? COARSE_GRID : FINE_GRID;
    this.ncols = Math.floor(NTSTEP / this.grid) + 1;
    this.ntz = Math.round((0.016 * FS) / this.grid);
  }

  setBand(lowHz, highHz) {
    const lo = Math.max(200, Math.min(lowHz, highHz));
    const hi = Math.min(2900, Math.max(lowHz, highHz));
    this.lowHz = lo;
    this.highHz = hi;
    // Channel 0 is the operator's band (with sync refinement); channels 1 and 2
    // are WSJT-X's fixed 1350/1650 Hz +-150 Hz searches, which try the
    // unrefined peak (refinement occasionally lands on the wrong side of a
    // weak signal) with a stricter sync gate.
    this.channels = [
      this._channel(0, (lo + hi) / 2, (hi - lo) / 2, false),
      this._channel(1, 1350, 150, true),
      this._channel(2, 1650, 150, true),
    ];
    const usable = this.channels.filter((c) => c.usable);
    this.firstBin = Math.min(...usable.map((c) => c.ja));
    this.lastBin = Math.max(...usable.map((c) => c.jb));
  }

  /** jtty_search_window(): the bin range a channel covers. */
  _channel(ichan, fc, fwid, constrain) {
    const NFA = 200;
    const NFB = 2800;
    let ja = Math.max(3, Math.trunc((fc - fwid) / DF2));
    let jb = Math.min(NH2 - 2, Math.trunc((fc + fwid) / DF2));
    if (constrain) {
      ja = Math.max(ja, Math.ceil(NFA / DF2));
      jb = Math.min(jb, Math.floor(NFB / DF2));
    }
    return { ichan, fc, fwid, ja, jb, usable: ja <= jb };
  }

  reset() {
    this.buffer = new Float32Array(0);
    this.consumed = 0; // absolute index of buffer[0]
    this.nextStart = 0; // absolute index of the next window
    this.active = [];
    this.recent = [];
    this.nextId = 1;
    this.stats = { windows: 0, decodes: 0, attempts: 0 };
  }

  /** Feeds 12 kHz mono audio (Float32 in [-1, 1], or Int16). Returns the number of windows processed. */
  push(samples) {
    const add = samples instanceof Float32Array ? samples : Float32Array.from(samples, (v) => v / 32768);
    const merged = new Float32Array(this.buffer.length + add.length);
    merged.set(this.buffer);
    merged.set(add, this.buffer.length);
    this.buffer = merged;
    let n = 0;
    while (this.nextStart + NCHUNK12 <= this.consumed + this.buffer.length) {
      const off = this.nextStart - this.consumed;
      this._window(this.buffer.subarray(off, off + NCHUNK12), this.nextStart);
      this.nextStart += STEP12;
      n++;
    }
    const drop = this.nextStart - this.consumed;
    if (drop > 0) {
      this.buffer = this.buffer.slice(drop);
      this.consumed += drop;
    }
    return n;
  }

  /** Finishes: expires any message still waiting for a continuation. */
  flush() {
    for (const msg of this.active) this._emit(msg, 'expired');
    this.active = [];
  }

  // -- one window ------------------------------------------------------

  _window(x, startIndex) {
    this.stats.windows++;
    const tStart = startIndex / INPUT_RATE;
    this._prune(tStart);
    let silent = true;
    for (let i = 0; i < x.length; i += 7) {
      if (x[i] !== 0) {
        silent = false;
        break;
      }
    }
    if (silent) return;

    const c0 = analytic(x);
    const c1 = { re: new Float64Array(NCHUNK6), im: new Float64Array(NCHUNK6) };
    const ctx = { c0, c1, tStart, cands: [], ok0: [], subtracted: false, s0: null, s0Valid: false };
    const [ch0, ch1, ch2] = this.channels;

    // Phase A: channel 0 gets first claim on every signal (up to two passes;
    // the second searches the residual after the first pass's subtractions).
    for (let pass = 1; pass <= 2; pass++) {
      if (pass === 2 && !ctx.subtracted) break;
      if (!ctx.s0Valid) this._buildSurface(ctx);
      this._processChannel(ctx, ch0);
    }
    // Phase B: the fixed channels, on the leftovers.
    ctx.subtracted = false;
    for (let pass = 1; pass <= 2; pass++) {
      if (pass === 2 && !ctx.subtracted) break;
      if (!ctx.s0Valid) this._buildSurface(ctx);
      for (const ch of [ch1, ch2]) this._processChannel(ctx, ch);
      ctx.s0Valid = false;
    }
  }

  /** The FFT-correlation sync surface s0[col * nbins + bin - firstBin], smoothed over 5 bins. */
  _buildSurface(ctx) {
    const { c0 } = ctx;
    const first = this.firstBin;
    const nbins = this.lastBin - first + 1;
    const s0 = new Float32Array(this.ncols * nbins);
    const re = new Float64Array(NFFT);
    const im = new Float64Array(NFFT);
    const pw = new Float64Array(nbins + 4);
    const n13 = NSYNC_SYM * NSS;
    for (let col = 0; col < this.ncols; col++) {
      const i0 = col * this.grid;
      re.fill(0);
      im.fill(0);
      for (let k = 0; k < n13; k++) {
        const xr = c0.re[i0 + k];
        const xi = c0.im[i0 + k];
        re[k] = SYNC.re[k] * xr + SYNC.im[k] * xi; // conj(csync) * c0
        im[k] = SYNC.re[k] * xi - SYNC.im[k] * xr;
      }
      fft(re, im, NFFT, -1);
      for (let j = first - 2; j <= this.lastBin + 2; j++) pw[j - first + 2] = re[j] * re[j] + im[j] * im[j];
      const row = col * nbins;
      for (let b = 0; b < nbins; b++) {
        s0[row + b] = pw[b] + 2 * pw[b + 1] + 3 * pw[b + 2] + 2 * pw[b + 3] + pw[b + 4];
      }
    }
    ctx.s0 = s0;
    ctx.nbins = nbins;
    ctx.s0Valid = true;
  }

  /** One channel's candidate search (process_channel in jtty_mdecode.f90). */
  _processChannel(ctx, ch) {
    if (!ch.usable) return;
    const { s0, nbins, c0, c1 } = ctx;
    const first = this.firstBin;
    const lo = ch.ja - first; // bin range within the surface
    const hi = ch.jb - first;
    const nc0 = ch.ichan === 0 ? Math.max(2, Math.min(8, nint(ch.fwid / (NFZ * DF2)))) : 2;
    let decodedAny = false;

    if (ch.ichan !== 0) {
      // channel 0's decoded signals must not be rediscovered here
      for (const ok of ctx.ok0) {
        const a = Math.max(ch.ja, ok.ja);
        const b = Math.min(ch.jb, ok.jb);
        if (a > b) continue;
        for (let col = 0; col < this.ncols; col++) s0.fill(0, col * nbins + a - first, col * nbins + b - first + 1);
      }
    }
    // channel 0 blanks peaks in a private mask so channels 1 and 2 still see the surface
    const mask = ch.ichan === 0 ? new Uint8Array(this.ncols * nbins).fill(1) : null;

    for (let ic = 0; ic < nc0; ic++) {
      let best = -1;
      let bestVal = -Infinity;
      for (let col = 0; col < this.ncols; col++) {
        const row = col * nbins;
        for (let b = lo; b <= hi; b++) {
          if (mask && !mask[row + b]) continue;
          if (s0[row + b] > bestVal) {
            bestVal = s0[row + b];
            best = row + b;
          }
        }
      }
      if (best < 0 || (!mask && bestVal <= 0)) break;
      const peakCol = Math.floor(best / nbins);
      const peakBin = best % nbins;
      // blank a zone around the peak (the reference zone is one bin wider on the high side)
      const b1 = Math.max(lo, peakBin + 1 - NFZ);
      const b2 = Math.min(hi, peakBin + 1 + NFZ);
      const k1 = Math.max(0, peakCol + 1 - this.ntz);
      const k2 = Math.min(this.ncols - 1, peakCol + 1 + this.ntz);
      for (let col = k1; col <= k2; col++) {
        if (mask) mask.fill(0, col * nbins + b1, col * nbins + b2 + 1);
        else s0.fill(0, col * nbins + b1, col * nbins + b2 + 1);
      }

      let f1 = (peakBin + first) * DF2;
      let xdt = (peakCol * this.grid) / FS;
      const coarseF = f1;
      const coarseT = xdt;
      if (ch.ichan === 0) {
        const peak = peakup(c0, c1, xdt, f1);
        f1 = peak.f1;
        xdt = peak.xdt;
      }
      if (ctx.cands.length >= MAX_CANDIDATES) break;
      const cand = { xdt, f1, snr: -99.9, decoded: '', tsync: 0, isLast: false, trailingSep: false, ichan: ch.ichan };
      ctx.cands.push(cand);

      shiftFrequency(c0.re, c0.im, c1.re, c1.im, NCHUNK6, -cand.f1);
      const sync = this._syncPower(c1, cand.xdt);
      cand.snr = sync.snr;
      if (this.onDebug) this.onDebug({ t: ctx.tStart, ichan: ch.ichan, coarseF, coarseT, f1: cand.f1, xdt: cand.xdt, nsync: sync.nsync, snr: sync.snr });
      if (ch.ichan === 0 ? sync.nsync <= 6 || sync.snr < this.smin : sync.nsync <= 8 || sync.snr < 5.0) continue;
      if (this._decodeAndMerge(ctx, cand, sync)) {
        decodedAny = true;
        if (ch.ichan === 0 && ctx.ok0.length < 16) {
          const bin = nint(cand.f1 / DF2);
          ctx.ok0.push({ ja: bin - NFZ, jb: bin + NFZ, f1: cand.f1, tsync: cand.tsync });
        }
      }
    }

    if (!decodedAny) this._stickyRetry(ctx, ch);
  }

  /** Tone powers of the 13 sync symbols at a candidate: hard-decision match count and SNR. */
  _syncPower(c1, xdt) {
    let pt = 0;
    let pa = 0;
    let nsync = 0;
    for (let j = 0; j < NSYNC_SYM; j++) {
      const i0 = nint(xdt * FS) + j * NSS;
      if (i0 + NSS > NCHUNK6) break;
      let best = 0;
      let bestPow = -1;
      let sum = 0;
      let own = 0;
      for (let t = 0; t < 4; t++) {
        let zr = 0;
        let zi = 0;
        const tr = TONES.re[t];
        const ti = TONES.im[t];
        for (let n = 0; n < NSS; n++) {
          const xr = c1.re[i0 + n];
          const xi = c1.im[i0 + n];
          zr += tr[n] * xr + ti[n] * xi; // conj(tone) * c1
          zi += tr[n] * xi - ti[n] * xr;
        }
        const p = zr * zr + zi * zi;
        sum += p;
        if (t === IS13[j]) own = p;
        if (p > bestPow) {
          bestPow = p;
          best = t;
        }
      }
      if (best === IS13[j]) nsync++;
      pt += own;
      pa += sum;
    }
    const pn = (pa - pt) / 3;
    return { pt, pa, nsync, snr: pn > 0 ? db(pt / pn) : -99.9 };
  }

  /** Decode the frame at `cand`, subtract it, and merge it into a message. Returns true on success. */
  _decodeAndMerge(ctx, cand, sync) {
    this.stats.attempts++;
    const payloadStart = nint(cand.xdt * FS) + NSYNC_SYM * NSS;
    const { zRe, zIm, half } = correlatePayload(ctx.c1, payloadStart);
    const res = tbccDecode(zRe, zIm, half);
    cand.decoded = '';
    if (!res.success) return false;
    const un = unpackPayload(res.payload);
    if (!un.valid) return false;
    cand.decoded = un.text;
    cand.trailingSep = un.trailingSep;
    cand.isLast = un.isLast;

    // SNR from the full frame: sync tones plus the decoded symbol sequence
    const tones46 = tbccEncode(res.payload);
    let pt = sync.pt;
    let pa = sync.pa;
    for (let j = 0; j < NCHAN_SYM; j++) {
      let sum = 0;
      for (let t = 0; t < 4; t++) {
        const e = zRe[t * NCHAN_SYM + j] ** 2 + zIm[t * NCHAN_SYM + j] ** 2;
        sum += e;
        if (t === tones46[j]) pt += e;
      }
      pa += sum;
    }
    const pn = (pa - pt) / 3;
    if (pn > 0) {
      const ratio = (pt - pn) / pn;
      cand.snr = ratio > 0 ? Math.max(db(ratio) - db(2500 / BAUD), SNR_LEAKAGE_FLOOR_DB) : SNR_LEAKAGE_FLOOR_DB;
    }
    cand.tsync = ctx.tStart + cand.xdt;
    this.stats.decodes++;

    // duplicate of a frame decoded earlier in this window?
    for (const other of ctx.cands) {
      if (other === cand) continue;
      if (other.decoded === cand.decoded && other.decoded !== '' && Math.abs(other.tsync - cand.tsync) < 0.032) return true;
    }
    // a fixed-channel hit on a frame channel 0 already decoded is sync-estimation noise
    if (cand.ichan) {
      for (const ok of ctx.ok0) {
        if (Math.abs(cand.f1 - ok.f1) < FRAME_HISTORY_FREQ_TOLERANCE && Math.abs(cand.tsync - ok.tsync) < FRAME_HISTORY_TIME_TOLERANCE) return true;
      }
    }

    // subtract so a weaker signal underneath can show up in the second pass
    const tones59 = IS13.concat(tones46);
    subtractFrame(ctx.c0, tones59, cand.f1, cand.xdt);
    ctx.subtracted = true;

    this._merge(cand);
    return true;
  }

  /**
   * If an active message's next frame is due one frame period after its last
   * and nothing decoded this window, retry the FEC decode at that remembered
   * frequency and time.
   */
  _stickyRetry(ctx, ch) {
    const { c0, c1, tStart } = ctx;
    for (const msg of this.active) {
      if (msg.f1 < ch.fc - ch.fwid || msg.f1 > ch.fc + ch.fwid) continue;
      if (Math.abs(tStart - msg.tsync - FRAME_PERIOD) > 0.1) continue;
      const xdt = msg.tsync + FRAME_PERIOD - tStart;
      if (xdt < 0) continue;
      if (ctx.cands.length >= MAX_CANDIDATES) return;
      const cand = { xdt, f1: msg.f1, snr: -99.9, decoded: '', tsync: 0, isLast: false, trailingSep: false };
      ctx.cands.push(cand);
      shiftFrequency(c0.re, c0.im, c1.re, c1.im, NCHUNK6, -cand.f1);
      const sync = this._syncPower(c1, cand.xdt);
      cand.snr = sync.snr;
      this._decodeAndMerge(ctx, cand, sync);
      return; // at most one retry per window
    }
  }

  // -- message assembly ------------------------------------------------

  _isRecentFrame(cand) {
    return this.recent.some(
      (r) => Math.abs(cand.f1 - r.f1) < NEAR_SIMULTANEOUS_FREQ_TOLERANCE && Math.abs(cand.tsync - r.tsync) < FRAME_HISTORY_TIME_TOLERANCE
    );
  }

  _rememberFrame(cand) {
    if (this.recent.length >= MAX_RECENT_FRAMES) this.recent.shift();
    this.recent.push({ f1: cand.f1, tsync: cand.tsync });
  }

  /** classify_active_candidate(): does `cand` continue `existing`, or repeat one of its frames? */
  _classify(existing, cand) {
    const df1 = cand.f1 - existing.f1;
    const dtsync = cand.tsync - existing.tsync;
    let match = false;
    let gap = 1;
    const nfp = nint(dtsync / FRAME_PERIOD);
    const fpResid = Math.abs(dtsync - FRAME_PERIOD * nfp);
    if (nfp >= 1 && nfp <= MAX_CONTINUATION_GAP && fpResid < CONTINUATION_TIME_TOLERANCE) {
      const tol = 10.0 + 3.0 * (nfp - 1);
      match = Math.abs(df1) < tol;
      if (match) gap = nfp;
    }
    let windowDupe = false;
    if (!match) {
      const qstep = FRAME_PERIOD / 4;
      const nstep = nint(dtsync / qstep);
      const resid = Math.abs(dtsync - qstep * nstep);
      if (Math.abs(nstep) <= MAX_RETRO_STEPS && Math.abs(df1) < 10.0 && resid < 0.003 && !(Math.abs(nstep) % 4 === 0 && nstep !== 0)) {
        match = true;
        windowDupe = true;
      }
    }
    return { match, windowDupe, gap };
  }

  _merge(cand) {
    let pureDupe = this._isRecentFrame(cand);
    let target = null;
    let gap = 1;
    if (!pureDupe && this.active.length > 0) {
      let haveWin = false;
      let bestDf = Infinity;
      for (const msg of this.active) {
        const c = this._classify(msg, cand);
        if (!c.match) continue;
        if (c.windowDupe) {
          haveWin = true;
          continue;
        }
        const dfabs = Math.abs(cand.f1 - msg.f1);
        if (dfabs < bestDf) {
          bestDf = dfabs;
          target = msg;
          gap = c.gap;
        }
      }
      if (haveWin) {
        pureDupe = true;
        target = null;
      }
    }
    if (pureDupe) return;

    if (target) {
      this._rememberFrame(cand);
      const joined = this._append(target, cand, gap);
      target.decoded = joined;
      target.trailingSep = cand.trailingSep;
      target.f1 = cand.f1;
      target.tsync = cand.tsync;
      if (cand.isLast) {
        this.active.splice(this.active.indexOf(target), 1);
        this._emit(target, 'complete');
      } else {
        this._emit(target, 'growing');
      }
      return;
    }

    if (!cand.isLast && this.active.length >= MAX_ACTIVE_MESSAGES) return;
    this._rememberFrame(cand);
    const msg = {
      id: this.nextId++,
      f1: cand.f1,
      tsync: cand.tsync,
      startTsync: cand.tsync,
      startSnr: cand.snr,
      decoded: cand.decoded.slice(0, MAX_MESSAGE_CHARS),
      trailingSep: cand.trailingSep,
    };
    if (cand.isLast) {
      this._emit(msg, 'complete');
    } else {
      this.active.push(msg);
      this._emit(msg, 'growing');
    }
  }

  /** append_active_message(): join a continuation frame (bridging missed frames with "~~~~~"). */
  _append(msg, cand, gap) {
    let out = msg.decoded;
    if (gap > 1) {
      const next = cand.decoded.startsWith('~') ? cand.decoded.slice(1) : cand.decoded;
      out += '~~~~~' + next;
    } else {
      out += (msg.trailingSep ? ' ' : '') + cand.decoded;
    }
    return out.slice(0, MAX_MESSAGE_CHARS);
  }

  /** prune_receive_state(): forget old frames and expire stale partial messages. */
  _prune(forwardT) {
    const oldestRevisit = forwardT - (MAX_RETRO_STEPS * FRAME_PERIOD) / 4;
    this.recent = this.recent.filter((r) => r.tsync >= oldestRevisit - FRAME_HISTORY_TIME_TOLERANCE);
    const keep = [];
    for (const msg of this.active) {
      if (oldestRevisit - msg.tsync > MAX_CONTINUATION_GAP * FRAME_PERIOD + CONTINUATION_TIME_TOLERANCE) {
        this._emit(msg, 'expired');
      } else {
        keep.push(msg);
      }
    }
    this.active = keep;
  }

  _emit(msg, status) {
    this.onMessage({
      id: msg.id,
      freqHz: msg.f1,
      snr: Math.round(msg.startSnr),
      text: displayText(msg.decoded),
      status,
      startTime: msg.startTsync,
      latestTime: msg.tsync,
    });
  }
}

/**
 * Decides when to switch the receiver between normal and light search from
 * how long each window takes against the 472 ms it must stay ahead of.
 * Switches to light above 75% load, back to normal when the light-mode load
 * has fallen under 25% (a normal window costs about 1.6x a light one).
 */
class LoadGovernor {
  constructor({ stepMs = (STEP12 / INPUT_RATE) * 1000, high = 0.75, low = 0.25, smoothing = 0.3 } = {}) {
    this.stepMs = stepMs;
    this.high = high;
    this.low = low;
    this.smoothing = smoothing;
    this.ema = null;
    this.light = false;
  }

  /** @returns {boolean|null} the new light-mode setting if it changed, else null */
  update(msPerWindow) {
    this.ema = this.ema === null ? msPerWindow : this.ema * (1 - this.smoothing) + msPerWindow * this.smoothing;
    const load = this.ema / this.stepMs;
    if (!this.light && load > this.high) {
      this.light = true;
      return true;
    }
    if (this.light && load < this.low) {
      this.light = false;
      this.ema = null;
      return false;
    }
    return null;
  }
}

module.exports = {
  JttyReceiver,
  LoadGovernor,
  analytic,
  peakup,
  unpackPayload,
  displayText,
  INPUT_RATE,
  NCHUNK12,
  STEP12,
  FRAME_PERIOD,
  DEFAULT_SMIN,
};
