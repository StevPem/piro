'use strict';

const { EventEmitter } = require('events');

/**
 * FT8 (and FT4, if added later) transmissions are aligned to fixed-length
 * UTC time slots (15s for FT8), not free-running like CW or voice — every
 * station on the band starts transmitting at the same wall-clock instant
 * (:00/:15/:30/:45 for FT8), which is what lets receivers find and decode
 * multiple overlapping signals at all. This module is the shared "when is
 * the next boundary" logic, kept as pure, easily-testable functions
 * (`currentSlotStart`/`nextSlotStart`/`msUntilNextSlot`) separate from the
 * `SlotClock` EventEmitter that actually schedules real timers against
 * them — so the boundary arithmetic can be tested exhaustively without
 * ever waiting on a real 15-second timer.
 */

/** The start (epoch ms) of the slot containing `nowMs`. */
function currentSlotStart(nowMs, slotMs) {
  return nowMs - (((nowMs % slotMs) + slotMs) % slotMs);
}

/** The start (epoch ms) of the *next* slot boundary strictly after `nowMs`. */
function nextSlotStart(nowMs, slotMs) {
  return currentSlotStart(nowMs, slotMs) + slotMs;
}

/** Milliseconds from `nowMs` until the next slot boundary. */
function msUntilNextSlot(nowMs, slotMs) {
  return nextSlotStart(nowMs, slotMs) - nowMs;
}

/**
 * Fires a 'boundary' event at every slot edge, each carrying the epoch ms
 * of the slot that just *started* (equivalently: the slot that just
 * *ended* is the one immediately before it) — a listener doing RX uses
 * this to know "the previous slot's audio buffer is complete, decode it
 * now and start a fresh buffer"; a listener doing TX uses it to know
 * "this is a legal moment to key up and start playing a waveform".
 *
 * Deliberately re-arms against the wall clock on every fire (computing a
 * fresh delay to the *next* boundary) rather than chaining fixed
 * `slotMs`-length timers, since `setTimeout` delays drift under load and
 * chained fixed delays would accumulate that drift slot after slot —
 * this instead self-corrects back to the true UTC grid every 15 seconds.
 *
 * `now`/`setTimer`/`clearTimer` are injectable so tests can drive this
 * deterministically without real waiting; they default to the real
 * `Date.now`/`setTimeout`/`clearTimeout`.
 */
class SlotClock extends EventEmitter {
  constructor({ slotMs = 15000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    if (!(slotMs > 0)) throw new Error('SlotClock requires a positive slotMs');
    this.slotMs = slotMs;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._timer = null;
    this._running = false;
  }

  get running() {
    return this._running;
  }

  currentSlotStart(nowMs = this._now()) {
    return currentSlotStart(nowMs, this.slotMs);
  }

  nextSlotStart(nowMs = this._now()) {
    return nextSlotStart(nowMs, this.slotMs);
  }

  msUntilNextSlot(nowMs = this._now()) {
    return msUntilNextSlot(nowMs, this.slotMs);
  }

  /**
   * Switches the slot grid at runtime (e.g. FT8's 15000ms <-> FT4's
   * 7500ms — see ft8-bridge.js's setVariant()). If the clock is currently
   * running, re-arms immediately against the new grid rather than waiting
   * out whatever delay was already scheduled against the old slotMs, so a
   * switch takes effect on the very next UTC boundary of the *new* grid
   * instead of up to one old-slot-length late.
   */
  setSlotMs(slotMs) {
    if (!(slotMs > 0)) throw new Error('setSlotMs requires a positive slotMs');
    this.slotMs = slotMs;
    if (this._running) {
      if (this._timer !== null) {
        this._clearTimer(this._timer);
        this._timer = null;
      }
      this._armNext();
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._armNext();
  }

  stop() {
    this._running = false;
    if (this._timer !== null) {
      this._clearTimer(this._timer);
      this._timer = null;
    }
  }

  _armNext() {
    const delay = this.msUntilNextSlot();
    this._timer = this._setTimer(() => {
      if (!this._running) return;
      const slotStartMs = this.currentSlotStart();
      this.emit('boundary', { slotStartMs, slotMs: this.slotMs });
      this._armNext();
    }, delay);
  }
}

module.exports = { SlotClock, currentSlotStart, nextSlotStart, msUntilNextSlot };
