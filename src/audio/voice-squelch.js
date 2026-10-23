'use strict';

/**
 * Voice squelch for SSB, AM and FM receive audio: passes speech, mutes the
 * hiss between overs.
 *
 * A level squelch (like the radio's own) opens on anything loud enough, so
 * on HF it needs constant adjusting as the noise changes, and it opens on
 * carriers and static crashes. This one looks for what only speech has:
 * the pitch of a voice. Voiced speech (vowels) is a train of pulses from
 * the vocal cords, 80 to 300 times a second, so the envelope of the audio
 * repeats at that rate. That holds even when an SSB signal is mistuned,
 * which shifts the harmonics but not their spacing. Noise, a carrier, a CW
 * note and a click have no such repetition.
 *
 * Every 20 ms, on the audio resampled to 8 kHz:
 *   band-pass 300-1000 Hz (where a voice's harmonics are strongest) ->
 *   rectify, low-pass at 600 Hz and high-pass at 60 Hz (the envelope's
 *   pitch-rate wobble) -> over the last 128 ms,
 *   the best normalised autocorrelation at lags of 3.4-12.5 ms (296-80 Hz)
 *   -> "voiced" if above VOICED_THRESHOLD.
 * Speech is "heard" when 3 of the last 10 steps (200 ms) are voiced. The
 * squelch then opens from PRE_ROLL_SEC before that moment, and stays open
 * until HANG_SEC after the last time speech was heard.
 *
 * Two carriers beating together also make a periodic envelope. Their
 * "pitch" never moves, while a voice's wanders, so if the voiced readings
 * of the last 2 s are nearly all one pitch (see MIN_TONE_READINGS), it is
 * taken as a tone: the squelch shuts at once and stays shut while the tone
 * lasts. The 2 s is needed because a held vowel ("ahh") is steady too;
 * the cost is that a new pair of carriers can open the squelch for a
 * second or so before it shuts.
 *
 * The audio is delayed by PRE_ROLL_SEC, so the start of an over, heard
 * before the detector is sure, is not lost. Opening fades in over 5 ms and
 * closing fades out over 30 ms, so there are no clicks.
 *
 * Tuned on a real 285 s SSB recording (ham-qso-ai's demo.opus, with a weak
 * station, static crashes and AGC) and on synthetic noise, clicks and
 * carriers: see docs/audio-notes.md. The idea of telling speech by its
 * syllable rhythm rather than its level comes from ham-qso-ai's
 * SyllabicVAD (Apache-2.0) and the DB1NV and JPL SSB squelches; that
 * rhythm test turned out too weak on AGC'd SSB, so this uses pitch
 * instead. No code was copied.
 */

const DETECT_RATE = 8000;
const FRAME = 1024; // 128 ms at 8 kHz
const HOP = 160; // 20 ms
const MIN_LAG = 27; // 296 Hz
const MAX_LAG = 100; // 80 Hz
const VOICED_THRESHOLD = 0.4;
// Speech is heard when 3 of the last 10 steps (200 ms) are voiced.
const WINDOW_STEPS = 10;
const MIN_VOICED = 3;
// A tone: at least 40 voiced readings in the last 2 s taken at a steady
// level, 75% of them within 0.8% of their median.
const PITCH_WINDOW_STEPS = 100; // 2 s
const MIN_TONE_READINGS = 40;
const MAX_TONE_DEVIATION = 0.008;
const TONE_FRACTION = 0.75;
const PRE_ROLL_SEC = 0.3;
const HANG_SEC = 1.5;
const FADE_IN_SEC = 0.005;
const FADE_OUT_SEC = 0.03;

/** RBJ biquad, direct form I. */
class Biquad {
  constructor(type, f0, rate, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * f0) / rate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    let b0;
    let b1;
    let b2;
    if (type === 'lowpass') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = b0;
    } else {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
    }
    const a0 = 1 + alpha;
    this.b = [b0 / a0, b1 / a0, b2 / a0];
    this.a = [(-2 * cos) / a0, (1 - alpha) / a0];
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  step(x) {
    const y = this.b[0] * x + this.b[1] * this.x1 + this.b[2] * this.x2 - this.a[0] * this.y1 - this.a[1] * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Best normalised autocorrelation of `e` (mean removed) over the pitch lags.
 * @returns {{r: number, lag: number, steady: boolean}} r 0..1; the lag
 *   (samples at 8 kHz, refined between samples) of the pitch; and whether
 *   the level was steady across the window
 */
function pitchStrength(e, level = e) {
  const n = e.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += e[i];
  mean /= n;
  const d = new Float64Array(n);
  const sq = new Float64Array(n + 1); // prefix sums of d^2
  for (let i = 0; i < n; i++) {
    d[i] = e[i] - mean;
    sq[i + 1] = sq[i] + d[i] * d[i];
  }
  if (sq[n] < 1e-12) return { r: 0, lag: 0, steady: false }; // digital silence
  const rs = new Float64Array(MAX_LAG + 2);
  for (let lag = MIN_LAG - 1; lag <= MAX_LAG + 1; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += d[i] * d[i + lag];
    const ea = sq[n - lag]; // d[0 .. n-lag)
    const eb = sq[n] - sq[lag]; // d[lag .. n)
    rs[lag] = acc / Math.sqrt(ea * eb + 1e-30);
  }
  let top = MIN_LAG;
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) if (rs[lag] > rs[top]) top = lag;
  // a best lag at the edge of the range, still rising beyond it, is a
  // periodicity outside the voice range (e.g. two tones 320 Hz apart)
  if (rs[top] < rs[top - 1] || rs[top] < rs[top + 1]) return { r: 0, lag: 0, steady: false };
  // A periodic envelope also correlates at 2, 3... times its period. Take
  // the shortest lag that is a peak nearly as high as the best, so the same
  // sound gives the same lag every time (a steady tone then shows as steady).
  let best = top;
  for (let lag = MIN_LAG; lag < top; lag++) {
    if (rs[lag] >= 0.85 * rs[top] && rs[lag] >= rs[lag - 1] && rs[lag] >= rs[lag + 1]) {
      best = lag;
      break;
    }
  }
  // parabolic refinement, so small pitch changes show
  const a = rs[best - 1];
  const b = rs[best];
  const c = rs[best + 1];
  const den = a - 2 * b + c;
  const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  // Whether the level is steady across the window: a sound starting or
  // stopping inside the window skews the lag, so such steps don't count
  // towards the tone test.
  let e1 = 0;
  let e2 = 0;
  for (let i = 0; i < n >> 1; i++) e1 += level[i];
  for (let i = n >> 1; i < n; i++) e2 += level[i];
  const steady = e1 < 1.6 * e2 && e2 < 1.6 * e1;
  return { r: Math.max(0, rs[top]), lag: best + off, steady };
}

class VoiceSquelch {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate - of the audio passed to process()
   * @param {(inRate: number, outRate: number) => {process(x: Float32Array): Float32Array}} opts.makeResampler
   *   - e.g. (a, b) => new StreamResampler(a, b) from client/audio-codec.js
   * @param {number} [opts.preRollSec]
   * @param {number} [opts.hangSec]
   */
  constructor({ sampleRate, makeResampler, preRollSec = PRE_ROLL_SEC, hangSec = HANG_SEC }) {
    this.sampleRate = sampleRate;
    this.resampler = makeResampler(sampleRate, DETECT_RATE);
    this.hp1 = new Biquad('highpass', 300, DETECT_RATE);
    this.hp2 = new Biquad('highpass', 300, DETECT_RATE);
    this.lp1 = new Biquad('lowpass', 1000, DETECT_RATE);
    this.lp2 = new Biquad('lowpass', 1000, DETECT_RATE);
    // smooths the rectified audio into its envelope: keeps the pitch,
    // removes most of the audio itself (a lone carrier's rectified waveform
    // repeats every half cycle, which would look like a pitch)
    this.env1 = new Biquad('lowpass', 600, DETECT_RATE);
    this.env2 = new Biquad('lowpass', 600, DETECT_RATE);
    // and drops what changes slower than a voice's pitch (syllables, a
    // carrier switching on or off), which would otherwise correlate with
    // itself at every lag
    this.env3 = new Biquad('highpass', 60, DETECT_RATE);
    this.env = new Float32Array(FRAME * 2);
    this.level = new Float32Array(FRAME * 2); // the envelope before the high-pass, for the steady-level test
    this.envLen = 0; // samples in env
    this.detectPos = 0; // 8 kHz samples consumed before env[0]
    this.recent = []; // voiced steps of the last 2 s: {s: step index, lag, steady}
    this.step = 0;

    this.delay = Math.round(preRollSec * sampleRate);
    this.hang = Math.round(hangSec * sampleRate);
    this.fifo = new Float32Array(this.delay); // the delay line, primed with silence
    this.fifoPos = 0;
    this.inCount = 0; // input samples so far
    this.openFrom = Infinity; // input-sample interval in which the output is open
    this.openUntil = -Infinity;
    this.nextFrom = Infinity; // a further interval queued behind the current one
    this.nextUntil = -Infinity;
    this.gain = 0;
    this.fadeIn = 1 / Math.max(1, FADE_IN_SEC * sampleRate);
    this.fadeOut = 1 / Math.max(1, FADE_OUT_SEC * sampleRate);
  }

  /** Whether the squelch is open now (at the output, PRE_ROLL_SEC behind the input). */
  get open() {
    return this.gain > 0;
  }

  /**
   * @param {Buffer} pcm - S16LE mono
   * @returns {Buffer|null} the same amount of audio, delayed and gated;
   *   null if all of it is muted (nothing worth sending)
   */
  process(pcm) {
    const n = pcm.length >> 1;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(2 * i) / 32768;
    this._detect(x);

    const out = Buffer.alloc(n * 2);
    let any = false;
    const startOut = this.inCount - this.delay; // input-sample time of this chunk's first output
    for (let i = 0; i < n; i++) {
      const delayed = this.fifo[this.fifoPos];
      this.fifo[this.fifoPos] = x[i];
      this.fifoPos = this.fifoPos + 1 === this.delay ? 0 : this.fifoPos + 1;
      const t = startOut + i;
      if (t > this.openUntil && this.nextFrom !== Infinity && t >= this.nextFrom) {
        this.openFrom = this.nextFrom;
        this.openUntil = this.nextUntil;
        this.nextFrom = Infinity;
        this.nextUntil = -Infinity;
      }
      const want = t >= this.openFrom && t <= this.openUntil;
      if (want) this.gain = Math.min(1, this.gain + this.fadeIn);
      else if (this.gain > 0) this.gain = Math.max(0, this.gain - this.fadeOut);
      if (this.gain > 0) {
        any = true;
        const v = Math.round(delayed * this.gain * 32768);
        out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, 2 * i);
      }
    }
    this.inCount += n;
    return any ? out : null;
  }

  _detect(x) {
    const y = this.resampler.process(x);
    for (let i = 0; i < y.length; i++) {
      const b = this.lp2.step(this.lp1.step(this.hp2.step(this.hp1.step(y[i]))));
      const lv = this.env2.step(this.env1.step(b < 0 ? -b : b));
      this.level[this.envLen] = lv;
      this.env[this.envLen++] = this.env3.step(lv);
      if (this.envLen === FRAME) {
        // one step: the last FRAME envelope samples, ending at 8 kHz sample detectPos + FRAME
        const p = pitchStrength(this.env.subarray(0, FRAME), this.level.subarray(0, FRAME));
        this._onStep(p.r > VOICED_THRESHOLD ? p : null, this.detectPos + FRAME);
        this.env.copyWithin(0, HOP, FRAME);
        this.level.copyWithin(0, HOP, FRAME);
        this.envLen = FRAME - HOP;
        this.detectPos += HOP;
      }
    }
  }

  /** One 20 ms step: `p` is pitchStrength()'s result if the step was voiced, else null. */
  _onStep(p, end8k) {
    const s = this.step++;
    if (p) this.recent.push({ s, lag: p.lag, steady: p.steady });
    while (this.recent.length && this.recent[0].s <= s - PITCH_WINDOW_STEPS) this.recent.shift();
    const t = Math.round((end8k * this.sampleRate) / DETECT_RATE); // input-sample time of this step
    if (this._isTone()) {
      // shut now (at the output, which runs `delay` behind) and forget anything queued
      this.openUntil = Math.min(this.openUntil, this.inCount - this.delay);
      this.nextFrom = Infinity;
      this.nextUntil = -Infinity;
      return;
    }
    let count = 0;
    for (let i = this.recent.length - 1; i >= 0 && this.recent[i].s > s - WINDOW_STEPS; i--) count++;
    if (count < MIN_VOICED) return;
    // speech heard: open from PRE_ROLL before this moment until HANG after it
    const from = t - this.delay;
    const until = t + this.hang;
    if (this.openUntil === -Infinity || from <= this.openUntil + 1) {
      if (this.openUntil === -Infinity || this.openFrom > this.openUntil) this.openFrom = from;
      this.openUntil = Math.max(this.openUntil, until);
    } else if (this.nextFrom === Infinity) {
      this.nextFrom = from;
      this.nextUntil = until;
    } else {
      this.nextUntil = Math.max(this.nextUntil, until);
    }
  }

  /** Whether the voiced readings of the last 2 s are one steady tone (see MIN_TONE_READINGS). */
  _isTone() {
    const lags = [];
    for (const v of this.recent) if (v.steady) lags.push(v.lag);
    if (lags.length < MIN_TONE_READINGS) return false;
    lags.sort((a, b) => a - b);
    const median = lags[lags.length >> 1];
    let near = 0;
    for (const l of lags) if (Math.abs(l - median) <= MAX_TONE_DEVIATION * median) near++;
    return near >= TONE_FRACTION * lags.length;
  }
}

module.exports = { VoiceSquelch, pitchStrength, PRE_ROLL_SEC, HANG_SEC };
