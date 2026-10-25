'use strict';

/**
 * HamDRM receiver, OFDM front end: robustness mode detection, OFDM symbol
 * extraction with time and frequency tracking, integer frequency offset and
 * frame start. Ported from QSSTV's drmrx (getmode.cpp, getofdm.cpp,
 * getofdmsync.cpp, getfoffsint.cpp, getsymbolidx.cpp, filter1.cpp,
 * filter1c.cpp), which M. Bos (PA0MBO) translated to C from Andreas
 * Dittrich's diorama MATLAB receiver.
 *
 * Portions copyright (C) 2009 M. Bos (PA0MBO); GPL-2.0-or-later. See
 * third_party/qsstv-drm/README.md.
 *
 * Complex data is stored as interleaved re, im pairs, as in the C code.
 * The C code works in single precision; this port works in double. The
 * odd-looking expressions marked "as QSSTV" are kept on purpose, so this
 * receiver behaves like the one EasyPal users test against.
 */

const { Ts_list, Tu_list } = require('./tables');

/** Forward complex DFT of a fixed length (direct, O(N^2); N is at most 288). */
class Dft {
  constructor(n) {
    this.n = n;
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    // radix-2 when it can be
    this.pow2 = (n & (n - 1)) === 0;
    if (this.pow2) {
      this.rev = new Uint32Array(n);
      const bits = Math.log2(n);
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        this.rev[i] = r;
      }
    }
  }

  /** X[k] = sum x[m] e^{-2 pi i k m / n}. x and out are interleaved complex arrays. */
  forward(x, out) {
    const n = this.n;
    if (this.pow2) {
      for (let i = 0; i < n; i++) {
        const r = this.rev[i];
        out[2 * r] = x[2 * i];
        out[2 * r + 1] = x[2 * i + 1];
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let j = 0; j < half; j++) {
            const wr = this.cos[j * step];
            const wi = -this.sin[j * step];
            const a = start + j;
            const b = a + half;
            const tr = out[2 * b] * wr - out[2 * b + 1] * wi;
            const ti = out[2 * b] * wi + out[2 * b + 1] * wr;
            out[2 * b] = out[2 * a] - tr;
            out[2 * b + 1] = out[2 * a + 1] - ti;
            out[2 * a] += tr;
            out[2 * a + 1] += ti;
          }
        }
      }
      return out;
    }
    for (let k = 0; k < n; k++) {
      let re = 0;
      let im = 0;
      let idx = 0;
      for (let m = 0; m < n; m++) {
        const c = this.cos[idx];
        const s = this.sin[idx];
        const xr = x[2 * m];
        const xi = x[2 * m + 1];
        re += xr * c + xi * s;
        im += xi * c - xr * s;
        idx += k;
        if (idx >= n) idx -= n;
      }
      out[2 * k] = re;
      out[2 * k + 1] = im;
    }
    return out;
  }
}

/** MATLAB filter(coef, 1, x) for real x (filter1.cpp). */
function filterReal(x, out, coef, dataLen, coefLen) {
  for (let i = 0; i < dataLen; i++) {
    let acc = 0;
    const jmax = Math.min(i, coefLen - 1);
    for (let j = 0; j <= jmax; j++) acc += coef[j] * x[i - j];
    out[i] = acc;
  }
}

/** MATLAB filter(coef, 1, x) for complex x (filter1c.cpp). */
function filterComplex(x, out, coef, dataLen, coefLen) {
  for (let i = 0; i < dataLen; i++) {
    let re = 0;
    let im = 0;
    const jmax = Math.min(i, coefLen - 1);
    for (let j = 0; j <= jmax; j++) {
      re += coef[j] * x[2 * (i - j)];
      im += coef[j] * x[2 * (i - j) + 1];
    }
    out[2 * i] = re;
    out[2 * i + 1] = im;
  }
}

/**
 * Robustness mode, time offset, sample rate offset and fractional frequency
 * offset from the guard-interval correlation (getmode.cpp).
 * @param {Float64Array} input n complex samples
 * @returns {{mode:number, timeOffset:number, sampleRateOffset:number, freqOffsetFract:number, scores:number[]}} mode 99 if not found
 */
function getmode(input, n) {
  const EPSILON = 1.0e-10;
  const SNR_mode_det = Math.exp((15.0 * Math.log(10)) / 10.0);
  const rho = SNR_mode_det / (SNR_mode_det + 1);
  const nSym = Math.trunc((n + 1) / Ts_list[0]) - 1;
  const inC = new Float64Array(2 * n);
  const convIn = new Float64Array(2 * n);
  const absIn = new Float64Array(n);
  const absInIn = new Float64Array(n);
  const convAbs = new Float64Array(n);
  const rect = new Float64Array(Ts_list[3]);
  const gamma = new Float64Array(2 * Ts_list[0]);
  const Phi = new Float64Array(Ts_list[0]);
  const maxList = [0, 0, 0, 0];
  const thetaList = [0, 0, 0, 0];
  const epsList = [0, 0, 0, 0];

  const correlate = (Tu, Tg, lastHalf) => {
    for (let i = 0; i < n - Tu; i++) {
      const a = 2 * i;
      const b = 2 * (i + Tu);
      inC[a] = input[a] * input[b] + input[a + 1] * input[b + 1];
      inC[a + 1] = -input[a] * input[b + 1] + input[a + 1] * input[b];
    }
    rect[0] = 0.5;
    for (let i = 1; i < Tg; i++) rect[i] = 1.0;
    if (lastHalf) rect[Tg - 1] = 0.5;
    filterComplex(inC, convIn, rect, n - Tu, Tg);
    for (let i = 0; i < n; i++) absIn[i] = input[2 * i] * input[2 * i] + input[2 * i + 1] * input[2 * i + 1];
    for (let i = 0; i < n - Tu; i++) absInIn[i] = absIn[i] + absIn[i + Tu];
    filterReal(absInIn, convAbs, rect, n - Tu, Tg);
  };

  for (let mode = 0; mode < 3; mode++) {
    const Ts = Ts_list[mode];
    const Tu = Tu_list[mode];
    const Tg = Ts - Tu;
    gamma.fill(0);
    Phi.fill(0);
    correlate(Tu, Tg, false);
    let t = 0;
    for (let j = 0; j < nSym; j++) {
      for (let i = 0; i < Ts; i++) {
        const k = t + Tg + i - 1;
        gamma[2 * i] += convIn[2 * k];
        gamma[2 * i + 1] += convIn[2 * k + 1];
        Phi[i] += 0.5 * (EPSILON + convAbs[k]);
      }
      t += Ts;
    }
    let theta = 0;
    let best = -1e20;
    for (let i = 0; i < Ts; i++) {
      const v = Math.hypot(gamma[2 * i], gamma[2 * i + 1]) - rho * Phi[i];
      if (v > best) {
        best = v;
        theta = i;
      }
    }
    maxList[mode] = Math.hypot(gamma[2 * theta], gamma[2 * theta + 1]) / (rho * Phi[theta]);
    thetaList[mode] = theta;
    epsList[mode] = Math.atan2(gamma[2 * theta], gamma[2 * theta + 1]); // (re, im) order as QSSTV; unused
  }

  let mode = 0;
  let best = -1e20;
  for (let i = 0; i < 4; i++) {
    if (maxList[i] > best) {
      best = maxList[i];
      mode = i;
    }
  }
  let ok = best > 0.6;
  if (ok) for (let i = 0; i < 3; i++) if (i !== mode && maxList[i] > 0.6) ok = false;
  if (!ok) return { mode: 99, timeOffset: 0, sampleRateOffset: 0, freqOffsetFract: 0, scores: maxList };

  const Ts = Ts_list[mode];
  const Tu = Tu_list[mode];
  const Tg = Ts - Tu;
  const timeOffsetMean = thetaList[mode];
  correlate(Tu, Tg, true);
  let t = Tg + timeOffsetMean + Ts / 2;
  const b = [];
  for (let j = 0; j < nSym - 2; j++) {
    let bestv = -1e20;
    let bi = 0;
    for (let i = 0; i < Ts; i++) {
      const v = Math.hypot(convIn[2 * (t + i)], convIn[2 * (t + i) + 1]) - rho * 0.5 * (EPSILON + convAbs[t + i]);
      if (v > bestv) {
        bestv = v;
        bi = i;
      }
    }
    b.push(bi);
    t += Ts;
  }
  let sumx = 0;
  let sumy = 0;
  let sumxx = 0;
  let sumxy = 0;
  const N = nSym - 2;
  for (let i = 0; i < N; i++) {
    sumx += i;
    sumy += b[i];
    sumxx += i * i;
    sumxy += i * b[i];
  }
  const slope = (N * sumxy - sumx * sumy) / (N * sumxx - sumx * sumx);
  const boffs = (sumy * sumxx - sumx * sumxy) / (N * sumxx - sumx * sumx);
  return {
    mode,
    timeOffset: (boffs + Ts / 2 + timeOffsetMean - 1) % Ts, // fmodf: keeps the sign
    sampleRateOffset: slope / Ts,
    freqOffsetFract: epsList[mode],
    scores: maxList,
  };
}

/** Turns an FFT into the carrier-ordered symbol QSSTV uses (index Tu/2 is DC), with the time-offset phase ramp. */
function arrange(S, Tu, shift, out, lastPositive) {
  const half = Tu / 2;
  // negative frequencies: out[half-1-i] = S[Tu-1-i] e^{-j(i+1)w}
  for (let i = 0; i < half; i++) {
    const a = ((i + 1) * 2 * Math.PI * shift) / Tu;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const re = S[2 * (Tu - 1 - i)];
    const im = S[2 * (Tu - 1 - i) + 1];
    out[2 * (half - 1 - i)] = re * c + im * s;
    out[2 * (half - 1 - i) + 1] = im * c - re * s;
  }
  for (let i = 0; i < lastPositive; i++) {
    const a = (i * 2 * Math.PI * shift) / Tu;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const re = S[2 * i];
    const im = S[2 * i + 1];
    out[2 * (half + i)] = re * c - im * s;
    out[2 * (half + i) + 1] = im * c + re * s;
  }
  for (let i = half + lastPositive; i < Tu; i++) out[2 * i] = out[2 * i + 1] = 0;
}

/**
 * One OFDM symbol with guard-interval time tracking and frequency tracking
 * (getofdm.cpp). Zi is the tracking state, shared with getofdmsync.
 * @returns {number} the integer time step taken (-1, 0 or 1)
 */
function getofdm(rs, off, tofInit, foInit, dtoIInit, Ts, Tu, Zi, out, ctx) {
  const EPSILON = 1.0e-10;
  const max_theta = 5.0;
  const kP_small_timing = 0.01;
  const kP_large_timing = 0.01;
  const threshold_timing = 2.0;
  const kI_timing = 0.00005;
  const kP_small_freq = 0.05;
  const kP_large_freq = 0.75;
  const threshold_freq = 0.5;
  const kI_freq = 0.0008;
  const Tg = Ts - Tu;
  const Tgh = Math.floor(Tg / 2 + 0.5);
  let phiLast;
  let dtoI;
  let dfoI;
  let fo;
  let tof;
  if (Zi[0] < 0.0) {
    phiLast = 0.0;
    dtoI = dtoIInit;
    dfoI = 0.0;
    fo = foInit;
    tof = tofInit;
  } else {
    phiLast = Zi[1];
    dtoI = Zi[2];
    dfoI = Zi[3];
    fo = Zi[4];
    tof = Zi[5];
  }
  const R = (i) => rs[off + 2 * i];
  const I = (i) => rs[off + 2 * i + 1];

  // time offset from the guard interval
  let t1r = 0;
  let t1i = 0;
  let t2 = 0;
  let t3 = 0;
  for (let i = 0; i < Tg + 2; i++) {
    t1r += R(i) * R(Tu + i) + I(i) * I(Tu + i);
    t1i += -R(i) * I(Tu + i) + I(i) * R(Tu + i);
    t2 += R(i) * R(i) + I(i) * I(i);
    t3 += R(i + Tu) * R(i + Tu) + I(i + Tu) * I(i + Tu);
  }
  const t4 = EPSILON + 0.5 * (t2 + t3);
  let t5r = 0;
  let t5i = 0;
  let t6 = 0;
  let t7 = 0;
  let t8r = 0;
  let t8i = 0;
  let t9 = 0;
  let t10 = 0;
  for (let i = 0; i < 5; i++) {
    t5r += R(i) * R(Tu + i) + I(i) * I(Tu + i);
    t5i += -R(i) * I(Tu + i) + I(i) * R(Tu + i);
    t6 += R(i) * R(i) + I(i) * I(i);
    t7 += R(i + Tu) * R(i + Tu) + I(i + Tu) * I(i + Tu);
    const a = i + Tg - 3;
    const b = i + Tu + Tg - 3;
    t8r += R(a) * R(b) + I(a) * I(b);
    t8i += -R(a) * I(b) + I(a) + R(b); // as QSSTV ("+" where "*" was meant)
    t9 += R(a) * R(a) + I(a) * I(a);
    t10 += R(b) * R(b) + I(b) * I(b);
  }
  let theta_plus = Math.hypot(t1r - t5r, t1i - t5i);
  theta_plus -= 0.5 * (-t6 - t7);
  let theta_minus = Math.hypot(t1r - t8r, t1i - t8i);
  theta_minus -= 0.5 * (t9 - t10);
  let delta_theta = ((theta_plus - theta_minus) * Tgh) / t4;
  if (delta_theta < -max_theta) delta_theta = -max_theta;
  if (delta_theta > max_theta) delta_theta = max_theta;
  const ctrl = delta_theta - tof;
  dtoI += kI_timing * ctrl;
  const dtoP = kP_large_timing * ctrl + threshold_timing * (kP_small_timing - kP_large_timing) * Math.tanh(ctrl / threshold_timing);
  const dto = dtoP + dtoI + tof;
  let dtoInt = Math.floor(dto + 0.5);
  if (dtoInt < -1) dtoInt = -1;
  if (dtoInt > 1) dtoInt = 1;
  tof = dto - dtoInt;
  // QSSTV adds (dtoInt / Tu) * fo here in integer arithmetic, which is always 0

  // frequency offset from the guard interval
  let tr = 0;
  let ti = 0;
  for (let i = 0; i < Tg; i++) {
    const a = i + 1 + dtoInt;
    tr += R(a) * R(a + Tu) + I(a) * I(a + Tu);
    ti += I(a) * R(a + Tu) - R(a) * I(a + Tu);
  }
  const eps = Math.atan2(ti, tr);
  const foCtrl = ((eps - fo + Math.PI + 100.0 * Math.PI) % (2 * Math.PI)) - Math.PI; // fmodf, as QSSTV
  dfoI += kI_freq * foCtrl;
  const dfoP = kP_large_freq * foCtrl + threshold_freq * (kP_small_freq - kP_large_freq) * Math.tanh(foCtrl / threshold_freq);
  fo += dfoP + dfoI;

  // take the symbol, correct the frequency, FFT
  const s = ctx.s;
  for (let i = 0; i < Tu; i++) {
    const th = (fo / Tu) * i + phiLast;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const k = 1 + dtoInt + Tgh + i;
    s[2 * i] = R(k) * c - I(k) * sn;
    s[2 * i + 1] = R(k) * sn + I(k) * c;
  }
  phiLast = (phiLast + (Ts / Tu) * fo) % (2 * Math.PI);
  const S = ctx.dft.forward(s, ctx.S);
  arrange(S, Tu, Tgh + tof, out, Tu / 2);
  Zi[0] = 1.0;
  Zi[1] = phiLast;
  Zi[2] = dtoI;
  Zi[3] = dfoI;
  Zi[4] = fo;
  Zi[5] = tof;
  return dtoInt;
}

/**
 * Time and frequency tracking once the channel is known (getofdmsync.cpp):
 * timing from the channel impulse response, frequency from the pilots'
 * phase drift (deltaFreqOffset).
 */
class OfdmSync {
  constructor(Ts, Tu, lH) {
    this.Ts = Ts;
    this.Tu = Tu;
    this.Tg = Ts - Tu;
    this.Tgh = Math.floor(this.Tg / 2 + 0.5);
    this.Tc = 2 ** Math.ceil(Math.log(lH) / Math.log(2.0));
    this.Tgs = Math.floor((this.Tg / Tu) * this.Tc);
    this.Tgsh = Math.floor((this.Tg / Tu / 2.0) * this.Tc);
    this.lH = lH;
    this.sinfilter = new Float64Array(this.Tgs);
    for (let i = 0; i < this.Tgs; i++) this.sinfilter[i] = Math.sin(((i + 1.0) / (this.Tgs + 1.0)) * Math.PI) ** 0.001;
    this.dftC = new Dft(this.Tc);
    this.dftU = new Dft(Tu);
    this.h = new Float64Array(2 * this.Tc);
    this.H = new Float64Array(2 * this.Tc);
    this.habs = new Float64Array(2 * this.Tc);
    this.hfilt = new Float64Array(2 * this.Tc);
    this.s = new Float64Array(2 * Tu);
    this.S = new Float64Array(2 * Tu);
  }

  /** @returns {number} the integer time step taken */
  next(rs, off, H, deltaFreqOffset, Zi, out) {
    const { Ts, Tu, Tgh, Tc, Tgs, Tgsh, lH } = this;
    const kP_small = 0.001;
    const kP_large = 0.001;
    const threshold = Tgh;
    const kI = 2e-5;
    const maxDeltaTheta = Tgh;
    const maxDtoInt = 3;
    const maxSpo = Tgh - maxDtoInt;
    const kPfreq = 0.01;
    let phiLast = Zi[1];
    let dtoI = Zi[2];
    let fo = Zi[4];
    let tof = Zi[5];

    // timing from the channel impulse response
    for (let i = 0; i < lH; i++) {
      this.h[2 * i] = H[2 * i];
      this.h[2 * i + 1] = H[2 * i + 1];
    }
    for (let i = lH; i < Tc; i++) this.h[2 * i] = this.h[2 * i + 1] = 0;
    this.dftC.forward(this.h, this.H);
    for (let i = 0; i < Tc; i++) {
      const v = this.H[2 * i] * this.H[2 * i] + this.H[2 * i + 1] * this.H[2 * i + 1];
      this.habs[i] = v;
      this.habs[i + Tc] = v;
    }
    filterReal(this.habs, this.hfilt, this.sinfilter, 2 * Tc, Tgs);
    let best = -1e30;
    let idx = 0;
    for (let i = 0; i < 2 * Tc; i++) {
      if (this.hfilt[i] > best) {
        best = this.hfilt[i];
        idx = i;
      }
    }
    let deltaTheta = ((((Tc + Tgsh - idx + Math.trunc(Tc * 1.5)) % Tc) - Math.trunc(Tc / 2)) * Tu) / Tc;
    if (deltaTheta >= maxDeltaTheta) deltaTheta = maxDeltaTheta;
    if (deltaTheta <= -maxDeltaTheta) deltaTheta = -maxDeltaTheta;
    const ctrl = deltaTheta - tof;
    dtoI += kI * ctrl;
    const dtoP = kP_large * ctrl + threshold * (kP_small - kP_large) * Math.tanh(ctrl / threshold);
    const dto = dtoP + dtoI + tof;
    let dtoInt = Math.floor(dto + 0.5);
    if (dtoInt < -maxDtoInt) dtoInt = -maxDtoInt;
    if (dtoInt > maxDtoInt) dtoInt = maxDtoInt;
    tof = dto - dtoInt;
    let spo = Math.floor(deltaTheta - dtoInt + 0.5);
    if (spo < -maxSpo) spo = -maxSpo;
    if (spo > maxSpo) spo = maxSpo;
    phiLast += (dtoInt / Tu) * fo;

    fo += kPfreq * deltaFreqOffset;

    const s = this.s;
    for (let i = 0; i < Tu; i++) {
      const th = (fo / Tu) * (i + spo) + phiLast;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const k = off + 2 * (i + 1 + dtoInt + Tgh + spo);
      s[2 * i] = rs[k] * c - rs[k + 1] * sn;
      s[2 * i + 1] = rs[k] * sn + rs[k + 1] * c;
    }
    phiLast = (phiLast + (Ts / Tu) * fo) % (2 * Math.PI);
    this.dftU.forward(s, this.S);
    arrange(this.S, Tu, Tgh + tof - spo, out, Tu / 2 - 1);
    Zi[1] = phiLast;
    Zi[2] = dtoI;
    Zi[4] = fo;
    Zi[5] = tof;
    return dtoInt;
  }
}

/** Integer frequency offset (in radians per symbol, a multiple of 2 pi) from the frequency pilots' steady phase (getfoffsint.cpp). */
function getfoffsint(symbuf, nSymbols, K_dc, K_modulo, Tu) {
  const dS = new Float64Array(2 * Tu);
  for (let i = 1; i < nSymbols; i++) {
    for (let j = 0; j < Tu; j++) {
      const a = 2 * (j + (i - 1) * K_modulo);
      const b = 2 * (j + i * K_modulo);
      const re = symbuf[a] * symbuf[b] + symbuf[a + 1] * symbuf[b + 1];
      const im = symbuf[a + 1] * symbuf[b] - symbuf[a] * symbuf[b + 1];
      const ang = Math.atan2(im, re);
      dS[2 * j] += Math.cos(ang);
      dS[2 * j + 1] += Math.sin(ang);
    }
  }
  const k1 = Math.trunc((9 * Tu) / 288);
  const k2 = Math.trunc((27 * Tu) / 288);
  const k3 = Math.trunc((36 * Tu) / 288);
  const abs = new Float64Array(Tu);
  for (let i = 0; i < Tu; i++) abs[i] = Math.hypot(dS[2 * i], dS[2 * i + 1]);
  let best = -1e20;
  let off = 0;
  for (let i = 0; i < Tu; i++) {
    const v = abs[(i + k1) % Tu] + abs[(i + k2) % Tu] + abs[(i + k3) % Tu];
    if (v > best) {
      best = v;
      off = i;
    }
  }
  off = ((off - K_dc + Tu / 2 + Tu) % Tu) - Tu / 2;
  return 2 * Math.PI * off;
}

/** First symbol of the frame, from the time reference cells (getsymbolidx.cpp). */
function getsymbolidx(symbuf, symbolsPerFrame, trK, trTheta, K_dc, K_modulo, nCells) {
  const sum = new Float64Array(symbolsPerFrame);
  for (let n = 0; n < nCells - 1; n++) {
    if (trK[n + 1] - trK[n] !== 1) continue;
    const k1 = K_dc + trK[n];
    const k2 = K_dc + trK[n + 1];
    const p1 = (2.0 * Math.PI * trTheta[n]) / 1024.0;
    const p2 = (2.0 * Math.PI * trTheta[n + 1]) / 1024.0;
    const c1 = Math.cos(p1);
    const s1 = Math.sin(p1);
    const c2 = Math.cos(p2);
    const s2 = Math.sin(p2);
    for (let j = 0; j < symbolsPerFrame; j++) {
      const a = 2 * (k1 + j * K_modulo);
      const b = 2 * (k2 + j * K_modulo);
      const r1 = symbuf[a] * c1 + symbuf[a + 1] * s1;
      const i1 = symbuf[a + 1] * c1 - symbuf[a] * s1;
      const r2 = symbuf[b] * c2 + symbuf[b + 1] * s2;
      const i2 = symbuf[b + 1] * c2 - symbuf[b] * s2;
      sum[j] += r1 * r2 + i1 * i2;
    }
  }
  let best = -1e20;
  let symbol0 = 0;
  for (let j = 0; j < symbolsPerFrame; j++) {
    if (Math.abs(sum[j]) > best) {
      best = Math.abs(sum[j]);
      symbol0 = j;
    }
  }
  return symbol0;
}

module.exports = { Dft, filterReal, filterComplex, getmode, getofdm, OfdmSync, getfoffsint, getsymbolidx };
