'use strict';

/**
 * WSPR receiver: finds and decodes every WSPR signal in one two-minute
 * slot of 12 kHz audio.
 *
 * This is a JavaScript port of wsprd.c from WSJT-X (lib/wsprd), by Joe
 * Taylor K1JT and Steven Franke K9AN, GPL-3.0 (see
 * third_party/wsjtx-wsprd). It follows wsprd step by step:
 *
 *  1. Shift 1500 Hz to 0 Hz and reduce the rate to 375 Hz (one FFT in,
 *     one FFT out), giving complex samples covering +/-187 Hz.
 *  2. Average 512-point spectra and pick peaks above the noise floor as
 *     candidates, with an SNR estimate in a 2500 Hz bandwidth.
 *  3. For each candidate, search time, frequency and drift against the
 *     known sync vector, coarse then fine.
 *  4. Make soft symbols (non-coherent, over blocks of 1 to 3 symbols),
 *     deinterleave, and run the Fano decoder. Jitter the start time a
 *     little if the first try fails.
 *  5. Subtract each decoded signal and run again, so weaker signals
 *     under it can decode (three passes).
 *
 * wsprd's OSD and stack (Jelinek) decoders are off by default and are
 * not ported.
 */

const codec = require('./wspr-codec');

const PR3 = codec.PR3;
const FS = 375; // baseband rate
const DT = 1 / FS;
const DF_TONE = 375 / 256; // tone spacing at 375 Hz
const DF_SPEC = 375 / 512; // spectrum bin width
const NPOINTS = 46080; // baseband samples wsprd keeps
const MAXPTS = 65536;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------- FFT

const twiddles = new Map();
function twiddleTable(n) {
  let t = twiddles.get(n);
  if (!t) {
    t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) {
      t.cos[k] = Math.cos((TWO_PI * k) / n);
      t.sin[k] = Math.sin((TWO_PI * k) / n);
    }
    twiddles.set(n, t);
  }
  return t;
}

/** In-place radix-2 complex FFT. sign -1 = forward, +1 = inverse (unscaled, as FFTW). */
function fft(re, im, sign = -1) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const tw = twiddleTable(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = tw.cos[k * step];
        const wi = sign * tw.sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// ---------------------------------------------------------------- step 1

/**
 * 12 kHz real audio (up to 114 s) to 375 Hz complex baseband centred
 * on 1500 Hz. wsprd uses a 1474560-point FFT; this uses 2^21 points
 * (same 12000/32 output rate, finer bins) and rescales to match.
 */
function downconvert(samples) {
  const N1 = 1 << 21;
  const N2 = 1 << 16;
  const n = Math.min(samples.length, 114 * 12000);
  const re = new Float64Array(N1);
  const im = new Float64Array(N1);
  for (let i = 0; i < n; i++) re[i] = samples[i];
  fft(re, im, -1);
  const i0 = Math.round((1500 * N1) / 12000);
  const bre = new Float64Array(N2);
  const bim = new Float64Array(N2);
  const nh2 = N2 / 2;
  for (let i = 0; i < N2; i++) {
    let j = i0 + i;
    if (i > nh2) j -= N2;
    bre[i] = re[j];
    bim[i] = im[j];
  }
  fft(bre, bim, 1);
  // wsprd: samples/32768 in, unscaled FFTs over 1474560 points, /1000 out
  const scale = 1474560 / N1 / 1000;
  const id = new Float64Array(MAXPTS);
  const qd = new Float64Array(MAXPTS);
  for (let i = 0; i < NPOINTS; i++) {
    id[i] = bre[i] * scale;
    qd[i] = bim[i] * scale;
  }
  return { id, qd, np: NPOINTS };
}

// ---------------------------------------------------------------- tone tables

/** cos/sin of the four tone phases over 257 samples, for tone frequency fp. */
function toneTables(fp, out) {
  const offs = [-1.5 * DF_TONE, -0.5 * DF_TONE, 0.5 * DF_TONE, 1.5 * DF_TONE];
  for (let t = 0; t < 4; t++) {
    const dphi = TWO_PI * DT * (fp + offs[t]);
    const cd = Math.cos(dphi);
    const sd = Math.sin(dphi);
    const c = out.c[t];
    const s = out.s[t];
    c[0] = 1;
    s[0] = 0;
    for (let j = 1; j < 257; j++) {
      c[j] = c[j - 1] * cd - s[j - 1] * sd;
      s[j] = c[j - 1] * sd + s[j - 1] * cd;
    }
  }
  return out;
}

function newTables() {
  return {
    c: [0, 1, 2, 3].map(() => new Float64Array(257)),
    s: [0, 1, 2, 3].map(() => new Float64Array(257)),
  };
}

/** Correlations of symbol i at `lag` with the four tones: fills is[t], qs[t]. */
function correlate(id, qd, np, lag, i, tb, isOut, qsOut) {
  const base = lag + i * 256;
  // wsprd skips samples outside 0 < k < np
  const j0 = Math.max(0, 1 - base);
  const j1 = Math.min(256, np - base);
  const c0 = tb.c[0], s0 = tb.s[0], c1 = tb.c[1], s1 = tb.s[1];
  const c2 = tb.c[2], s2 = tb.s[2], c3 = tb.c[3], s3 = tb.s[3];
  let i0 = 0, q0 = 0, i1 = 0, q1 = 0, i2 = 0, q2 = 0, i3 = 0, q3 = 0;
  for (let j = j0; j < j1; j++) {
    const x = id[base + j];
    const y = qd[base + j];
    i0 += x * c0[j] + y * s0[j];
    q0 += y * c0[j] - x * s0[j];
    i1 += x * c1[j] + y * s1[j];
    q1 += y * c1[j] - x * s1[j];
    i2 += x * c2[j] + y * s2[j];
    q2 += y * c2[j] - x * s2[j];
    i3 += x * c3[j] + y * s3[j];
    q3 += y * c3[j] - x * s3[j];
  }
  isOut[0] = i0;
  qsOut[0] = q0;
  isOut[1] = i1;
  qsOut[1] = q1;
  isOut[2] = i2;
  qsOut[2] = q2;
  isOut[3] = i3;
  qsOut[3] = q3;
}

function softSymbols(fsymb, symfac) {
  let fsum = 0;
  let f2sum = 0;
  for (let i = 0; i < 162; i++) {
    fsum += fsymb[i] / 162;
    f2sum += (fsymb[i] * fsymb[i]) / 162;
  }
  const fac = Math.sqrt(f2sum - fsum * fsum);
  const symbols = new Uint8Array(162);
  for (let i = 0; i < 162; i++) {
    let v = (symfac * fsymb[i]) / fac;
    if (!(v <= 127)) v = v > 127 ? 127 : 0; // NaN (no signal at all) reads as "no information"
    if (v < -128) v = -128;
    symbols[i] = Math.floor(v + 128);
  }
  return symbols;
}

// ---------------------------------------------------------------- step 3

/**
 * wsprd's sync_and_demodulate. mode 0: best lag; mode 1: best frequency;
 * mode 2: soft symbols at the given frequency and lag.
 */
function syncAndDemodulate(id, qd, np, p, mode, symfac = 50) {
  let { ifmin, ifmax, fstep, lagmin, lagmax, lagstep } = p;
  if (mode === 0) {
    ifmin = 0;
    ifmax = 0;
    fstep = 0;
  }
  if (mode === 1) {
    lagmin = p.shift;
    lagmax = p.shift;
  }
  if (mode === 2) {
    lagmin = p.shift;
    lagmax = p.shift;
    ifmin = 0;
    ifmax = 0;
  }
  const tb = newTables();
  const is = new Float64Array(4);
  const qs = new Float64Array(4);
  const fsymb = new Float64Array(162);
  let syncmax = -1e30;
  let bestShift = p.shift;
  let fbest = p.freq;
  for (let ifreq = ifmin; ifreq <= ifmax; ifreq++) {
    const f0 = p.freq + ifreq * fstep;
    for (let lag = lagmin; lag <= lagmax; lag += lagstep) {
      let ss = 0;
      let totp = 0;
      let fplast = NaN;
      for (let i = 0; i < 162; i++) {
        const fp = f0 + (p.drift / 2) * ((i - 81) / 81);
        if (fp !== fplast) {
          toneTables(fp, tb);
          fplast = fp;
        }
        correlate(id, qd, np, lag, i, tb, is, qs);
        const p0 = Math.sqrt(is[0] * is[0] + qs[0] * qs[0]);
        const p1 = Math.sqrt(is[1] * is[1] + qs[1] * qs[1]);
        const p2 = Math.sqrt(is[2] * is[2] + qs[2] * qs[2]);
        const p3 = Math.sqrt(is[3] * is[3] + qs[3] * qs[3]);
        totp += p0 + p1 + p2 + p3;
        const cmet = p1 + p3 - (p0 + p2);
        ss = PR3[i] === 1 ? ss + cmet : ss - cmet;
        if (mode === 2) fsymb[i] = PR3[i] === 1 ? p3 - p1 : p2 - p0;
      }
      ss /= totp;
      if (ss > syncmax) {
        syncmax = ss;
        bestShift = lag;
        fbest = f0;
      }
    }
  }
  if (mode <= 1) return { sync: syncmax, shift: bestShift, freq: fbest };
  return { sync: syncmax, symbols: softSymbols(fsymb, symfac) };
}

// ---------------------------------------------------------------- step 4

/** wsprd's noncoherent_sequence_detection: soft symbols from blocks of `nblock` symbols. */
function noncoherentSequenceDetection(id, qd, np, f0, lag, drift, nblock, bitmetric, symfac = 50) {
  const tb = newTables();
  const is = [0, 1, 2, 3].map(() => new Float64Array(162));
  const qs = [0, 1, 2, 3].map(() => new Float64Array(162));
  const cf = [0, 1, 2, 3].map(() => new Float64Array(162));
  const sf = [0, 1, 2, 3].map(() => new Float64Array(162));
  const ti = new Float64Array(4);
  const tq = new Float64Array(4);
  let fplast = NaN;
  for (let i = 0; i < 162; i++) {
    const fp = f0 + (drift / 2) * ((i - 81) / 81);
    if (fp !== fplast) {
      toneTables(fp, tb);
      fplast = fp;
    }
    for (let t = 0; t < 4; t++) {
      cf[t][i] = tb.c[t][256];
      sf[t][i] = tb.s[t][256];
    }
    correlate(id, qd, np, lag, i, tb, ti, tq);
    for (let t = 0; t < 4; t++) {
      is[t][i] = ti[t];
      qs[t][i] = tq[t];
    }
  }
  const nseq = 1 << nblock;
  const pw = new Float64Array(nseq);
  const fsymb = new Float64Array(162);
  for (let i = 0; i < 162; i += nblock) {
    for (let j = 0; j < nseq; j++) {
      let xi = 0;
      let xq = 0;
      let cm = 1;
      let sm = 0;
      for (let ib = 0; ib < nblock; ib++) {
        const b = (j >> (nblock - 1 - ib)) & 1;
        const itone = PR3[i + ib] + 2 * b;
        xi += is[itone][i + ib] * cm + qs[itone][i + ib] * sm;
        xq += qs[itone][i + ib] * cm - is[itone][i + ib] * sm;
        const cmp = cf[itone][i + ib] * cm - sf[itone][i + ib] * sm;
        const smp = sf[itone][i + ib] * cm + cf[itone][i + ib] * sm;
        cm = cmp;
        sm = smp;
      }
      pw[j] = Math.sqrt(xi * xi + xq * xq);
    }
    for (let ib = 0; ib < nblock; ib++) {
      const imask = 1 << (nblock - 1 - ib);
      let xm1 = 0;
      let xm0 = 0;
      for (let j = 0; j < nseq; j++) {
        if (j & imask) {
          if (pw[j] > xm1) xm1 = pw[j];
        } else if (pw[j] > xm0) xm0 = pw[j];
      }
      fsymb[i + ib] = xm1 - xm0;
      if (bitmetric) fsymb[i + ib] /= xm1 > xm0 ? xm1 : xm0;
    }
  }
  return softSymbols(fsymb, symfac);
}

// ---------------------------------------------------------------- step 5

/** wsprd's subtract_signal2: removes a decoded signal's coherent component. */
function subtractSignal(id, qd, np, f0, shift0, drift0, channelSymbols) {
  const nsym = 162;
  const nspersym = 256;
  const nfilt = 360;
  const nsig = nsym * nspersym;
  const nc2 = 45000;
  const refi = new Float64Array(nc2);
  const refq = new Float64Array(nc2);
  const ci = new Float64Array(nc2);
  const cq = new Float64Array(nc2);
  const cfi = new Float64Array(nc2);
  const cfq = new Float64Array(nc2);
  let phi = 0;
  for (let i = 0; i < nsym; i++) {
    const cs = channelSymbols[i];
    const dphi = TWO_PI * DT * (f0 + (drift0 / 2) * ((i - nsym / 2) / (nsym / 2)) + (cs - 1.5) * DF_TONE);
    for (let j = 0; j < nspersym; j++) {
      const ii = nspersym * i + j;
      refi[ii] = Math.cos(phi);
      refq[ii] = Math.sin(phi);
      phi += dphi;
    }
  }
  const w = new Float64Array(nfilt);
  const partialsum = new Float64Array(nfilt);
  let norm = 0;
  for (let i = 0; i < nfilt; i++) {
    w[i] = Math.sin((Math.PI * i) / (nfilt - 1));
    norm += w[i];
  }
  for (let i = 0; i < nfilt; i++) w[i] /= norm;
  for (let i = 1; i < nfilt; i++) partialsum[i] = partialsum[i - 1] + w[i];
  for (let i = 0; i < nsig; i++) {
    const k = shift0 + i;
    if (k > 0 && k < np) {
      ci[i + nfilt] = id[k] * refi[i] + qd[k] * refq[i];
      cq[i + nfilt] = qd[k] * refi[i] - id[k] * refq[i];
    }
  }
  for (let i = nfilt / 2; i < nc2 - nfilt / 2; i++) {
    let a = 0;
    let b = 0;
    const o = i - nfilt / 2;
    for (let j = 0; j < nfilt; j++) {
      a += w[j] * ci[o + j];
      b += w[j] * cq[o + j];
    }
    cfi[i] = a;
    cfq[i] = b;
  }
  for (let i = 0; i < nsig; i++) {
    if (i < nfilt / 2) norm = partialsum[nfilt / 2 + i];
    else if (i > nsig - 1 - nfilt / 2) norm = partialsum[nfilt / 2 + nsig - 1 - i];
    else norm = 1;
    const k = shift0 + i;
    const j = i + nfilt;
    if (k > 0 && k < np) {
      id[k] -= (cfi[j] * refi[i] - cfq[j] * refq[i]) / norm;
      qd[k] -= (cfi[j] * refq[i] + cfq[j] * refi[i]) / norm;
    }
  }
}

// ---------------------------------------------------------------- main loop

/**
 * Decodes one slot.
 * @param {Float32Array} samples - 12 kHz audio, starting at the even
 *   minute (a WSPR transmission starts 1 s later)
 * @param {object} [opts]
 * @param {Map<number,string>} [opts.hashtab] - callsign hash table, kept between slots
 * @param {number} [opts.fmin=-110] [opts.fmax=110] - search range around 1500 Hz
 * @param {number} [opts.npasses=3]
 * @param {number} [opts.maxcycles=10000] - Fano decoder cycles per bit
 * @param {number} [opts.deadline] - epoch ms; after it, the Fano limit drops to 200 cycles
 *   per bit. Failed Fano runs on noise take most of the time, so this bounds a busy slot.
 * @returns {Array<{snr:number, dt:number, audioHz:number, drift:number, sync:number,
 *   message:string, callsign:string, grid:string, dbm:number, type:number}>}
 */
function decodeWspr(samples, opts = {}) {
  const { id, qd, np } = downconvert(samples);
  return decodeBaseband(id, qd, np, opts);
}

function decodeBaseband(id, qd, np, opts = {}) {
  const { hashtab = new Map(), fmin = -110, fmax = 110, maxcycles = 10000, npasses = 3, deadline = Infinity, now = Date.now } = opts;
  const symfac = 50;
  const minsync1 = 0.1;
  const iifac = 8;
  const minrms = 52.0 * (symfac / 64.0);
  const nffts = 4 * Math.floor(np / 512) - 1;
  const win = new Float64Array(512);
  for (let i = 0; i < 512; i++) win[i] = Math.sin(0.006147931 * i);
  const ps = Array.from({ length: 512 }, () => new Float64Array(nffts));
  const fre = new Float64Array(512);
  const fim = new Float64Array(512);

  const decodes = [];
  let ndecodesPass = 0;
  for (let ipass = 0; ipass < npasses; ipass++) {
    if (ipass === 1 && ndecodesPass === 0 && npasses > 2) ipass = 2;
    let nblocksize;
    let maxdrift;
    let minsync2;
    if (ipass < 2) {
      nblocksize = 1;
      maxdrift = 4;
      minsync2 = 0.12;
    } else {
      nblocksize = 4;
      maxdrift = 0;
      minsync2 = 0.1;
    }
    ndecodesPass = 0;

    for (let i = 0; i < nffts; i++) {
      for (let j = 0; j < 512; j++) {
        const k = i * 128 + j;
        fre[j] = id[k] * win[j];
        fim[j] = qd[k] * win[j];
      }
      fft(fre, fim, -1);
      for (let j = 0; j < 512; j++) {
        let k = j + 256;
        if (k > 511) k -= 512;
        ps[j][i] = fre[k] * fre[k] + fim[k] * fim[k];
      }
    }
    const psavg = new Float64Array(512);
    for (let j = 0; j < 512; j++) for (let i = 0; i < nffts; i++) psavg[j] += ps[j][i];
    const smspec = new Float64Array(411);
    for (let i = 0; i < 411; i++) for (let j = -3; j <= 3; j++) smspec[i] += psavg[256 - 205 + i + j];
    const sorted = Float64Array.from(smspec).sort();
    const noiseLevel = sorted[122];
    const minSnr = 10 ** (-8 / 10);
    for (let j = 0; j < 411; j++) {
      smspec[j] = smspec[j] / noiseLevel - 1;
      if (!(smspec[j] >= minSnr)) smspec[j] = 0.1 * minSnr;
    }

    let candidates = [];
    for (let j = 1; j < 410 && candidates.length < 200; j++) {
      if (smspec[j] > smspec[j - 1] && smspec[j] > smspec[j + 1]) {
        candidates.push({ freq: (j - 205) * DF_SPEC, snr: 10 * Math.log10(smspec[j]) - 26.3, shift: 0, drift: 0, sync: 0 });
      }
    }
    candidates = candidates.filter((c) => c.freq >= fmin && c.freq <= fmax);
    // wsprd bubble-sorts by SNR, highest first (a stable sort)
    candidates.sort((a, b) => b.snr - a.snr);

    // coarse search over frequency, time and drift in the spectrogram
    const sq = ps.map((row) => row.map(Math.sqrt));
    for (const cand of candidates) {
      let smax = -1e30;
      const if0 = Math.round(cand.freq / DF_SPEC) + 256;
      for (let ifr = if0 - 2; ifr <= if0 + 2; ifr++) {
        for (let k0 = -10; k0 < 22; k0++) {
          for (let idrift = -maxdrift; idrift <= maxdrift; idrift++) {
            let ss = 0;
            let pow = 0;
            for (let k = 0; k < 162; k++) {
              const ifd = Math.trunc(ifr + ((k - 81) / 81) * (idrift / (2 * DF_SPEC)));
              const kindex = k0 + 2 * k;
              if (kindex >= 0 && kindex < nffts) {
                const p0 = sq[ifd - 3][kindex];
                const p1 = sq[ifd - 1][kindex];
                const p2 = sq[ifd + 1][kindex];
                const p3 = sq[ifd + 3][kindex];
                ss += (2 * PR3[k] - 1) * (p1 + p3 - (p0 + p2));
                pow += p0 + p1 + p2 + p3;
              }
            }
            const sync1 = ss / pow;
            if (sync1 > smax) {
              smax = sync1;
              cand.shift = 128 * (k0 + 1);
              cand.drift = idrift;
              cand.freq = (ifr - 256) * DF_SPEC;
              cand.sync = sync1;
            }
          }
        }
      }
    }

    // refine lag, frequency and drift
    for (const cand of candidates) {
      let f1 = cand.freq;
      let drift1 = cand.drift;
      let shift1 = cand.shift;
      let sync1 = cand.sync;
      let r = syncAndDemodulate(id, qd, np, { freq: f1, shift: shift1, drift: drift1, lagmin: shift1 - 128, lagmax: shift1 + 128, lagstep: 64 }, 0);
      shift1 = r.shift;
      sync1 = r.sync;
      r = syncAndDemodulate(id, qd, np, { freq: f1, shift: shift1, drift: drift1, fstep: 0.25, ifmin: -2, ifmax: 2 }, 1);
      f1 = r.freq;
      sync1 = r.sync;
      if (ipass < 2) {
        const rp = syncAndDemodulate(id, qd, np, { freq: f1, shift: shift1, drift: drift1 + 0.5, fstep: 0, ifmin: 0, ifmax: 0 }, 1);
        const rm = syncAndDemodulate(id, qd, np, { freq: f1, shift: shift1, drift: drift1 - 0.5, fstep: 0, ifmin: 0, ifmax: 0 }, 1);
        if (rp.sync > sync1) {
          drift1 += 0.5;
          sync1 = rp.sync;
        } else if (rm.sync > sync1) {
          drift1 -= 0.5;
          sync1 = rm.sync;
        }
      }
      if (sync1 > minsync1) {
        r = syncAndDemodulate(id, qd, np, { freq: f1, shift: shift1, drift: drift1, lagmin: shift1 - 32, lagmax: shift1 + 32, lagstep: 16 }, 0);
        shift1 = r.shift;
        sync1 = r.sync;
        r = syncAndDemodulate(id, qd, np, { freq: f1, shift: shift1, drift: drift1, fstep: 0.05, ifmin: -2, ifmax: 2 }, 1);
        f1 = r.freq;
        sync1 = r.sync;
        cand.freq = f1;
        cand.shift = shift1;
        cand.drift = drift1;
        cand.sync = sync1;
      }
    }

    // drop duplicates and weak sync
    const work = [];
    for (const cand of candidates) {
      const k = work.findIndex((w) => Math.abs(cand.freq - w.freq) < 0.05 && Math.abs(cand.shift - w.shift) < 16);
      if (k >= 0) {
        if (cand.sync > work[k].sync) work[k] = cand;
      } else if (cand.sync > minsync2) work.push(cand);
    }

    for (const cand of work) {
      const f1 = cand.freq;
      const shift1 = cand.shift;
      const drift1 = cand.drift;
      let result = null;
      for (let ib = 1; ib <= nblocksize && !result; ib++) {
        const blocksize = ib < 4 ? ib : 1;
        const bitmetric = ib === 4 ? 1 : 0;
        for (let idt = 0; !result && idt <= 128 / iifac; idt++) {
          let ii = Math.floor((idt + 1) / 2);
          if (idt % 2 === 1) ii = -ii;
          ii *= iifac;
          const symbols = noncoherentSequenceDetection(id, qd, np, f1, shift1 + ii, drift1, blocksize, bitmetric, symfac);
          let s2 = 0;
          for (let i = 0; i < 162; i++) s2 += (symbols[i] - 128) ** 2;
          if (Math.sqrt(s2 / 162) > minrms) {
            // past the deadline, give up on hard candidates quickly so the slot still finishes
            const dec = codec.fano(codec.deinterleave(symbols), { maxcycles: now() > deadline ? 200 : maxcycles });
            if (dec) result = { data: dec.data, jitter: ii };
          }
        }
      }
      if (!result) continue;
      ndecodesPass++;
      const msg = codec.unpackMessage(result.data, hashtab);
      if (!msg || !msg.print) continue;
      subtractSignal(id, qd, np, f1, shift1, drift1, codec.dataToSymbols(result.data));
      const name = msg.type === 3 ? msg.message.split(' ')[0] : msg.callsign;
      if (decodes.some((d) => d._name === name && Math.abs(f1 - d._f) < 4)) continue;
      decodes.push({
        _name: name,
        _f: f1,
        snr: Math.round(cand.snr),
        dt: Math.round((shift1 * DT - 1) * 10) / 10,
        audioHz: 1500 + f1,
        drift: Math.trunc(drift1),
        sync: cand.sync,
        message: msg.message,
        callsign: msg.callsign,
        grid: msg.grid,
        dbm: msg.dbm,
        type: msg.type,
        pass: ipass + 1,
      });
    }
  }
  decodes.sort((a, b) => a.audioHz - b.audioHz);
  return decodes.map(({ _name, _f, ...d }) => d);
}

module.exports = { decodeWspr, decodeBaseband, downconvert, fft };
