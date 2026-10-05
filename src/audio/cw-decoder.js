'use strict';

const { EventEmitter } = require('events');

/**
 * Goertzel algorithm: detects the magnitude of a single target frequency
 * within a block of PCM samples. Much cheaper than a full FFT when only
 * one frequency (the CW pitch) needs watching, which is exactly this
 * use case. Returns a magnitude on roughly the same scale as the input
 * samples (normalized by block length) — not calibrated to any
 * absolute unit, only meaningful relative to this decoder's own noise
 * floor and threshold, which adapt to it.
 */
function goertzelMagnitude(samples, sampleRate, targetFreq) {
  const n = samples.length;
  if (n === 0) return 0;
  const k = Math.round((n * targetFreq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * cosine;
  const imag = q2 * Math.sin(omega);
  return Math.sqrt(real * real + imag * imag) / n;
}

// International Morse Code. Deliberately scoped to letters, digits, and
// commonly-needed punctuation for v1 — prosigns (<SK>, <AR>, etc.) are
// not included, since several share patterns with punctuation already
// in the table (e.g. <AR> and "+" are both ".-.-.") and resolving that
// ambiguity cleanly is more complexity than this first version needs.
const MORSE_TABLE = {
  '.-': 'A',
  '-...': 'B',
  '-.-.': 'C',
  '-..': 'D',
  '.': 'E',
  '..-.': 'F',
  '--.': 'G',
  '....': 'H',
  '..': 'I',
  '.---': 'J',
  '-.-': 'K',
  '.-..': 'L',
  '--': 'M',
  '-.': 'N',
  '---': 'O',
  '.--.': 'P',
  '--.-': 'Q',
  '.-.': 'R',
  '...': 'S',
  '-': 'T',
  '..-': 'U',
  '...-': 'V',
  '.--': 'W',
  '-..-': 'X',
  '-.--': 'Y',
  '--..': 'Z',
  '-----': '0',
  '.----': '1',
  '..---': '2',
  '...--': '3',
  '....-': '4',
  '.....': '5',
  '-....': '6',
  '--...': '7',
  '---..': '8',
  '----.': '9',
  '.-.-.-': '.',
  '--..--': ',',
  '..--..': '?',
  '.----.': "'",
  '-.-.--': '!',
  '-..-.': '/',
  '-.--.': '(',
  '-.--.-': ')',
  '.-...': '&',
  '---...': ':',
  '-.-.-.': ';',
  '-...-': '=',
  '.-.-.': '+',
  '-....-': '-',
  '..--.-': '_',
  '.-..-.': '"',
  '...-..-': '$',
  '.--.-.': '@',
};

/** Looks up a dot/dash sequence; returns '?' for anything not recognized. */
function morseToChar(sequence) {
  return MORSE_TABLE[sequence] ?? '?';
}

// Standard morse timing ratios, all relative to one "unit" (a dot's
// length): dash = 3 units, intra-character gap = 1 unit, inter-character
// gap = 3 units, word gap = 7 units. Classification thresholds below sit
// at the midpoint between adjacent ratios, the same convention most
// software CW decoders use, since real keying (human or this app's own
// paddle) never lands exactly on the ideal ratio.
const DASH_THRESHOLD_UNITS = 2; // > 2 units -> dash, else dot
const CHAR_GAP_THRESHOLD_UNITS = 2; // > 2 units -> at least a character gap
const WORD_GAP_THRESHOLD_UNITS = 5; // > 5 units -> a word gap

/**
 * Streaming CW decoder: feed it raw PCM samples via pushSamples() as
 * they arrive from the radio's RX audio, and it emits decoded
 * characters as they resolve. Maintains its own adaptive estimate of
 * the operator's current keying speed (unitMs) rather than assuming a
 * fixed WPM, since CW speed varies both between and within sessions —
 * a fixed threshold breaks the moment speed changes.
 *
 * This is a genuinely lossy, best-effort process, not a guarantee of
 * accurate copy — see docs/ui-notes.md for the honest limitations
 * (QRM, fading, chirpy keying, and this app's own paddle jitter all
 * degrade it, the same way they degrade a real operator's ear).
 *
 * Events:
 *   'char' (string) — a single decoded character (or '?' for an
 *                      unrecognized dot/dash sequence) as soon as it
 *                      resolves (i.e. the following gap confirms the
 *                      character boundary)
 *   'space' — a word-gap-sized pause was detected; UI layers typically
 *             render this as a literal space character
 */
class CwDecoder extends EventEmitter {
  /**
   * @param {number} [opts.sampleRate=48000]
   * @param {number} [opts.pitchHz=600] - target CW tone frequency
   * @param {number} [opts.blockMs=8] - PCM block size for each Goertzel pass
   * @param {number} [opts.initialUnitMs=80] - starting dot-length guess
   *   (80ms = 15 WPM, matching this app's own CW paddle keyer default)
   *   before any real timing data has been observed
   * @param {number} [opts.toneThresholdMultiplier=6] - how many times
   *   above the adaptive noise floor a block's magnitude must be to
   *   count as "tone present" — 6 was chosen empirically, verified
   *   against synthetic audio at a moderate ~5:1 signal-to-noise ratio
   *   (see test/cw-decoder.test.js); a lower value decoded noisy audio
   *   badly, garbling entire words
   * @param {boolean} [opts.autoCalibratePitch=true] - periodically
   *   re-derives the actual tone frequency from the received audio
   *   itself and retunes `pitchHz` to match, rather than trusting
   *   `setPitch()`'s value (normally the radio's reported CW pitch —
   *   see cw-decoder-bridge.js) to be exactly right forever. Added
   *   after a real user-supplied recording completely failed to decode
   *   (not garbled — *nothing* decoded) while the decoder sat at its
   *   600Hz default: the recording's actual tone was ~787Hz, a gap the
   *   Goertzel filter can't bridge, and `_refreshPitch()` in
   *   cw-decoder-bridge.js silently keeps whatever pitch it already had
   *   if the CI-V read fails — a real risk this project has already
   *   flagged elsewhere for this exact command group (see
   *   `_decodeMeterReply()`'s doc comment in driver.js) and one with no
   *   other visible symptom besides "decodes nothing". See
   *   `_maybeCalibratePitch()` below for how this stays safe against
   *   locking onto ordinary background noise instead of a real tone.
   * @param {number} [opts.calibrationIntervalMs=3000] - minimum time
   *   between calibration attempts once a first lock has been found
   * @param {number} [opts.calibrationRetryIntervalMs=500] - minimum
   *   time between attempts *before* any lock has been found yet — a
   *   single 250ms scan window can land on a gap between marks even
   *   while real CW is playing, so retrying quickly (rather than
   *   waiting a full calibrationIntervalMs for a second try) matters
   *   most right at the very start of a message, before anything has
   *   decoded at all
   * @param {number} [opts.calibrationWindowMs=250] - how much recent
   *   raw audio each calibration attempt scans
   * @param {number} [opts.calibrationMinHz=300] - low end of the scan
   *   range, matching the IC-7300's own documented CW pitch range (see
   *   `LEVEL_SUBCMD.CW_PITCH` in `src/civ/commands.js`)
   * @param {number} [opts.calibrationMaxHz=900] - high end of the scan
   *   range, same source as calibrationMinHz
   * @param {number} [opts.calibrationStepHz=10] - frequency grid the
   *   scan checks; also the minimum drift from the current pitch worth
   *   retuning for
   * @param {number} [opts.calibrationContrastThreshold=15] - how far the
   *   scan's peak must stand above its own median magnitude (across the
   *   whole scan range) to be trusted as a genuine narrowband tone
   *   rather than broadband noise — see `_maybeCalibratePitch()`. 15 was
   *   chosen (not the smallest value that "works") specifically to stay
   *   comfortably clear of false-lock risk: on the real recording this
   *   was verified against, actual CW consistently scored >15x while
   *   room noise during the silence *after* the transmission ended
   *   stayed under 7x — this sits with margin above that gap rather
   *   than right on its edge.
   */
  constructor({
    sampleRate = 48000,
    pitchHz = 600,
    blockMs = 8,
    initialUnitMs = 80,
    toneThresholdMultiplier = 6,
    debounceBlocks = 2,
    autoCalibratePitch = true,
    calibrationIntervalMs = 3000,
    calibrationRetryIntervalMs = 500,
    calibrationWindowMs = 250,
    calibrationMinHz = 300,
    calibrationMaxHz = 900,
    calibrationStepHz = 10,
    calibrationContrastThreshold = 15,
  } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.pitchHz = pitchHz;
    this.blockSamples = Math.max(1, Math.round((sampleRate * blockMs) / 1000));
    this.toneThresholdMultiplier = toneThresholdMultiplier;
    this.debounceBlocks = debounceBlocks;

    this.autoCalibratePitch = autoCalibratePitch;
    this.calibrationIntervalMs = calibrationIntervalMs;
    this.calibrationRetryIntervalMs = calibrationRetryIntervalMs;
    this.calibrationMinHz = calibrationMinHz;
    this.calibrationMaxHz = calibrationMaxHz;
    this.calibrationStepHz = calibrationStepHz;
    this.calibrationContrastThreshold = calibrationContrastThreshold;
    this._calibSampleCount = Math.max(1, Math.round((sampleRate * calibrationWindowMs) / 1000));
    this._calibBuffer = new Float64Array(this._calibSampleCount);
    this._calibWritePos = 0;
    this._calibFilled = 0;
    this._lastCalibrationMs = 0;
    this._hasCalibratedOnce = false;

    this._pendingState = null;
    this._pendingCount = 0;

    this._sampleBuffer = [];
    this._toneOn = false;
    this._stateStartedAt = 0; // ms, decoder-internal clock (sum of processed block durations)
    this._clockMs = 0;
    // Starts as a conservative low guess rather than requiring an
    // observed "no tone" block before any tone detection can happen at
    // all — real audio can start mid-mark with no leading silence
    // (e.g. the decoder engaging while someone's already transmitting),
    // and gating on an explicit prior silence observation meant that
    // exact scenario silently dropped the very first character. This
    // guess converges quickly via the normal exponential averaging once
    // real silence is observed.
    this._noiseFloor = 10;
    // Decaying peak magnitude observed from actual tone-classified
    // blocks — anchors a ceiling on the noise floor; see the comment
    // in _processBlock().
    this._signalPeak = 0;
    this._unitMs = initialUnitMs;
    // Sliding window of recent MARK durations, used to re-derive the
    // unit estimate as roughly its minimum, since a dot is by definition
    // the shortest legitimate element. This recovers far faster from a
    // sudden speed change than a plain exponential average of only
    // dot-classified durations did — a real gap found while testing: a
    // common CW practice is sending a callsign slowly then speeding up
    // for the rest of a call, and a dot-only EMA adapted the wrong
    // direction entirely when a genuinely fast dash got misclassified as
    // a slow dot against a stale threshold. A handful of anomalously
    // short blips pulling this too low used to be accepted as a tradeoff
    // for recovering quickly from real speed changes — real user
    // recordings later showed that "temporarily" wasn't accurate (one
    // blip could wreck the rest of a message), so _onStateChange() below
    // now guards what's allowed to seed this window at all — including,
    // after a *second* real bug (found this time against clean synthetic
    // audio, no real recording needed — see that method's own comment),
    // only ever seeding from marks actually classified as dots, never
    // dashes, so the window can never be poisoned by a message that
    // simply starts with one or more genuine dashes (e.g. "CQ", or any
    // digit built mostly from dashes). See docs/ui-notes.md for the full
    // history of both bugs.
    this._recentMarkDurations = [];
    this._currentSequence = ''; // accumulated dot/dash for the in-progress character
    this._sinceLastMark = 0; // ms of continuous "no tone" — used to detect char/word gaps once
    this._charGapPending = false; // a gap long enough to end a character has been seen but not yet finalized (word-gap vs char-gap ambiguity resolves as more silence accumulates)
  }

  /** Change the target tone frequency, e.g. when the radio's configured CW pitch is read/changed. */
  setPitch(pitchHz) {
    this.pitchHz = pitchHz;
  }

  /** Clears all decode state — call when leaving CW mode or reconnecting. */
  reset() {
    this._sampleBuffer.length = 0;
    this._toneOn = false;
    this._clockMs = 0;
    this._noiseFloor = 10;
    this._signalPeak = 0;
    this._currentSequence = '';
    this._sinceLastMark = 0;
    this._charGapPending = false;
    this._recentMarkDurations.length = 0;
    this._pendingState = null;
    this._pendingCount = 0;
    this._calibBuffer.fill(0);
    this._calibWritePos = 0;
    this._calibFilled = 0;
    this._lastCalibrationMs = 0;
    this._hasCalibratedOnce = false;
  }

  /** @param {Int16Array|number[]} samples - new PCM samples to append and process */
  pushSamples(samples) {
    for (let i = 0; i < samples.length; i++) {
      this._sampleBuffer.push(samples[i]);
      if (this.autoCalibratePitch) this._pushCalibrationSample(samples[i]);
    }
    while (this._sampleBuffer.length >= this.blockSamples) {
      const block = this._sampleBuffer.splice(0, this.blockSamples);
      this._processBlock(block);
    }
  }

  /** Appends one raw sample to the fixed-size calibration ring buffer (independent of block-sized decode processing — see _maybeCalibratePitch()). */
  _pushCalibrationSample(sample) {
    this._calibBuffer[this._calibWritePos] = sample;
    this._calibWritePos = (this._calibWritePos + 1) % this._calibSampleCount;
    if (this._calibFilled < this._calibSampleCount) this._calibFilled++;
  }

  _processBlock(block) {
    const blockMs = (block.length / this.sampleRate) * 1000;
    this._clockMs += blockMs;

    if (this.autoCalibratePitch) this._maybeCalibratePitch();

    const magnitude = goertzelMagnitude(block, this.sampleRate, this.pitchHz);
    const toneNow = magnitude > this._noiseFloor * this.toneThresholdMultiplier;

    // Track the noise floor continuously while no tone is present —
    // this is what lets the decoder tolerate a signal that fades in and
    // out rather than needing a fixed absolute threshold. Based on the
    // raw per-block classification, not the debounced one below, since
    // the noise floor estimate benefits from every sample it can get.
    //
    // A real bug found against a user-provided off-air/recorded sample,
    // not the idealized synthetic test tones this module was originally
    // tuned against: those synthetic tones have perfectly instantaneous
    // on/off transitions, so a block is always purely tone or purely
    // silence. A real recording (mic pickup, speaker acoustics, lossy
    // re-encoding) instead smears real, non-trivial energy across the
    // block or two right next to every mark's edge — still under the
    // momentary threshold, so classified "no tone", but far above
    // genuine background noise. Blending that straight into the noise
    // floor's EMA pushed the floor up on every single element of fast
    // keying, a positive feedback loop: a higher floor raises the
    // threshold, which admits even more marginal "off" blocks next
    // time. On the real recording this ran the floor's threshold past
    // the tone's own peak magnitude within ~2 seconds of keying,
    // permanently silencing detection for the rest of a 30+ second
    // transmission even though a strong, clean tone continued for
    // another 15+ seconds after that point.
    //
    // On the real recording, this turned out to be a *gradual*
    // compounding drift rather than one single outlier block: each
    // edge-bleed block was typically only a few times the floor at the
    // moment it occurred (not some huge one-off spike), and slowing the
    // EMA down (a cap on one block's contribution, or ramping the
    // update in over a short streak of consecutive "no tone" blocks)
    // was tried and didn't help much — the floor still climbed into the
    // hundreds either way, just a bit slower. Any scheme that only
    // looks at the noise side of the picture is fighting a genuinely
    // unstable feedback loop: a higher floor admits more marginal "off"
    // blocks, which push it higher still, with nothing to anchor it
    // back down.
    //
    // What actually stops it is anchoring the ceiling to the *signal*
    // side instead: the noise floor is never allowed to climb past a
    // fraction of the strongest magnitude recently seen from an
    // actual tone block. That's the one thing the runaway can't argue
    // with — real received CW has to be substantially louder than the
    // noise floor to be detected as a mark at all (that's what
    // toneThresholdMultiplier means), so the true noise floor is
    // necessarily well below any genuine mark's magnitude; capping it
    // there directly reflects that invariant instead of hoping the
    // "off" side never drifts into it. _signalPeak decays slowly when
    // no tone is present so a one-off loud burst doesn't pin the
    // ceiling forever once the actual signal has genuinely faded.
    if (toneNow) {
      this._signalPeak = Math.max(magnitude, this._signalPeak * 0.995);
    } else {
      const alpha = 0.05;
      this._noiseFloor = this._noiseFloor * (1 - alpha) + magnitude * alpha;
      if (this._signalPeak > 0) {
        const maxAllowedFloor = this._signalPeak / (this.toneThresholdMultiplier * 2);
        this._noiseFloor = Math.min(this._noiseFloor, maxAllowedFloor);
      }
    }

    // Debounced state transitions: a lone noisy block flipping the
    // classification isn't treated as a real transition until a few
    // consecutive blocks agree. Random noise causes real, if
    // infrequent, single-block false positives in the Goertzel
    // magnitude (short blocks have more estimate variance), and without
    // this a moderately noisy signal produced badly garbled output
    // while testing — debouncing meaningfully improved it without
    // adding much latency (debounceBlocks * blockMs, a few ms).
    if (toneNow === this._toneOn) {
      this._pendingState = null;
      this._pendingCount = 0;
      if (!toneNow) {
        this._sinceLastMark += blockMs;
        this._maybeFinalizeOnSilence();
      }
      return;
    }
    if (this._pendingState === toneNow) {
      this._pendingCount++;
    } else {
      this._pendingState = toneNow;
      this._pendingCount = 1;
    }
    if (this._pendingCount >= this.debounceBlocks) {
      this._onStateChange(toneNow);
      this._pendingState = null;
      this._pendingCount = 0;
    } else if (!this._toneOn) {
      // Still-unconfirmed possible transition out of silence — keep
      // accumulating silence duration in the meantime.
      this._sinceLastMark += blockMs;
      this._maybeFinalizeOnSilence();
    }
  }

  _onStateChange(toneNow) {
    const elapsed = this._clockMs - this._stateStartedAt;
    if (this._toneOn) {
      // A mark (tone) just ended — classify it as a dot or a dash
      // against the *current* unit estimate first, then (usually) feed
      // its raw duration into the recent-marks window, and re-derive
      // the unit estimate from the window's minimum. See the
      // constructor's doc comment for why this replaced a simpler
      // "only dots update the estimate" EMA.
      const isDash = elapsed > this._unitMs * DASH_THRESHOLD_UNITS;
      this._currentSequence += isDash ? '-' : '.';
      // A real bug found against user-recorded audio: because the
      // window tracks the *minimum* recent duration, a single
      // implausibly short mark — shorter than any real dot could be at
      // the current keying speed, more likely a brief noise blip or a
      // debounce-boundary artifact than a genuine element — could
      // collapse the unit estimate by 3-4x in one step. Once collapsed,
      // every subsequent *real* mark then reads as many multiples of
      // the (now far too small) unit and gets classified a dash no
      // matter what it actually was, which feeds more artificially
      // "long" durations back into the window and locks the estimate
      // at the wrong speed for the rest of the message — turning one
      // glitch into a permanently garbled transmission (observed
      // directly: a single 16ms blip mid-message on a real recording
      // preceded a long run of otherwise-legible marks all coming out
      // as dashes). Guarded by simply not letting a mark drag the
      // window down by more than this ratio in one step; the window
      // still adapts to a genuine gradual speed-up (which arrives as a
      // sequence of consistently shorter marks, not one outlier) within
      // a couple of elements, same as before.
      //
      // The window-empty (bootstrap) case needs its own check rather
      // than unconditionally trusting whatever comes first: on another
      // real recording, a loud several-second burst of interference
      // right at the start was misread as a single enormous "mark"
      // before any real CW began. Blindly seeding the window with it
      // set the unit estimate to over a second, after which every
      // genuine mark for the rest of the message (tens to a couple
      // hundred ms) failed the *relative* plausibility check against
      // that poisoned estimate and could never correct it — the same
      // failure mode as the mid-message glitch above, just triggered
      // from the opposite (too-long) direction and unrecoverable
      // because it happened before the window held anything to
      // outvote it. Guarded with a generous absolute sanity range
      // instead (spanning roughly 2-120 WPM) purely for this one
      // bootstrap decision; a bogus first "mark" outside it is
      // discarded rather than seeding anything, and the next candidate
      // gets the same chance.
      const MIN_PLAUSIBLE_MARK_RATIO = 0.4;
      const MIN_BOOTSTRAP_MARK_MS = 10;
      const MAX_BOOTSTRAP_MARK_MS = 600;
      // A real bug found by testing against messages that simply start
      // with a dash — "CQ" (the single most common CW call there is:
      // -.-. --.-) and any leading digit built from mostly dashes (e.g.
      // "0" is -----, so "0700 UTC" ) — which reproduced with clean,
      // noise-free synthetic audio, no real-recording artifacts needed at
      // all: purely deterministic given the algorithm. Before this fix,
      // *any* classified mark (dot or dash alike) could seed/update this
      // window, on the reasoning that the window's minimum will always
      // settle on the true dot length once enough marks accumulate. That
      // reasoning breaks down specifically while the window doesn't yet
      // contain a single genuine dot: if the very first mark(s) of a
      // message happen to be dashes — entirely normal, not noise or a
      // glitch — their raw (3-unit) duration became the window's only
      // data point, dragging the unit estimate well above the true dot
      // length. Every dash immediately afterward then read as fewer
      // multiples of that inflated unit than it should have, misreading
      // as a dot — "CQ" decoded as "BQ" (its second dash misread as a
      // dot) on every trial across ten different noise seeds *and* with
      // no noise at all, and "0700 UTC" — all-dash-heavy at the very
      // start — decoded as nothing but a single "?". Fixed by only ever
      // letting a mark *classified as a dot* (`!isDash`, checked against
      // whatever unit estimate is current at the moment of
      // classification) seed or update this window — a mark classified
      // as a dash is simply never trusted as a stand-in for "one unit",
      // cold-start or not. This doesn't reintroduce the older
      // slow-callsign-then-speeds-up problem the window was widened to
      // fix in the first place (see this field's own doc comment above):
      // that recovery specifically depends on a now-fast dash reading as
      // *shorter* than the stale (too-slow) unit estimate, which means it
      // gets classified `isDash: false` (a "dot") at the moment it's
      // checked — exactly the case this still allows through.
      const canSeed =
        !isDash &&
        (this._recentMarkDurations.length === 0
          ? elapsed >= MIN_BOOTSTRAP_MARK_MS && elapsed <= MAX_BOOTSTRAP_MARK_MS
          : elapsed >= this._unitMs * MIN_PLAUSIBLE_MARK_RATIO);
      if (canSeed) {
        this._recentMarkDurations.push(elapsed);
        if (this._recentMarkDurations.length > 8) this._recentMarkDurations.shift();
        const windowMin = Math.min(...this._recentMarkDurations);
        const alpha = 0.3;
        this._unitMs = this._unitMs * (1 - alpha) + windowMin * alpha;
      }
      this._sinceLastMark = 0;
      this._charGapPending = false;
    } else {
      // A space just ended (tone starting again) — nothing to finalize
      // beyond what _maybeFinalizeOnSilence() already handled while the
      // silence was ongoing.
      this._sinceLastMark = 0;
      this._charGapPending = false;
    }
    this._toneOn = toneNow;
    this._stateStartedAt = this._clockMs;
  }

  _maybeFinalizeOnSilence() {
    if (this._currentSequence && !this._charGapPending && this._sinceLastMark > this._unitMs * CHAR_GAP_THRESHOLD_UNITS) {
      this.emit('char', morseToChar(this._currentSequence));
      this._currentSequence = '';
      this._charGapPending = true;
    }
    if (this._charGapPending && this._sinceLastMark > this._unitMs * WORD_GAP_THRESHOLD_UNITS) {
      this.emit('space');
      this._charGapPending = false; // don't re-emit further spaces for the same ongoing silence
      this._sinceLastMark = -Infinity; // suppress repeat word-gap emissions until the next tone
    }
  }

  /** Current adaptive speed estimate, in WPM (informational only). */
  get estimatedWpm() {
    return Math.round(1200 / this._unitMs);
  }

  /**
   * Returns the calibration ring buffer's contents in correct
   * chronological order (oldest sample first). The buffer itself is
   * circular for O(1) writes; this only linearizes it right before a
   * scan actually needs to run (every calibrationIntervalMs, not per
   * sample), which is cheap enough to just allocate fresh each time.
   */
  _calibrationSamplesInOrder() {
    const n = this._calibFilled;
    if (n < this._calibSampleCount) return this._calibBuffer.subarray(0, n);
    const out = new Float64Array(n);
    const tail = this._calibBuffer.subarray(this._calibWritePos);
    const head = this._calibBuffer.subarray(0, this._calibWritePos);
    out.set(tail, 0);
    out.set(head, tail.length);
    return out;
  }

  /**
   * Periodically re-derives the actual tone frequency directly from the
   * received audio and retunes `pitchHz` if it's drifted (or was simply
   * wrong to begin with — see the constructor's `autoCalibratePitch`
   * doc comment for the real failure this fixes). A coarse Goertzel
   * bank scan across [calibrationMinHz, calibrationMaxHz] finds the
   * loudest frequency in the most recent `calibrationWindowMs` of raw
   * audio; if that peak stands out clearly from the rest of the scanned
   * band (a real CW tone is narrowband and shows a sharp peak; ordinary
   * room/band noise doesn't), and it's meaningfully different from the
   * currently-tracked pitch, that becomes the new `pitchHz`.
   *
   * The "stands out clearly" check compares the scan's peak against its
   * own *median* across the whole scan, not against `_noiseFloor` — the
   * noise floor is only ever measured at whatever `pitchHz` currently
   * is, which is exactly the value that might be wrong (including
   * "wrong enough that nothing has ever been classified as tone", where
   * `_noiseFloor` and `_signalPeak` are both still near their initial
   * defaults and useless as a reference). The scan's own peak-to-median
   * ratio needs no such reference: verified against a real user-supplied
   * recording, an actual CW tone's ratio was consistently >15x, while
   * silence/room noise after the transmission ended stayed under 7x —
   * calibrationContrastThreshold (8) sits with margin on both sides of
   * that gap.
   */
  _maybeCalibratePitch() {
    if (this._calibFilled < this._calibSampleCount) return; // not enough audio buffered yet
    // Retry quickly until the first successful lock (a single 250ms
    // window can land on a gap between marks even during real CW), then
    // fall back to a slower cadence just to track drift/reconfiguration.
    const interval = this._hasCalibratedOnce ? this.calibrationIntervalMs : this.calibrationRetryIntervalMs;
    if (this._clockMs - this._lastCalibrationMs < interval) return;
    this._lastCalibrationMs = this._clockMs;

    const window = this._calibrationSamplesInOrder();
    const magnitudes = [];
    let bestFreq = this.pitchHz;
    let bestMag = -Infinity;
    for (let f = this.calibrationMinHz; f <= this.calibrationMaxHz; f += this.calibrationStepHz) {
      const mag = goertzelMagnitude(window, this.sampleRate, f);
      magnitudes.push(mag);
      if (mag > bestMag) {
        bestMag = mag;
        bestFreq = f;
      }
    }

    const sorted = [...magnitudes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const isDecisiveTone = median > 0 && bestMag / median >= this.calibrationContrastThreshold;
    const meaningfullyDifferent = Math.abs(bestFreq - this.pitchHz) > this.calibrationStepHz;

    if (isDecisiveTone && meaningfullyDifferent) {
      this.pitchHz = bestFreq;
      this._hasCalibratedOnce = true;
      this.emit('pitch', bestFreq);
    } else if (isDecisiveTone) {
      // Already at (or within one grid step of) the right frequency —
      // still counts as "locked" so we drop to the slower cadence.
      this._hasCalibratedOnce = true;
    }
  }
}

module.exports = { CwDecoder, goertzelMagnitude, morseToChar, MORSE_TABLE };
