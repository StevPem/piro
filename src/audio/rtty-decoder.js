'use strict';

const { EventEmitter } = require('events');
const { goertzelMagnitude } = require('./cw-decoder');

// Standard amateur RTTY parameters: 45.45 baud, 170Hz shift, mark tone
// lower than space tone. 2125Hz mark / 2295Hz space is the specific tone
// pair "used by most Amateurs" on USB (per AA5AU's own RTTY primer) —
// cross-checked against two further independent references (Wikipedia's
// Radioteletype article and a hex-indexed ITA2/US-TTY code-table dump)
// which agree mark < space by exactly 170Hz and give these same two
// absolute frequencies, rather than assumed/guessed. A European
// convention (2125/1955Hz, i.e. the same mark tone but shifted the other
// way) also exists and isn't handled here — `markHz`/`spaceHz` are both
// constructor options precisely so a different convention (or a
// different band-plan/rig setup entirely) can be substituted without
// code changes, the same way CwDecoder's `pitchHz` is configurable
// rather than hardcoded.
const DEFAULT_MARK_HZ = 2125;
const DEFAULT_SPACE_HZ = 2295;
const DEFAULT_BAUD = 45.45;

// ITA2 (Baudot/Murray) code table, US-TTY figures-case variant — the
// same character set real amateur RTTY terminal units and software
// (Fldigi, MMTTY, etc.) use. Indexed 0-31 by the 5-bit code accumulated
// bit-by-bit as each data bit is received off the air, *least-significant
// bit first* — i.e. the first data bit after the start bit is worth 1,
// the last is worth 16 — matching this file's own bit-sync state machine
// below (see _finalizeFrame()) and independently cross-checked against
// three separate published ITA2/US-TTY references (not guessed): a
// letter-by-letter "LSB-first as transmitted" table, a second table
// giving the same codes MSB-first (the two agree once one is
// bit-reversed against the other), and a third, hex-indexed dump that
// resolved the specific national-variant ambiguities below by exact
// binary code rather than English description.
//
// A handful of figures-case assignments genuinely differ between
// national ITA2 variants (this isn't sloppiness in the sources, several
// *are* legitimately different standards) and needed the third,
// hex-indexed reference to settle definitively against the specifically
// US-TTY convention ham radio RTTY uses, since the first two sources
// disagreed with each other on exactly these:
//   - S: BEL (US-TTY) vs "'" (apostrophe, plain ITA2/European)
//   - J: "'" (apostrophe, US-TTY) — some tables list this differently
//   - H: "#" (US-TTY) vs "£" (ITA2/European)
//   - Z: '"' (double quote) — one source incorrectly gave "+" for this
//     cell; rejected once the hex-indexed table and the LSB-first table
//     agreed with each other against it
// D ("$") and V (";") were consistent across every source checked.
const BAUDOT_TABLE = [
  { ltrs: null, figs: null }, // 0: NUL/NUL — never emitted
  { ltrs: 'E', figs: '3' }, // 1
  { ltrs: '\n', figs: '\n' }, // 2: LF
  { ltrs: 'A', figs: '-' }, // 3
  { ltrs: ' ', figs: ' ' }, // 4: SPACE
  { ltrs: 'S', figs: '\x07' }, // 5: BEL in figures case (US-TTY)
  { ltrs: 'I', figs: '8' }, // 6
  { ltrs: 'U', figs: '7' }, // 7
  { ltrs: '\r', figs: '\r' }, // 8: CR
  { ltrs: 'D', figs: '$' }, // 9
  { ltrs: 'R', figs: '4' }, // 10
  { ltrs: 'J', figs: "'" }, // 11
  { ltrs: 'N', figs: ',' }, // 12
  { ltrs: 'F', figs: '!' }, // 13
  { ltrs: 'C', figs: ':' }, // 14
  { ltrs: 'K', figs: '(' }, // 15
  { ltrs: 'T', figs: '5' }, // 16
  { ltrs: 'Z', figs: '"' }, // 17
  { ltrs: 'L', figs: ')' }, // 18
  { ltrs: 'W', figs: '2' }, // 19
  { ltrs: 'H', figs: '#' }, // 20
  { ltrs: 'Y', figs: '6' }, // 21
  { ltrs: 'P', figs: '0' }, // 22
  { ltrs: 'Q', figs: '1' }, // 23
  { ltrs: 'O', figs: '9' }, // 24
  { ltrs: 'B', figs: '?' }, // 25
  { ltrs: 'G', figs: '&' }, // 26
  { ltrs: null, figs: null }, // 27: FIGS shift
  { ltrs: 'M', figs: '.' }, // 28
  { ltrs: 'X', figs: '/' }, // 29
  { ltrs: 'V', figs: ';' }, // 30
  { ltrs: null, figs: null }, // 31: LTRS shift
];
const FIGS_CODE = 27;
const LTRS_CODE = 31;

/**
 * Decodes one 5-bit Baudot/ITA2 code against the current shift state.
 * LTRS/FIGS codes never produce a character themselves — they only
 * change which case subsequent codes are read against — matching how a
 * real teleprinter's mechanical shift lever worked. Deliberately does
 * NOT implement "unshift on space" (some RTTY conventions auto-revert to
 * LTRS on a space character, as a defense against a lost FIGS/LTRS code
 * leaving the rest of a message permanently misinterpreted) — a
 * reasonable robustness feature, but not something the original request
 * asked for; see docs/ui-notes.md for this as a known limitation.
 */
function baudotToChar(code, shiftState) {
  if (code === LTRS_CODE) return { char: null, shiftState: 'LTRS' };
  if (code === FIGS_CODE) return { char: null, shiftState: 'FIGS' };
  const entry = BAUDOT_TABLE[code];
  const char = shiftState === 'FIGS' ? entry.figs : entry.ltrs;
  return { char, shiftState };
}

/**
 * Streaming RTTY (Baudot/ITA2) decoder: feed it raw PCM samples via
 * pushSamples() as they arrive from the radio's RX audio, and it emits
 * decoded characters as they resolve. Mirrors CwDecoder's overall shape
 * (Goertzel tone detection per fixed-size PCM block, an adaptive noise
 * floor, debounced state transitions — see cw-decoder.js, whose
 * `goertzelMagnitude` this file reuses directly) but detects two
 * simultaneously-tracked tones (mark/space FSK) instead of one
 * tone-vs-silence, and — unlike CW's adaptive, operator-speed-dependent
 * dot/dash timing — RTTY's baud rate is fixed and known in advance, so
 * this decodes it the way a UART receives asynchronous serial data:
 * watch for the mark-to-space edge that starts a character (the start
 * bit), then sample the line state at the nominal center of every
 * subsequent bit position for the rest of the fixed-length character
 * frame, rather than adaptively estimating anything.
 *
 * Frame shape (standard amateur RTTY): 1 start bit (space) + 5 data bits
 * (Baudot/ITA2, least-significant bit first) + a stop bit sampled once
 * at the nominal 1-bit position (real amateur RTTY typically uses a
 * 1.5-bit stop period; sampling only the first bit of it is enough to
 * validate framing and naturally leaves the remaining ~0.5 bit as
 * margin before the next start-bit edge is expected, rather than
 * needing to explicitly wait it out).
 *
 * This is a genuinely lossy, best-effort process, not a guarantee of
 * accurate copy — see docs/ui-notes.md for the honest limitations (QRM,
 * fading, mistuning, and multipath-garbled mark/space transitions all
 * degrade it, the same way they degrade a real RTTY terminal unit).
 *
 * Events:
 *   'char' (string) — a single decoded character as soon as its frame
 *                      resolves (CR/LF pass through as '\r'/'\n'; NUL and
 *                      the LTRS/FIGS shift codes themselves are consumed
 *                      internally and never emitted)
 */
class RttyDecoder extends EventEmitter {
  /**
   * @param {number} [opts.sampleRate=48000]
   * @param {number} [opts.markHz=2125] - mark tone frequency
   * @param {number} [opts.spaceHz=2295] - space tone frequency (170Hz
   *   above markHz by the standard amateur convention — see this file's
   *   own top-of-file doc comment for the sourcing)
   * @param {number} [opts.baud=45.45] - standard amateur RTTY baud rate
   * @param {number} [opts.windowMs=10] - length of audio each Goertzel
   *   pass analyzes (mark and space are each evaluated over the same
   *   window, independently). This can't be as short as CW's 8ms block
   *   the way an earlier version of this file assumed: at 45.45 baud a
   *   bit is only ~22ms, but a *short* Goertzel window has coarse
   *   frequency resolution (bin spacing = sampleRate/windowSamples), and
   *   170Hz — the entire shift between mark and space — turned out to
   *   be narrower than that spacing at 4ms (both tones rounded to the
   *   exact same bin, making them numerically indistinguishable — caught
   *   by direct testing against synthetic mark/space tones, not
   *   discovered against real audio after the fact). 10ms keeps the bin
   *   spacing (100Hz) comfortably under the 170Hz shift while still
   *   being under half a bit period, so a transition doesn't spend most
   *   of a bit smeared between two symbols.
   * @param {number} [opts.stepMs=2] - how often (in raw audio time) a new
   *   windowMs-long analysis is re-run, via a sliding window (a ring
   *   buffer of the last windowMs of audio) rather than windowMs itself
   *   being the bit-sync clock's own granularity — decoupling frequency
   *   resolution (windowMs) from timing resolution (stepMs) the way a
   *   single fixed block size can't: windowMs alone (as a disjoint,
   *   non-overlapping block) would only place bit-sample points to
   *   within +-5ms of their true center, a meaningful fraction of a
   *   22ms bit; stepMs re-evaluates every 2ms instead, using the same
   *   10ms of context each time.
   * @param {number} [opts.toneThresholdMultiplier=4] - how many times
   *   above the adaptive noise floor the *stronger* of the mark/space
   *   magnitudes must be before a step counts as "signal present" at
   *   all (as opposed to noise, where the mark/space classification is
   *   held at its previous value rather than trusted) — a lower value
   *   than CW's default 6 since FSK's mark-vs-space comparison is
   *   inherently more discriminating than CW's tone-vs-silence one (two
   *   tones to compare against each other, not just one against a noise
   *   floor).
   * @param {number} [opts.debounceSteps=3] - consecutive steps that must
   *   agree before a mark/space transition is trusted, the same
   *   debouncing rationale as CwDecoder's own `debounceBlocks` (a lone
   *   noisy step flipping the classification isn't treated as a real
   *   transition) — 3 steps at the 2ms default stepMs is 6ms, comfortably
   *   under one bit period.
   * @param {boolean} [opts.reversed=false] - **Real bug found**: this
   *   decoder was, until this option existed, hardwired to one fixed
   *   mark/space polarity with no way to invert it, and normal-vs-reversed
   *   RTTY polarity is genuinely not predictable in advance — unlike (say)
   *   a fixed mic-audio phase convention, which normal/reversed tone
   *   pairing a given contact needs depends on *both* stations' equipment
   *   and is routinely different from one contact to the next, which is
   *   exactly why every real RTTY terminal program (fldigi, MMTTY, and
   *   the IC-7300's own built-in decoder, which is unaffected since it
   *   demodulates FSK internally rather than searching for two fixed
   *   audio tones the way this decoder does) offers a manual "Reverse"
   *   toggle rather than trying to guess it from the radio's CI-V mode —
   *   there is no CI-V field for this to read in the first place (see
   *   RttyDecoderBridge's own doc comment on why RTTY, unlike CW, has no
   *   tone/polarity readback at all). Without it, a signal actually using
   *   the opposite polarity from whatever this decoder assumed decoded
   *   nothing at all: every "mark" reads as "space" and vice versa, so
   *   the very first (assumed-space) start-bit check already fails validation
   *   permanently — indistinguishable from "no signal" even though a real
   *   terminal happily copies the exact same audio. `true` swaps which of
   *   `markHz`/`spaceHz` is treated as the logical mark tone (equivalent
   *   to calling `setTones()` with the two arguments swapped, but tracked
   *   as its own flag so `setTones()` and `setReversed()` can each be
   *   called independently without one clobbering the other's effect —
   *   see setReversed()/setTones() below).
   */
  constructor({
    sampleRate = 48000,
    markHz = DEFAULT_MARK_HZ,
    spaceHz = DEFAULT_SPACE_HZ,
    baud = DEFAULT_BAUD,
    windowMs = 10,
    stepMs = 2,
    toneThresholdMultiplier = 4,
    debounceSteps = 3,
    reversed = false,
  } = {}) {
    super();
    this.sampleRate = sampleRate;
    // The "base" (as-configured) tone pair, independent of `reversed` —
    // see setTones()/setReversed(). `markHz`/`spaceHz` (no underscore)
    // remain the *effective*, possibly-swapped pair _processStep()
    // actually analyzes against, so the hot per-sample path never needs
    // to branch on `reversed` itself.
    this._baseMarkHz = markHz;
    this._baseSpaceHz = spaceHz;
    this.reversed = reversed;
    this.markHz = reversed ? spaceHz : markHz;
    this.spaceHz = reversed ? markHz : spaceHz;
    this.baud = baud;
    this.bitMs = 1000 / baud;
    this.toneThresholdMultiplier = toneThresholdMultiplier;
    this.debounceSteps = debounceSteps;

    this._windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
    this._stepSamples = Math.max(1, Math.round((sampleRate * stepMs) / 1000));
    this._stepMs = (this._stepSamples / sampleRate) * 1000;
    // Sliding analysis window, same ring-buffer technique as
    // CwDecoder's own `_calibBuffer` — written one raw sample at a time,
    // linearized only when a step's worth of new samples has actually
    // arrived (see _linearizedWindow()).
    this._ring = new Float64Array(this._windowSamples);
    this._ringPos = 0;
    this._ringFilled = 0;
    this._sinceLastStep = 0;

    this._clockMs = 0;
    this._noiseFloor = 10;
    // Idle/rest state is mark (the teleprinter convention: mark = stop
    // bit = "1" = line at rest), so start here rather than requiring an
    // observed tone first — same rationale as CwDecoder's own initial
    // noise-floor guess (real audio can start mid-transmission with no
    // leading silence to learn from).
    this._lineIsMark = true;
    this._pendingState = null;
    this._pendingCount = 0;
    this._shiftState = 'LTRS';
    this._frame = null; // {startMs, nextBitIndex, bits: []} while mid-character; null while idle/searching for the next start bit
  }

  /**
   * Retune the base target mark/space tone frequencies (before any
   * `reversed` swap — see the constructor's own `reversed` doc comment).
   * Preserves whatever polarity `setReversed()` last set, rather than
   * silently un-reversing — the two are independent settings (one is
   * "what frequencies", the other is "which one means mark"), so a
   * caller that's already reversed and then just wants to retune the
   * frequencies (or vice versa) doesn't have to remember to re-apply the
   * other.
   */
  setTones(markHz, spaceHz) {
    this._baseMarkHz = markHz;
    this._baseSpaceHz = spaceHz;
    this.markHz = this.reversed ? spaceHz : markHz;
    this.spaceHz = this.reversed ? markHz : spaceHz;
  }

  /**
   * Swaps which of the base mark/space tones is treated as the logical
   * mark — see the constructor's own `reversed` doc comment for why this
   * exists at all (real bug: no way to invert polarity previously, and
   * RTTY polarity genuinely isn't predictable in advance). Does not touch
   * `_baseMarkHz`/`_baseSpaceHz` — only which of the two is currently
   * assigned to `markHz` vs `spaceHz` for `_processStep()`'s analysis.
   */
  setReversed(reversed) {
    this.reversed = reversed;
    this.markHz = reversed ? this._baseSpaceHz : this._baseMarkHz;
    this.spaceHz = reversed ? this._baseMarkHz : this._baseSpaceHz;
  }

  /** Clears all decode state — call when leaving RTTY mode or reconnecting. */
  reset() {
    this._ring.fill(0);
    this._ringPos = 0;
    this._ringFilled = 0;
    this._sinceLastStep = 0;
    this._clockMs = 0;
    this._noiseFloor = 10;
    this._lineIsMark = true;
    this._pendingState = null;
    this._pendingCount = 0;
    this._shiftState = 'LTRS';
    this._frame = null;
  }

  /** @param {Int16Array|number[]} samples - new PCM samples to append and process */
  pushSamples(samples) {
    for (let i = 0; i < samples.length; i++) {
      this._ring[this._ringPos] = samples[i];
      this._ringPos = (this._ringPos + 1) % this._windowSamples;
      if (this._ringFilled < this._windowSamples) this._ringFilled++;
      this._sinceLastStep++;
      if (this._sinceLastStep >= this._stepSamples && this._ringFilled >= this._windowSamples) {
        this._sinceLastStep = 0;
        this._processStep();
      }
    }
  }

  /** Linearizes the ring buffer into chronological order (oldest first) — same technique as CwDecoder's own `_calibrationSamplesInOrder()`. */
  _linearizedWindow() {
    if (this._ringFilled < this._windowSamples) return this._ring.subarray(0, this._ringFilled);
    const out = new Float64Array(this._windowSamples);
    const tail = this._ring.subarray(this._ringPos);
    const head = this._ring.subarray(0, this._ringPos);
    out.set(tail, 0);
    out.set(head, tail.length);
    return out;
  }

  _processStep() {
    const stepStartMs = this._clockMs;
    this._clockMs += this._stepMs;

    const window = this._linearizedWindow();
    const markMag = goertzelMagnitude(window, this.sampleRate, this.markHz);
    const spaceMag = goertzelMagnitude(window, this.sampleRate, this.spaceHz);
    const combined = Math.max(markMag, spaceMag);
    const hasSignal = combined > this._noiseFloor * this.toneThresholdMultiplier;

    if (!hasSignal) {
      // Same adaptive-noise-floor EMA as CwDecoder, tracked from
      // whichever tone (if either) reads strongest even below threshold
      // — there's deliberately no signal-peak ceiling here the way CW
      // needed one: FSK's mark-vs-space comparison never depends on
      // this floor to *classify* a step, only to decide whether a step
      // counts as signal at all, so CW's runaway-feedback failure mode
      // (the floor climbing above a real, still-present signal) doesn't
      // apply the same way.
      const alpha = 0.05;
      this._noiseFloor = this._noiseFloor * (1 - alpha) + combined * alpha;
      this._pendingState = null;
      this._pendingCount = 0;
      return;
    }

    const classifiedMark = markMag >= spaceMag;
    if (classifiedMark === this._lineIsMark) {
      this._pendingState = null;
      this._pendingCount = 0;
    } else {
      if (this._pendingState === classifiedMark) {
        this._pendingCount++;
      } else {
        this._pendingState = classifiedMark;
        this._pendingCount = 1;
      }
      if (this._pendingCount >= this.debounceSteps) {
        const wasMark = this._lineIsMark;
        this._lineIsMark = classifiedMark;
        this._pendingState = null;
        this._pendingCount = 0;
        if (this._frame === null && wasMark && !this._lineIsMark) {
          // A confirmed mark->space transition while idle/searching is
          // the leading edge of a start bit. Backdated by debounceSteps'
          // worth of steps, since the edge actually occurred that many
          // steps before it was confirmed, not at the moment of
          // confirmation — otherwise every bit-sample point downstream
          // would be shifted late by the same debounce delay.
          this._frame = { startMs: stepStartMs - (this.debounceSteps - 1) * this._stepMs, nextBitIndex: 0, bits: [] };
        }
      }
    }

    if (this._frame) this._advanceFrame();
  }

  /**
   * Samples the line's current classification at every bit-center
   * timestamp the clock has now reached or passed, for as long as
   * `_frame` remains in progress. Approximates "sample at exactly time T"
   * with "use whatever the most recent step's classification is, once
   * the clock has reached T" — accurate enough given stepMs is small
   * relative to a full bit (see the constructor's stepMs doc comment),
   * and consistent with the same step-granularity tradeoff CwDecoder's
   * own block processing makes throughout.
   */
  _advanceFrame() {
    const f = this._frame;
    for (;;) {
      const sampleAtMs = f.startMs + (f.nextBitIndex + 0.5) * this.bitMs;
      if (this._clockMs < sampleAtMs) return;
      f.bits.push(this._lineIsMark);
      f.nextBitIndex++;
      if (f.nextBitIndex === 7) {
        // start + 5 data bits + stop, all sampled.
        this._finalizeFrame(f);
        this._frame = null;
        return;
      }
    }
  }

  /**
   * Validates and decodes one completed 7-bit-sampled frame. A bad start
   * or stop bit means this wasn't really a character (most likely a
   * false trigger from noise, or the middle of an already-garbled
   * transmission) — silently dropped rather than emitted as '?', since
   * unlike CW's dot/dash sequences (where an unrecognized-but-real
   * character is still meaningful to show the operator), a framing
   * failure here means the bit boundaries themselves aren't trustworthy,
   * so there's no sensible decoded value to show at all. Either way,
   * `_frame` is always cleared by the caller and the search for the next
   * start-bit edge resumes immediately.
   */
  _finalizeFrame(frame) {
    const bits = frame.bits; // [startBit, d0, d1, d2, d3, d4, stopBit], each true=mark/false=space
    const validStart = bits[0] === false;
    const validStop = bits[6] === true;
    if (!validStart || !validStop) return;

    let code = 0;
    for (let i = 0; i < 5; i++) {
      if (bits[1 + i]) code |= 1 << i;
    }
    const { char, shiftState } = baudotToChar(code, this._shiftState);
    this._shiftState = shiftState;
    if (char !== null) this.emit('char', char);
  }
}

module.exports = { RttyDecoder, baudotToChar, BAUDOT_TABLE, FIGS_CODE, LTRS_CODE, DEFAULT_MARK_HZ, DEFAULT_SPACE_HZ, DEFAULT_BAUD };
