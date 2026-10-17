'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { EVENT } = require('./protocol');
const { MODES, videoSeconds } = require('../audio/sstv-modes');
const { encodePng } = require('./png');

const DEFAULT_SSTV_TX_MODE = 'S1';
const PTT_RELEASE_MARGIN_MS = 300; // as tty-bridge.js: let the last of the audio leave the pipe
const DEFAULT_TX_AMPLITUDE = 1.0;

/** Seconds an SSTV transmission takes: VIS header, picture, FSK ID, pause and CW ID. */
function sstvTxSeconds(mode, callsign, { fskId = true, cwId = true, cwWpm = 20 } = {}) {
  let s = 0.91 + videoSeconds(mode);
  const call = String(callsign || '').trim().toUpperCase();
  if (call && fskId) s += (Math.min(10, call.length) + 3) * 6 * 0.022;
  if (call && cwId) {
    // "DE <call>" at PARIS timing: count dot units
    const { cwSegments } = require('../audio/sstv-tx');
    s += 0.3 + cwSegments(`DE ${call}`, { wpm: cwWpm }).reduce((n, sg) => n + sg[2], 0);
  }
  return s;
}

/** Runs the encoder in a worker thread; resolves with { pcm: Buffer, durationSec }. */
function encodeInWorker(job) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, '..', 'audio', 'sstv-encode-worker.js'), { workerData: job });
    w.once('message', (m) => {
      w.terminate();
      if (m.error) reject(new Error(m.error));
      else resolve({ pcm: Buffer.from(m.pcm), durationSec: m.durationSec });
    });
    w.once('error', reject);
  });
}

/**
 * SSTV transmit. Receives `sstv-send` / `sstv-abort` events from the
 * ControlServer (the SSTV panel's Send / Stop), encodes the picture in the
 * configured mode (SSTV_TX_MODE, Scottie 1 by default) followed by the FSK ID
 * and a CW ID with the station's callsign, then sends it as audio the way
 * the RTTY transmitter does: DATA MODE on (so the radio takes USB audio),
 * optionally a lower TX power (SSTV is a full-power tone for minutes), PTT,
 * play, PTT off, everything put back. The sent picture is added to the
 * recent pictures as the station's own.
 *
 * Status is broadcast as EVENT.SSTV_TX_STATUS:
 *   {status: 'encoding' | 'sending' | 'sent' | 'aborted' | 'error', mode, name, durationSec?, error?}
 */
class SstvTxBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {string} [opts.mode='S1'] - SSTV mode id (src/audio/sstv-modes.js)
   * @param {string} [opts.callsign] - for the FSK ID and CW ID
   * @param {boolean} [opts.fskId=true]
   * @param {boolean} [opts.cwId=true]
   * @param {number} [opts.txPowerW] - TX power while sending (restored after); unset leaves it alone
   * @param {number} [opts.pttReleaseMarginMs]
   * @param {number} [opts.amplitude]
   * @param {(job: object) => Promise<{pcm: Buffer, durationSec: number}>} [opts.encode] - injectable for testing
   * @param {() => number} [opts.now]
   */
  constructor({ controlServer, audioBridge, mode = DEFAULT_SSTV_TX_MODE, callsign, fskId = true, cwId = true, txPowerW, pttReleaseMarginMs, amplitude, encode, now } = {}) {
    if (!controlServer) throw new Error('SstvTxBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('SstvTxBridge requires opts.audioBridge');
    if (!MODES[mode]) throw new Error(`Unknown SSTV mode "${mode}"`);
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.mode = mode;
    this.callsign = callsign || '';
    this.fskId = fskId !== false;
    this.cwId = cwId !== false;
    this.txPowerW = Number.isFinite(txPowerW) && txPowerW > 0 ? txPowerW : null;
    this.pttReleaseMarginMs = pttReleaseMarginMs ?? PTT_RELEASE_MARGIN_MS;
    this.amplitude = amplitude ?? DEFAULT_TX_AMPLITUDE;
    this.encode = encode ?? encodeInWorker;
    this.now = now ?? Date.now;
    this._tx = null;
    this._picId = 0x8000; // own pictures, apart from received ones
    const m = MODES[mode];
    // What the client needs to prepare a picture (sent in the connect snapshot)
    controlServer.state.sstvTx = {
      mode,
      name: m.name,
      width: m.width,
      lines: m.lines,
      lineHeight: m.lineHeight,
      durationSec: Math.round(sstvTxSeconds(mode, this.callsign, { fskId: this.fskId, cwId: this.cwId }) * 10) / 10,
      fskId: this.fskId && !!this.callsign,
      cwId: this.cwId && !!this.callsign,
    };
    this._onSend = (req) => this.send(req).catch(() => {});
    this._onAbort = () => this.abort();
  }

  start() {
    this.controlServer.on('sstv-send', this._onSend);
    this.controlServer.on('sstv-abort', this._onAbort);
  }

  stop() {
    this.controlServer.off('sstv-send', this._onSend);
    this.controlServer.off('sstv-abort', this._onAbort);
    if (this._tx) this.abort();
  }

  get transmitting() {
    return this._tx !== null;
  }

  _status(data) {
    const m = MODES[this.mode];
    this.controlServer.broadcastJsonEvent(EVENT.SSTV_TX_STATUS, { mode: this.mode, name: m.name, ...data });
  }

  /**
   * @param {{rgb: Uint8Array|Buffer, width: number, height: number}} req - the picture, at the mode's
   *   width and its lines (or lines * lineHeight) high, 3 bytes per pixel
   */
  async send({ rgb, width, height } = {}) {
    const m = MODES[this.mode];
    const fail = (error) => {
      this._status({ status: 'error', error });
      return Promise.reject(new Error(error));
    };
    if (this._tx) return fail('Already sending a picture.');
    if (this.controlServer.state?.ptt) return fail('The radio is already transmitting.');
    if (width !== m.width || !(height === m.lines || height === m.lines * m.lineHeight)) {
      return fail(`The picture must be ${m.width} x ${m.lines * m.lineHeight} for ${m.name}.`);
    }
    if (!rgb || rgb.length !== width * height * 3) return fail('The picture data is the wrong size.');
    const civ = this.controlServer.civ;
    const tx = { aborted: false, timer: null, wake: null };
    this._tx = tx;
    let dataOn = false;
    let prevPower = null;
    let keyed = false;
    try {
      const radioMode = civ ? (await civ.getMode()).mode : null;
      if (civ && radioMode !== 'LSB' && radioMode !== 'USB') throw new Error('Put the radio on LSB or USB first (the SSTV button does this).');
      this._status({ status: 'encoding' });
      const { pcm, durationSec } = await this.encode({
        rgb: Uint8Array.from(rgb),
        width,
        height,
        mode: this.mode,
        callsign: this.callsign,
        fskId: this.fskId,
        cwId: this.cwId,
        sampleRate: this.audioBridge.sampleRate,
        amplitude: this.amplitude,
      });
      if (tx.aborted) {
        this._tx = null;
        this._status({ status: 'aborted' });
        return;
      }
      if (this.controlServer.state?.ptt) throw new Error('The radio is already transmitting.');
      if (civ) {
        await civ.setDataMode(true);
        dataOn = true;
        if (this.txPowerW) {
          prevPower = await civ.getTxPower();
          await civ.setTxPower(this.txPowerW);
        }
      }
      keyed = true;
      await this.controlServer.setPttFromServer(true);
      this._status({ status: 'sending', durationSec, startTime: this.now() });
      if (!tx.aborted) {
        this.audioBridge.playback.write(pcm);
        const ms = (pcm.length / 2 / this.audioBridge.sampleRate) * 1000;
        await new Promise((resolve) => {
          tx.wake = resolve;
          tx.timer = setTimeout(resolve, ms + this.pttReleaseMarginMs);
        });
      }
      tx.timer = null;
      await this.controlServer.setPttFromServer(false);
      keyed = false;
      await this._restore(civ, dataOn, prevPower);
      dataOn = false;
      prevPower = null;
      this._tx = null;
      this._status({ status: tx.aborted ? 'aborted' : 'sent', durationSec });
      if (!tx.aborted) this._addOwnPicture(rgb, width, height);
    } catch (err) {
      if (keyed) {
        try {
          await this.controlServer.setPttFromServer(false);
        } catch {
          // best effort; the PTT watchdog is still armed
        }
      }
      try {
        await this._restore(civ, dataOn, prevPower);
      } catch {
        // best effort
      }
      this._tx = null;
      this._status({ status: 'error', error: err.message });
      throw err;
    }
  }

  async _restore(civ, dataOn, prevPower) {
    if (!civ) return;
    if (prevPower != null) await civ.setTxPower(prevPower);
    if (dataOn) await civ.setDataMode(false);
  }

  abort() {
    const tx = this._tx;
    if (!tx || tx.aborted) return;
    tx.aborted = true;
    if (tx.timer) clearTimeout(tx.timer);
    if (typeof this.audioBridge.playback.restart === 'function') this.audioBridge.playback.restart();
    if (tx.wake) tx.wake();
  }

  _addOwnPicture(rgb, width, height) {
    const m = MODES[this.mode];
    const t = this.now();
    this._picId = this._picId >= 0xffff ? 0x8000 : this._picId + 1;
    const picture = {
      id: this._picId,
      own: true,
      mode: this.mode,
      name: m.name,
      width,
      lines: height,
      lineHeight: 1,
      shiftHz: 0,
      time: t,
      endTime: t,
      complete: true,
      linesReceived: height,
      slantDeg: 90,
      png: encodePng(Uint8Array.from(rgb), width, height).toString('base64'),
    };
    const list = (this.controlServer.sstvPictures = this.controlServer.sstvPictures ?? []);
    list.push(picture);
    while (list.length > 12) list.shift();
    this.controlServer.broadcastJsonEvent(EVENT.SSTV_PICTURE, picture);
  }
}

module.exports = { SstvTxBridge, sstvTxSeconds, encodeInWorker, DEFAULT_SSTV_TX_MODE };
