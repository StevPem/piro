'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { EVENT } = require('./protocol');
const { normaliseSettings, HamDrmTransmitter } = require('../audio/drm/transmitter');
const { ensureDataMode, watchDataMode } = require('../civ/data-mode-guard');
const { MAX_WIDTH, MAX_HEIGHT } = require('../audio/drm/tx-picture');

const PTT_RELEASE_MARGIN_MS = 300; // as tty-bridge.js: let the last of the audio leave the pipe
const DEFAULT_SECONDS = 90;
const MAX_SECONDS = 9 * 60; // under the 10-minute limit on remotely controlled transmissions, with room to spare
const DEFAULT_AMPLITUDE = 0.9; // the peaks; OFDM's average is about 10 dB lower
const RS_TYPES = ['rs1', 'rs2', 'rs3', 'rs4'];

/**
 * EasyPal settings from the environment (EASYPAL_TX_*), as the SSTV
 * transmitter takes SSTV_TX_MODE. Bad values are reported and the default
 * used.
 * @returns {{settings: object, rsType: string|null, seconds: number, warnings: string[]}}
 */
function easypalTxConfig(env = process.env, callsign = '') {
  const warnings = [];
  const pick = (key, value, ok, def) => {
    if (value == null || value === '') return def;
    if (ok(value)) return value;
    warnings.push(`${key}="${value}" is not valid; using ${def}.`);
    return def;
  };
  const settings = {
    mode: pick('EASYPAL_TX_MODE', env.EASYPAL_TX_MODE?.trim().toUpperCase(), (v) => ['A', 'B', 'E'].includes(v), 'B'),
    bandwidth: Number(pick('EASYPAL_TX_BANDWIDTH', env.EASYPAL_TX_BANDWIDTH?.trim(), (v) => ['2.3', '2.5'].includes(v), '2.5')),
    qam: Number(pick('EASYPAL_TX_QAM', env.EASYPAL_TX_QAM?.trim(), (v) => ['4', '16', '64'].includes(v), '16')),
    protection: pick('EASYPAL_TX_PROTECTION', env.EASYPAL_TX_PROTECTION?.trim().toLowerCase(), (v) => ['high', 'normal'].includes(v), 'high'),
    interleave: pick('EASYPAL_TX_INTERLEAVE', env.EASYPAL_TX_INTERLEAVE?.trim().toLowerCase(), (v) => ['short', 'long'].includes(v), 'short'),
    callsign,
  };
  const rs = pick('EASYPAL_TX_RS', env.EASYPAL_TX_RS?.trim().toLowerCase(), (v) => v === 'off' || RS_TYPES.includes(v), 'rs2');
  const seconds = Number(pick('EASYPAL_TX_SECONDS', env.EASYPAL_TX_SECONDS?.trim(), (v) => Number(v) >= 10 && Number(v) <= MAX_SECONDS, String(DEFAULT_SECONDS)));
  return { settings: normaliseSettings(settings), rsType: rs === 'off' ? null : rs, seconds, warnings };
}

/** Runs the encoder in a worker thread. */
function encodeInWorker(job) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, '..', 'audio', 'easypal-encode-worker.js'), { workerData: job });
    w.once('message', (m) => {
      w.terminate();
      if (m.error) reject(new Error(m.error));
      else resolve({ ...m, pcm: Buffer.from(m.pcm), jpeg: Buffer.from(m.jpeg) });
    });
    w.once('error', reject);
  });
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * EasyPal (HamDRM) transmit. Receives `easypal-send` / `easypal-abort`
 * events from the ControlServer (the EasyPal panel's Send / Stop), fits the
 * picture to the transmission time (EASYPAL_TX_SECONDS) as a JPEG with
 * Reed-Solomon protection, makes the audio in a worker
 * (audio/drm/transmitter.js, a port of QSSTV's) and sends it the way the
 * SSTV transmitter does: DATA MODE on and confirmed, an optional lower TX
 * power, PTT, play, PTT off, everything put back. The sent picture is added
 * to the EasyPal pictures as the station's own.
 *
 * Status is broadcast as EVENT.EASYPAL_TX_STATUS:
 *   {status: 'preparing' | 'sending' | 'sent' | 'aborted' | 'error', error?}
 * 'sending' also carries durationSec, startTime, elapsedSec, fileName,
 * bytes, width, height, quality and the picture (jpeg, base64). A page that
 * connects while a picture is being prepared or sent is sent the current
 * status, with elapsedSec how far in it is.
 */
class EasypalTxBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {object} [opts.settings] - {mode, bandwidth, qam, protection, interleave} (audio/drm/transmitter.js)
   * @param {string|null} [opts.rsType='rs2'] - Reed-Solomon protection, or null
   * @param {number} [opts.seconds=90] - the longest a transmission may take
   * @param {string} [opts.callsign] - sent in every frame, and in the file name
   * @param {number} [opts.txPowerW] - TX power while sending (restored after); unset leaves it alone
   * @param {number} [opts.pttReleaseMarginMs]
   * @param {number} [opts.amplitude]
   * @param {(job: object) => Promise<object>} [opts.encode] - injectable for testing
   * @param {() => number} [opts.now]
   * @param {number} [opts.dataSettleMs]
   * @param {number} [opts.dataWatchMs]
   */
  constructor({ controlServer, audioBridge, settings = {}, rsType = 'rs2', seconds = DEFAULT_SECONDS, callsign, txPowerW, pttReleaseMarginMs, amplitude, encode, now, dataSettleMs, dataWatchMs } = {}) {
    if (!controlServer) throw new Error('EasypalTxBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('EasypalTxBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.callsign = String(callsign || '').toUpperCase();
    this.settings = normaliseSettings({ ...settings, callsign: this.callsign });
    this.rsType = rsType || null;
    this.seconds = Math.min(MAX_SECONDS, seconds);
    this.txPowerW = Number.isFinite(txPowerW) && txPowerW > 0 ? txPowerW : null;
    this.pttReleaseMarginMs = pttReleaseMarginMs ?? PTT_RELEASE_MARGIN_MS;
    this.amplitude = amplitude ?? DEFAULT_AMPLITUDE;
    this.encode = encode ?? encodeInWorker;
    this.now = now ?? Date.now;
    this.dataSettleMs = dataSettleMs;
    this.dataWatchMs = dataWatchMs;
    this._tx = null;
    this._id = 0x10000; // own pictures: above the receiver's 16-bit ids
    this._current = null;
    const t = new HamDrmTransmitter(this.settings);
    // What the client shows and needs (sent in the connect snapshot)
    controlServer.state.easypalTx = {
      mode: this.settings.mode,
      bandwidth: this.settings.bandwidth,
      qam: this.settings.qam,
      protection: this.settings.protection,
      interleave: this.settings.interleave,
      rs: this.rsType,
      seconds: this.seconds,
      bytesPerSecond: Math.round(t.bytesPerFrame / 0.4),
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      callsign: this.callsign,
    };
    this._onSend = (req) => this.send(req).catch(() => {});
    this._onAbort = () => this.abort();
    this._onClientGone = () => {
      if (this._tx && this.controlServer.clients && this.controlServer.clients.size === 0) this.abort();
    };
    this._onClientJoined = (ws) => {
      const s = this._current;
      if (!s || typeof this.controlServer.sendJsonEvent !== 'function') return;
      const data = { ...s.data };
      if (s.startedAt != null) data.elapsedSec = (this.now() - s.startedAt) / 1000;
      this.controlServer.sendJsonEvent(ws, EVENT.EASYPAL_TX_STATUS, data);
    };
  }

  start() {
    this.controlServer.on('easypal-send', this._onSend);
    this.controlServer.on('easypal-abort', this._onAbort);
    this.controlServer.on('client-disconnected', this._onClientGone);
    this.controlServer.on('client-connected', this._onClientJoined);
  }

  stop() {
    this.controlServer.off('easypal-send', this._onSend);
    this.controlServer.off('easypal-abort', this._onAbort);
    this.controlServer.off('client-disconnected', this._onClientGone);
    this.controlServer.off('client-connected', this._onClientJoined);
    if (this._tx) this.abort();
  }

  get transmitting() {
    return this._tx !== null;
  }

  _status(data) {
    const busy = data.status === 'preparing' || data.status === 'sending';
    this._current = busy ? { data, startedAt: data.status === 'sending' ? this.now() : null } : null;
    this.controlServer.broadcastJsonEvent(EVENT.EASYPAL_TX_STATUS, data);
  }

  _fileName() {
    const d = new Date(this.now());
    const stamp = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
    return `${this.callsign ? `${this.callsign.replace(/[^A-Z0-9/-]/g, '')}-` : ''}${stamp}`;
  }

  /** @param {{jpeg: Buffer}} req - the picture, as a JPEG (the browser has shrunk it) */
  async send({ jpeg } = {}) {
    const fail = (error) => {
      this._status({ status: 'error', error });
      return Promise.reject(new Error(error));
    };
    if (this._tx) return fail('Already sending a picture.');
    if (this.controlServer.state?.ptt) return fail('The radio is already transmitting.');
    if (!jpeg || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return fail('The picture must be a JPEG.');
    const civ = this.controlServer.civ;
    const tx = { aborted: false, timer: null, wake: null };
    this._tx = tx;
    let dataOn = false;
    let prevPower = null;
    let keyed = false;
    let stopWatch = null;
    try {
      const radioMode = civ ? (await civ.getMode()).mode : null;
      if (civ && radioMode !== 'USB') throw new Error('Put the radio on USB first (the EasyPal button does this).');
      this._status({ status: 'preparing' });
      const name = this._fileName();
      const r = await this.encode({
        jpeg: Uint8Array.from(jpeg),
        settings: this.settings,
        seconds: this.seconds,
        rsType: this.rsType,
        name,
        sampleRate: this.audioBridge.sampleRate,
        amplitude: this.amplitude,
      });
      if (tx.aborted) {
        this._tx = null;
        this._status({ status: 'aborted' });
        return;
      }
      if (r.durationSec > this.seconds) {
        // fitPicture() has made it as small as it goes
        throw new Error(`Even at its smallest that picture would take ${Math.round(r.durationSec)} s to send, longer than allowed (${this.seconds} s).`);
      }
      if (this.controlServer.state?.ptt) throw new Error('The radio is already transmitting.');
      if (civ) {
        // Confirmed by reading it back, and given a moment to take, before
        // PTT: keyed too soon, the radio can transmit from the microphone.
        dataOn = true;
        await ensureDataMode(civ, true, { settleMs: this.dataSettleMs });
        if (this.txPowerW) {
          const p = await civ.getTxPower();
          prevPower = Number.isFinite(p) && p > 0 ? p : null;
          await civ.setTxPower(this.txPowerW);
        }
      }
      const info = {
        fileName: r.fileName,
        bytes: r.bytes,
        width: r.width,
        height: r.height,
        quality: r.quality,
        jpeg: r.jpeg.toString('base64'),
      };
      if (!tx.aborted) {
        keyed = true;
        await this.controlServer.setPttFromServer(true);
        this._status({ status: 'sending', durationSec: r.durationSec, startTime: this.now(), elapsedSec: 0, ...info });
      }
      if (!tx.aborted) {
        this.audioBridge.playback.write(r.pcm);
        if (civ) {
          stopWatch = watchDataMode(civ, {
            intervalMs: this.dataWatchMs,
            onLost: () => this._warn('DATA mode was turned off during the EasyPal transmission (no output while it was off); turned it back on.'),
          });
        }
        const ms = (r.pcm.length / 2 / this.audioBridge.sampleRate) * 1000;
        await new Promise((resolve) => {
          tx.wake = resolve;
          tx.timer = setTimeout(resolve, ms + this.pttReleaseMarginMs);
        });
      }
      tx.timer = null;
      if (stopWatch) await stopWatch();
      stopWatch = null;
      if (keyed) await this.controlServer.setPttFromServer(false);
      keyed = false;
      await this._restore(civ, dataOn, prevPower);
      dataOn = false;
      prevPower = null;
      this._tx = null;
      this._status({ status: tx.aborted ? 'aborted' : 'sent', durationSec: r.durationSec, fileName: r.fileName });
      if (!tx.aborted) this._addOwnPicture(r);
    } catch (err) {
      if (stopWatch) await stopWatch().catch(() => {});
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

  _warn(message) {
    console.warn(`EasyPal transmit: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { message: `EasyPal transmit: ${message}` });
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

  _addOwnPicture(r) {
    this._id += 1;
    const s = this.settings;
    const picture = {
      id: this._id,
      own: true,
      transportId: null,
      time: this.now(),
      fileName: r.fileName,
      callsign: this.callsign,
      mode: { mode: s.mode, bandwidth: s.bandwidth, qam: s.qam, protection: s.protection, interleave: s.interleave },
      snr: null,
      segments: null,
      recovered: 0,
      seconds: Math.round(r.durationSec),
      size: r.bytes,
      mime: 'image/jpeg',
      data: r.jpeg.toString('base64'),
      width: r.width,
      height: r.height,
      text: null,
    };
    const list = (this.controlServer.easypalPictures = this.controlServer.easypalPictures ?? []);
    list.push(picture);
    while (list.length > 8) list.shift();
    this.controlServer.broadcastJsonEvent(EVENT.EASYPAL_PICTURE, picture);
  }
}

module.exports = { EasypalTxBridge, easypalTxConfig, encodeInWorker, DEFAULT_SECONDS, MAX_SECONDS };
