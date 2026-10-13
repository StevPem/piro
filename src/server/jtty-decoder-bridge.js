'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { StreamDecimator } = require('../audio/decimator');
const { EVENT } = require('./protocol');
const {
  FT8_SPECTRUM_FFT_SIZE,
  FT8_SPECTRUM_MAX_HZ,
  FT8_SPECTRUM_INTERVAL_MS,
  encodeFt8SpectrumFrame,
  _dbToScaledBytes,
} = require('../audio/ft8-bridge');
const { computeMagnitudeSpectrum } = require('../audio/fft');

const JTTY_RX_RATE = 12000;
const DEFAULT_LOW_HZ = 1000;
const DEFAULT_HIGH_HZ = 2000;
// If the worker falls this far behind (seconds of audio queued), drop input
// instead of letting the queue grow without bound.
const MAX_BACKLOG_SEC = 20;
const RESUME_BACKLOG_SEC = 6;

/**
 * Wires the JTTY receiver to the radio's RX audio. Like RttyDecoderBridge it
 * attaches as an extra listener on AudioBridge's capture stream, so it needs
 * no capture of its own, and it only runs while the operator has JTTY
 * selected (REQUEST.SET_JTTY_ACTIVE — JTTY is an app-level mode layered on
 * USB, so the radio's own mode can't say) and the radio is not transmitting.
 *
 * The audio is reduced to 12 kHz here and handed to a worker thread (see
 * audio/jtty-decode-worker.js); decoded messages come back as they grow and
 * are broadcast as EVENT.JTTY_TEXT:
 *   { id, freqHz, snr, text, status: 'growing'|'complete'|'expired', time, startTime }
 * where `id` is stable for one message (the client updates its row in place)
 * and `time`/`startTime` are epoch milliseconds of the latest/first frame.
 */
class JttyDecoderBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {number} [opts.lowHz] - lower edge of the audio search band
   * @param {number} [opts.highHz]
   * @param {'economy'|'light'|'full'|'auto'} [opts.quality='economy'] - decoder effort (CPU use)
   * @param {{postMessage: Function, on: Function, terminate: Function}} [opts.worker] - injectable for testing
   * @param {() => number} [opts.now] - injectable clock (ms)
   */
  constructor({ controlServer, audioBridge, lowHz, highHz, quality, worker, now } = {}) {
    if (!controlServer) throw new Error('JttyDecoderBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('JttyDecoderBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.lowHz = lowHz ?? DEFAULT_LOW_HZ;
    this.highHz = highHz ?? DEFAULT_HIGH_HZ;
    this.now = now ?? Date.now;

    const rate = audioBridge.sampleRate;
    this.supported = Number.isInteger(rate / JTTY_RX_RATE) && rate >= JTTY_RX_RATE;
    this.worker = worker ?? new Worker(path.join(__dirname, '..', 'audio', 'jtty-decode-worker.js'));
    this.worker.postMessage({ type: 'config', lowHz: this.lowHz, highHz: this.highHz, quality: quality ?? 'economy' });

    this._active = false; // the client has JTTY selected
    this._pttActive = false;
    this._attached = false;
    this._decimator = null;
    this._streamStartMs = 0;
    this._sentSamples = 0;
    this._ackedSamples = 0;
    this._dropping = false;
    this._warnedUnsupported = false;
    // Rolling 12 kHz audio for the 0-3 kHz spectrum shown while JTTY is selected (same display as FT8/FT4).
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
    this._onWorkerMessage = (msg) => this._handleWorkerMessage(msg);
    this.worker.on('message', this._onWorkerMessage);
    this.worker.on('error', (err) => this._reportError(err.message));
  }

  start() {
    this.controlServer.on('jtty-active', this._onActive);
    this.controlServer.on('ptt', this._onPtt);
    if (this.controlServer.state?.jttyActive) this._onActive(true);
  }

  stop() {
    this.controlServer.off('jtty-active', this._onActive);
    this.controlServer.off('ptt', this._onPtt);
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
          `JTTY receive needs an audio sample rate that is a multiple of ${JTTY_RX_RATE} Hz (this server captures at ${this.audioBridge.sampleRate} Hz).`
        );
      }
      return;
    }
    this._decimator = new StreamDecimator(this.audioBridge.sampleRate, JTTY_RX_RATE);
    this._streamStartMs = this.now();
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
    this.worker.postMessage({ type: 'flush' });
  }

  _handlePcm(chunk) {
    const count = Math.floor(chunk.length / 2);
    if (count === 0) return;
    const backlogSec = (this._sentSamples - this._ackedSamples) / JTTY_RX_RATE;
    if (this._dropping) {
      if (backlogSec < RESUME_BACKLOG_SEC) this._dropping = false;
      else return;
    } else if (backlogSec > MAX_BACKLOG_SEC) {
      this._dropping = true;
      this._reportError('JTTY decoder is falling behind; dropping audio until it catches up.');
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
    const { magnitudes, binHz } = computeMagnitudeSpectrum(this._spectrumRing, {
      fftSize: FT8_SPECTRUM_FFT_SIZE,
      sampleRate: JTTY_RX_RATE,
    });
    const binCount = Math.min(magnitudes.length, Math.round(FT8_SPECTRUM_MAX_HZ / binHz));
    this.controlServer.broadcastBinary?.(encodeFt8SpectrumFrame(binHz, _dbToScaledBytes(magnitudes, binCount)));
  }

  _handleWorkerMessage(msg) {
    switch (msg.type) {
      case 'update': {
        const u = msg.update;
        this.controlServer.broadcastJsonEvent(EVENT.JTTY_TEXT, {
          id: u.id,
          freqHz: Math.round(u.freqHz * 10) / 10,
          snr: u.snr,
          text: u.text,
          status: u.status,
          time: this._streamStartMs + Math.round(u.latestTime * 1000),
          startTime: this._streamStartMs + Math.round(u.startTime * 1000),
        });
        break;
      }
      case 'ack':
        this._ackedSamples += msg.samples;
        break;
      case 'load':
        console.log(`JTTY decoder switched to ${msg.light ? 'light' : 'full'} search (${msg.avgWindowMs} ms per window).`);
        break;
      case 'error':
        this._reportError(msg.error);
        break;
      default:
        break;
    }
  }

  _reportError(message) {
    console.error(`JTTY decoder: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { message: `JTTY decoder: ${message}` });
  }
}

module.exports = { JttyDecoderBridge, DEFAULT_LOW_HZ, DEFAULT_HIGH_HZ };
