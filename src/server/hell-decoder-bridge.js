'use strict';

const { StreamDecimator } = require('../audio/decimator');
const { EVENT, BINARY_TYPE } = require('./protocol');
const { FT8_SPECTRUM_MAX_HZ, FT8_SPECTRUM_INTERVAL_MS, encodeFt8SpectrumFrame, _dbToScaledBytes } = require('../audio/ft8-bridge');
const { computeMagnitudeSpectrum } = require('../audio/fft');
const { HELL_SAMPLE_RATE } = require('../audio/hell-tx');
const { HellReceiver, clampHellTone, DEFAULT_ROWS, DEFAULT_TONE_HZ } = require('../audio/hell-rx');
const { HellTextReader } = require('../audio/hell-ocr');

// Read text kept for a page that opens later (EVENT.HELL_TEXT with replace).
const TEXT_BACKLOG_CHARS = 2000;

// Same 0-3 kHz audio spectrum as Olivia's: 2048 points at 8 kHz.
const SPECTRUM_FFT_SIZE = 2048;
// Columns go out about ten times a second (17.5 columns a second, so one or
// two a frame): smooth scrolling without a WebSocket message per column.
const COLUMN_FLUSH_MS = 100;

/**
 * Encodes received Feld-Hell columns as one BINARY_TYPE.HELL_COLUMNS frame
 * (see protocol.js): tag, rows, count, tone (uint16 LE), then the columns.
 */
function encodeHellColumnsFrame(columns, rows, toneHz) {
  const count = Math.min(255, columns.length);
  const buf = Buffer.alloc(5 + count * rows);
  buf[0] = BINARY_TYPE.HELL_COLUMNS;
  buf[1] = rows;
  buf[2] = count;
  buf.writeUInt16LE(Math.round(toneHz), 3);
  for (let i = 0; i < count; i++) buf.set(columns[i], 5 + i * rows);
  return buf;
}

/**
 * Wires the Feld-Hell receiver to the radio's RX audio, the same way
 * OliviaDecoderBridge does for Olivia: an extra listener on AudioBridge's
 * capture stream, active only while the operator has Feld-Hell selected
 * (REQUEST.SET_HELL_ACTIVE) and the radio is not transmitting.
 *
 * The receiver (audio/hell-rx.js) turns the keyed tone into columns of
 * pixel brightness, which go to the browser as BINARY_TYPE.HELL_COLUMNS
 * frames for the scrolling picture. The same columns are read as text by
 * matching them against the Feld-Hell font (audio/hell-ocr.js); what it
 * reads goes out as EVENT.HELL_TEXT, a few seconds behind the picture, and
 * the recent text is sent to a page that opens later. The picture stays the
 * thing to trust on weak signals. Both are cheap (a few percent of a Pi
 * core together), so they run here rather than in a worker. While Feld-Hell is selected the 0-3 kHz audio spectrum is
 * broadcast too (the ft8-spectrum frames FT8, JTTY and Olivia use), for
 * finding signals and click-tuning.
 */
class HellDecoderBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {number} [opts.rows] - pixels per received column
   * @param {boolean} [opts.timers=true] - false: no interval timers (tests call _flushColumns/_emitSpectrum)
   */
  constructor({ controlServer, audioBridge, rows = DEFAULT_ROWS, timers = true } = {}) {
    if (!controlServer) throw new Error('HellDecoderBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('HellDecoderBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.rows = rows;
    this.timers = timers;
    const rate = audioBridge.sampleRate;
    this.supported = Number.isInteger(rate / HELL_SAMPLE_RATE) && rate >= HELL_SAMPLE_RATE;
    this.toneHz = clampHellTone(controlServer.state?.hellToneHz ?? DEFAULT_TONE_HZ);

    this._active = false;
    this._pttActive = false;
    this._attached = false;
    this._decimator = null;
    this._receiver = null;
    this._reader = null;
    this._pending = [];
    this._text = ''; // read, not yet sent
    this._backlog = ''; // recently read, for pages that open later
    this._warnedUnsupported = false;
    this._spectrumRing = new Float32Array(SPECTRUM_FFT_SIZE);
    this._spectrumFilled = 0;
    this._timers = [];

    this._onPcm = (chunk) => this._handlePcm(chunk);
    this._onActive = ({ active, toneHz } = {}) => {
      this.toneHz = clampHellTone(toneHz ?? this.toneHz);
      // Retuning keeps the picture going: the receiver just moves.
      this._receiver?.setTone(this.toneHz);
      this._active = !!active;
      this._sync();
    };
    this._onPtt = (on) => {
      this._pttActive = !!on;
      this._sync();
    };
    this._onClientJoined = (ws) => {
      if (this._backlog && typeof this.controlServer.sendJsonEvent === 'function') {
        this.controlServer.sendJsonEvent(ws, EVENT.HELL_TEXT, { text: this._backlog, replace: true, time: Date.now() });
      }
    };
  }

  start() {
    this.controlServer.on('hell-active', this._onActive);
    this.controlServer.on('ptt', this._onPtt);
    this.controlServer.on('client-connected', this._onClientJoined);
    const st = this.controlServer.state;
    if (st?.hellActive) this._onActive({ active: true, toneHz: st.hellToneHz });
  }

  stop() {
    this.controlServer.off('hell-active', this._onActive);
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('client-connected', this._onClientJoined);
    this._detach();
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
          `Feld-Hell receive needs an audio sample rate that is a multiple of ${HELL_SAMPLE_RATE} Hz (this server captures at ${this.audioBridge.sampleRate} Hz).`
        );
      }
      return;
    }
    this._decimator = new StreamDecimator(this.audioBridge.sampleRate, HELL_SAMPLE_RATE, { cutoffHz: 3000 });
    this._receiver = new HellReceiver({ toneHz: this.toneHz, rows: this.rows });
    this._reader = new HellTextReader({ rows: this.rows });
    this._pending = [];
    this._spectrumFilled = 0;
    this.audioBridge.capture.on('data', this._onPcm);
    this._attached = true;
    if (this.timers) {
      this._timers = [setInterval(() => this._flushColumns(), COLUMN_FLUSH_MS), setInterval(() => this._emitSpectrum(), FT8_SPECTRUM_INTERVAL_MS)];
      for (const t of this._timers) t.unref?.();
    }
  }

  _detach() {
    if (!this._attached) return;
    this.audioBridge.capture.off('data', this._onPcm);
    this._attached = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    // whatever is left of the picture so far (our own transmission is starting, or Feld-Hell was left)
    if (this._reader) this._addText(this._reader.flush());
    this._flushColumns();
    this._decimator = null;
    this._receiver = null;
    this._reader = null;
  }

  _addText(text) {
    if (!text) return;
    this._text += text;
    this._backlog = (this._backlog + text).slice(-TEXT_BACKLOG_CHARS);
  }

  /** Recent read text, as sent to a page that opens later. */
  get backlog() {
    return this._backlog;
  }

  _handlePcm(chunk) {
    const count = Math.floor(chunk.length / 2);
    if (count === 0) return;
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) samples[i] = chunk.readInt16LE(i * 2);
    const out = this._decimator.process(samples);
    if (out.length === 0) return;
    this._pushSpectrum(out);
    const cols = this._receiver.process(out);
    for (const col of cols) this._pending.push(col);
    if (cols.length) this._addText(this._reader.push(cols));
  }

  _flushColumns() {
    if (this._text) {
      this.controlServer.broadcastJsonEvent(EVENT.HELL_TEXT, { text: this._text, time: Date.now() });
      this._text = '';
    }
    if (this._pending.length === 0) return;
    while (this._pending.length) {
      const batch = this._pending.splice(0, 255);
      this.controlServer.broadcastBinary?.(encodeHellColumnsFrame(batch, this.rows, this.toneHz));
    }
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
      sampleRate: HELL_SAMPLE_RATE,
    });
    const binCount = Math.min(magnitudes.length, Math.round(FT8_SPECTRUM_MAX_HZ / binHz));
    this.controlServer.broadcastBinary?.(encodeFt8SpectrumFrame(binHz, _dbToScaledBytes(magnitudes, binCount)));
  }

  _reportError(message) {
    console.error(`Feld-Hell receiver: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { message: `Feld-Hell receiver: ${message}` });
  }
}

module.exports = { HellDecoderBridge, encodeHellColumnsFrame, SPECTRUM_FFT_SIZE, COLUMN_FLUSH_MS };
