'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { StreamDecimator } = require('../audio/decimator');
const { EVENT } = require('./protocol');
const { FT8_SPECTRUM_FFT_SIZE, FT8_SPECTRUM_MAX_HZ, FT8_SPECTRUM_INTERVAL_MS, encodeFt8SpectrumFrame, _dbToScaledBytes } = require('../audio/ft8-bridge');
const { computeMagnitudeSpectrum } = require('../audio/fft');
const { ReceiveRadioSetup } = require('./radio-setup');

const RATE = 12000;
const MAX_BACKLOG_SEC = 20;
const RESUME_BACKLOG_SEC = 6;
const DEFAULT_KEEP_PICTURES = 8;
const STATUS_EVERY_MS = 1000; // while nothing is heard; every frame (0.4 s) once something is

/**
 * Wires the EasyPal (HamDRM) receiver (audio/drm/, a port of QSSTV's, in a
 * worker: audio/easypal-decode-worker.js) to the radio's RX audio, the same
 * way the SSTV bridge does: an extra listener on AudioBridge's capture
 * stream, active only while the operator has EasyPal selected
 * (REQUEST.SET_EASYPAL_ACTIVE) and the radio is not transmitting. Like
 * Radiofax, it turns the radio's NR and auto notch off and selects FIL1
 * while it runs (see radio-setup.js).
 *
 * The receiver's progress is broadcast as EVENT.EASYPAL_STATUS, the top of
 * a JPEG coming in as EVENT.EASYPAL_PREVIEW, and each file received as
 * EVENT.EASYPAL_PICTURE, kept in ControlServer.easypalPictures for pages
 * that connect later (REQUEST.GET_EASYPAL_PICTURES) and optionally saved,
 * as it was sent, to a folder. The 0-3 kHz audio spectrum is broadcast too,
 * for tuning.
 */
class EasypalDecoderBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {string} [opts.saveDir] - also write each received file here
   * @param {number} [opts.keep=8] - files kept for pages that connect later
   * @param {object} [opts.civ] - the CI-V driver, for the radio set-up
   * @param {boolean} [opts.setUpRadio=true]
   * @param {{postMessage: Function, on: Function, terminate: Function}} [opts.worker] - injectable for testing
   * @param {() => number} [opts.now] - injectable clock (ms)
   */
  constructor({ controlServer, audioBridge, saveDir, keep = DEFAULT_KEEP_PICTURES, civ, setUpRadio = true, worker, now } = {}) {
    if (!controlServer) throw new Error('EasypalDecoderBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('EasypalDecoderBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.saveDir = saveDir || null;
    this.keep = keep;
    this.now = now ?? Date.now;
    const rate = audioBridge.sampleRate;
    this.supported = Number.isInteger(rate / RATE) && rate >= RATE;
    this.worker = worker ?? new Worker(path.join(__dirname, '..', 'audio', 'easypal-decode-worker.js'));
    controlServer.easypalPictures = controlServer.easypalPictures ?? [];
    controlServer.easypalPreview = null;
    controlServer.state.easypal = { state: 'idle', snr: null, mode: null, callsign: '', offsetHz: 0, file: null };
    this.civ = civ ?? controlServer.civ ?? null;
    this.setUpRadio = setUpRadio && !!this.civ;
    this._radioSetup = this.setUpRadio ? new ReceiveRadioSetup({ civ: this.civ, purpose: 'EasyPal', report: (m) => this._reportError(m) }) : null;
    this._radio = Promise.resolve();

    this._active = false;
    this._pttActive = false;
    this._attached = false;
    this._decimator = null;
    this._sentSamples = 0;
    this._ackedSamples = 0;
    this._dropping = false;
    this._id = 0;
    this._lastStatusAt = 0;
    this._spectrumRing = new Float32Array(FT8_SPECTRUM_FFT_SIZE);
    this._spectrumFilled = 0;
    this._spectrumTimer = null;

    this._onPcm = (chunk) => this._handlePcm(chunk);
    this._onActive = (on) => {
      const was = this._active;
      this._active = !!on;
      if (this._radioSetup && this._active && !was) this._radio = this._radio.then(() => this._radioSetup.setUp());
      if (this._radioSetup && !this._active && was) this._radio = this._radio.then(() => this._radioSetup.restore());
      this._sync();
    };
    this._onPtt = (on) => {
      this._pttActive = !!on;
      this._sync();
    };
    this._onWorkerMessage = (msg) => this._handleWorkerMessage(msg);
    this.worker.on('message', this._onWorkerMessage);
    this.worker.on('error', (err) => this._reportError(err.message));
  }

  start() {
    this.controlServer.on('easypal-active', this._onActive);
    this.controlServer.on('ptt', this._onPtt);
    if (this.controlServer.state?.easypalActive) this._onActive(true);
  }

  stop() {
    this.controlServer.off('easypal-active', this._onActive);
    this.controlServer.off('ptt', this._onPtt);
    this._detach();
    if (this._active) {
      this._active = false;
      if (this._radioSetup) this._radio = this._radio.then(() => this._radioSetup.restore());
    }
    this.worker.off?.('message', this._onWorkerMessage);
    this.worker.terminate();
  }

  get attached() {
    return this._attached;
  }

  /** Resolves once any radio set-up or restore has finished (for tests). */
  radioSettled() {
    return this._radio;
  }

  _sync() {
    const should = this._active && !this._pttActive;
    if (should && !this._attached) this._attach();
    else if (!should && this._attached) this._detach();
  }

  _status(patch, force = true) {
    const s = { ...this.controlServer.state.easypal, ...patch };
    this.controlServer.state.easypal = s;
    const t = this.now();
    if (!force && t - this._lastStatusAt < STATUS_EVERY_MS) return;
    this._lastStatusAt = t;
    this.controlServer.broadcastJsonEvent(EVENT.EASYPAL_STATUS, s);
  }

  _attach() {
    if (!this.supported) {
      this._reportError(`EasyPal receive needs an audio sample rate that is a multiple of ${RATE} Hz (this server captures at ${this.audioBridge.sampleRate} Hz).`);
      return;
    }
    // HamDRM is 0.25-2.75 kHz; keep up to 4.5 kHz so the receiver's own filters see a clean band
    this._decimator = new StreamDecimator(this.audioBridge.sampleRate, RATE, { cutoffHz: 4500 });
    this._sentSamples = 0;
    this._ackedSamples = 0;
    this._dropping = false;
    this.worker.postMessage({ type: 'reset' });
    this.audioBridge.capture.on('data', this._onPcm);
    this._attached = true;
    this._spectrumFilled = 0;
    this._spectrumTimer = setInterval(() => this._emitSpectrum(), FT8_SPECTRUM_INTERVAL_MS);
    this._spectrumTimer.unref?.();
    this._status({ state: 'listening', snr: null, mode: null, offsetHz: 0, file: null });
  }

  _detach() {
    if (!this._attached) return;
    this.audioBridge.capture.off('data', this._onPcm);
    this._attached = false;
    if (this._spectrumTimer) clearInterval(this._spectrumTimer);
    this._spectrumTimer = null;
    this._decimator = null;
    this.controlServer.easypalPreview = null;
    this._status({ state: 'idle', snr: null, file: null });
  }

  _handlePcm(chunk) {
    const count = Math.floor(chunk.length / 2);
    if (count === 0 || !this._decimator) return;
    const backlogSec = (this._sentSamples - this._ackedSamples) / RATE;
    if (this._dropping) {
      if (backlogSec < RESUME_BACKLOG_SEC) this._dropping = false;
      else return;
    } else if (backlogSec > MAX_BACKLOG_SEC) {
      this._dropping = true;
      this._reportError('the receiver is falling behind; dropping audio until it catches up.');
      return;
    }
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) samples[i] = chunk.readInt16LE(i * 2);
    const out = this._decimator.process(samples);
    if (out.length === 0) return;
    this._pushSpectrum(out);
    this._sentSamples += out.length;
    this.worker.postMessage({ type: 'samples', samples: out.buffer }, [out.buffer]);
  }

  _pushSpectrum(samples) {
    const ring = this._spectrumRing;
    if (samples.length >= ring.length) ring.set(samples.subarray(samples.length - ring.length));
    else {
      ring.copyWithin(0, samples.length);
      ring.set(samples, ring.length - samples.length);
    }
    this._spectrumFilled = Math.min(ring.length, this._spectrumFilled + samples.length);
  }

  _emitSpectrum() {
    if (this._spectrumFilled < this._spectrumRing.length) return;
    const { magnitudes, binHz } = computeMagnitudeSpectrum(this._spectrumRing, { fftSize: FT8_SPECTRUM_FFT_SIZE, sampleRate: RATE });
    const binCount = Math.min(magnitudes.length, Math.round(FT8_SPECTRUM_MAX_HZ / binHz));
    this.controlServer.broadcastBinary?.(encodeFt8SpectrumFrame(binHz, _dbToScaledBytes(magnitudes, binCount)));
  }

  _handleWorkerMessage(msg) {
    switch (msg.type) {
      case 'status': {
        if (!this._attached) break;
        const receiving = msg.stage === 'receiving';
        const file = msg.file ? { transportId: msg.file.transportId, fileName: msg.file.fileName, received: msg.file.received, total: msg.file.total, totalKnown: !!msg.file.lastSeen } : null;
        const prev = this.controlServer.state.easypal;
        const changed = prev.state !== msg.stage || prev.callsign !== msg.callsign || prev.file?.received !== file?.received || prev.file?.fileName !== file?.fileName;
        this._status(
          {
            state: msg.stage,
            snr: Number.isFinite(msg.snr) ? Math.round(msg.snr * 10) / 10 : null,
            mode: receiving ? msg.mode : prev.mode,
            callsign: msg.callsign || prev.callsign,
            offsetHz: Math.round(msg.tuningHz || 0),
            file,
          },
          receiving || changed
        );
        break;
      }
      case 'lost':
        if (this._attached) this._status({ state: 'listening', snr: null });
        break;
      case 'preview': {
        const p = { transportId: msg.transportId, fileName: msg.fileName, mime: msg.mime, data: Buffer.from(msg.data).toString('base64') };
        this.controlServer.easypalPreview = p;
        this.controlServer.broadcastJsonEvent(EVENT.EASYPAL_PREVIEW, p);
        break;
      }
      case 'file':
        this._finish(msg);
        break;
      case 'ack':
        this._ackedSamples += msg.samples;
        break;
      case 'error':
        this._reportError(msg.error);
        break;
      default:
        break;
    }
  }

  _finish(msg) {
    this._id = (this._id + 1) & 0xffff;
    const s = this.controlServer.state.easypal;
    const d = msg.display;
    const picture = {
      id: this._id,
      transportId: msg.transportId,
      time: this.now(),
      fileName: msg.fileName,
      callsign: msg.callsign || s.callsign || '',
      mode: msg.modeCode || s.mode || null,
      snr: s.snr,
      segments: msg.segments,
      recovered: msg.recovered || 0,
      seconds: Math.round(msg.seconds || 0),
      size: msg.data.byteLength,
      mime: d && d.mime ? d.mime : null,
      data: d && d.data ? Buffer.from(d.data).toString('base64') : null,
      width: d?.width ?? null,
      height: d?.height ?? null,
      text: d?.text ?? null,
    };
    this.controlServer.easypalPreview = null;
    const list = this.controlServer.easypalPictures;
    list.push(picture);
    while (list.length > this.keep) list.shift();
    this.controlServer.broadcastJsonEvent(EVENT.EASYPAL_PICTURE, picture);
    if (this.saveDir) this._save(picture, Buffer.from(msg.data));
  }

  _save(picture, data) {
    const d = new Date(picture.time);
    const pad = (n) => String(n).padStart(2, '0');
    const safe = picture.fileName.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'file';
    const call = picture.callsign ? `${picture.callsign.replace(/[^\w-]+/g, '_')}-` : '';
    const name = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}z-${call}${safe}`;
    fs.promises
      .mkdir(this.saveDir, { recursive: true })
      .then(() => fs.promises.writeFile(path.join(this.saveDir, name), data))
      .catch((err) => this._reportError(`couldn't save ${name}: ${err.message}`));
  }

  _reportError(message) {
    console.error(`EasyPal receiver: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { message: `EasyPal receiver: ${message}` });
  }
}

module.exports = { EasypalDecoderBridge };
