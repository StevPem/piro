'use strict';

const { refreshTransmitting } = require('./tx-safety');
const { EVENT } = require('./protocol');

/**
 * The CW paddle (Dot/Dash buttons), timed at the radio's end.
 *
 * Before, each dot or dash was a PTT on and a PTT off sent from the
 * browser, each waiting for the reply before the next step. Every element
 * and every gap on air was then one network round trip longer than keyed:
 * at 20 WPM over a 100 ms mobile link a dot came out 160 ms (2.7 units)
 * and the gaps 160 ms, so letters were misread, not just sloppy.
 *
 * Now the browser runs the iambic keyer and sends each element as it
 * starts, as {session, t, d}: t is when it starts (ms since the browser's
 * keying session began, from the keyer's own schedule) and d how long the
 * key is down. This bridge holds the elements for `delayMs` and replays
 * them on the Pi's clock, so every element and gap keeps the length keyed;
 * the whole sending is just `delayMs` (plus the one-way network time)
 * late. The network delay itself can't be taken away; for CW a steady
 * delay does no harm, an uneven one does. An element that arrives after
 * its slot (a network stall longer than delayMs) moves the rest of the
 * session later rather than being squashed.
 *
 * Keying, by `keyLine`:
 * - 'dtr' or 'rts': the USB serial port's control line, with the radio's
 *   Menu > Set > Connectors > USB SEND/Keying > USB Keying (CW) set to the
 *   same line. The line is set directly (CivDriver#setKeyLine), not
 *   through the CI-V queue, so its timing is the Pi's. The radio only
 *   transmits on the key with break-in on, so semi break-in is turned on
 *   for the session and put back after it (like the CW text sender).
 * - null: CI-V PTT on and off per element (1C 00), as the paddle always
 *   did, now timed on the Pi. Each command takes a few ms on the serial
 *   link and can wait for a reply already due, so this is less exact.
 *
 * Safety: one browser keys at a time; the key goes up as soon as that
 * browser disconnects (pending elements are dropped), on stop() and when
 * the session ends. An element may be at most MAX_ELEMENT_MS long, so a
 * stuck paddle can't hold the key down; a session (elements no more than
 * SESSION_IDLE_MS apart) is stopped after SESSION_MAX_MS, the 10-minute
 * limit for remote operation (keying the line is a transmission without
 * PTT, so the PTT watchdog doesn't see it).
 *
 * Not tested on air.
 */

const DEFAULT_DELAY_MS = 250;
const MIN_ELEMENT_MS = 10;
const MAX_ELEMENT_MS = 1500; // a dash at 5 WPM is 720 ms
const MAX_AHEAD_MS = 10 * 1000; // an element may not be scheduled further ahead than this
const SESSION_IDLE_MS = 5000; // a session ends this long after its last element
const SESSION_MAX_MS = 10 * 60 * 1000;
const LATE_MARGIN_MS = 5; // a late element is rescheduled this far ahead of now

class CwPaddleBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {'dtr'|'rts'|null} [opts.keyLine] - key with this serial line; null keys with CI-V PTT
   * @param {number} [opts.delayMs=250] - how long elements are held before they are replayed
   * @param {() => number} [opts.now] - ms clock (tests)
   * @param {Function} [opts.setTimer] / [opts.clearTimer] - (tests)
   */
  constructor({
    controlServer,
    keyLine = null,
    delayMs = DEFAULT_DELAY_MS,
    now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    sessionIdleMs = SESSION_IDLE_MS,
    sessionMaxMs = SESSION_MAX_MS,
  } = {}) {
    if (!controlServer) throw new Error('CwPaddleBridge requires opts.controlServer');
    if (keyLine !== null && keyLine !== 'dtr' && keyLine !== 'rts') throw new Error(`keyLine must be 'dtr', 'rts' or null, not ${keyLine}`);
    this.controlServer = controlServer;
    this.keyLine = keyLine;
    this.delayMs = delayMs;
    this.now = now ?? (() => performance.now());
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sessionIdleMs = sessionIdleMs;
    this.sessionMaxMs = sessionMaxMs;
    this._s = null; // the session: {ws, id, offset, lastT, lastEndAt, startedAt, timers, ready, restore, keyDown, ended}
    this._onClientGone = (ws) => {
      if (this._s && this._s.ws === ws) this._end('browser disconnected');
    };
  }

  start() {
    this.controlServer.on('client-disconnected', this._onClientGone);
    this.controlServer.cwPaddle = this;
  }

  stop() {
    this.controlServer.off('client-disconnected', this._onClientGone);
    if (this.controlServer.cwPaddle === this) this.controlServer.cwPaddle = null;
    if (this._s) this._end('stopped');
  }

  /** Whether a keying session is under way. */
  get active() {
    return this._s !== null;
  }

  /**
   * One element from a browser (REQUEST.CW_KEY). Throws (the browser is
   * told) if it can't be keyed. Returns {delayMs, lateMs}: lateMs > 0 when
   * the element arrived after its slot and the session was moved later.
   */
  key(ws, { session, t, d } = {}) {
    if (typeof session !== 'string' || !session || session.length > 64) throw new Error('"session" must be a short string');
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw new Error('"t" must be a time in ms from the start of the session');
    if (typeof d !== 'number' || !Number.isFinite(d) || d < MIN_ELEMENT_MS || d > MAX_ELEMENT_MS) {
      throw new Error(`"d" must be a key-down time from ${MIN_ELEMENT_MS} to ${MAX_ELEMENT_MS} ms`);
    }
    const now = this.now();
    let s = this._s;
    if (s && s.ws !== ws) throw new Error('Someone else is keying the radio.');
    if (s && s.id !== session) {
      this._end('new session');
      s = null;
    }
    if (!s) s = this._begin(ws, session, t, now);
    if (t < s.lastT) throw new Error('Elements must come in order.');
    if (now - s.startedAt > this.sessionMaxMs) {
      this._end('10-minute limit', 'CW keying stopped after 10 minutes (the limit for remote operation).');
      throw new Error('CW keying stopped after 10 minutes.');
    }

    let at = s.offset + t;
    let lateMs = 0;
    if (at < now + LATE_MARGIN_MS) {
      // A stall longer than the delay: move this and everything after it later.
      lateMs = now + LATE_MARGIN_MS - at;
      s.offset += lateMs;
      at += lateMs;
    }
    if (at - now > MAX_AHEAD_MS) throw new Error('That element is too far ahead.');
    // Never overlap the previous element (a gap of at least 1 ms).
    if (at < s.lastEndAt + 1) at = s.lastEndAt + 1;
    s.lastT = t;
    s.lastEndAt = at + d;
    this._schedule(s, at - now, true);
    this._schedule(s, at + d - now, false);
    this._armIdle(s, at + d + this.sessionIdleMs - now);
    return { delayMs: this.delayMs, lateMs: Math.round(lateMs) };
  }

  _begin(ws, id, t, now) {
    const cs = this.controlServer;
    const mode = cs.state?.mode?.mode;
    if (mode !== 'CW' && mode !== 'CW_R' && mode !== 'CW-R') throw new Error('Put the radio in CW first.');
    if (cs.state?.ptt) throw new Error('The radio is already transmitting.');
    if (cs.cwTxBusy?.()) throw new Error('CW text is being sent.');
    const s = {
      ws,
      id,
      offset: now + this.delayMs - t,
      lastT: t,
      lastEndAt: -Infinity,
      startedAt: now,
      timers: new Set(),
      idle: null,
      keyDown: false,
      ended: false,
      restore: null,
    };
    // Break-in, needed for the key line to transmit: checked and set in the
    // delay window, before the first element is due.
    s.ready = this.keyLine ? this._ensureBreakIn(s) : Promise.resolve();
    this._s = s;
    cs.state.cwKeying = true;
    cs.broadcastJsonEvent(EVENT.CW_KEYING, { active: true });
    refreshTransmitting(cs); // settings can't be changed while the paddle keys
    return s;
  }

  async _ensureBreakIn(s) {
    const civ = this.controlServer.civ;
    try {
      const prev = await civ.getBreakIn();
      if (prev !== 1 && prev !== 2) {
        await civ.setBreakIn(1);
        s.restore = prev;
      }
    } catch (err) {
      console.error('[cw-paddle] could not check or set break-in:', err.message);
    }
  }

  _schedule(s, inMs, down) {
    const timer = this.setTimer(() => {
      s.timers.delete(timer);
      if (!s.ended) this._setKey(s, down);
    }, Math.max(0, inMs));
    s.timers.add(timer);
  }

  _armIdle(s, inMs) {
    if (s.idle) this.clearTimer(s.idle);
    s.idle = this.setTimer(() => {
      s.idle = null;
      if (this._s === s) this._end('idle');
    }, Math.max(0, inMs));
  }

  _setKey(s, down) {
    s.keyDown = down;
    const cs = this.controlServer;
    const fail = (err) => {
      console.error(`[cw-paddle] keying ${down ? 'down' : 'up'} failed: ${err.message}`);
      if (down && this._s === s) this._end('error', `CW keying stopped: ${err.message}`);
    };
    if (this.keyLine) {
      // Break-in is set (or failed) before the first element is due; if the
      // radio was slow, wait for it rather than key without it.
      s.ready.then(() => (s.ended && down ? null : cs.civ.setKeyLine(this.keyLine, down))).catch(fail);
    } else {
      cs.setPttFromServer(down, { urgent: true }).catch(fail);
    }
  }

  /** Ends the session: key up at once, drop what's pending, put break-in back. */
  _end(why, message) {
    const s = this._s;
    if (!s) return;
    this._s = null;
    s.ended = true;
    for (const t of s.timers) this.clearTimer(t);
    s.timers.clear();
    if (s.idle) this.clearTimer(s.idle);
    const cs = this.controlServer;
    const civ = cs.civ;
    if (this.keyLine) {
      // Always drop the line, whatever we think its state is.
      Promise.resolve(civ.setKeyLine(this.keyLine, false))
        .catch((err) => console.error('[cw-paddle] key up failed:', err.message))
        .then(() => s.ready)
        .then(() => (s.restore != null ? civ.setBreakIn(s.restore) : null))
        .catch((err) => console.error('[cw-paddle] could not put break-in back:', err.message));
    } else if (s.keyDown || cs.state?.ptt) {
      cs.setPttFromServer(false, { urgent: true }).catch((err) => console.error('[cw-paddle] key up failed:', err.message));
    }
    cs.state.cwKeying = false;
    refreshTransmitting(cs);
    cs.broadcastJsonEvent(EVENT.CW_KEYING, { active: false, reason: why, ...(message ? { message } : {}) });
  }
}

module.exports = { CwPaddleBridge, DEFAULT_DELAY_MS, MAX_ELEMENT_MS, SESSION_IDLE_MS, SESSION_MAX_MS };
