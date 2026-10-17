'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { StreamDecimator } = require('../audio/decimator');
const { EVENT, BINARY_TYPE } = require('./protocol');
const { FT8_SPECTRUM_FFT_SIZE, FT8_SPECTRUM_MAX_HZ, FT8_SPECTRUM_INTERVAL_MS, encodeFt8SpectrumFrame, _dbToScaledBytes } = require('../audio/ft8-bridge');
const { computeMagnitudeSpectrum } = require('../audio/fft');
const { SSTV_SAMPLE_RATE } = require('../audio/sstv-rx');
const { encodePng } = require('./png');

// The receiver costs a few percent of a Pi core; if the worker ever falls
// this far behind, drop audio rather than queue it without bound.
const MAX_BACKLOG_SEC = 20;
const RESUME_BACKLOG_SEC = 6;
const DEFAULT_KEEP_PICTURES = 12;

/** One received line as a BINARY_TYPE.SSTV_LINE frame (see protocol.js). */
function encodeSstvLineFrame(picId, y, width, rgb) {
  const buf = Buffer.alloc(7 + width * 3);
  buf[0] = BINARY_TYPE.SSTV_LINE;
  buf.writeUInt16LE(picId & 0xffff, 1);
  buf.writeUInt16LE(y, 3);
  buf.writeUInt16LE(width, 5);
  buf.set(rgb.subarray(0, width * 3), 7);
  return buf;
}

/**
 * Wires the SSTV receiver (audio/sstv-rx.js, after slowrx, in a worker:
 * audio/sstv-decode-worker.js) to the radio's RX audio, the same way the
 * JTTY and Olivia bridges do: an extra listener on AudioBridge's capture
 * stream, active only while the operator has SSTV selected
 * (REQUEST.SET_SSTV_ACTIVE) and the radio is not transmitting.
 *
 * While a picture comes in, each line is broadcast as a binary SSTV_LINE
 * frame (EVENT.SSTV_START announces the mode and size first). When it ends,
 * the slant-corrected picture is broadcast as a PNG (EVENT.SSTV_PICTURE),
 * kept in ControlServer.sstvPictures for pages that connect later
 * (REQUEST.GET_SSTV_PICTURES), and optionally saved to a folder. The 0-3 kHz
 * audio spectrum is broadcast too, for tuning.
 */
class SstvDecoderBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {string} [opts.saveDir] - also write each picture here as a PNG
   * @param {number} [opts.keep=12] - pictures kept for pages that connect later
   * @param {{postMessage: Function, on: Function, terminate: Function}} [opts.worker] - injectable for testing
   * @param {() => number} [opts.now] - injectable clock (ms)
   */
  constructor({ controlServer, audioBridge, saveDir, keep = DEFAULT_KEEP_PICTURES, worker, now } = {}) {
    if (!controlServer) throw new Error('SstvDecoderBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('SstvDecoderBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.saveDir = saveDir || null;
    this.keep = keep;
    this.now = now ?? Date.now;
    const rate = audioBridge.sampleRate;
    this.supported = Number.isInteger(rate / SSTV_SAMPLE_RATE) && rate >= SSTV_SAMPLE_RATE;
    this.worker = worker ?? new Worker(path.join(__dirname, '..', 'audio', 'sstv-decode-worker.js'));
    controlServer.sstvPictures = controlServer.sstvPictures ?? [];

    this._active = false;
    this._pttActive = false;
    this._attached = false;
    this._decimator = null;
    this._sentSamples = 0;
    this._ackedSamples = 0;
    this._dropping = false;
    this._warnedUnsupported = false;
    this._picId = 0;
    this._current = null; // the picture coming in: {id, mode, ..., time}
    this._spectrumRing = new Float32Array(FT8_SPECTRUM_FFT_SIZE);
    this._spectrumFilled = 0;
    this._spectrumTimer = null;

    this._onPcm = (chunk) => this._handlePcm(chunk);
    this._onActive = (active) => {
      this._active = !!active;
      this._sync();
    };
    this._onPtt = (on) => {
      this._pttActive = !!on;
      this._sync();
    };
    this._onEndPicture = () => this.worker.postMessage({ type: 'flush' });
    this._onWorkerMessage = (msg) => this._handleWorkerMessage(msg);
    this.worker.on('message', this._onWorkerMessage);
    this.worker.on('error', (err) => this._reportError(err.message));
  }

  start() {
    this.controlServer.on('sstv-active', this._onActive);
    this.controlServer.on('ptt', this._onPtt);
    this.controlServer.on('sstv-end-picture', this._onEndPicture);
    if (this.controlServer.state?.sstvActive) this._onActive(true);
  }

  stop() {
    this.controlServer.off('sstv-active', this._onActive);
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('sstv-end-picture', this._onEndPicture);
    this._detach();
    this.worker.off?.('message', this._onWorkerMessage);
    this.worker.terminate();
  }

  get attached() {
    return this._attached;
  }

  _sync() {
    const should = this._active && !this._pttActive;
    if (should && !this._attached) this._attach();
    else if (!should && this._attached) this._detach();
  }

  _attach() {
    if (!this.supported) {
      if (!this._warnedUnsupported) {
        this._warnedUnsupported = true;
        this._reportError(
          `SSTV receive needs an audio sample rate that is a multiple of ${SSTV_SAMPLE_RATE} Hz (this server captures at ${this.audioBridge.sampleRate} Hz).`
        );
      }
      return;
    }
    this._decimator = new StreamDecimator(this.audioBridge.sampleRate, SSTV_SAMPLE_RATE);
    this._sentSamples = 0;
    this._ackedSamples = 0;
    this._dropping = false;
    this.worker.postMessage({ type: 'reset' });
    this.audioBridge.capture.on('data', this._onPcm);
    this._attached = true;
    this._spectrumFilled = 0;
    this._spectrumTimer = setInterval(() => this._emitSpectrum(), FT8_SPECTRUM_INTERVAL_MS);
    this._spectrumTimer.unref?.();
  }

  _detach() {
    if (!this._attached) return;
    this.audioBridge.capture.off('data', this._onPcm);
    this._attached = false;
    if (this._spectrumTimer) clearInterval(this._spectrumTimer);
    this._spectrumTimer = null;
    this._decimator = null;
    // Keep whatever part of a picture has arrived (our own transmission, or SSTV deselected).
    this.worker.postMessage({ type: 'flush' });
  }

  _handlePcm(chunk) {
    const count = Math.floor(chunk.length / 2);
    if (count === 0) return;
    const backlogSec = (this._sentSamples - this._ackedSamples) / SSTV_SAMPLE_RATE;
    if (this._dropping) {
      if (backlogSec < RESUME_BACKLOG_SEC) this._dropping = false;
      else return;
    } else if (backlogSec > MAX_BACKLOG_SEC) {
      this._dropping = true;
      this._reportError('SSTV receiver is falling behind; dropping audio until it catches up.');
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
    const { magnitudes, binHz } = computeMagnitudeSpectrum(this._spectrumRing, { fftSize: FT8_SPECTRUM_FFT_SIZE, sampleRate: SSTV_SAMPLE_RATE });
    const binCount = Math.min(magnitudes.length, Math.round(FT8_SPECTRUM_MAX_HZ / binHz));
    this.controlServer.broadcastBinary?.(encodeFt8SpectrumFrame(binHz, _dbToScaledBytes(magnitudes, binCount)));
  }

  _handleWorkerMessage(msg) {
    switch (msg.type) {
      case 'start': {
        this._picId = (this._picId + 1) & 0xffff;
        this._current = {
          id: this._picId,
          mode: msg.mode,
          name: msg.name,
          width: msg.width,
          lines: msg.lines,
          lineHeight: msg.lineHeight,
          shiftHz: msg.shiftHz,
          time: this.now(),
        };
        this.controlServer.broadcastJsonEvent(EVENT.SSTV_START, this._current);
        break;
      }
      case 'line':
        if (this._current) this.controlServer.broadcastBinary?.(encodeSstvLineFrame(this._current.id, msg.y, this._current.width, new Uint8Array(msg.rgb)));
        break;
      case 'end':
        this._finishPicture(msg);
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

  _finishPicture(msg) {
    const cur = this._current ?? { id: (this._picId = (this._picId + 1) & 0xffff), time: this.now() };
    this._current = null;
    const png = encodePng(new Uint8Array(msg.rgb), msg.width, msg.lines);
    const picture = {
      id: cur.id,
      mode: msg.mode,
      name: msg.name,
      width: msg.width,
      lines: msg.lines,
      lineHeight: msg.lineHeight,
      shiftHz: msg.shiftHz,
      time: cur.time,
      endTime: this.now(),
      complete: msg.complete,
      linesReceived: msg.linesReceived,
      slantDeg: msg.slantDeg,
      png: png.toString('base64'),
    };
    const list = this.controlServer.sstvPictures;
    list.push(picture);
    while (list.length > this.keep) list.shift();
    this.controlServer.broadcastJsonEvent(EVENT.SSTV_PICTURE, picture);
    if (this.saveDir) this._save(picture, png);
  }

  _save(picture, png) {
    const d = new Date(picture.time);
    const pad = (n) => String(n).padStart(2, '0');
    const name = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}z-${picture.mode}.png`;
    fs.promises
      .mkdir(this.saveDir, { recursive: true })
      .then(() => fs.promises.writeFile(path.join(this.saveDir, name), png))
      .catch((err) => this._reportError(`couldn't save ${name}: ${err.message}`));
  }

  _reportError(message) {
    console.error(`SSTV receiver: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { message: `SSTV receiver: ${message}` });
  }
}

module.exports = { SstvDecoderBridge, encodeSstvLineFrame };
