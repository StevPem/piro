'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { StreamDecimator } = require('../audio/decimator');
const { EVENT } = require('./protocol');
const { FT8_SPECTRUM_MAX_HZ, FT8_SPECTRUM_INTERVAL_MS, encodeFt8SpectrumFrame, _dbToScaledBytes } = require('../audio/ft8-bridge');
const { computeMagnitudeSpectrum } = require('../audio/fft');
const { OLIVIA_SAMPLE_RATE, OLIVIA_DEFAULT_CENTRE_HZ, clampOliviaCentre } = require('../audio/olivia-dsp');

// 2048 points at 8 kHz: 3.9 Hz bins, close to the 2.9 Hz the FT8/JTTY
// spectrum uses, over the same 0-3 kHz.
const SPECTRUM_FFT_SIZE = 2048;
// The receiver is light, but if the worker ever falls this far behind
// (seconds of audio queued), drop input rather than queue without bound.
const MAX_BACKLOG_SEC = 20;
const RESUME_BACKLOG_SEC = 6;

/**
 * Wires the Olivia 8/250 receiver to the radio's RX audio, the same way
 * JttyDecoderBridge does for JTTY: an extra listener on AudioBridge's
 * capture stream, active only while the operator has Olivia selected
 * (REQUEST.SET_OLIVIA_ACTIVE — Olivia is an app-level mode on USB) and the
 * radio is not transmitting.
 *
 * Audio is reduced to the modem's 8 kHz here and decoded in a worker
 * (audio/olivia-decode-worker.js). Like fldigi, the receiver listens at one
 * audio centre frequency, searching +/-125 Hz around it; the client sets
 * it (the "Centre" box, a click on the spectrum). Decoded characters are
 * broadcast as EVENT.OLIVIA_TEXT:
 *   { text, snr, freqOffsetHz, centreHz, time }
 * While Olivia is selected the 0-3 kHz audio spectrum is broadcast too
 * (the same ft8-spectrum frames FT8 and JTTY use).
 */
class OliviaDecoderBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {boolean} [opts.squelch=true] - PiRO's extra junk filtering (false = exactly as fldigi with its squelch off)
   * @param {{postMessage: Function, on: Function, terminate: Function}} [opts.worker] - injectable for testing
   * @param {() => number} [opts.now] - injectable clock (ms)
   */
  constructor({ controlServer, audioBridge, squelch = true, worker, now } = {}) {
    if (!controlServer) throw new Error('OliviaDecoderBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('OliviaDecoderBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.squelch = squelch !== false;
    this.now = now ?? Date.now;
    const rate = audioBridge.sampleRate;
    this.supported = Number.isInteger(rate / OLIVIA_SAMPLE_RATE) && rate >= OLIVIA_SAMPLE_RATE;
    this.worker = worker ?? new Worker(path.join(__dirname, '..', 'audio', 'olivia-decode-worker.js'));
    this.centreHz = clampOliviaCentre(controlServer.state?.oliviaCentreHz ?? OLIVIA_DEFAULT_CENTRE_HZ);

    this._active = false;
    this._pttActive = false;
    this._attached = false;
    this._decimator = null;
    this._sentSamples = 0;
    this._ackedSamples = 0;
    this._dropping = false;
    this._warnedUnsupported = false;
    this._spectrumRing = new Float32Array(SPECTRUM_FFT_SIZE);
    this._spectrumFilled = 0;
    this._spectrumTimer = null;

    this._onPcm = (chunk) => this._handlePcm(chunk);
    this._onActive = ({ active, centreHz } = {}) => {
      const centre = clampOliviaCentre(centreHz ?? this.centreHz);
      const retune = centre !== this.centreHz;
      this.centreHz = centre;
      this._active = !!active;
      if (retune && this._attached) this._configure();
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
    this.controlServer.on('olivia-active', this._onActive);
    this.controlServer.on('ptt', this._onPtt);
    const st = this.controlServer.state;
    if (st?.oliviaActive) this._onActive({ active: true, centreHz: st.oliviaCentreHz });
  }

  stop() {
    this.controlServer.off('olivia-active', this._onActive);
    this.controlServer.off('ptt', this._onPtt);
    this._detach();
    this.worker.off?.('message', this._onWorkerMessage);
    this.worker.terminate();
  }

  get attached() {
    return this._attached;
  }

  _configure() {
    this.worker.postMessage({ type: 'config', centreHz: this.centreHz, squelch: this.squelch });
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
          `Olivia receive needs an audio sample rate that is a multiple of ${OLIVIA_SAMPLE_RATE} Hz (this server captures at ${this.audioBridge.sampleRate} Hz).`
        );
      }
      return;
    }
    // A fresh receiver for each stream: after our own transmission, or a
    // retune, nothing half-decoded from before should come out.
    this._configure();
    this._decimator = new StreamDecimator(this.audioBridge.sampleRate, OLIVIA_SAMPLE_RATE, { cutoffHz: 3000 });
    this._sentSamples = 0;
    this._ackedSamples = 0;
    this._dropping = false;
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
    // Let the last characters of a signal that just ended come out.
    this.worker.postMessage({ type: 'flush' });
  }

  _handlePcm(chunk) {
    const count = Math.floor(chunk.length / 2);
    if (count === 0) return;
    const backlogSec = (this._sentSamples - this._ackedSamples) / OLIVIA_SAMPLE_RATE;
    if (this._dropping) {
      if (backlogSec < RESUME_BACKLOG_SEC) this._dropping = false;
      else return;
    } else if (backlogSec > MAX_BACKLOG_SEC) {
      this._dropping = true;
      this._reportError('Olivia decoder is falling behind; dropping audio until it catches up.');
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
      fftSize: SPECTRUM_FFT_SIZE,
      sampleRate: OLIVIA_SAMPLE_RATE,
    });
    const binCount = Math.min(magnitudes.length, Math.round(FT8_SPECTRUM_MAX_HZ / binHz));
    this.controlServer.broadcastBinary?.(encodeFt8SpectrumFrame(binHz, _dbToScaledBytes(magnitudes, binCount)));
  }

  _handleWorkerMessage(msg) {
    switch (msg.type) {
      case 'text':
        this.controlServer.broadcastJsonEvent(EVENT.OLIVIA_TEXT, {
          text: msg.text,
          snr: msg.snr,
          freqOffsetHz: msg.freqOffsetHz,
          centreHz: msg.centreHz,
          time: this.now(),
        });
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

  _reportError(message) {
    console.error(`Olivia decoder: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { message: `Olivia decoder: ${message}` });
  }
}

module.exports = { OliviaDecoderBridge, SPECTRUM_FFT_SIZE };
