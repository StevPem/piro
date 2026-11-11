'use strict';

const { refreshTransmitting, holdReceiveConfirmation, confirmReceive,
  restoreWhenReceiving, settingStillIs } = require('./tx-safety');
const { EVENT } = require('./protocol');
const { MORSE_TABLE } = require('../audio/cw-decoder');

// What the radio's keyer (CI-V 17) can send. "^" joins the next two
// characters into one prosign, as on Icom's own keyer memories (^AR, ^SK).
const SENDABLE = /[A-Z0-9/?.,:'()=+"@ ^-]/;
const MAX_CHARS = 300;
const CHUNK_CHARS = 30; // the most the radio takes per CI-V 17 command
const MAX_SECONDS = 9 * 60; // under the 10-minute limit for remote operation (see ws-server.js's PTT watchdog)
const BUSY_RETRY_MS = 250; // the radio's buffer was full: try again after this
const LEAD_SEC = 3; // hand the radio the next piece this long before it runs out
const TX_END_QUIET_MS = 800; // the radio counts as finished once it has been back on receive this long
const TX_END_MAX_WAIT_MS = 15000; // ...or after this much longer than the estimate, whatever it says

// Thrown by send()'s setup when Stop was pressed meanwhile (issue #79), so
// the catch can tell it from a radio error.
const ABORTED = Symbol('CW text aborted');

const MORSE = Object.fromEntries(Object.entries(MORSE_TABLE).map(([code, ch]) => [ch, code]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The text as the radio's keyer will send it: capitals, unsendable characters dropped, spaces tidied. */
function cleanCwText(text) {
  const upper = String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const dropped = new Set();
  let out = '';
  for (const ch of upper) {
    if (SENDABLE.test(ch)) out += ch;
    else dropped.add(ch);
  }
  return { text: out.replace(/ {2,}/g, ' ').trim(), dropped: [...dropped] };
}

/**
 * Seconds the keyer takes for `text` at `wpm` (PARIS timing: a dot is
 * 1.2 / wpm seconds; dash 3, gaps 1 within a letter, 3 between letters, 7
 * between words). Characters with no code here are counted as 10 units.
 */
function cwSeconds(text, wpm) {
  let units = 0;
  const words = text.split(' ').filter(Boolean);
  words.forEach((word, wi) => {
    if (wi > 0) units += 7;
    let joined = 0;
    [...word].forEach((ch, ci) => {
      if (ch === '^') {
        joined = 2;
        return;
      }
      const code = MORSE[ch];
      units += code ? [...code].reduce((n, el) => n + (el === '-' ? 3 : 1), 0) + (code.length - 1) : 10;
      const last = ci === word.length - 1;
      if (!last) units += joined === 2 ? 1 : 3; // inside a prosign the letters run together
      if (joined) joined--;
    });
  });
  return (units * 1.2) / Math.max(6, Math.min(48, wpm));
}

/** Splits text into pieces of at most 30 characters, at spaces where it can. */
function cwChunks(text, size = CHUNK_CHARS) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut <= 0) cut = size;
    out.push(rest.slice(0, cut + (rest[cut] === ' ' ? 1 : 0)));
    rest = rest.slice(cut + (rest[cut] === ' ' ? 1 : 0));
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Sends typed text as CW with the radio's own keyer (CI-V 17), the CW
 * mode's Send button. Receives `cw-send` {text, wpm} and `cw-abort` from the
 * ControlServer. The radio does the keying, so the timing is the keyer's
 * own, not the CI-V round trip the DOT/DASH paddle depends on.
 *
 * For each message: refuse unless the radio is in CW (or CW-R); set the
 * keyer to the requested speed; turn semi break-in on if it was off (the
 * radio only transmits CI-V CW with break-in on); hand over the text 30
 * characters at a time, retrying while the radio's buffer is full; wait
 * until the radio has finished transmitting; put the speed and break-in
 * back. Stop drops what's left (CI-V 17 FF).
 *
 * Status is broadcast as EVENT.CW_TX_STATUS:
 *   {status: 'sending' | 'sent' | 'aborted' | 'error', text?, wpm?, durationSec?, dropped?, error?}
 */
class CwTxBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {(text: string, wpm: number) => number} [opts.estimateSeconds] - injectable for testing
   * @param {number} [opts.leadSec]
   * @param {number} [opts.txEndQuietMs]
   */
  constructor({ controlServer, estimateSeconds = cwSeconds, leadSec = LEAD_SEC, txEndQuietMs = TX_END_QUIET_MS, txEndMaxWaitMs = TX_END_MAX_WAIT_MS } = {}) {
    if (!controlServer) throw new Error('CwTxBridge requires opts.controlServer');
    this.controlServer = controlServer;
    this.estimateSeconds = estimateSeconds;
    this.leadSec = leadSec;
    this.txEndQuietMs = txEndQuietMs;
    this.txEndMaxWaitMs = txEndMaxWaitMs;
    this._tx = null;
    this._recovery = null;
    this._stopped = false;
    this._onSend = (req) => this.send(req).catch(() => {});
    this._onAbort = () => this.abort();
    this._onClientJoined = (ws) => {
      const status = this.controlServer.state.cwTx;
      if (status) this.controlServer.sendJsonEvent?.(ws, EVENT.CW_TX_STATUS, status);
    };
    // Nobody left to press Stop.
    this._onClientGone = () => {
      if (this.transmitting && this.controlServer.clients && this.controlServer.clients.size === 0) this.abort();
    };
  }

  start() {
    this._stopped = false;
    this.controlServer.on('cw-send', this._onSend);
    this.controlServer.on('cw-abort', this._onAbort);
    this.controlServer.on('client-connected', this._onClientJoined);
    this.controlServer.on('client-disconnected', this._onClientGone);
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._recovery?.timer);
    this.controlServer.off('cw-send', this._onSend);
    this.controlServer.off('cw-abort', this._onAbort);
    this.controlServer.off('client-connected', this._onClientJoined);
    this.controlServer.off('client-disconnected', this._onClientGone);
    if (this.transmitting) this.abort();
  }

  get transmitting() {
    return this._tx !== null || this._recovery !== null;
  }

  _status(data) {
    const status = { ...data, transmitting: this.transmitting };
    this.controlServer.state.cwTx = status;
    this.controlServer.broadcastJsonEvent(EVENT.CW_TX_STATUS, status);
  }

  /** Sleeps, but wakes early if the transmission is stopped. */
  _wait(tx, ms) {
    if (tx.aborted || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        tx.wakers.delete(done);
        resolve();
      }
      tx.wakers.add(done);
    });
  }

  async send({ text, wpm } = {}) {
    const fail = (error) => {
      this._status({ status: 'error', error });
      return Promise.reject(new Error(error));
    };
    const civ = this.controlServer.civ;
    if (this.transmitting) return fail('Already sending CW, or waiting for the radio to confirm it has stopped.');
    if (this.controlServer.state?.ptt) return fail('The radio is already transmitting.');
    if (this.controlServer.state?.cwKeying) return fail('The CW paddle is keying.');
    if (this.controlServer.transmitting) return fail('The radio may still be transmitting.');
    if (!civ || typeof civ.sendCw !== 'function') return fail("This radio can't be sent CW text.");
    const { text: clean, dropped } = cleanCwText(text);
    if (!clean) return fail('Nothing to send.');
    if (clean.length > MAX_CHARS) return fail(`At most ${MAX_CHARS} characters at a time.`);
    const speed = Math.max(6, Math.min(48, Math.round(Number(wpm) || 20)));
    const durationSec = this.estimateSeconds(clean, speed);
    if (durationSec > MAX_SECONDS) return fail(`That would take ${Math.ceil(durationSec / 60)} minutes at ${speed} WPM; send it in parts.`);

    const tx = { aborted: false, wakers: new Set() };
    this._tx = tx;
    holdReceiveConfirmation(this.controlServer, tx);
    refreshTransmitting(this.controlServer); // the radio's keyer is about to send: settings can't be changed meanwhile
    // After each awaited step: stop before changing anything once Stop was pressed.
    const step = () => {
      if (tx.aborted) throw ABORTED;
    };
    let prevSpeed = null;
    let prevBreakIn = null;
    let changedSpeed = false;
    let changedBreakIn = false;
    let started = false; // the keyer has been given some text
    let failure = null;
    let completed = false;
    const info = { text: clean, wpm: speed, durationSec };
    if (dropped.length) info.dropped = dropped;
    try {
      const mode = (await civ.getMode()).mode;
      step();
      if (mode !== 'CW' && mode !== 'CW-R') throw new Error('Put the radio in CW first.');
      prevSpeed = await civ.getKeySpeed().catch(() => null);
      step();
      prevBreakIn = await civ.getBreakIn().catch(() => null);
      step();
      if (prevSpeed !== speed) {
        changedSpeed = true; // before the write: if it lands, it is put back
        await civ.setKeySpeed(speed);
        step();
      }
      if (prevBreakIn !== 1 && prevBreakIn !== 2) {
        changedBreakIn = true;
        await civ.setBreakIn(1);
        step();
      }
      this._status({ status: 'sending', ...info, startTime: Date.now() });

      // Hand the radio the text a piece at a time, a few seconds before it
      // runs out; if its buffer is still full, it says NG: wait and retry.
      const t0 = Date.now();
      let queuedSec = 0;
      for (const chunk of cwChunks(clean)) {
        await this._wait(tx, (queuedSec - this.leadSec) * 1000 - (Date.now() - t0));
        started = true;
        while (!tx.aborted && !(await civ.sendCw(chunk))) await this._wait(tx, BUSY_RETRY_MS);
        if (tx.aborted) break;
        queuedSec = Math.max(queuedSec, (Date.now() - t0) / 1000) + this.estimateSeconds(chunk.trim(), speed);
      }
      // Then until it has all gone out: the estimate, then until the radio is back on receive.
      await this._wait(tx, queuedSec * 1000 - (Date.now() - t0));
      // "sent" only once the radio has reported receive for txEndQuietMs (issue #78).
      completed = !tx.aborted && await this._confirmReceive(tx, civ);
    } catch (err) {
      failure = err;
    }

    let confirmed = !started || completed;
    if (started && !completed) {
      await this._stopKeyer(tx, civ);
      // An ACK to STOP is not proof of receive. Stop, errors and abort all
      // use the same read-back check, including when STOP was rejected.
      confirmed = await this._confirmReceive(tx, civ, true);
    }
    if (confirmed) await confirmReceive(this.controlServer, tx);
    else this._recovery = { tx, civ, info, quietSince: null, timer: null };
    try {
      await restoreWhenReceiving(this.controlServer, ({ held }) => this._restore(civ,
        { changedSpeed, prevSpeed, changedBreakIn, prevBreakIn, speed }, held));
    } catch (err) {
      failure ||= err;
    }
    this._done();
    if (!confirmed) {
      this._pollRecovery(this._recovery);
      this._status({ status: 'error', ...info, error: "CW stop not confirmed: the radio may still be transmitting. Settings are held until receive is confirmed. Check the radio." });
    } else if (failure && failure !== ABORTED) {
      this._status({ status: 'error', ...info, error: failure.message });
    } else if (tx.aborted || failure === ABORTED) {
      this._status({ status: 'aborted', ...info });
    } else if (!completed) {
      this._status({ status: 'error', ...info, error: "The radio didn't finish sending in time; the keyer was stopped and receive confirmed." });
    } else this._status({ status: 'sent', ...info });
    if (failure && failure !== ABORTED) throw failure;
  }

  _done() {
    this._tx = null;
    refreshTransmitting(this.controlServer);
  }

  /**
   * Whether the radio reported receive (transmit state false) continuously
   * for txEndQuietMs before TX_END_MAX_WAIT_MS ran out. A read that fails,
   * or anything but a plain false, doesn't count as receive.
   */
  async _confirmReceive(tx, civ, afterStop = false) {
    const until = Date.now() + this.txEndMaxWaitMs;
    let quietSince = null;
    while ((afterStop || !tx.aborted) && Date.now() < until) {
      let on;
      try {
        on = await civ.getTransmitting();
      } catch {
        on = null; // not known: not receive
      }
      if (on === false) {
        if (quietSince === null) quietSince = Date.now();
        else if (Date.now() - quietSince >= this.txEndQuietMs) return true;
      } else {
        quietSince = null;
      }
      if (afterStop) await new Promise((resolve) => setTimeout(resolve, 150));
      else await this._wait(tx, 150);
    }
    return false;
  }

  async _restore(civ, { changedSpeed, prevSpeed, changedBreakIn, prevBreakIn, speed }, held) {
    if (changedBreakIn && prevBreakIn != null && (!held || await settingStillIs(() => civ.getBreakIn(), 1))) await civ.setBreakIn(prevBreakIn);
    if (changedSpeed && prevSpeed != null && (!held || await settingStillIs(() => civ.getKeySpeed(), speed))) await civ.setKeySpeed(prevSpeed);
  }

  _stopKeyer(tx, civ) {
    tx.stopPromise ||= Promise.resolve().then(() => civ.stopCw()).catch(() => {});
    return tx.stopPromise;
  }

  async _pollRecovery(recovery) {
    if (this._stopped || this._recovery !== recovery) return;
    let on;
    try { on = await recovery.civ.getTransmitting(); } catch { on = null; }
    if (this._stopped || this._recovery !== recovery) return;
    if (on === false) {
      recovery.quietSince ??= Date.now();
      if (Date.now() - recovery.quietSince >= this.txEndQuietMs) {
        await confirmReceive(this.controlServer, recovery.tx);
        this._recovery = null;
        refreshTransmitting(this.controlServer);
        this._status({ status: 'error', ...recovery.info,
          error: 'The CW stop was not confirmed at first. Receive is now confirmed.' });
        return;
      }
    } else recovery.quietSince = null;
    recovery.timer = setTimeout(() => this._pollRecovery(recovery), 250);
    recovery.timer.unref?.();
  }

  /** Stops the CW being sent: the radio drops the rest, and the speed and break-in are put back. */
  abort() {
    const tx = this._tx || this._recovery?.tx;
    if (this._recovery && tx) {
      // A later Stop can retry a rejected command without dropping the guard.
      tx.stopPromise = null;
      this._stopKeyer(tx, this.controlServer.civ);
      return;
    }
    if (!tx || tx.aborted) return;
    tx.aborted = true;
    for (const wake of [...tx.wakers]) wake();
    // Stop the keyer straight away rather than when send() next looks.
    this._stopKeyer(tx, this.controlServer.civ);
  }
}

module.exports = { CwTxBridge, cleanCwText, cwSeconds, cwChunks, CW_MAX_CHARS: MAX_CHARS };
