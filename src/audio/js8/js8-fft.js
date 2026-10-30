'use strict';

/**
 * A mixed-radix FFT (radices 2, 3, 4 and 5) for the JS8 decoder.
 *
 * JS8 works with sizes that are not powers of two: 192000 (the whole slot,
 * zero-padded), 180000, 3840 and 3200 points. src/audio/fft.js is radix-2
 * only, so this is a separate, small Stockham FFT. It is unnormalised in
 * both directions, like FFTW, which the JS8 code it was ported from uses.
 *
 * One FftPlan per size: it keeps the factors and a table of twiddle
 * factors, and two scratch buffers.
 */

function factorise(n) {
  const radices = [];
  let rest = n;
  for (const r of [4, 2, 3, 5]) {
    while (rest % r === 0) {
      radices.push(r);
      rest /= r;
    }
  }
  if (rest !== 1) throw new Error(`FFT size ${n} has a factor other than 2, 3 and 5`);
  return radices;
}

class FftPlan {
  constructor(n) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`Bad FFT size ${n}`);
    this.n = n;
    this.radices = n === 1 ? [] : factorise(n);
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * i) / n;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
    this._re = new Float64Array(n);
    this._im = new Float64Array(n);
  }

  /** Forward transform (e^-i), in place on two Float64Arrays (or Float32Arrays) of length n. */
  forward(re, im) {
    this._run(re, im);
  }

  /** Inverse transform (e^+i), unnormalised, in place. */
  inverse(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this._run(re, im);
    for (let i = 0; i < n; i++) im[i] = -im[i];
  }

  _run(re, im) {
    const N = this.n;
    if (N === 1) return;
    let xr = re;
    let xi = im;
    let yr = this._re;
    let yi = this._im;
    let n = N;
    let s = 1;
    const C = this.cos;
    const S = this.sin;
    for (const p of this.radices) {
      const m = n / p;
      const tw = N / n; // twiddle W_n^k = W_N^(k*tw)
      for (let q = 0; q < m; q++) {
        if (p === 2) {
          const wr = C[q * tw];
          const wi = S[q * tw];
          for (let t = 0; t < s; t++) {
            const a = t + s * q;
            const b = a + s * m;
            const ar = xr[a];
            const ai = xi[a];
            const br = xr[b];
            const bi = xi[b];
            const o = t + s * 2 * q;
            yr[o] = ar + br;
            yi[o] = ai + bi;
            const dr = ar - br;
            const di = ai - bi;
            yr[o + s] = dr * wr - di * wi;
            yi[o + s] = dr * wi + di * wr;
          }
        } else if (p === 4) {
          const w1r = C[q * tw];
          const w1i = S[q * tw];
          const w2r = C[2 * q * tw];
          const w2i = S[2 * q * tw];
          const w3r = C[3 * q * tw];
          const w3i = S[3 * q * tw];
          for (let t = 0; t < s; t++) {
            const i0 = t + s * q;
            const i1 = i0 + s * m;
            const i2 = i1 + s * m;
            const i3 = i2 + s * m;
            const a0r = xr[i0], a0i = xi[i0];
            const a1r = xr[i1], a1i = xi[i1];
            const a2r = xr[i2], a2i = xi[i2];
            const a3r = xr[i3], a3i = xi[i3];
            const t0r = a0r + a2r, t0i = a0i + a2i;
            const t1r = a0r - a2r, t1i = a0i - a2i;
            const t2r = a1r + a3r, t2i = a1i + a3i;
            // (a1 - a3) * -i
            const t3r = a1i - a3i, t3i = a3r - a1r;
            const o = t + s * 4 * q;
            yr[o] = t0r + t2r;
            yi[o] = t0i + t2i;
            let br = t1r + t3r, bi = t1i + t3i;
            yr[o + s] = br * w1r - bi * w1i;
            yi[o + s] = br * w1i + bi * w1r;
            br = t0r - t2r;
            bi = t0i - t2i;
            yr[o + 2 * s] = br * w2r - bi * w2i;
            yi[o + 2 * s] = br * w2i + bi * w2r;
            br = t1r - t3r;
            bi = t1i - t3i;
            yr[o + 3 * s] = br * w3r - bi * w3i;
            yi[o + 3 * s] = br * w3i + bi * w3r;
          }
        } else {
          // Radix 3 or 5: a direct p-point DFT, then the twiddles.
          const step = N / p; // W_p^k = W_N^(k*N/p)
          for (let t = 0; t < s; t++) {
            const o = t + s * p * q;
            for (let j = 0; j < p; j++) {
              let sr = 0;
              let si = 0;
              for (let k = 0; k < p; k++) {
                const idx = t + s * (q + k * m);
                const w = ((j * k) % p) * step;
                const c = C[w];
                const d = S[w];
                sr += xr[idx] * c - xi[idx] * d;
                si += xr[idx] * d + xi[idx] * c;
              }
              const w = (j * q * tw) % N;
              const c = C[w];
              const d = S[w];
              yr[o + s * j] = sr * c - si * d;
              yi[o + s * j] = sr * d + si * c;
            }
          }
        }
      }
      n = m;
      s *= p;
      [xr, yr] = [yr, xr];
      [xi, yi] = [yi, xi];
    }
    if (xr !== re) {
      re.set(xr);
      im.set(xi);
    }
  }
}

const plans = new Map();

/** A shared plan for size n (plans are reused; don't use one from two places at once). */
function fftPlan(n) {
  let plan = plans.get(n);
  if (!plan) {
    plan = new FftPlan(n);
    plans.set(n, plan);
  }
  return plan;
}

module.exports = { FftPlan, fftPlan, factorise };
