'use strict';

/**
 * JS8 Normal-speed receiver: finds and decodes every JS8 frame in one
 * 15-second slot of 12 kHz audio.
 *
 * A port of the core of JS8Call-improved's decoder (JS8_Mode/JS8.cpp,
 * DecodeMode<ModeA>: syncjs8(), baselinejs8(), computeBasebandFFT(),
 * js8_downsample(), syncjs8d(), js8dec(), genjs8refsig(), subtractjs8();
 * whitening_processor.h for the bit likelihoods), GPL-3.0. Left out, for
 * a first version: the frequency and timing trackers, the coherent
 * likelihoods, soft combining across slots, the deep (weak-sync) search,
 * the LDPC rescue and the decoder-aided re-demodulation, and the
 * segmented channel model in subtraction. See third_party/js8call/README.md.
 *
 * decodeSlot(samples, {nfa, nfb, nfqso}) takes the slot's audio at 12 kHz
 * (any scale; JS8Call feeds 16-bit sample values) starting at the slot
 * boundary, and returns [{freq, dt, snr, frame, type, hardErrors}]:
 * freq is the lowest tone in Hz, dt the start time relative to the usual
 * 0.5 s after the boundary, snr in dB (2500 Hz), frame the 12 characters
 * and type the 3 frame-type bits.
 */

const { fftPlan } = require('./js8-fft');
const codec = require('./js8-codec');

const { N, NN, ND, COSTAS_ORIGINAL } = codec;

// Normal speed (JS8Call's "Mode A").
const NSPS = 1920; // samples per symbol at 12 kHz (6.25 baud)
const NTXDUR = 15;
const NDOWNSPS = 32;
const NDD = 100;
const JZ = 62;
const ASTART = 0.5;
const BASESUB = 40;
const SAMPLE_RATE = 12000;
const NFOS = 2;
const NSSY = 4;
const NROWS = 8;
const NMAX = NTXDUR * SAMPLE_RATE; // 180000
const NFFT1 = NSPS * NFOS; // 3840
const NSTEP = NSPS / NSSY; // 480
const NHSYM = NMAX / NSTEP - 3; // 372
const NDOWN = NSPS / NDOWNSPS; // 60
const NQSYMBOL = NDOWNSPS / 4; // 8
const NDFFT1 = NSPS * NDD; // 192000
const NDFFT2 = NDFFT1 / NDOWN; // 3200
const MODE_NP2 = NN * NDOWNSPS; // 2528
const NP2 = 2812; // the decoder's own sample limit (JS8.cpp's namespace NP2)
const TSTEP = NSTEP / SAMPLE_RATE; // 0.04 s
const JSTRT = Math.trunc(ASTART / TSTEP); // 12
const DF = SAMPLE_RATE / NFFT1; // 3.125 Hz
const AZ = (SAMPLE_RATE / NSPS) * 0.64; // 4 Hz: candidates closer than this are one
const FS2 = SAMPLE_RATE / NDOWN; // 200 Hz
const DT2 = 1 / FS2;
const ASYNCMIN = 1.5;
const NMAXCAND = 300;
const NFSRCH = 5;
const NFILT = 1400;
const LLR_SCALE = 2;
const MAX_LDPC_PASSES = 8;
const BASELINE_MIN = 500;
const BASELINE_MAX = 2500;
const BASELINE_DEGREE = 5;
const BASELINE_SAMPLE = 10;
const COSTAS = COSTAS_ORIGINAL;

// The Nuttall window for the symbol spectra, normalised as JS8Call does.
const NUTTALL = (() => {
  const w = new Float64Array(NFFT1);
  let sum = 0;
  for (let i = 0; i < NFFT1; i++) {
    const v =
      0.3635819 -
      0.4891775 * Math.cos((2 * Math.PI * i) / NFFT1) +
      0.1365995 * Math.cos((4 * Math.PI * i) / NFFT1) -
      0.0106411 * Math.cos((6 * Math.PI * i) / NFFT1);
    w[i] = v;
    sum += v;
  }
  for (let i = 0; i < NFFT1; i++) w[i] = (w[i] / sum) * (NFFT1 / 300);
  return w;
})();

// Tapers for the edges of the band taken out when downsampling.
const TAPER_HEAD = new Float64Array(NDD + 1);
const TAPER_TAIL = new Float64Array(NDD + 1);
for (let i = 0; i <= NDD; i++) {
  const v = 0.5 * (1 + Math.cos((i * Math.PI) / NDD));
  TAPER_TAIL[i] = v;
  TAPER_HEAD[NDD - i] = v;
}

// The Costas waveforms at the downsampled rate.
const CSYNC = COSTAS.map((block) =>
  block.map((tone) => {
    const re = new Float64Array(NDOWNSPS);
    const im = new Float64Array(NDOWNSPS);
    for (let j = 0; j < NDOWNSPS; j++) {
      const ph = (2 * Math.PI * tone * j) / NDOWNSPS;
      re[j] = Math.cos(ph);
      im[j] = Math.sin(ph);
    }
    return { re, im };
  })
);

// cos/sin of 2*pi*m/32, for the 8-bin symbol DFTs.
const DFT_COS = Float64Array.from({ length: NDOWNSPS }, (_, m) => Math.cos((-2 * Math.PI * m) / NDOWNSPS));
const DFT_SIN = Float64Array.from({ length: NDOWNSPS }, (_, m) => Math.sin((-2 * Math.PI * m) / NDOWNSPS));

// Chebyshev nodes on [0, 1] for the noise baseline fit.
const BASELINE_NODES = Array.from(
  { length: BASELINE_DEGREE + 1 },
  (_, i) => 0.5 * (1 - Math.cos((Math.PI / (2 * (BASELINE_DEGREE + 1))) * (2 * i + 1)))
);

// The low-pass filter for subtraction, as its spectrum (circular, length NMAX).
let subtractFilter = null;
function getSubtractFilter() {
  if (subtractFilter) return subtractFilter;
  const re = new Float64Array(NMAX);
  const im = new Float64Array(NMAX);
  let sum = 0;
  for (let j = -NFILT / 2; j <= NFILT / 2; j++) sum += Math.cos((Math.PI * j) / NFILT) ** 2;
  for (let j = -NFILT / 2; j <= NFILT / 2; j++) {
    re[j >= 0 ? j : NMAX + j] = Math.cos((Math.PI * j) / NFILT) ** 2 / sum;
  }
  fftPlan(NMAX).forward(re, im);
  for (let i = 0; i < NMAX; i++) {
    re[i] /= NMAX;
    im[i] /= NMAX;
  }
  subtractFilter = { re, im };
  return subtractFilter;
}

/** The k-th smallest of an array (a copy is sorted). */
function kthSmallest(values, k) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(k, sorted.length - 1)];
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 0 && mid > 0) return 0.5 * (sorted[mid] + sorted[mid - 1]);
  return sorted[mid];
}

class Js8Decoder {
  constructor() {
    this.dd = new Float64Array(NMAX);
    // Symbol spectra: s[bin][step], bins 0..NSPS-1.
    this.s = Array.from({ length: NSPS }, () => new Float32Array(NHSYM));
    this.savg = new Float64Array(NSPS);
    this.dsRe = new Float64Array(NDFFT1);
    this.dsIm = new Float64Array(NDFFT1);
    this.cdRe = new Float64Array(NDFFT2);
    this.cdIm = new Float64Array(NDFFT2);
  }

  /**
   * Decodes one slot. `samples`: 12 kHz audio from the slot boundary (it is
   * cut or zero-padded to 15 s). Options: nfa/nfb the search range in Hz,
   * nfqso the transmit offset (signals near it are tried first).
   */
  decodeSlot(samples, { nfa = 200, nfb = 2900, nfqso = 1500 } = {}) {
    const dd = this.dd;
    dd.fill(0);
    const n = Math.min(samples.length, NMAX);
    for (let i = 0; i < n; i++) dd[i] = samples[i];

    const decodes = new Map(); // `${type}:${frame}` -> decode
    for (let ipass = 1; ipass <= 3; ipass++) {
      const candidates = this.syncjs8(nfa, nfb);
      if (candidates.length === 0) break;
      candidates.sort((a, b) => {
        const ad = Math.abs(a.freq - nfqso);
        const bd = Math.abs(b.freq - nfqso);
        if (ad < 10 && bd >= 10) return -1;
        if (bd < 10 && ad >= 10) return 1;
        return ad - bd || a.freq - b.freq;
      });
      this.computeBasebandFft();
      const subtract = ipass < 3;
      let improved = false;
      for (const cand of candidates) {
        const d = this.js8dec(cand.freq, cand.dt, subtract);
        if (!d) continue;
        const key = `${d.type}:${d.frame}`;
        const prev = decodes.get(key);
        if (!prev || prev.snr < d.snr) {
          improved = true;
          decodes.set(key, prev ? { ...prev, snr: d.snr } : d);
        }
      }
      if (!improved) break;
    }
    return [...decodes.values()].sort((a, b) => a.freq - b.freq);
  }

  /** Symbol spectra, noise baseline, and the coarse sync search: [{freq, dt, sync}]. */
  syncjs8(nfa, nfb) {
    const { dd, s, savg } = this;
    const plan = fftPlan(NFFT1);
    const re = new Float64Array(NFFT1);
    const im = new Float64Array(NFFT1);
    savg.fill(0);
    for (let j = 0; j < NHSYM; j++) {
      const ia = j * NSTEP;
      if (ia + NFFT1 > NMAX) break;
      for (let i = 0; i < NFFT1; i++) {
        re[i] = dd[ia + i] * NUTTALL[i];
        im[i] = 0;
      }
      plan.forward(re, im);
      for (let i = 0; i < NSPS; i++) {
        const p = re[i] * re[i] + im[i] * im[i];
        s[i][j] = p;
        savg[i] += p;
      }
    }

    const nwin = nfb - nfa;
    if (nfa < 100) {
      nfa = 100;
      if (nwin < 100) nfb = nfa + nwin;
    }
    if (nfb > 4910) {
      nfb = 4910;
      if (nwin < 100) nfa = nfb - nwin;
    }
    const ia = Math.max(0, Math.round(nfa / DF));
    const ib = Math.round(nfb / DF);
    this.baselinejs8(ia, ib);

    const entries = [];
    const t0 = [0, 0, 0];
    const t1 = [0, 0, 0];
    for (let i = ia; i <= ib; i++) {
      if (i + NFOS * 7 >= NSPS) break;
      let maxValue = -Infinity;
      let maxIndex = -JZ;
      for (let j = -JZ; j <= JZ; j++) {
        for (let p = 0; p < 3; p++) {
          t0[p] = 0;
          t1[p] = 0;
          for (let k = 0; k < 7; k++) {
            const offset = j + JSTRT + NSSY * k + p * 36 * NSSY;
            if (offset < 0 || offset >= NHSYM) continue;
            t0[p] += s[i + NFOS * COSTAS[p][k]][offset];
            for (let f = 0; f < 7; f++) t1[p] += s[i + NFOS * f][offset];
          }
        }
        const sync = (a, b) => {
          let tx = 0;
          let tt = 0;
          for (let p = a; p <= b; p++) {
            tx += t0[p];
            tt += t1[p];
          }
          return tx / ((tt - tx) / 6);
        };
        const v = Math.max(sync(0, 2), sync(0, 1), sync(1, 2));
        if (v > maxValue) {
          maxValue = v;
          maxIndex = j;
        }
      }
      entries.push({ freq: DF * i, dt: TSTEP * (maxIndex + 0.5), sync: maxValue });
    }
    if (entries.length === 0) return [];

    // Normalise to the 40th percentile.
    const ranked = entries.map((e) => e.sync).sort((a, b) => a - b);
    const ref = ranked[Math.floor((ranked.length * 4) / 10)];
    for (const e of entries) e.sync /= ref;

    // Strongest first; each one removes its neighbours within AZ Hz.
    const bySync = entries.filter((e) => !Number.isNaN(e.sync)).sort((a, b) => b.sync - a.sync);
    const taken = [];
    const removed = new Set();
    for (const e of bySync) {
      if (removed.has(e)) continue;
      if (!(e.sync >= ASYNCMIN)) break;
      if (taken.length >= NMAXCAND) break;
      taken.push(e);
      for (const o of entries) if (o.freq >= e.freq - AZ && o.freq <= e.freq + AZ) removed.add(o);
    }
    return taken;
  }

  /**
   * The noise baseline, in dB, over [ia, ib]: a 5th-degree polynomial
   * through the 10th-percentile level at six Chebyshev nodes in 500-2500 Hz.
   * It replaces savg.
   */
  baselinejs8(ia, ib) {
    const savg = this.savg;
    const bmin = Math.round(BASELINE_MIN / DF);
    const bmax = Math.round(BASELINE_MAX / DF);
    const size = bmax - bmin + 1;
    const arm = Math.floor(size / (2 * BASELINE_NODES.length));
    const data = new Float64Array(size);
    for (let i = 0; i < size; i++) data[i] = 10 * Math.log10(savg[bmin + i]);
    const xs = [];
    const ys = [];
    for (const nodeFrac of BASELINE_NODES) {
      const node = size * nodeFrac;
      const base = Math.round(node);
      const from = Math.max(0, Math.min(size, base - arm));
      const to = Math.max(0, Math.min(size, base + arm));
      const span = data.subarray(from, to);
      const k = Math.floor((span.length * BASELINE_SAMPLE) / 100);
      xs.push(node);
      ys.push(kthSmallest(span, k));
    }
    // Six points, degree 5: the polynomial goes through them (Lagrange form).
    const evaluate = (x) => {
      let y = 0;
      for (let i = 0; i < xs.length; i++) {
        let l = 1;
        for (let j = 0; j < xs.length; j++) if (j !== i) l *= (x - xs[j]) / (xs[i] - xs[j]);
        y += ys[i] * l;
      }
      return y;
    };
    savg.fill(0);
    const last = size - 1;
    for (let i = ia; i <= ib && i < savg.length; i++) savg[i] = evaluate(((i - ia) * last) / (ib - ia)) + 0.65;
  }

  /** The spectrum of the whole slot (zero-padded to NDFFT1), for downsampling. */
  computeBasebandFft() {
    const { dd, dsRe, dsIm } = this;
    dsRe.fill(0);
    dsIm.fill(0);
    dsRe.set(dd);
    fftPlan(NDFFT1).forward(dsRe, dsIm);
  }

  /** Takes a 62.5 Hz band from f0 - 1.5 baud and brings it down to 200 samples a second in cd. */
  js8Downsample(f0) {
    const { dsRe, dsIm, cdRe, cdIm } = this;
    const df = SAMPLE_RATE / NDFFT1;
    const baud = SAMPLE_RATE / NSPS;
    const ft = f0 + 8.5 * baud;
    const fb = f0 - 1.5 * baud;
    const i0 = Math.round(f0 / df);
    const it = Math.min(Math.round(ft / df), NDFFT1 / 2);
    const ib = Math.max(0, Math.round(fb / df));
    const range = it - ib + 1;
    const tmpRe = new Float64Array(NDFFT2);
    const tmpIm = new Float64Array(NDFFT2);
    for (let i = 0; i < range; i++) {
      tmpRe[i] = dsRe[ib + i];
      tmpIm[i] = dsIm[ib + i];
    }
    for (let i = 0; i <= NDD; i++) {
      tmpRe[i] *= TAPER_HEAD[i];
      tmpIm[i] *= TAPER_HEAD[i];
      const t = range - (NDD + 1) + i;
      tmpRe[t] *= TAPER_TAIL[i];
      tmpIm[t] *= TAPER_TAIL[i];
    }
    const shift = i0 - ib;
    for (let i = 0; i < NDFFT2; i++) {
      const src = (i + shift) % NDFFT2;
      cdRe[i] = tmpRe[src];
      cdIm[i] = tmpIm[src];
    }
    fftPlan(NDFFT2).inverse(cdRe, cdIm);
    const factor = 1 / Math.sqrt(NDFFT1 * NDFFT2);
    for (let i = 0; i < NDFFT2; i++) {
      cdRe[i] *= factor;
      cdIm[i] *= factor;
    }
  }

  /** Costas power at downsampled start sample i0, frequency moved by delf Hz. */
  syncjs8d(i0, delf) {
    const { cdRe, cdIm } = this;
    let faRe = null;
    let faIm = null;
    if (delf !== 0) {
      faRe = new Float64Array(NDOWNSPS);
      faIm = new Float64Array(NDOWNSPS);
      const dphi = ((2 * Math.PI) / FS2) * delf;
      for (let i = 0; i < NDOWNSPS; i++) {
        faRe[i] = Math.cos(dphi * i);
        faIm[i] = Math.sin(dphi * i);
      }
    }
    let power = 0;
    for (let block = 0; block < 3; block++) {
      for (let sym = 0; sym < 7; sym++) {
        const offset = 36 * block * NDOWNSPS + i0 + sym * NDOWNSPS;
        if (offset < 0 || offset + NDOWNSPS > MODE_NP2) continue;
        const cs = CSYNC[block][sym];
        let accRe = 0;
        let accIm = 0;
        for (let j = 0; j < NDOWNSPS; j++) {
          // reference = fa * csync; accumulate cd * conj(reference)
          let rr = cs.re[j];
          let ri = cs.im[j];
          if (faRe) {
            const a = faRe[j] * rr - faIm[j] * ri;
            ri = faRe[j] * ri + faIm[j] * rr;
            rr = a;
          }
          const xr = cdRe[offset + j];
          const xi = cdIm[offset + j];
          accRe += xr * rr + xi * ri;
          accIm += xi * rr - xr * ri;
        }
        power += accRe * accRe + accIm * accIm;
      }
    }
    return power;
  }

  /** Tries to decode a candidate; returns a decode or null. */
  js8dec(f1In, xdtIn, subtract) {
    const { cdRe, cdIm } = this;
    const fr = SAMPLE_RATE / NFFT1;
    const index = Math.round(f1In / fr);
    const xbase = Math.pow(10, 0.1 * (this.savg[index] - BASESUB));

    this.js8Downsample(f1In);

    let i0 = Math.round((xdtIn + ASTART) * FS2);
    let smax = 0;
    let ibest = 0;
    for (let idt = i0 - NQSYMBOL; idt <= i0 + NQSYMBOL; idt++) {
      const v = this.syncjs8d(idt, 0);
      if (v > smax) {
        smax = v;
        ibest = idt;
      }
    }
    const xdt2 = ibest * DT2;
    i0 = Math.round(xdt2 * FS2);
    smax = 0;
    let delfbest = 0;
    for (let ifr = -NFSRCH; ifr <= NFSRCH; ifr++) {
      const delf = ifr * 0.5;
      const v = this.syncjs8d(i0, delf);
      if (v > smax) {
        smax = v;
        delfbest = delf;
      }
    }
    // Take the frequency error out.
    const dphi = -delfbest * ((2 * Math.PI) / FS2);
    const wsr = Math.cos(dphi);
    const wsi = Math.sin(dphi);
    let wr = 1;
    let wi = 0;
    for (let i = 0; i < NP2; i++) {
      const a = wr * wsr - wi * wsi;
      wi = wr * wsi + wi * wsr;
      wr = a;
      const xr = cdRe[i];
      const xi = cdIm[i];
      cdRe[i] = xr * wr - xi * wi;
      cdIm[i] = xr * wi + xi * wr;
    }
    const f1 = f1In + delfbest;
    const sync = this.syncjs8d(i0, 0);

    // Tone magnitudes, symbol by symbol (8 bins of a 32-point DFT).
    const s2 = Array.from({ length: NROWS }, () => new Float64Array(NN));
    for (let k = 0; k < NN; k++) {
      let i1 = ibest + k * NDOWNSPS;
      if (i1 < 0) i1 = 0;
      else if (i1 + NDOWNSPS > NP2) i1 = NP2 - NDOWNSPS;
      for (let t = 0; t < NROWS; t++) {
        let sr = 0;
        let si = 0;
        for (let j = 0; j < NDOWNSPS; j++) {
          const m = (t * j) % NDOWNSPS;
          const c = DFT_COS[m];
          const d = DFT_SIN[m];
          const xr = cdRe[i1 + j];
          const xi = cdIm[i1 + j];
          sr += xr * c - xi * d;
          si += xr * d + xi * c;
        }
        s2[t][k] = Math.hypot(sr, si) / 1000;
      }
    }

    // The Costas symbols must mostly be right.
    let nsync = 0;
    for (let b = 0; b < 3; b++) {
      for (let col = 0; col < 7; col++) {
        const k = b * 36 + col;
        let best = 0;
        for (let t = 1; t < NROWS; t++) if (s2[t][k] > s2[best][k]) best = t;
        if (best === COSTAS[b][col]) nsync++;
      }
    }
    if (nsync <= 6) return null;

    const llr0 = toneLlrs(s2);
    let llr = llr0;
    let passes = 0;
    for (let ipass = 1; ipass <= 4 && passes < MAX_LDPC_PASSES; ipass++) {
      if (ipass === 3) llr0.fill(0, 0, 24);
      else if (ipass === 4) llr0.fill(0, 24, 48);
      llr = llr0;
      let result = this._tryDecode(Float64Array.from(llr), ipass, sync);
      passes++;
      if (result.decode) return this._finish(result.decode, { f1, xdt2, s2, xbase, subtract });
      if (passes < MAX_LDPC_PASSES) {
        const refined = codec.refineLlrs(llr, result.cw);
        result = this._tryDecode(refined, ipass, sync);
        passes++;
        if (result.decode) return this._finish(result.decode, { f1, xdt2, s2, xbase, subtract });
      }
    }
    return null;
  }

  _tryDecode(llr, ipass, sync) {
    const bp = codec.bpDecode(llr);
    if (!bp.cw.some((b) => b !== 0)) return { decode: null, cw: bp.cw };
    const nh = bp.hardErrors;
    if (nh >= 0 && nh < 60 && !(sync < 2 && nh > 35) && !(ipass > 2 && nh > 39) && !(ipass === 4 && nh > 30)) {
      if (codec.checkCrc12(bp.decoded)) {
        return { decode: { decoded: bp.decoded, hardErrors: nh }, cw: bp.cw };
      }
    }
    return { decode: null, cw: bp.cw };
  }

  _finish({ decoded, hardErrors }, { f1, xdt2, s2, xbase, subtract }) {
    const frame = codec.extractFrame(decoded);
    const type = codec.frameType(decoded);
    const tones = codec.encodeTones(frame, type, COSTAS);
    if (subtract) this.subtractjs8(genRefSig(tones, f1), xdt2);
    let xsig = 0;
    for (let k = 0; k < NN; k++) xsig += s2[tones[k]][k] ** 2;
    const snr = Math.max(10 * Math.log10(Math.max(xsig / xbase - 1, 1.259e-10)) - 32, -60);
    return { freq: f1, dt: xdt2 - ASTART, snr: Math.round(snr), frame, type, hardErrors };
  }

  /** Removes a decoded signal (its reference waveform, scaled by a low-passed channel estimate). */
  subtractjs8(cref, dt) {
    const dd = this.dd;
    const nstart = Math.round(dt * SAMPLE_RATE);
    const crefStart = nstart < 0 ? -nstart : 0;
    const ddStart = nstart > 0 ? nstart : 0;
    const count = cref.re.length;
    if (crefStart >= count || ddStart >= NMAX) return;
    const size = Math.min(count - crefStart, NMAX - ddStart);
    if (size <= 0) return;
    const re = new Float64Array(NMAX);
    const im = new Float64Array(NMAX);
    for (let i = 0; i < size; i++) {
      const x = dd[ddStart + i];
      re[i] = x * cref.re[crefStart + i];
      im[i] = -x * cref.im[crefStart + i];
    }
    const plan = fftPlan(NMAX);
    plan.forward(re, im);
    const filt = getSubtractFilter();
    for (let i = 0; i < NMAX; i++) {
      const a = re[i] * filt.re[i] - im[i] * filt.im[i];
      im[i] = re[i] * filt.im[i] + im[i] * filt.re[i];
      re[i] = a;
    }
    plan.inverse(re, im);

    // Only subtract if it lowers the matched correlation with the reference.
    const before = new Float64Array(2 * NN);
    const after = new Float64Array(2 * NN);
    for (let i = 0; i < size; i++) {
      const ci = crefStart + i;
      const sym = Math.floor(ci / NSPS);
      const cr = cref.re[ci];
      const cim = cref.im[ci];
      const x = dd[ddStart + i];
      before[2 * sym] += x * cr;
      before[2 * sym + 1] -= x * cim;
      const recon = 2 * (re[i] * cr - im[i] * cim);
      const r = x - recon;
      after[2 * sym] += r * cr;
      after[2 * sym + 1] -= r * cim;
    }
    let b = 0;
    let a = 0;
    for (let i = 0; i < 2 * NN; i++) {
      b += before[i] * before[i];
      a += after[i] * after[i];
    }
    if (!(Number.isFinite(b) && b > Number.EPSILON && Number.isFinite(a) && a < b)) return;
    for (let i = 0; i < size; i++) {
      const ci = crefStart + i;
      dd[ddStart + i] -= 2 * (re[i] * cref.re[ci] - im[i] * cref.im[ci]);
    }
  }
}

/** The complex reference waveform for 79 tones at f0 (12 kHz). */
function genRefSig(tones, f0) {
  const re = new Float64Array(NN * NSPS);
  const im = new Float64Array(NN * NSPS);
  const bfpi = (2 * Math.PI * f0) / SAMPLE_RATE;
  let phi = 0;
  let n = 0;
  for (let k = 0; k < NN; k++) {
    const dphi = bfpi + (2 * Math.PI * tones[k]) / NSPS;
    for (let i = 0; i < NSPS; i++) {
      re[n] = Math.cos(phi);
      im[n] = Math.sin(phi);
      n++;
      phi = (phi + dphi) % (2 * Math.PI);
    }
  }
  return { re, im };
}

/**
 * Bit likelihoods from the 58 data symbols' tone magnitudes, JS8Call's way:
 * each tone's power scaled by a noise estimate for that tone and that
 * symbol, then log-sum-exp over the tones with each bit 1 and 0.
 */
function toneLlrs(s2) {
  // Data symbols: 7..35 and 43..71.
  const s1 = Array.from({ length: NROWS }, (_, t) => {
    const row = new Float64Array(ND);
    for (let j = 0; j < 29; j++) {
      row[j] = s2[t][7 + j];
      row[29 + j] = s2[t][43 + j];
    }
    return row;
  });
  const winners = new Int32Array(ND);
  for (let j = 0; j < ND; j++) {
    let w = 0;
    for (let t = 1; t < NROWS; t++) if (s1[t][j] > s1[w][j]) w = t;
    winners[j] = w;
  }
  const toneNoise = new Float64Array(NROWS);
  for (let t = 0; t < NROWS; t++) {
    const vals = [];
    for (let j = 0; j < ND; j++) if (winners[j] !== t) vals.push(s1[t][j]);
    toneNoise[t] = vals.length ? median(vals) : NaN;
  }
  const whitening = toneNoise.every((v) => Number.isFinite(v));
  const llr = new Float64Array(N);
  const w = new Float64Array(NROWS);
  for (let j = 0; j < ND; j++) {
    let inv = 1;
    if (whitening) {
      const vals = [];
      for (let t = 0; t < NROWS; t++) if (t !== winners[j]) vals.push(s1[t][j]);
      const symbolNoise = median(vals);
      inv = 1 / (Math.max(0, toneNoise[winners[j]]) * Math.max(0, symbolNoise) + 1e-12);
    }
    for (let t = 0; t < NROWS; t++) w[t] = 0.5 * s1[t][j] * s1[t][j] * inv;
    for (let bit = 0; bit < 3; bit++) {
      const shift = 2 - bit;
      llr[3 * j + bit] = (logSumExp(w, shift, 1) - logSumExp(w, shift, 0)) * LLR_SCALE;
    }
  }
  return llr;
}

function logSumExp(scores, shift, bit) {
  let m = -Infinity;
  for (let i = 0; i < NROWS; i++) if (((i >> shift) & 1) === bit && scores[i] > m) m = scores[i];
  if (!Number.isFinite(m)) return 0;
  let s = 0;
  for (let i = 0; i < NROWS; i++) if (((i >> shift) & 1) === bit) s += Math.exp(scores[i] - m);
  return m + Math.log(s);
}

module.exports = {
  Js8Decoder,
  genRefSig,
  toneLlrs,
  SAMPLE_RATE,
  NSPS,
  NMAX,
  ASTART,
  NTXDUR,
};
