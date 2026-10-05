'use strict';

/**
 * A small, dependency-free radix-2 Cooley-Tukey FFT, purpose-built for
 * FT8's real-time audio spectrum display (see Ft8Bridge and
 * docs/ui-notes.md) rather than as a general-purpose DSP library.
 * `computeMagnitudeSpectrum()` is the only entry point most callers
 * need; `fftInPlace()`/`hannWindow()` are exported mainly for direct
 * unit testing (see test/fft.test.js) and because computeMagnitudeSpectrum
 * is itself built from them.
 *
 * Written from scratch rather than pulling in a dependency, consistent
 * with this project's "no external dependencies" preference elsewhere
 * (ft8ts itself is the one deliberate, accepted exception — see
 * README's Licence section) — an FFT is a well-understood, boundedly
 * complex algorithm, unlike an FT8 codec.
 */

function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * In-place iterative radix-2 FFT (decimation-in-time) on parallel
 * real/imaginary Float64Array pairs, both of length `n` (must be a
 * power of two). Standard bit-reversal-permutation + butterfly
 * algorithm; not optimized beyond that (no lookup-table twiddle
 * factors), which is more than fast enough at the sizes/rates this
 * app actually needs (a few thousand points, a few times a second).
 */
function fftInPlace(re, im) {
  const n = re.length;
  if (n !== im.length) throw new Error('fftInPlace requires re/im arrays of equal length');
  if (!isPowerOfTwo(n)) throw new Error(`fftInPlace requires a power-of-two length, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }

  // Iterative Cooley-Tukey butterflies, one stage per power-of-two
  // sub-length from 2 up to n.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angleStep = (-2 * Math.PI) / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const evenIdx = start + k;
        const oddIdx = start + k + half;
        const tr = re[oddIdx] * wr - im[oddIdx] * wi;
        const ti = re[oddIdx] * wi + im[oddIdx] * wr;
        re[oddIdx] = re[evenIdx] - tr;
        im[oddIdx] = im[evenIdx] - ti;
        re[evenIdx] += tr;
        im[evenIdx] += ti;
      }
    }
  }
}

/**
 * Hann window — tapers the analyzed chunk's edges to reduce spectral
 * leakage from the FFT's implicit rectangular windowing (without this,
 * a strong tone "smears" energy across many neighboring bins instead of
 * showing up as a clean peak).
 */
function hannWindow(n) {
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

/**
 * Computes a magnitude spectrum from a chunk of real-valued audio
 * samples. Takes the most recent `fftSize` samples (zero-padding at the
 * *start* if fewer are available, e.g. right after FT8 mode is first
 * activated and the rolling buffer hasn't filled yet), applies a Hann
 * window, runs the FFT, and returns the magnitude of each of the
 * fftSize/2 positive-frequency bins (real input, so negative-frequency
 * bins are a mirror image and carry no additional information) plus the
 * frequency width of one bin.
 *
 * @param {Float32Array|Float64Array} samples
 * @param {{fftSize: number, sampleRate: number}} opts
 * @returns {{magnitudes: Float64Array, binHz: number}}
 */
function computeMagnitudeSpectrum(samples, { fftSize, sampleRate }) {
  if (!isPowerOfTwo(fftSize)) throw new Error(`fftSize must be a power of two, got ${fftSize}`);
  if (!(sampleRate > 0)) throw new Error(`sampleRate must be positive, got ${sampleRate}`);

  const window = hannWindow(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize); // stays zero: real-valued input

  const n = samples.length;
  const usable = Math.min(fftSize, n);
  const padStart = fftSize - usable; // leading zero-pad if not enough samples yet
  const offset = Math.max(0, n - fftSize); // most recent `usable` samples
  for (let i = 0; i < usable; i++) {
    re[padStart + i] = samples[offset + i] * window[padStart + i];
  }

  fftInPlace(re, im);

  const binCount = fftSize / 2;
  const magnitudes = new Float64Array(binCount);
  for (let i = 0; i < binCount; i++) {
    magnitudes[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }

  return { magnitudes, binHz: sampleRate / fftSize };
}

module.exports = { isPowerOfTwo, fftInPlace, hannWindow, computeMagnitudeSpectrum };
