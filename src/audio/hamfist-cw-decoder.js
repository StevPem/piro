'use strict';

const { EventEmitter } = require('events');
const { fftInPlace } = require('./fft');
const DATA = require('./hamfist-data.json');

/**
 * "CW 2" — a port of Jonathan Dawson (G6AMU)'s "Hamfist" CW decoder
 * (https://github.com/dawsonjon/HamFist, cw_decoder/ — MIT licensed) to
 * run against PiRO's own PCM stream, as an alternative to this app's
 * original decoder (cw-decoder.js, "CW 1"). See cw-decoder-bridge.js for
 * how the two are switched between.
 *
 * Architecturally very different from CW 1: rather than a Goertzel
 * filter locked to one target frequency plus a scalar adaptive noise
 * floor/unit-length estimate, Hamfist runs a small FFT and decodes
 * across several frequency "channels" in parallel (so it doesn't need
 * CW 1's periodic pitch auto-calibration sweep — whichever channel has
 * the tone just lights up on its own), with per-bin gated noise
 * estimation, histogram-based (not fixed-ratio) dot/dash/gap
 * classification, and a Bayesian beam-search decode with a ~9800-word
 * dictionary for letter/word-boundary disambiguation and autocorrect.
 * Ported from cw_dsp.cpp/cw_classifier.cpp/cw_decode.cpp/dictionary.cpp/
 * cw_data.cpp (see hamfist-data.json for the extracted MORSE table,
 * prosign list, and autocorrect dictionary+rankings).
 *
 * Two deliberate departures from the original, both because this is a
 * software port of firmware originally paired with its own dedicated
 * ADC, not a drop-in of the exact same numeric pipeline:
 *
 *  1. The original decimates a 15000Hz ADC stream straight to 7500Hz by
 *     simply keeping every other sample, with no anti-alias filtering,
 *     relying on the hardware's own analog front end already being
 *     bandlimited well under 7.5kHz. PiRO's capture rate is typically
 *     48000Hz (a 6.4x decimation to Hamfist's working rate), and PiRO's
 *     software pipeline has no equivalent guarantee, so a simple one-pole
 *     low-pass filter is applied ahead of decimation here — an addition,
 *     not present in the original source.
 *  2. The original's fixed-point FFT scales its output down at each
 *     butterfly stage to avoid overflow on embedded hardware; this port
 *     uses plain floating-point magnitudes instead (see fft.js), which
 *     are therefore larger in absolute terms. This only matters for one
 *     of Hamfist's constants — the absolute noise-floor floor of 5 in
 *     _updateNoiseFloor() below — which exists purely to stop the floor
 *     collapsing to zero during true silence; at any real signal level
 *     (speech- or CW-tone-range PCM) it's several orders of magnitude
 *     below the actual magnitudes either implementation would see, so
 *     the mismatch has no practical effect. Every other Hamfist constant
 *     ported here (thresh_mult, the 0.7x hysteresis factor, the 12dB SNR
 *     gate, etc.) is a ratio between two magnitudes computed the same
 *     way, so it carries over unchanged regardless of absolute scaling.
 *
 * Exposes the same minimal event-driven interface as CwDecoder
 * (pushSamples(), 'char'/'space' events, reset(), setPitch() — a no-op
 * here, see its own doc comment, estimatedWpm) so CwDecoderBridge can
 * treat either decoder identically.
 */

// --- Tunable/structural constants (ported from cw_dsp.h) ---
const FRAME_SIZE = 64; // samples per FFT frame, at the decimated rate below
const TARGET_SAMPLE_RATE = 7500; // Hamfist's own working rate, post-decimation
const FRAME_MS = (1000 * FRAME_SIZE) / TARGET_SAMPLE_RATE; // ~8.5333ms/frame
const NUM_CHANNELS = 6;
const CHANNEL_SIZE = 5;
const BIN_COUNT = FRAME_SIZE / 2; // 32 FFT bins actually computed
const OBSERVATION_BUFFER_SIZE = 50; // enough observations to (re)train a channel
const OBSERVATION_BURST_SIZE = 10; // enough observations to update an already-trained channel
const TIMEOUT_FRAMES = 500; // ~4.27s of one continuous state -> treat as end of transmission
const THRESH_MULT = 9; // tone-present threshold = noise_estimate * THRESH_MULT
const MIN_DECODE_SNR_DB = 12.0; // below this, a channel's observations are too noisy to bother decoding
const ACTIVE_CHANNEL_SWITCH_MARGIN_DB = 3.0; // hysteresis so the ticker doesn't flap between two simultaneously-active channels

// --- Beam-search decoder constants (ported from cw_decode.h) ---
const BEAM_WIDTH = 3;

// --- Timing-classifier constants (ported from cw_classifier.h) ---
const BIN_WIDTH = 10;
const BIN_MAX = 500;
const NUM_HIST_BINS = BIN_MAX / BIN_WIDTH;

function generateWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  return w;
}

// === Morse binary-tree lookup (ported from cw_data.cpp's indexing scheme) ===
// MORSE is a 128-char flattened binary tree: walking a dot/dash pattern
// one symbol at a time computes an index into it exactly as the original
// C++ does (dot: index += 1; dash: index += the current level's "span",
// halving from 64 down to 1 over 7 levels) — not a conceptually tidy
// scheme, just ported byte-for-byte so MORSE/PROSIGNS stay meaningful.
function morsePatternIndex(pattern) {
  let span = 128;
  let index = 0;
  for (let i = 0; i < 7; i++) {
    span >>= 1;
    if (i >= pattern.length) return index;
    const c = pattern[i];
    if (c === '.') index += 1;
    else if (c === '-') index += span;
  }
  return null; // pattern longer than any real/prosign code supports
}

function isStartOfCode(pattern) {
  const idx = morsePatternIndex(pattern);
  if (idx === null) return false;
  return DATA.morse[idx] !== '~';
}

function getLetterFromCode(pattern) {
  const idx = morsePatternIndex(pattern);
  if (idx === null) return '#';
  return DATA.morse[idx];
}

// === Dictionary / autocorrect (ported from dictionary.cpp) ===
const WORDS = DATA.words;
const RANKINGS = DATA.rankings;

function strCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function binarySearchWord(target) {
  let left = 0;
  let right = WORDS.length - 1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const cmp = strCmp(WORDS[mid], target);
    if (cmp === 0) return true;
    else if (cmp < 0) left = mid + 1;
    else right = mid - 1;
  }
  return false;
}

function hasPrefix(word, target) {
  return word.length >= target.length && word.slice(0, target.length) === target;
}

function binarySearchPrefix(target) {
  let left = 0;
  let right = WORDS.length - 1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const word = WORDS[mid];
    if (hasPrefix(word, target)) return true;
    else if (strCmp(word, target) < 0) left = mid + 1;
    else right = mid - 1;
  }
  return false;
}

function binarySearchInsertionPoint(key) {
  let left = 0;
  let right = WORDS.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (WORDS[mid] < key) left = mid + 1;
    else right = mid;
  }
  return left;
}

function binarySearchRanking(target) {
  let left = 0;
  let right = WORDS.length - 1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const cmp = strCmp(WORDS[mid], target);
    if (cmp === 0) return RANKINGS[mid];
    else if (cmp < 0) left = mid + 1;
    else right = mid - 1;
  }
  return -1;
}

function levenshteinDistance1(a, b) {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > 1) return 2;

  let i = 0;
  let j = 0;
  let foundDiff = false;
  while (i < lenA && j < lenB) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (foundDiff) return 2;
    foundDiff = true;
    if (lenA > lenB) i++;
    else if (lenA < lenB) j++;
    else {
      i++;
      j++;
    }
  }
  if (i < lenA || j < lenB) {
    if (foundDiff) return 2;
    foundDiff = true;
  }
  return foundDiff ? 1 : 0;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Returns `word` unchanged, or the dictionary word it's edit-distance-1 from (preferring the better-ranked candidate), ported from dictionary.cpp#autocorrect. */
function autocorrect(word) {
  if (binarySearchWord(word)) return word;

  let bestWord = word;
  let bestDistance = Infinity;
  let bestRanking = Infinity;

  const idx = binarySearchInsertionPoint(word);
  const WINDOW = 50; // good balance for ~10k words, per the original's own comment
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(WORDS.length, idx + WINDOW);
  for (let i = start; i < end; i++) {
    const candidate = WORDS[i];
    const d = levenshteinDistance1(word, candidate);
    if (d <= 1 && (d < bestDistance || (d === bestDistance && RANKINGS[i] < bestRanking))) {
      bestDistance = d;
      bestWord = candidate;
      bestRanking = RANKINGS[i];
      if (bestDistance === 0) break;
    }
  }

  // First-letter substitutions fall outside the insertion-point window
  // above (a different first letter sorts to a completely different part
  // of the dictionary), so they're checked separately.
  if (bestDistance > 1) {
    for (let i = 0; i < ALPHABET.length; i++) {
      const candidate = ALPHABET[i] + word.slice(1);
      const ranking = binarySearchRanking(candidate);
      if (ranking > 0 && ranking < bestRanking) {
        bestWord = candidate;
        bestDistance = 1;
        bestRanking = ranking;
      }
    }
  }

  // Note: this only ever applies a distance-1 correction — a distance-0
  // (exact) match found via the window scan above is deliberately NOT
  // applied here, matching the original's own behavior (only the
  // up-front binarySearchWord() check above returns early for an exact
  // match; one found mid-scan just establishes bestRanking/bestDistance
  // without ever being copied back into the result).
  return bestDistance === 1 ? bestWord : word;
}

function isAlpha(c) {
  return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z';
}

function isDigit(c) {
  return c >= '0' && c <= '9';
}

/** e.g. "VK3TR", "W1AW/P" — ported from cw_decode.cpp#is_valid_callsign. */
function isValidCallsign(s) {
  let i = 0;
  const n = s.length;

  let letters1 = 0;
  while (i < n && isAlpha(s[i]) && letters1 < 2) {
    i++;
    letters1++;
  }
  if (letters1 === 0 || i >= n) return false;

  if (!isDigit(s[i])) return false;
  i++;
  if (i >= n) return false;

  let letters2 = 0;
  while (i < n && isAlpha(s[i]) && letters2 < 3) {
    i++;
    letters2++;
  }
  if (letters2 === 0) return false;

  if (i < n) {
    const c = s[i];
    i++;
    if (c !== '/' || i >= n) return false;
    let suf = 0;
    while (i < n && isAlpha(s[i]) && suf < 3) {
      i++;
      suf++;
    }
    if (suf === 0) return false;
  }

  return i === n;
}

function wordPrefixLogProb(word) {
  if (word.length < 2) return 0;
  return binarySearchPrefix(word) ? 1.0 : 0;
}

function languageLogProb(word) {
  if (binarySearchWord(word)) return 4.0;
  if (isValidCallsign(word)) return 2.0;
  return 0;
}

function replaceProsigns(str) {
  let result = str;
  for (let i = 0; i < DATA.prosigns.length; i++) {
    result = result.split(String.fromCharCode(0x80 + i)).join(DATA.prosigns[i]);
  }
  return result;
}

function autocorrectText(text) {
  let word = '';
  let newText = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (isAlpha(c)) {
      word += c;
    } else {
      if (word.length > 2) word = autocorrect(word);
      newText += word + c;
      word = '';
    }
  }
  if (word.length > 2) word = autocorrect(word);
  newText += word;
  return newText;
}

// === Element/gap pre-filter (ported from cw_decode.cpp#pre_filter_observations) ===
// Merges runs of implausibly short/long on/off durations into their
// neighbors before they reach the classifier, in four passes, each
// collapsing one specific kind of outlier. Ported as four calls to the
// same generic "collapse while predicate holds" helper rather than
// four hand-duplicated loops.
function collapsePass(signal, shouldMerge) {
  const out = [];
  let i = 0;
  const n = signal.length;
  while (i < n) {
    const current = { mark: signal[i].mark, duration: signal[i].duration };
    while (i + 2 < n && shouldMerge(signal, i)) {
      current.duration += signal[i + 1].duration + signal[i + 2].duration;
      i += 2;
    }
    out.push(current);
    i++;
  }
  return out;
}

function preFilterObservations(signal) {
  const dotMinMs = 30.0;
  const dashMaxMs = 720.0;
  const minHard = Math.max(dotMinMs * 0.5, 8.0);
  const maxHard = dashMaxMs * 2.0;

  let s = collapsePass(signal, (sig, i) => sig[i + 1].mark === false && sig[i + 1].duration < minHard);
  s = collapsePass(s, (sig, i) => sig[i + 1].mark === true && sig[i + 1].duration < minHard);
  s = collapsePass(s, (sig, i) => sig[i + 1].mark === true && sig[i + 1].duration > maxHard);
  s = collapsePass(
    s,
    (sig, i) => sig[i + 1].mark === true && sig[i].duration > maxHard && sig[i + 2].duration > maxHard
  );
  return s;
}

// === Timing classifier (ported from cw_classifier.cpp) ===
function logGaussian(x, mu, sigma) {
  const z = (x - mu) / sigma;
  return -0.5 * z * z;
}

function histogramMean(data, begin, end, binWidth) {
  let sumData = 0;
  let sumCounts = 0;
  for (let idx = begin; idx <= end; idx++) {
    const binCentre = idx * binWidth + 0.5 * binWidth;
    sumData += data[idx] * binCentre;
    sumCounts += data[idx];
  }
  return sumData / sumCounts;
}

function histogramStddev(mean, data, begin, end, binWidth) {
  let sumDataSquared = 0;
  let sumCounts = 0;
  for (let idx = begin; idx <= end; idx++) {
    const binCentre = idx * binWidth + 0.5 * binWidth;
    sumDataSquared += data[idx] * binCentre * binCentre;
    sumCounts += data[idx];
  }
  const m2 = sumDataSquared / sumCounts;
  let varianceBinned = m2 - mean * mean;
  if (varianceBinned < 0 && varianceBinned > -1e-8) varianceBinned = 0;
  const withinBinVar = (binWidth * binWidth) / 12.0;
  return Math.sqrt(varianceBinned + withinBinVar);
}

/**
 * Finds the two strongest local-maxima peaks in a smoothed histogram and
 * returns their bin indices in ascending position order, or null if
 * fewer than two distinct peaks exist (not (yet) bimodal).
 */
function findTwoPeaks(smoothed) {
  const n = NUM_HIST_BINS;
  const truePeaks = [];
  let idx = 1;
  while (idx < n - 1) {
    if (smoothed[idx] > smoothed[idx - 1] && smoothed[idx] >= smoothed[idx + 1]) {
      let start = idx;
      let end = idx;
      while (end + 1 < n - 1 && smoothed[end + 1] >= smoothed[idx]) end++;
      truePeaks.push(Math.floor((start + end) / 2));
      idx = end + 1;
    } else {
      idx++;
    }
  }
  if (truePeaks.length < 2) return null;
  truePeaks.sort((a, b) => smoothed[b] - smoothed[a]);
  return truePeaks.slice(0, 2).sort((a, b) => a - b);
}

class MorseTimingClassifier {
  constructor() {
    this.reset();
  }

  reset() {
    this.goodEstimates = false;
    this.dotMu = 20.0;
    this.dashMu = this.dotMu * 3.0;
    this.gap1Mu = this.dotMu * 1.0;
    this.gap3Mu = this.dotMu * 5.0;
    this.gap7Mu = this.dotMu * 7.0;
    this.dotSigma = 10.0;
    this.dashSigma = this.dotSigma;
    this.gap1Sigma = this.dotSigma;
    this.gap3Sigma = this.dotSigma;
    this.gap7Sigma = this.dotSigma;
    this.onHistogram = new Array(NUM_HIST_BINS).fill(0);
    this.offHistogram = new Array(NUM_HIST_BINS).fill(0);
  }

  getDotLength() {
    return this.dotMu;
  }

  getWpm() {
    return 1200.0 / this.getDotLength();
  }

  updateOnModel(durations) {
    if (durations.length < 2) return;
    for (const d of durations) {
      const bin = Math.min(Math.floor(d / BIN_WIDTH), NUM_HIST_BINS - 1);
      this.onHistogram[bin]++;
    }

    const smoothed = new Array(NUM_HIST_BINS).fill(0);
    for (let idx = 1; idx < NUM_HIST_BINS - 1; idx++) {
      smoothed[idx] = this.onHistogram[idx - 1] + this.onHistogram[idx] + this.onHistogram[idx + 1];
    }

    const peaks = findTwoPeaks(smoothed);
    if (!peaks) return; // not (yet) bimodal
    const [peak1, peak2] = peaks;

    let valleyBin = peak1;
    let valleyValue = smoothed[peak1];
    for (let idx = peak1 + 1; idx < peak2; idx++) {
      if (smoothed[idx] < valleyValue) {
        valleyValue = smoothed[idx];
        valleyBin = idx;
      }
    }

    this.dotMu = histogramMean(smoothed, 0, valleyBin, BIN_WIDTH);
    this.dotSigma = histogramStddev(this.dotMu, smoothed, 0, valleyBin, BIN_WIDTH);
    const end = Math.min(peak2 * 2, NUM_HIST_BINS - 1);
    this.dashMu = histogramMean(smoothed, valleyBin, end, BIN_WIDTH);
    this.dashSigma = histogramStddev(this.dashMu, smoothed, valleyBin, end, BIN_WIDTH);

    let good = Number.isFinite(this.dotMu) && Number.isFinite(this.dashMu);
    good = good && this.dashMu > 1.5 * this.dotMu && this.dashMu <= 5.0 * this.dotMu;
    good = good && this.dotSigma < 2.0 * this.dotMu && this.dashSigma <= 2.0 * this.dotMu;
    this.goodEstimates = good;
  }

  updateOffModel(durations) {
    if (durations.length < 2) return;
    for (const d of durations) {
      const bin = Math.min(Math.floor(d / BIN_WIDTH), NUM_HIST_BINS - 1);
      this.offHistogram[bin]++;
    }

    const smoothed = new Array(NUM_HIST_BINS).fill(0);
    for (let idx = 1; idx < NUM_HIST_BINS - 1; idx++) {
      smoothed[idx] = this.offHistogram[idx - 1] + this.offHistogram[idx] + this.offHistogram[idx + 1];
    }

    const peaks = findTwoPeaks(smoothed);
    if (!peaks) {
      // Fewer than 2 peaks yet - fall back to standard 1:3:7 ratios off
      // the dot length already established by the on-model.
      this.gap1Mu = this.dotMu;
      this.gap1Sigma = this.dotSigma;
      this.gap3Mu = 3 * this.dotMu;
      this.gap3Sigma = this.dotSigma;
      this.gap7Mu = 7 * this.dotMu;
      this.gap7Sigma = this.dotSigma;
      return;
    }
    const [peak1, peak2] = peaks;

    let valley1Bin = peak1;
    let valley1Value = smoothed[peak1];
    for (let idx = peak1 + 1; idx < peak2; idx++) {
      if (smoothed[idx] < valley1Value) {
        valley1Value = smoothed[idx];
        valley1Bin = idx;
      }
    }

    this.gap1Mu = histogramMean(smoothed, 0, valley1Bin, BIN_WIDTH);
    this.gap1Sigma = histogramStddev(this.gap1Mu, smoothed, 0, valley1Bin, BIN_WIDTH);
    this.gap1Sigma = Math.max(0.1 * this.gap1Mu, this.gap1Sigma);

    const end = Math.min(peak2 * 2, NUM_HIST_BINS - 1);
    this.gap3Mu = histogramMean(smoothed, valley1Bin, end, BIN_WIDTH);
    this.gap3Sigma = histogramStddev(this.gap3Mu, smoothed, valley1Bin, end, BIN_WIDTH);
    this.gap3Sigma = Math.min(Math.max(0.1 * this.gap3Mu, this.gap3Sigma), 2 * this.gap1Sigma);

    this.gap7Mu = 7 * this.gap1Mu;
    this.gap7Sigma = this.gap1Sigma;
  }

  classifyOn(d) {
    return {
      logpDot: logGaussian(d, this.dotMu, this.dotSigma),
      logpDash: logGaussian(d, this.dashMu, this.dashSigma),
      logpDotdot: logGaussian(d, this.dotMu + this.dotMu + this.gap1Mu, this.dashSigma),
      logpDotdash: logGaussian(d, this.dashMu + this.dotMu + this.gap1Mu, this.dashSigma),
      logpDashdash: logGaussian(d, this.dashMu + this.dashMu + this.gap1Mu, this.dashSigma),
    };
  }

  /** Returns [logp_symbol_gap, logp_letter_gap, logp_word_gap]. */
  classifyOff(d) {
    const logpGap1 = logGaussian(d, this.gap1Mu, this.gap1Sigma);
    const logpGap3 = logGaussian(d, this.gap3Mu, this.gap3Sigma);
    const logpGap7 = d < this.gap7Mu ? logGaussian(d, this.gap7Mu, this.gap7Sigma) : 0;
    return [logpGap1, logpGap3, logpGap7];
  }
}

// === Beam-search decoder (ported from cw_decode.cpp) ===
class ChannelDecoder {
  constructor() {
    this.classifier = new MorseTimingClassifier();
    this.reset();
  }

  reset() {
    this.classifier.reset();
    this.beam = [{ text: '', word: '', pattern: '', logp: 0.0 }];
    this.itemsInBeam = 1;
  }

  getWpm() {
    return this.classifier.getWpm();
  }

  /** The letter/word currently being spelled out but not yet committed. */
  getTextPartial() {
    const letter = getLetterFromCode(this.beam[0].pattern);
    return replaceProsigns(this.beam[0].word + letter);
  }

  /**
   * Returns the text newly committed since the last call (NOT the full
   * accumulated transcript — beam[0].text is cleared as a side effect of
   * reading it here, exactly as in the original, so callers just append
   * whatever comes back each time).
   */
  getText() {
    const committed = this.beam[0].text;
    const newBeam = [{ ...this.beam[0], text: '' }];
    for (let i = 1; i < this.itemsInBeam; i++) {
      if (this.beam[i].text === committed) {
        newBeam.push({ ...this.beam[i], text: '' });
      }
    }
    this.beam = newBeam;
    this.itemsInBeam = newBeam.length;

    let text = autocorrectText(committed);
    text = replaceProsigns(text);
    return text;
  }

  /** @param {{mark: boolean, duration: number}[]} rawObservations */
  decode(rawObservations) {
    const signal = preFilterObservations(rawObservations);

    const onDurations = [];
    const offDurations = [];
    for (const obs of signal) {
      if (obs.mark) onDurations.push(obs.duration);
      else offDurations.push(obs.duration);
    }

    this.classifier.updateOnModel(onDurations);
    if (!this.classifier.goodEstimates) return;
    this.classifier.updateOffModel(offDurations);

    for (const obs of signal) {
      const duration = obs.duration;
      const { logpDot, logpDash, logpDotdot, logpDotdash, logpDashdash } = this.classifier.classifyOn(duration);
      const [logpGap1, logpGap3, logpGap7] = this.classifier.classifyOff(duration);

      const candidates = [];

      for (let j = 0; j < this.itemsInBeam; j++) {
        const { text, word, pattern, logp } = this.beam[j];

        if (obs.mark) {
          const letter = getLetterFromCode(pattern);
          const patternIsCode = letter !== '#' && letter !== '~';

          const dotPattern = pattern + '.';
          if (isStartOfCode(dotPattern)) {
            candidates.push({ text, word, pattern: dotPattern, logp: logp + logpDot });
          } else if (patternIsCode) {
            candidates.push({ text, word: word + letter, pattern: '.', logp: logp + logpDot });
          }

          const dashPattern = pattern + '-';
          if (isStartOfCode(dashPattern)) {
            candidates.push({ text, word, pattern: dashPattern, logp: logp + logpDash });
          } else if (patternIsCode) {
            candidates.push({ text, word: word + letter, pattern: '-', logp: logp + logpDash });
          }

          const dotdashPattern = pattern + '.-';
          if (isStartOfCode(dotdashPattern)) {
            candidates.push({ text, word, pattern: dotdashPattern, logp: logp + logpDotdash });
          } else if (patternIsCode) {
            candidates.push({ text, word: word + letter, pattern: '.-', logp: logp + logpDotdash });
          }

          const dashdotPattern = pattern + '-.';
          if (isStartOfCode(dashdotPattern)) {
            candidates.push({ text, word, pattern: dashdotPattern, logp: logp + logpDotdash });
          } else if (patternIsCode) {
            candidates.push({ text, word: word + letter, pattern: '-.', logp: logp + logpDotdash });
          }

          const dashdashPattern = pattern + '--';
          if (isStartOfCode(dashdashPattern)) {
            candidates.push({ text, word, pattern: dashdashPattern, logp: logp + logpDashdash });
          } else if (patternIsCode) {
            candidates.push({ text, word: word + letter, pattern: '--', logp: logp + logpDashdash });
          }

          const dotdotPattern = pattern + '..';
          if (isStartOfCode(dotdotPattern)) {
            candidates.push({ text, word, pattern: dotdotPattern, logp: logp + logpDotdot - 2 });
          } else if (patternIsCode) {
            candidates.push({ text, word: word + letter, pattern: '..', logp: logp + logpDotdot - 2 });
          }
        } else {
          // symbol gap: stay within the current letter
          candidates.push({ text, word, pattern, logp: logp + logpGap1 });

          const letter = getLetterFromCode(pattern);
          const patternIsCode = letter !== '#' && letter !== '~';
          if (patternIsCode) {
            const lastWord = word + letter;
            const languageBonus = languageLogProb(lastWord);
            const prefixBonus = wordPrefixLogProb(lastWord);

            // letter gap: commit the letter, stay in the same word
            candidates.push({ text, word: lastWord, pattern: '', logp: logp + logpGap3 + prefixBonus });

            // word gap: commit the letter AND the word (with a trailing space)
            candidates.push({ text: text + lastWord + ' ', word: '', pattern: '', logp: logp + logpGap7 + languageBonus });
          }
        }
      }

      if (candidates.length === 0) continue; // shouldn't happen, but never crash on it
      const itemsInBeam = Math.min(BEAM_WIDTH, candidates.length);
      const order = candidates.map((_, i) => i).sort((a, b) => candidates[b].logp - candidates[a].logp);
      this.beam = order.slice(0, itemsInBeam).map((i) => candidates[i]);
      this.itemsInBeam = itemsInBeam;
    }
  }
}

// === Top-level multi-channel FFT DSP (ported from cw_dsp.cpp) ===
class HamfistCwDecoder extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sampleRate=48000] - input PCM sample rate
   */
  constructor({ sampleRate = 48000 } = {}) {
    super();
    this.sampleRate = sampleRate;

    // Anti-alias low-pass ahead of decimation to 7500Hz (Nyquist 3750Hz)
    // — see this file's top-of-file doc comment, departure #1.
    const cutoffHz = 3000;
    this._lpfAlpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / this.sampleRate);
    this._lpfState = 0;

    this._sampleRatioF16 = Math.round((TARGET_SAMPLE_RATE * 65536) / this.sampleRate);
    this._sampleAccumF16 = 0;

    this._window = generateWindow(FRAME_SIZE);
    this._frameBuf = new Float64Array(FRAME_SIZE);
    this._frameFill = 0;

    this._noiseEstimate = new Float64Array(BIN_COUNT);
    this._gateCount = new Int32Array(BIN_COUNT);
    this._threshold = new Float64Array(BIN_COUNT);
    this._noiseInitialised = false;

    this._channels = [];
    for (let i = 0; i < NUM_CHANNELS; i++) {
      this._channels.push({
        duration: 0,
        value: false,
        observations: [],
        decoder: new ChannelDecoder(),
        trained: false,
        snr: 0.0,
      });
    }
    this._activeChannel = null;
  }

  reset() {
    this._lpfState = 0;
    this._sampleAccumF16 = 0;
    this._frameFill = 0;
    this._noiseInitialised = false;
    this._noiseEstimate.fill(0);
    this._gateCount.fill(0);
    this._threshold.fill(0);
    for (const channel of this._channels) {
      channel.duration = 0;
      channel.value = false;
      channel.observations = [];
      channel.trained = false;
      channel.snr = 0.0;
      channel.decoder.reset();
    }
    this._activeChannel = null;
  }

  // CW 1 (cw-decoder.js) locks to one target frequency and needs the
  // radio's reported CW pitch (or its own auto-calibration sweep) to
  // know what to listen for. This decoder has no such single target —
  // every channel across the usable spectrum runs in parallel, so
  // whichever one the tone actually lands in just lights up on its own.
  // Kept as a no-op purely so CwDecoderBridge can treat both decoder
  // implementations identically — see its own doc comment.
  setPitch() {}

  get estimatedWpm() {
    if (this._activeChannel === null) return 0;
    return Math.round(this._channels[this._activeChannel].decoder.getWpm());
  }

  pushSamples(samples) {
    for (let n = 0; n < samples.length; n++) {
      const raw = samples[n];
      this._lpfState += this._lpfAlpha * (raw - this._lpfState);

      this._sampleAccumF16 += this._sampleRatioF16;
      if (this._sampleAccumF16 < 65536) continue;
      this._sampleAccumF16 -= 65536;

      this._frameBuf[this._frameFill++] = this._lpfState;
      if (this._frameFill === FRAME_SIZE) {
        this._frameFill = 0;
        this._processFrame();
      }
    }
  }

  _processFrame() {
    const re = new Float64Array(FRAME_SIZE);
    const im = new Float64Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) re[i] = this._frameBuf[i] * this._window[i];
    fftInPlace(re, im);

    const magnitude = new Float64Array(BIN_COUNT);
    for (let i = 0; i < BIN_COUNT; i++) magnitude[i] = Math.hypot(re[i], im[i]);

    this._updateNoiseFloor(magnitude);
    this._processChannels(magnitude);
  }

  /** Per-bin gated noise floor + threshold, ported from cw_dsp.cpp#process_frame. */
  _updateNoiseFloor(magnitude) {
    if (!this._noiseInitialised) {
      for (let idx = 0; idx < BIN_COUNT; idx++) this._noiseEstimate[idx] = magnitude[idx];
      this._noiseInitialised = true;
    }
    for (let idx = 0; idx < BIN_COUNT; idx++) {
      if (magnitude[idx] < 2.0 * this._noiseEstimate[idx] || magnitude[idx] < 5) {
        this._noiseEstimate[idx] = 0.99 * this._noiseEstimate[idx] + 0.01 * magnitude[idx];
        this._gateCount[idx] = 0;
      } else if (this._gateCount[idx] > 50) {
        // Signal has been gating updates for a long time — assume the
        // floor itself has risen rather than that a signal is still
        // present, and let it catch up.
        this._noiseEstimate[idx] = 0.9 * this._noiseEstimate[idx] + 0.1 * magnitude[idx];
      } else {
        this._gateCount[idx]++;
      }
      this._noiseEstimate[idx] = Math.max(this._noiseEstimate[idx], 1.0);
      this._threshold[idx] = this._noiseEstimate[idx] * THRESH_MULT;
    }
  }

  _getSnr(channelIndex) {
    const snr = this._channels[channelIndex].snr;
    if (snr > 0.0001) return 20.0 * Math.log10(snr) - 6.3; // -6.3dB: 117Hz bin -> 500Hz bandwidth
    return -99.0;
  }

  /** Per-channel tone detection + observation/decode bookkeeping, ported from cw_dsp.cpp#process_channels. */
  _processChannels(magnitude) {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const channel = this._channels[ch];
      const startBin = ch * CHANNEL_SIZE;
      const stopBin = startBin + CHANNEL_SIZE - 1; // exclusive — matches the original's own range exactly

      let max = 0;
      let maxBin = startBin;
      let maxThreshold = 0;
      for (let idx = startBin; idx < stopBin; idx++) {
        if (magnitude[idx] > max) {
          max = magnitude[idx];
          maxBin = idx;
        }
        if (this._threshold[idx] > maxThreshold) maxThreshold = this._threshold[idx];
      }

      let value;
      if (channel.value) {
        channel.snr = 0.99 * channel.snr + 0.01 * (max / this._noiseEstimate[maxBin]);
        value = max > 0.7 * maxThreshold; // hysteresis once already "on"
      } else {
        channel.snr = 0.999 * channel.snr + 0.001 * (max / this._noiseEstimate[maxBin]);
        value = max > maxThreshold;
      }

      channel.duration++;
      if (value !== channel.value) {
        channel.observations.push({ mark: channel.value, duration: FRAME_MS * channel.duration });
        channel.duration = 0;
        channel.value = value;
      }

      if (channel.duration === TIMEOUT_FRAMES) {
        if (this._getSnr(ch) > MIN_DECODE_SNR_DB) this._runDecode(ch);
        channel.observations = [];
        channel.duration = 0;
        channel.trained = false; // treat this as the end of a transmission and retrain
        channel.snr = 0;
        channel.decoder.reset();
        if (this._activeChannel === ch) this._activeChannel = null;
        continue;
      }

      if (
        channel.observations.length === OBSERVATION_BUFFER_SIZE ||
        (channel.trained && channel.observations.length === OBSERVATION_BURST_SIZE)
      ) {
        if (this._getSnr(ch) > MIN_DECODE_SNR_DB) {
          this._runDecode(ch);
          channel.trained = true;
        }
        channel.observations = [];
        channel.duration = 0;
      }
    }
  }

  _runDecode(channelIndex) {
    const channel = this._channels[channelIndex];
    channel.decoder.decode(channel.observations);
    const text = channel.decoder.getText();
    this._emitFromChannel(channelIndex, text);
  }

  /**
   * Adapts Hamfist's per-channel callback (meant for a GUI that shows
   * every channel's independent decode at once) to PiRO's single
   * scrolling ticker: only one channel's text reaches 'char'/'space' at
   * a time, with simple SNR hysteresis so the ticker doesn't flap back
   * and forth if two tones happen to be active at similar strength.
   */
  _emitFromChannel(channelIndex, text) {
    if (!text) return; // nothing newly committed this round
    if (this._activeChannel === null) {
      this._activeChannel = channelIndex;
    } else if (channelIndex !== this._activeChannel) {
      const snr = this._getSnr(channelIndex);
      const activeSnr = this._getSnr(this._activeChannel);
      if (snr > activeSnr + ACTIVE_CHANNEL_SWITCH_MARGIN_DB) {
        this._activeChannel = channelIndex;
      } else {
        return; // not our turn — drop this channel's output
      }
    }
    for (const c of text) {
      if (c === ' ') this.emit('space');
      else this.emit('char', c);
    }
  }
}

module.exports = {
  HamfistCwDecoder,
  // Exported for direct unit testing — see test/hamfist-cw-decoder.test.js.
  MorseTimingClassifier,
  ChannelDecoder,
  morsePatternIndex,
  isStartOfCode,
  getLetterFromCode,
  autocorrect,
  isValidCallsign,
  preFilterObservations,
};
