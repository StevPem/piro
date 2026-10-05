'use strict';

// Renders spectrum scope lines onto two canvases: a live trace (this
// sweep's amplitude curve) and a scrolling waterfall (amplitude history,
// newest at top). Deliberately plain Canvas 2D — no charting library —
// since this only needs a line plot and a scrolling colormapped image,
// both cheap to draw directly at the ~5-10Hz this data arrives.
//
// Color choice: Google's "Turbo" colormap — an improved rainbow palette
// designed for exactly this kind of scalar-field visualization (see
// https://research.google/blog/turbo-an-improved-rainbow-colormap-for-visualization/),
// per explicit request, in place of this project's own earlier hand-tuned
// blue/cyan/green/yellow/red heatmap (which was calibrated by sampling
// real reference waterfall screenshots — see git history/docs/ui-notes.md
// if that calibration is ever needed again).
//
// turboColormap() below is Google's own published polynomial
// approximation of the full 256-entry Turbo lookup table — the exact
// GLSL coefficients from
// https://gist.github.com/mikhailov-work/0d177465a8151eb6ede1768d51d476c7
// ("Turbo Colormap Polynomial Approximation in GLSL", Copyright 2019
// Google LLC, Apache-2.0), transcribed here rather than re-derived, and
// used in preference to hand-copying a handful of stops from the LUT
// since it reproduces the actual designed colormap continuously across
// the whole range. It's explicitly an *approximation* — Google's own
// gist notes it can be off from the true LUT by roughly a dozen-ish RGB
// levels right at the two extremes (0 and 1), tightest through the
// middle — a known, accepted trade-off for not needing to ship/interpolate
// a 256-entry table, and irrelevant at the resolution of a live waterfall
// display.
//
// amplitude byte -> colormap input: the full 0-255 raw amplitude range
// maps linearly onto Turbo's full [0,1] domain (dark blue/purple at 0,
// through cyan/green/yellow, to dark red at 255) — the standard,
// textbook way to apply a sequential colormap to a scalar range, and, per
// explicit confirmation, deliberately *not* the previous palette's
// special-cased "pin to solid red at/above S9 (raw 126)" behavior: a
// signal well above S9 now renders visibly further along the ramp (redder
// still) than one right at S9, rather than looking identical to it.
function turboColormap(t) {
  const x = Math.max(0, Math.min(1, t));
  // v2 = (x^4, x^5) — i.e. GLSL's `v4.zw * v4.z`, (x*x, x*x*x) scaled by x*x.
  const v4 = [1, x, x * x, x * x * x];
  const v2 = [v4[2] * v4[2], v4[3] * v4[2]];
  const kRedVec4 = [0.13572138, 4.6153926, -42.66032258, 132.13108234];
  const kGreenVec4 = [0.09140261, 2.19418839, 4.84296658, -14.18503333];
  const kBlueVec4 = [0.1066733, 12.64194608, -60.58204836, 110.36276771];
  const kRedVec2 = [-152.94239396, 59.28637943];
  const kGreenVec2 = [4.27729857, 2.82956604];
  const kBlueVec2 = [-89.90310912, 27.34824973];
  const dot4 = (v, k) => v[0] * k[0] + v[1] * k[1] + v[2] * k[2] + v[3] * k[3];
  const dot2 = (v, k) => v[0] * k[0] + v[1] * k[1];
  const r = dot4(v4, kRedVec4) + dot2(v2, kRedVec2);
  const g = dot4(v4, kGreenVec4) + dot2(v2, kGreenVec2);
  const b = dot4(v4, kBlueVec4) + dot2(v2, kBlueVec2);
  // The polynomial can slightly over/undershoot [0,1] right at the
  // extremes (see doc comment above) — clamp each channel rather than
  // let it wrap/go negative when scaled to a byte.
  const clampByte = (c) => Math.round(Math.max(0, Math.min(1, c)) * 255);
  return [clampByte(r), clampByte(g), clampByte(b)];
}

export function amplitudeToColor(value) {
  const t = Math.max(0, Math.min(1, value / 255));
  return turboColormap(t);
}

/**
 * Pixel x-coordinate for the tuning marker, given the tuned frequency and
 * the currently-displayed [lo, hi] range. Pure function (no canvas) so
 * it's directly unit-testable — see test/scope-display.test.mjs.
 * @returns {number|null} null if freqHz is outside [lo, hi] or the range is degenerate
 */
// RTTY's standard amateur shift (mark tone 170Hz below space) — see
// src/audio/rtty-decoder.js's own top-of-file doc comment for the sourcing.
// The trace canvas's second RTTY marker (see setRttyMode()/
// _drawRttyOffsetMarker()) sits this far *below* the tuned-frequency
// marker, mirroring that same mark/space relationship in the RF domain.
export const RTTY_SHIFT_HZ = 170;

export function tuningMarkerX(freqHz, lo, hi, width) {
  if (freqHz == null || lo == null || hi == null) return null;
  if (hi <= lo) return null;
  if (freqHz < lo || freqHz > hi) return null;
  return ((freqHz - lo) / (hi - lo)) * width;
}

/**
 * Inverse of tuningMarkerX: given a click's fractional x position (0-1)
 * across the canvas and the currently-displayed [lo, hi] range, returns
 * the frequency at that position. Pure function, unit-tested directly —
 * see test/scope-display.test.mjs.
 * @returns {number|null} null if lo/hi aren't known yet (no line received)
 */
export function frequencyAtFraction(xFraction, lo, hi) {
  if (lo == null || hi == null || hi <= lo) return null;
  const clamped = Math.max(0, Math.min(1, xFraction));
  return lo + clamped * (hi - lo);
}

/**
 * Rounds a frequency to the nearest whole kilohertz — used to snap
 * click-to-tune (and its hover preview) to a "clean" value like
 * 7,100,000 Hz rather than whatever sub-kHz value a pixel happens to
 * land on, matching how operators actually think about RF tuning
 * (e.g. "7.100 MHz"). Pure function, unit-tested directly — see
 * test/scope-display.test.mjs.
 */
export function snapToNearestKHz(hz) {
  return Math.round(hz / 1000) * 1000;
}

/**
 * Rounds an audio-domain (FT8 passband) frequency to the nearest 50Hz —
 * the FT8 audio-spectrum equivalent of snapToNearestKHz() above, used for
 * the spectrum's hover tag and click-to-set-TX-frequency (see
 * pushAudioSpectrum()). 50Hz, not 1kHz, because FT8 signals are packed
 * only ~6.25Hz apart within the passband and operators routinely pick a
 * specific narrow slot to transmit in (e.g. "1500", "1550") — a 1kHz snap
 * (fine for RF dial tuning) would be far too coarse to usefully target one
 * signal out of a busy band. Pure function, unit-tested directly — see
 * test/scope-display.test.mjs.
 */
export function snapTo50Hz(hz) {
  return Math.round(hz / 50) * 50;
}

/**
 * Frequencies (in Hz) of every division-step-aligned tick within [lo, hi]
 * — e.g. every 50kHz-aligned point, not just 50kHz offsets from lo/hi
 * themselves, so ticks land on round numbers (14.100, 14.150, ...) rather
 * than on whatever the sweep happens to start at. Pure function,
 * unit-tested directly — see test/scope-display.test.mjs.
 */
export function scopeDivisions(lo, hi, stepHz = 50000) {
  if (lo == null || hi == null || hi <= lo || stepHz <= 0) return [];
  const divisions = [];
  const first = Math.ceil(lo / stepHz) * stepHz;
  for (let f = first; f <= hi + 1e-6; f += stepHz) {
    divisions.push(f);
  }
  return divisions;
}

export class ScopeDisplay {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.traceCanvas
   * @param {HTMLCanvasElement} opts.waterfallCanvas
   * @param {(info: {lo: number, hi: number, divisions: number[]}) => void} [opts.onRangeUpdate]
   * @param {(hz: number) => void} [opts.onFrequencyClick] - called with the
   *   frequency at the clicked x position, when the user clicks either canvas
   *   while the RF scope is showing (kHz-snapped, except while in RTTY mode
   *   — see setRttyMode() — or CW mode — see setCwMode() — where the exact
   *   clicked frequency is used unsnapped: RTTY's 170Hz mark/space shift and
   *   CW's much narrower bandwidth both make kHz-precision tuning too
   *   coarse to reliably land on a specific signal)
   * @param {(hz: number) => void} [opts.onAudioFrequencyClick] - called with
   *   the audio-offset frequency (50Hz-snapped) at the clicked x position,
   *   when the user clicks either canvas while the FT8 audio spectrum is
   *   showing (see pushAudioSpectrum()) — the audio-mode counterpart to
   *   onFrequencyClick, used to set the FT8 TX frequency rather than retune
   *   the radio's VFO.
   * @param {number} [opts.divisionStepHz=50000] - spacing of the gridline/axis divisions
   */
  constructor({
    traceCanvas,
    waterfallCanvas,
    onRangeUpdate,
    onFrequencyClick,
    onAudioFrequencyClick,
    divisionStepHz = 50000,
  }) {
    this.traceCanvas = traceCanvas;
    this.waterfallCanvas = waterfallCanvas;
    this.onRangeUpdate = onRangeUpdate || (() => {});
    this.onFrequencyClick = onFrequencyClick || (() => {});
    this.onAudioFrequencyClick = onAudioFrequencyClick || (() => {});
    this.divisionStepHz = divisionStepHz;
    this._traceCtx = traceCanvas.getContext('2d');
    this._waterfallCtx = waterfallCanvas.getContext('2d');
    this._lastPointCount = 0;
    this._tunedFreqHz = null;
    this._lastLo = null;
    this._lastHi = null;
    this._audioMode = false; // true after pushAudioSpectrum(), until the next pushLine() — see both methods
    this._qsoFreqHz = null; // set via setQsoFreq() — see that method's doc comment
    this._rttyMode = false; // set via setRttyMode() — see that method's doc comment
    this._cwMode = false; // set via setCwMode() — see that method's doc comment
    this._resizeForDpr();

    // A single, exact source of truth for "what frequency is under this
    // pointer event", shared by both the click handler and the hover
    // tooltip below, so the two can never disagree with each other (or
    // with what's actually drawn — frequencyAtFraction is the exact,
    // round-trip-tested inverse of the tuningMarkerX() used to place the
    // tuning marker and gridlines; see test/scope-display.test.mjs).
    const freqForEvent = (canvas, event) => {
      const rect = canvas.getBoundingClientRect();
      const xFraction = (event.clientX - rect.left) / rect.width;
      return frequencyAtFraction(xFraction, this._lastLo, this._lastHi);
    };

    const handleClick = (canvas) => (event) => {
      const hz = freqForEvent(canvas, event);
      if (hz == null) return;
      if (this._audioMode) {
        // Clicking the FT8 audio spectrum sets that (50Hz-snapped) audio
        // offset as the TX frequency for FT8 transmissions — the
        // audio-domain counterpart to click-to-tune below, since the
        // x-axis here is an offset within the passband, not an RF
        // frequency, so setFrequency()/onFrequencyClick would make no
        // sense against it.
        this.onAudioFrequencyClick(snapTo50Hz(hz));
        return;
      }
      if (this._rttyMode || this._cwMode) {
        // RTTY/CW: set the exact clicked frequency (rounded only to the
        // nearest whole Hz, which CI-V requires anyway) rather than
        // snapping to the nearest kHz. Precise sub-kHz placement matters
        // for both: RTTY's mark/space tones are only 170Hz apart, and a CW
        // signal's own bandwidth is narrower still, so a 1kHz snap could
        // put the tuned frequency further from the intended signal than
        // the signal itself is wide — unlike voice, where a "clean" kHz
        // dial reading (e.g. "7.100 MHz") is what operators actually want.
        this.onFrequencyClick(Math.round(hz));
        return;
      }
      // Set exactly the frequency under the pointer — snapped to the
      // nearest kHz (matching how operators think about RF tuning, e.g.
      // "7.100 MHz") — never an average with the previously-tuned
      // frequency or anything else derived from prior state.
      this.onFrequencyClick(snapToNearestKHz(hz));
    };
    this.traceCanvas.addEventListener('click', handleClick(this.traceCanvas));
    this.waterfallCanvas.addEventListener('click', handleClick(this.waterfallCanvas));

    // Hover tooltip: previews the exact frequency a click at the
    // pointer's current position would select — kHz-snapped MHz reading
    // on the RF scope, 50Hz-snapped audio-offset reading on the FT8
    // audio spectrum (see _showHoverTip()). A single tooltip element,
    // positioned with `position: fixed` directly from clientX/clientY, is
    // simplest and avoids any clipping from `.scope__canvases`'
    // `overflow: hidden`.
    this._hoverTipEl = document.createElement('div');
    this._hoverTipEl.className = 'scope__hover-tip';
    this._hoverTipEl.hidden = true;
    document.body.appendChild(this._hoverTipEl);

    const handleMove = (canvas) => (event) => {
      const hz = freqForEvent(canvas, event);
      if (hz == null) {
        this._hideHoverTip();
        return;
      }
      if (this._audioMode) {
        this._showHoverTip(snapTo50Hz(hz), event.clientX, event.clientY, true);
      } else if (this._rttyMode || this._cwMode) {
        // Preview the exact (unsnapped) frequency a click would select —
        // see handleClick's own RTTY/CW branch for why kHz-snapping is
        // skipped here.
        this._showHoverTip(Math.round(hz), event.clientX, event.clientY, false, true);
      } else {
        this._showHoverTip(snapToNearestKHz(hz), event.clientX, event.clientY, false);
      }
    };
    const handleLeave = () => this._hideHoverTip();
    this.traceCanvas.addEventListener('mousemove', handleMove(this.traceCanvas));
    this.waterfallCanvas.addEventListener('mousemove', handleMove(this.waterfallCanvas));
    this.traceCanvas.addEventListener('mouseleave', handleLeave);
    this.waterfallCanvas.addEventListener('mouseleave', handleLeave);
  }

  /**
   * @param {number} hz - already snapped/rounded by the caller
   *   (snapToNearestKHz for the RF scope outside RTTY mode, snapTo50Hz for
   *   the FT8 audio spectrum, or just Math.round()'d to the nearest Hz for
   *   the RF scope while in RTTY mode — see `precise` below)
   * @param {boolean} [audio=false] - true renders a plain Hz label (e.g.
   *   "1500 Hz", matching how FT8 operators refer to an audio offset
   *   within the passband); false renders the RF scope's "7.100 MHz" style
   * @param {boolean} [precise=false] - RF scope only (ignored when
   *   `audio` is true): shows enough decimal places to display the exact
   *   Hz value (e.g. "7.100170 MHz") rather than the usual kHz-rounded
   *   "7.100 MHz" — used while in RTTY mode, where clicks aren't
   *   kHz-snapped (see handleClick's RTTY branch above).
   */
  _showHoverTip(hz, clientX, clientY, audio = false, precise = false) {
    this._hoverTipEl.textContent = audio ? `${hz} Hz` : `${(hz / 1e6).toFixed(precise ? 6 : 3)} MHz`;
    // Offset up-and-right of the pointer so the tip itself, and the
    // finger/cursor, don't sit on top of the tooltip text.
    this._hoverTipEl.style.left = `${clientX + 12}px`;
    this._hoverTipEl.style.top = `${clientY - 12}px`;
    this._hoverTipEl.hidden = false;
  }

  _hideHoverTip() {
    this._hoverTipEl.hidden = true;
  }

  /** Call whenever the operating frequency changes so the tuning marker tracks it. */
  setTunedFrequency(hz) {
    this._tunedFreqHz = hz;
  }

  /**
   * Marks the audio frequency (Hz within the FT8 passband) of an
   * in-progress guided QSO — see src/client/ft8-qso.js and app.js — with
   * a distinct amber marker on the audio spectrum, the same way
   * `setTunedFrequency()`/`_drawTuningMarker()` mark the RF dial
   * frequency on the RF scope. Pass null to clear it (e.g. the QSO
   * completes or the operator leaves FT8 mode). Has no visible effect
   * outside audio mode (pushAudioSpectrum()) — there's no equivalent
   * concept on the RF scope.
   */
  setQsoFreq(hz) {
    this._qsoFreqHz = hz;
  }

  /**
   * Enables/disables the RTTY mark/space offset marker — a second dashed
   * line on the trace canvas, RTTY_SHIFT_HZ below the tuned frequency (see
   * _drawRttyOffsetMarker()), drawn alongside the existing green dashed
   * tuning marker. Blue, so the two are never visually ambiguous. Per
   * explicit request, this lives only on the trace canvas — nothing is
   * drawn into the waterfall itself. Only applies while `active` (RTTY
   * mode) — every other mode leaves the trace exactly as before.
   */
  setRttyMode(active) {
    this._rttyMode = active;
  }

  /**
   * Enables/disables exact (unsnapped) click-to-tune for CW mode — see the
   * constructor's `onFrequencyClick` doc comment and handleClick's
   * RTTY/CW branch above. Unlike setRttyMode(), CW gets no extra visual
   * marker of its own — this only changes the click/hover tuning
   * precision. Per explicit request.
   */
  setCwMode(active) {
    this._cwMode = active;
  }

  _resizeForDpr() {
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of [this.traceCanvas, this.waterfallCanvas]) {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }
  }

  /** @param {{mode:number, centerFreq?:number, span?:number, startFreq?:number, endFreq?:number, points:Uint8Array}} line */
  pushLine(line) {
    this._resizeForDpr();
    this._audioMode = false;

    // Real hardware confirms the radio's own "span" value (Center/Scroll-C
    // header field, same numeric value requested via `setScopeSpan()` —
    // see docs/civ-notes.md) is the width to *each side* of center, not the
    // total displayed width: a 100kHz span tuned to 7100kHz covers
    // 7.000-7.200MHz (±100kHz, 200kHz total), not 7.050-7.150MHz. An
    // earlier version divided by 2 here, on the (reasonable-looking, but
    // wrong per this on-air confirmation) assumption that "span" meant
    // total width the way it's labeled on the SPAN_OPTIONS buttons/slider.
    const lo = line.centerFreq != null ? line.centerFreq - line.span : line.startFreq;
    const hi = line.centerFreq != null ? line.centerFreq + line.span : line.endFreq;
    this._lastLo = lo;
    this._lastHi = hi;
    const divisions = scopeDivisions(lo, hi, this.divisionStepHz);
    this.onRangeUpdate({ lo, hi, divisions, audio: false });

    this._drawTrace(line.points, lo, hi, divisions);
    this._drawTuningMarker(lo, hi);
    if (this._rttyMode) {
      this._drawRttyOffsetMarker(lo, hi);
    }
    this._scrollWaterfall(line.points);
  }

  /**
   * Renders an FT8 audio-domain spectrum frame (see EVENT.FT8_SPECTRUM /
   * Ft8Bridge's spectrum plumbing server-side) in place of the RF scope
   * while FT8 mode is active — a real FFT of the actual RX audio,
   * matching WSJT-X's own FT8 spectrum/waterfall display far more
   * closely than cropping the radio's own coarse RF sweep ever could
   * (an earlier version of this display did exactly that crop; see
   * docs/ui-notes.md for why it was replaced). The x-axis here is audio
   * frequency (Hz above the dial, i.e. 0Hz = the dial frequency itself,
   * matching how USB demodulation already works), not an RF frequency —
   * `_audioMode` swaps the click/hover behavior accordingly (see the
   * click/move handlers in the constructor): clicking sets the FT8 TX
   * frequency (50Hz-snapped, marked with the same amber marker used for
   * an in-progress guided QSO — see setQsoFreq()/_drawQsoMarker()) rather
   * than retuning the radio's VFO, and no RF tuning marker is drawn
   * (there's no "tuned frequency" concept within the audio passband
   * itself).
   * @param {{binHz: number, bins: Uint8Array}} spectrum
   */
  pushAudioSpectrum({ binHz, bins }) {
    this._resizeForDpr();
    this._audioMode = true;

    const lo = 0;
    const hi = binHz * bins.length;
    this._lastLo = lo;
    this._lastHi = hi;
    // A fixed 1kHz division step regardless of divisionStepHz (which is
    // tuned for the RF scope's MHz-scale range) — see renderScopeAxis()
    // in app.js, which formats audio-mode ticks in whole Hz rather than
    // MHz, and 1kHz steps land exactly on that display's precision.
    const divisions = scopeDivisions(lo, hi, 1000);
    this.onRangeUpdate({ lo, hi, divisions, audio: true });

    this._drawTrace(bins, lo, hi, divisions);
    this._drawQsoMarker(lo, hi);
    this._scrollWaterfall(bins);
  }

  _drawTrace(points, lo, hi, divisions) {
    const ctx = this._traceCtx;
    const w = this.traceCanvas.width;
    const h = this.traceCanvas.height;
    ctx.clearRect(0, 0, w, h);
    this._drawGridlines(lo, hi, divisions);

    const n = points.length;
    if (n < 2) return; // nothing meaningful to plot as a line

    ctx.strokeStyle = '#4fd67a';
    ctx.lineWidth = Math.max(1, Math.round(w / 400));
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - (points[i] / 255) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /**
   * Faint vertical gridlines on the trace canvas at each division
   * frequency (e.g. every 50kHz), drawn behind the amplitude curve so the
   * curve stays legible on top. Matching text labels are rendered outside
   * the canvas, in the HTML axis strip below it (see app.js) — canvas
   * text at small sizes doesn't render as crisply as real DOM text, and
   * percentage-based CSS positioning naturally tracks the container's
   * rendered width without needing to duplicate the DPR-aware pixel math
   * here.
   */
  _drawGridlines(lo, hi, divisions) {
    if (!divisions || divisions.length === 0) return;
    const ctx = this._traceCtx;
    const w = this.traceCanvas.width;
    const h = this.traceCanvas.height;
    ctx.save();
    ctx.strokeStyle = '#2a2f35';
    ctx.lineWidth = 1;
    for (const freq of divisions) {
      const x = tuningMarkerX(freq, lo, hi, w);
      if (x == null) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Dashed vertical marker at the tuned frequency, drawn on the trace
   * canvas (on top of the amplitude curve) — the conventional place for
   * this in SDR/rig software (e.g. wfview's tuning line in its upper
   * plot). Not drawn on the waterfall: each waterfall row is a snapshot
   * from a different moment, so a single static column wouldn't
   * correctly represent where the radio was tuned at every past row.
   */
  _drawTuningMarker(lo, hi) {
    const w = this.traceCanvas.width;
    const h = this.traceCanvas.height;
    const x = tuningMarkerX(this._tunedFreqHz, lo, hi, w);
    if (x == null) return;

    const ctx = this._traceCtx;
    ctx.save();
    ctx.strokeStyle = '#4fd67a';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = Math.max(1, Math.round(w / 500));
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Dashed blue vertical marker, RTTY_SHIFT_HZ (170Hz, the standard
   * amateur mark/space shift) below the tuned frequency — drawn on the
   * trace canvas only, right alongside _drawTuningMarker()'s own green
   * dashed line, for exactly the same reason that marker is trace-only
   * (a waterfall row is a snapshot from a different moment, so a static
   * column there can't correctly represent every past row's tuned
   * frequency at once). Per explicit request: RTTY mode gets this second
   * marker instead of anything drawn into the waterfall itself. Only
   * called while `_rttyMode` is active (see pushLine()) — every other
   * mode leaves the trace exactly as before.
   */
  _drawRttyOffsetMarker(lo, hi) {
    const w = this.traceCanvas.width;
    const h = this.traceCanvas.height;
    const offsetFreqHz = this._tunedFreqHz != null ? this._tunedFreqHz - RTTY_SHIFT_HZ : null;
    const x = tuningMarkerX(offsetFreqHz, lo, hi, w);
    if (x == null) return;

    const ctx = this._traceCtx;
    ctx.save();
    ctx.strokeStyle = '#4fc3f7';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = Math.max(1, Math.round(w / 500));
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Dashed amber vertical marker at the in-progress guided QSO's tracked
   * frequency (see setQsoFreq()) — same drawing approach as
   * _drawTuningMarker() (dashed line on the trace canvas, on top of the
   * amplitude curve, not drawn on the waterfall since each waterfall row
   * is a different moment in time), but in the amber "active/in-progress"
   * color rather than the RF tuning marker's green, so the two are never
   * visually ambiguous with each other even though this app never shows
   * both at once (one is RF-mode-only, the other audio-mode-only).
   */
  _drawQsoMarker(lo, hi) {
    const w = this.traceCanvas.width;
    const h = this.traceCanvas.height;
    const x = tuningMarkerX(this._qsoFreqHz, lo, hi, w);
    if (x == null) return;

    const ctx = this._traceCtx;
    ctx.save();
    ctx.strokeStyle = '#e8a33d';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = Math.max(1, Math.round(w / 500));
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();
  }

  _scrollWaterfall(points) {
    const n = points.length;
    if (n < 1) return;

    const ctx = this._waterfallCtx;
    const w = this.waterfallCanvas.width;
    const h = this.waterfallCanvas.height;

    // Scroll existing content down by one row.
    if (h > 1) {
      ctx.drawImage(this.waterfallCanvas, 0, 0, w, h - 1, 0, 1, w, h - 1);
    }

    // Draw the new line as row 0, resampling points -> pixel columns.
    const rowImage = ctx.createImageData(w, 1);
    for (let x = 0; x < w; x++) {
      const sampleIndex = Math.min(n - 1, Math.floor((x / w) * n));
      const [r, g, b] = amplitudeToColor(points[sampleIndex]);
      const offset = x * 4;
      rowImage.data[offset] = r;
      rowImage.data[offset + 1] = g;
      rowImage.data[offset + 2] = b;
      rowImage.data[offset + 3] = 255;
    }
    // RTTY's mark/space offset marker lives on the trace canvas only (see
    // _drawRttyOffsetMarker(), called from pushLine() alongside
    // _drawTuningMarker()) — not baked into waterfall rows here. A
    // waterfall row is a snapshot from a different moment than the one
    // before it, which is exactly why _drawTuningMarker() itself is
    // trace-only too; the offset marker follows that same reasoning rather
    // than being a special case.
    ctx.putImageData(rowImage, 0, 0);
  }
}
