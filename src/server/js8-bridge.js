'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { EVENT } = require('./protocol');
const { ensureDataMode } = require('../civ/data-mode-guard');
const { SlotClock } = require('../audio/slot-clock');
const { StreamDecimator } = require('../audio/decimator');
const { upsampleFloatToPcm } = require('../audio/resample');
const { computeMagnitudeSpectrum } = require('../audio/fft');
const { FT8_SPECTRUM_MAX_HZ, FT8_SPECTRUM_INTERVAL_MS, encodeFt8SpectrumFrame, _dbToScaledBytes } = require('../audio/ft8-bridge');
const { CALLSIGN_RE: PSK_CALLSIGN_RE } = require('../audio/psk-reporter');
const { encodeTones } = require('../audio/js8/js8-codec');
const { synthesize, START_DELAY_MS } = require('../audio/js8/js8-modulator');

const RATE = 12000; // JS8's sample rate
const SLOT_MS = 15000; // Normal speed
const SLOT_SAMPLES = (RATE * SLOT_MS) / 1000;
const MIN_SLOT_SAMPLES = 12.5 * RATE; // less than this (we were transmitting, or just started): no decode
const SPECTRUM_FFT_SIZE = 4096; // 2.9 Hz bins at 12 kHz, as FT8
const MIN_TX_HZ = 300;
const MAX_TX_HZ = 2700;
const DEFAULT_TX_HZ = 1500;
const MAX_TEXT = 300;
// A message is sent one frame a slot. 40 frames is 10 minutes, the class
// licence's limit on a remotely controlled transmission.
const MAX_FRAMES = 40;
const HISTORY_MAX = 120;
const DEFAULT_LATENCY_MS = 500;
const PTT_TAIL_MS = 200;
const DEFAULT_AMPLITUDE = 0.5;

function clampJs8TxHz(hz) {
  const v = Math.round(Number(hz));
  if (!Number.isFinite(v)) return DEFAULT_TX_HZ;
  return Math.max(MIN_TX_HZ, Math.min(MAX_TX_HZ, v));
}

/** Text as JS8 sends it: capitals, one line, no doubled spaces at the ends. */
function cleanText(text) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .toUpperCase()
    .trim();
}

/**
 * JS8 (JS8Call's Normal speed) while a browser has JS8 selected (the TTY
 * button; REQUEST.SET_JS8_ACTIVE, the 'js8-active' event, with the
 * transmit offset txHz).
 *
 * Receive: the radio's audio, reduced to 12 kHz, is cut into 15-second
 * UTC slots; each slot is decoded in a worker (audio/js8-worker.js) and
 * the frames found are broadcast as EVENT.JS8_DECODES, and kept (the last
 * 120) for a browser that connects. The 0-3 kHz spectrum is broadcast as
 * for FT8.
 *
 * Transmit (REQUEST.JS8: {action: 'send', text} | {action: 'cq'} |
 * {action: 'stop'}): the worker turns the text into frames as JS8Call
 * does, and one frame goes out each slot, starting at the next boundary:
 * DATA mode confirmed (ensureDataMode), PTT on, the frame's 12.6 s of
 * audio, PTT off. At most 40 frames (10 minutes). No automatic replies and
 * no heartbeats: this station only sends what the operator types.
 *
 * Its state is controlServer.state.js8, broadcast as EVENT.JS8_STATUS.
 */
class Js8Bridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {string} [opts.callsign] - STATION_CALLSIGN (needed to transmit)
   * @param {string} [opts.grid] - STATION_GRID (CQ sends its first 4 characters)
   * @param {{addSpot: Function}} [opts.pskReporter] - where "PSK Spot" reports go
   * @param {number} [opts.latencyMs=500] - how far transmit audio lags what is written (VARA_AUDIO_LATENCY_MS)
   * @param {() => object} [opts.createWorker] - injectable for testing
   * @param {SlotClock} [opts.slotClock] - injectable for testing
   * @param {() => number} [opts.now]
   * @param {number} [opts.dataSettleMs]
   * @param {number} [opts.amplitude=0.5] - transmit audio peak (0-1)
   * @param {Function} [opts.setTimer] - injectable setTimeout (how long PTT is held)
   * @param {Function} [opts.clearTimer] - injectable clearTimeout
   */
  constructor({ controlServer, audioBridge, callsign, grid, pskReporter, latencyMs = DEFAULT_LATENCY_MS, createWorker, slotClock, now, dataSettleMs, amplitude = DEFAULT_AMPLITUDE, setTimer, clearTimer } = {}) {
    if (!controlServer) throw new Error('Js8Bridge requires opts.controlServer');
    if (!audioBridge) throw new Error('Js8Bridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.callsign = String(callsign || '').toUpperCase();
    this.grid = String(grid || '').slice(0, 4).toUpperCase();
    this.pskReporter = pskReporter ?? null;
    this.latencyMs = latencyMs;
    this.createWorker = createWorker ?? (() => new Worker(path.join(__dirname, '..', 'audio', 'js8-worker.js')));
    this.now = now ?? Date.now;
    this.slotClock = slotClock ?? new SlotClock({ slotMs: SLOT_MS, now: this.now });
    this.dataSettleMs = dataSettleMs;
    this.amplitude = amplitude;
    this.setTimer = setTimer ?? setTimeout;
    this.clearTimer = clearTimer ?? clearTimeout;

    const rate = audioBridge.sampleRate;
    this.unavailable = Number.isInteger(rate / RATE) && rate >= RATE ? null : `JS8 needs an audio sample rate that is a multiple of ${RATE} Hz (this server uses ${rate} Hz).`;

    this._active = false;
    this._pttActive = false;
    this._attached = false;
    this._worker = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject}
    this._decimator = null;
    this._slot = new Float32Array(SLOT_SAMPLES);
    this._slotFill = 0;
    this._slotWhole = false; // listening since the start of the slot
    this._decoding = false;
    this._spectrumRing = new Float32Array(SPECTRUM_FFT_SIZE);
    this._spectrumFilled = 0;
    this._spectrumTimer = null;
    this._queue = []; // frames still to send: [{frame, bits, text}]
    this._txSession = 0;
    this._keyed = false;
    this._releaseTimer = null;
    this._history = []; // recent decodes and own frames, oldest first

    controlServer.state.js8 = this._freshState();

    this._onActive = ({ active, txHz } = {}) => this.setActive(!!active, txHz);
    this._onRequest = (req) => this.request(req);
    this._onPtt = (on) => {
      this._pttActive = !!on;
      this._sync();
    };
    this._onPcm = (chunk) => this._handlePcm(chunk);
    this._onBoundary = (info) => this._handleBoundary(info);
    this._onClientJoined = (ws) => {
      if (this._history.length && typeof this.controlServer.sendJsonEvent === 'function') {
        this.controlServer.sendJsonEvent(ws, EVENT.JS8_DECODES, { replace: true, decodes: this._history });
      }
    };
  }

  _freshState() {
    return {
      available: !this.unavailable,
      reason: this.unavailable,
      callsign: this.callsign,
      grid: this.grid,
      canTransmit: !!this.callsign && !this.unavailable,
      txHz: clampJs8TxHz(this.controlServer.state.js8TxHz ?? DEFAULT_TX_HZ),
      sending: null, // {text, frames: [text], sent, total}
      keyed: false,
      decoding: false,
    };
  }

  get state() {
    return this.controlServer.state.js8;
  }

  _update(changes) {
    const s = this.state;
    let changed = false;
    for (const [k, v] of Object.entries(changes)) {
      if (s[k] !== v) {
        s[k] = v;
        changed = true;
      }
    }
    if (changed) this.controlServer.broadcastJsonEvent(EVENT.JS8_STATUS, s);
  }

  _error(message) {
    console.warn(`JS8: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { context: 'js8', message: `JS8: ${message}` });
  }

  start() {
    this.controlServer.on('js8-active', this._onActive);
    this.controlServer.on('js8', this._onRequest);
    this.controlServer.on('ptt', this._onPtt);
    this.controlServer.on('client-connected', this._onClientJoined);
    this.slotClock.on('boundary', this._onBoundary);
    this.slotClock.start();
    this.controlServer.broadcastJsonEvent(EVENT.JS8_STATUS, this.state);
    if (this.controlServer.state.js8Active) this.setActive(true, this.controlServer.state.js8TxHz);
  }

  async stop() {
    this.controlServer.off('js8-active', this._onActive);
    this.controlServer.off('js8', this._onRequest);
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('client-connected', this._onClientJoined);
    this.slotClock.off('boundary', this._onBoundary);
    this.slotClock.stop();
    await this.setActive(false);
    this._endWorker();
  }

  get active() {
    return this._active;
  }

  /** On (receiving, and ready to send) or off (any message being sent is stopped). */
  async setActive(active, txHz) {
    if (txHz !== undefined) this._update({ txHz: clampJs8TxHz(txHz) });
    if (active === this._active) return;
    this._active = active;
    if (active) {
      if (this.unavailable) {
        this._error(this.unavailable);
        return;
      }
      this._ensureWorker();
      this._sync();
    } else {
      await this._stopSending('JS8 was turned off');
      this._sync();
      // The worker holds the word list and the decoder's buffers (some
      // tens of MB): free them on the Pi while JS8 isn't in use.
      this._endWorker();
    }
  }

  _endWorker() {
    if (!this._worker) return;
    this._worker.terminate();
    this._worker = null;
    for (const p of this._pending.values()) p.reject(new Error('JS8 was turned off'));
    this._pending.clear();
    if (this._decoding) {
      this._decoding = false;
      this._update({ decoding: false });
    }
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    const w = this.createWorker();
    this._worker = w;
    w.on('message', (msg) => this._handleWorker(msg));
    w.on('error', (err) => {
      this._error(`The decoder stopped: ${err.message}`);
      for (const p of this._pending.values()) p.reject(err);
      this._pending.clear();
      this._decoding = false;
      this._worker = null;
    });
    return w;
  }

  _call(msg, transfer) {
    const w = this._ensureWorker();
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id }, transfer);
    });
  }

  _handleWorker(msg) {
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error));
    else p.resolve(msg);
  }

  _sync() {
    const should = this._active && !this._pttActive && !this.unavailable;
    if (should && !this._attached) this._attach();
    else if (!should && this._attached) this._detach();
  }

  _attach() {
    this._decimator = new StreamDecimator(this.audioBridge.sampleRate, RATE);
    this._slotFill = 0;
    this._slotWhole = false;
    this._spectrumFilled = 0;
    this.audioBridge.capture.on('data', this._onPcm);
    this._attached = true;
    this._spectrumTimer = setInterval(() => this._emitSpectrum(), FT8_SPECTRUM_INTERVAL_MS);
    this._spectrumTimer.unref?.();
  }

  _detach() {
    this.audioBridge.capture.off('data', this._onPcm);
    this._attached = false;
    this._decimator = null;
    this._slotFill = 0;
    this._slotWhole = false;
    if (this._spectrumTimer) clearInterval(this._spectrumTimer);
    this._spectrumTimer = null;
  }

  _handlePcm(chunk) {
    const count = Math.floor(chunk.length / 2);
    if (count === 0 || !this._decimator) return;
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) samples[i] = chunk.readInt16LE(i * 2);
    const out = this._decimator.process(samples);
    if (out.length === 0) return;
    const room = SLOT_SAMPLES - this._slotFill;
    if (room > 0) {
      const n = Math.min(room, out.length);
      this._slot.set(out.subarray(0, n), this._slotFill);
      this._slotFill += n;
    }
    this._pushSpectrum(out);
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
    const { magnitudes, binHz } = computeMagnitudeSpectrum(this._spectrumRing, { fftSize: SPECTRUM_FFT_SIZE, sampleRate: RATE });
    const binCount = Math.min(magnitudes.length, Math.round(FT8_SPECTRUM_MAX_HZ / binHz));
    this.controlServer.broadcastBinary?.(encodeFt8SpectrumFrame(binHz, _dbToScaledBytes(magnitudes, binCount)));
  }

  _handleBoundary({ slotStartMs }) {
    // The slot that just ended.
    if (this._attached) {
      if (this._slotWhole && this._slotFill >= MIN_SLOT_SAMPLES) this._decodeSlot(slotStartMs - SLOT_MS, this._slot.slice(0, this._slotFill));
      this._slotFill = 0;
      this._slotWhole = true;
    }
    if (this._active && this._queue.length && !this._keyed) this._sendNextFrame(slotStartMs);
  }

  _decodeSlot(slotStartMs, samples) {
    if (this._decoding) return; // the last one is still running: the Pi is too slow for every slot
    this._decoding = true;
    this._update({ decoding: true });
    const dialHz = this.controlServer.state.frequency;
    this._call({ type: 'decode', samples: samples.buffer, nfa: 200, nfb: 2900, nfqso: this.state.txHz }, [samples.buffer])
      .then(({ decodes }) => {
        const entries = decodes.map((d) => this._entry(d, slotStartMs, dialHz));
        if (entries.length) {
          this._remember(entries);
          this.controlServer.broadcastJsonEvent(EVENT.JS8_DECODES, { slotStartMs, dialHz, decodes: entries });
          for (const e of entries) this._spot(e, dialHz, slotStartMs);
        }
      })
      .catch((err) => {
        if (this._active) this._error(`decoding failed: ${err.message}`);
      })
      .finally(() => {
        this._decoding = false;
        this._update({ decoding: false });
      });
  }

  _entry(d, slotStartMs, dialHz) {
    const info = d.info || {};
    const e = {
      slotStartMs,
      dialHz: Number.isFinite(dialHz) ? dialHz : null,
      freq: Math.round(d.freq),
      dt: Math.round(d.dt * 10) / 10,
      snr: d.snr,
      text: d.text,
      first: (d.bits & 1) === 1,
      last: (d.bits & 2) === 2,
    };
    for (const k of ['from', 'to', 'cmd', 'num', 'grid']) if (info[k]) e[k] = String(info[k]).trim();
    if (info.cq) e.cq = true;
    if (info.heartbeat) e.heartbeat = true;
    if (info.frameType === 4) e.data = true;
    return e;
  }

  _remember(entries) {
    this._history.push(...entries);
    if (this._history.length > HISTORY_MAX) this._history.splice(0, this._history.length - HISTORY_MAX);
  }

  /** PSK Spot: the stations a frame names as its sender (CQ, heartbeat, directed). */
  _spot(e, dialHz, slotStartMs) {
    if (!this.pskReporter || !this.controlServer.state.pskSpotEnabled) return;
    if (!Number.isFinite(dialHz) || dialHz <= 0) return;
    const call = e.from;
    if (!call || !PSK_CALLSIGN_RE.test(call) || call === this.callsign) return;
    this.pskReporter.addSpot({ call, grid: e.grid && /^[A-R]{2}\d{2}$/.test(e.grid) ? e.grid : null, freqHz: dialHz + e.freq, snr: e.snr, mode: 'JS8', timeSec: Math.floor(slotStartMs / 1000) });
  }

  /**
   * A browser's JS8 request: {action: 'send', text} | {action: 'cq'} | {action: 'stop'}.
   * Throws if it can't be done (ws-server.js returns the message to that browser).
   */
  async request({ action, text } = {}) {
    if (action === 'stop') {
      await this._stopSending('Stopped');
      return {};
    }
    if (!this._active) throw new Error(this.unavailable || 'JS8 is not on.');
    if (!this.callsign) throw new Error('JS8 needs STATION_CALLSIGN set on the server to transmit.');
    if (this._queue.length || this.state.sending) throw new Error('A message is still being sent. Wait for it, or press Stop.');
    let message;
    if (action === 'cq') message = this.grid ? `CQ CQ CQ ${this.grid}` : 'CQ CQ CQ';
    else if (action === 'send') message = cleanText(text);
    else throw new Error(`Unknown JS8 action "${action}"`);
    if (!message) throw new Error('Nothing to send.');
    if (message.length > MAX_TEXT) throw new Error(`Too long (${MAX_TEXT} characters at most).`);
    const { frames } = await this._call({ type: 'encode', mycall: this.callsign, mygrid: this.grid, text: message });
    if (!frames.length) throw new Error('Nothing to send.');
    if (frames.length > MAX_FRAMES) throw new Error(`That needs ${frames.length} frames (${Math.ceil((frames.length * SLOT_MS) / 60000)} minutes); ${MAX_FRAMES} (10 minutes) is the most. Shorten it.`);
    if (this._queue.length || this.state.sending) throw new Error('A message is still being sent. Wait for it, or press Stop.');
    this._queue = frames.slice();
    this._txSession++;
    this._update({
      sending: { text: message, frames: frames.map((f) => f.text), sent: 0, total: frames.length, startsAt: this.slotClock.nextSlotStart() },
    });
    return { frames: frames.length, startsAt: this.state.sending.startsAt };
  }

  async _sendNextFrame(slotStartMs) {
    const f = this._queue.shift();
    if (!f) return;
    const session = this._txSession;
    const sending = this.state.sending;
    const txHz = this.state.txHz;
    try {
      const tones = encodeTones(f.frame, f.bits);
      const leadMs = Math.max(0, START_DELAY_MS - this.latencyMs);
      const tone = synthesize(tones, txHz, { sampleRate: RATE, amplitude: this.amplitude });
      const lead = Math.round((leadMs * RATE) / 1000);
      const audio = new Float32Array(lead + tone.length);
      audio.set(tone, lead);
      const pcm = upsampleFloatToPcm(audio, RATE, this.audioBridge.sampleRate);
      const civ = this.controlServer.civ;
      // DATA mode must be on, or PTT would put the microphone on the air.
      if (civ) await ensureDataMode(civ, true, { settleMs: this.dataSettleMs });
      if (session !== this._txSession) return;
      this._keyed = true;
      await this.controlServer.setPttFromServer(true);
      this._update({ keyed: true });
      if (session !== this._txSession) {
        await this._unkey();
        return;
      }
      this.audioBridge.playback.write(pcm);
      const own = { slotStartMs, freq: txHz, snr: null, text: f.text, own: true, first: (f.bits & 1) === 1, last: (f.bits & 2) === 2 };
      this._remember([own]);
      this.controlServer.broadcastJsonEvent(EVENT.JS8_DECODES, { slotStartMs, dialHz: this.controlServer.state.frequency, decodes: [own] });
      const holdMs = (pcm.length / 2 / this.audioBridge.sampleRate) * 1000 + this.latencyMs + PTT_TAIL_MS;
      await new Promise((resolve) => {
        this._releaseTimer = this.setTimer(resolve, holdMs);
        this._releaseResolve = resolve;
      });
      this._releaseTimer = null;
      this._releaseResolve = null;
      if (session !== this._txSession) return; // stopped: _stopSending() unkeyed
      await this._unkey();
      if (sending) {
        const sent = sending.sent + 1;
        this._update({ sending: this._queue.length ? { ...sending, sent } : null });
      }
    } catch (err) {
      this._error(`transmit failed: ${err.message}`);
      this._queue = [];
      this._txSession++;
      await this._unkey();
      this._update({ sending: null });
    }
  }

  async _unkey() {
    if (!this._keyed) return;
    this._keyed = false;
    try {
      await this.controlServer.setPttFromServer(false);
    } catch (err) {
      this._error(`couldn't release PTT: ${err.message}`);
    }
    this._update({ keyed: false });
  }

  async _stopSending() {
    this._queue = [];
    this._txSession++;
    if (this._releaseTimer) {
      this.clearTimer(this._releaseTimer);
      this._releaseTimer = null;
      this._releaseResolve?.();
      this._releaseResolve = null;
    }
    if (this._keyed) {
      this.audioBridge.playback.restart?.(); // drop the rest of the frame's audio
      await this._unkey();
    }
    this._update({ sending: null });
  }
}

module.exports = { Js8Bridge, clampJs8TxHz, cleanText, MAX_FRAMES, SLOT_MS, MIN_TX_HZ, MAX_TX_HZ, DEFAULT_TX_HZ };
