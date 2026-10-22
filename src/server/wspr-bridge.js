'use strict';

/**
 * WSPR receive and transmit.
 *
 * WSPR runs in 2-minute slots that start on even UTC minutes. A
 * transmission starts 1 s into the slot and lasts 110.6 s. Every slot
 * that is not transmitting is decoded (in a worker thread, with
 * wspr-rx.js) and the spots are broadcast, and uploaded to wsprnet.org
 * unless that is turned off (WSPR_UPLOAD=off).
 *
 * WSPR is an app-level mode on USB + DATA MODE, like FT8: the client's
 * DIGI button sets the radio up and sends SET_WSPR_ACTIVE. While it is
 * on, this bridge holds the TX power at 5 W or less (WSPR is a
 * low-power mode; the client's power menu offers 1-5 W) and puts the
 * earlier power back when WSPR is turned off.
 *
 * Transmitting is off until a client turns it on (SET_WSPR_TX). Then
 * about one slot in five transmits, picked at random a slot ahead (the
 * way WSJT-X's "Tx Pct 20" spreads transmissions so stations don't keep
 * colliding). The message is STATION_CALLSIGN, the first 4 characters of
 * the grid, and the power in dBm read from the radio just before
 * keying.
 *
 * Unattended receive (WSPR_UNATTENDED=on, off by default): 10 minutes
 * after the last browser leaves, the radio is put on the WSPR frequency
 * of its current band (USB, DATA on) and WSPR receives (never
 * transmits) until a browser connects again. Then the frequency, mode
 * and DATA mode from before are put back. While receiving unattended it
 * moves to the next band every 6 minutes (WSPR_BAND_MINUTES, whole
 * 2-minute slots), 160 m up to 6 m and round again, leaving out
 * WSPR_SKIP_BANDS (WSPR_BAND_CYCLE=off stays on the one band). After each
 * band change it starts the radio's antenna tuner (the only transmission
 * unattended receive makes; see _tune() for its time limit).
 */

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ensureDataMode, watchDataMode } = require('../civ/data-mode-guard');
const { SlotClock } = require('../audio/slot-clock');
const { StreamDecimator } = require('../audio/decimator');
const { computeMagnitudeSpectrum } = require('../audio/fft');
const { encodeFt8SpectrumFrame, _dbToScaledBytes } = require('../audio/ft8-bridge');
const codec = require('../audio/wspr-codec');
const { WsprNetClient } = require('./wsprnet');
const { EVENT } = require('./protocol');

const SLOT_MS = 120000;
const RATE = 12000;
const DECODE_SECONDS = 114; // what wsprd reads
const MAX_START_GAP_MS = 20000; // a slot whose audio starts later than this is not decoded
const TX_START_MS = 1000; // a transmission starts 1 s into the slot
const TX_PCT = 20;
const MAX_POWER_W = 5;
const TX_HZ_MIN = 1410;
const TX_HZ_MAX = 1590;
const DEFAULT_TX_HZ = 1500;
const UNATTENDED_DELAY_MS = 10 * 60 * 1000;
const PTT_RELEASE_MARGIN_MS = 300;
const DECODE_BUDGET_MS = 60000; // then the Fano limit drops (see wspr-rx.js), so a busy slot ends in time
const BACKLOG = 100;
const MAX_HASHES = 2000;
const SPECTRUM_FFT = 4096;
const SPECTRUM_MAX_HZ = 3000;
const SPECTRUM_INTERVAL_MS = 250;

/** WSPR dial frequencies (USB; the signals are at 1400-1600 Hz audio), Hz. */
const WSPR_DIAL_HZ = {
  '160m': 1836600,
  '80m': 3568600,
  '40m': 7038600,
  '30m': 10138700,
  '20m': 14095600,
  '17m': 18104600,
  '15m': 21094600,
  '12m': 24924600,
  '10m': 28124600,
  '6m': 50293000,
};

const BAND_ORDER = Object.keys(WSPR_DIAL_HZ); // 160 m up to 6 m

/**
 * The band after the one `hz` is on, in `bands` (the cycle, low to high),
 * round to the lowest after the highest. From a band not in `bands`, the
 * next one above it that is.
 */
function nextWsprBand(hz, bands = BAND_ORDER) {
  if (!bands.length) return null;
  const i = BAND_ORDER.findIndex((b) => WSPR_DIAL_HZ[b] === hz);
  for (let k = 1; k <= BAND_ORDER.length; k++) {
    const b = BAND_ORDER[(i + k + BAND_ORDER.length) % BAND_ORDER.length];
    if (bands.includes(b)) return b;
  }
  return bands[0];
}

/**
 * WSPR_SKIP_BANDS: "160m, 6m" or "160 6" -> ['160m', '6m']. Unknown names
 * are returned in `unknown`.
 */
function parseBandList(text) {
  const bands = [];
  const unknown = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    if (!raw) continue;
    const name = /m$/i.test(raw) ? raw.toLowerCase() : `${raw.toLowerCase()}m`;
    if (WSPR_DIAL_HZ[name]) bands.push(name);
    else unknown.push(raw);
  }
  return { bands, unknown };
}

const TUNE_LIMIT_MS = 15000; // the IC-7300's tuner takes a few seconds
const TUNE_POLL_MS = 500;
const TUNE_START_MS = 1000; // before the first check that it has finished

const bandOf = (hz) => BAND_ORDER.find((b) => WSPR_DIAL_HZ[b] === hz) ?? null;

/** The WSPR dial frequency for the band `hz` is in (20 m if it isn't near one). */
function wsprDialFor(hz) {
  let best = WSPR_DIAL_HZ['20m'];
  if (!Number.isFinite(hz) || hz <= 0) return best;
  let bestRatio = Infinity;
  for (const f of Object.values(WSPR_DIAL_HZ)) {
    const r = Math.abs(Math.log(hz / f));
    if (r < bestRatio) {
      bestRatio = r;
      best = f;
    }
  }
  // within about 8% means the same band
  return bestRatio < 0.08 ? best : WSPR_DIAL_HZ['20m'];
}

function clampTxHz(hz) {
  return Math.round(Math.max(TX_HZ_MIN, Math.min(TX_HZ_MAX, hz)));
}

function floatToPcm(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

/** Runs decodes in a worker thread. Returns {decode(samples, hashtab, deadline) -> Promise, terminate()}. */
function workerDecoder() {
  const worker = new Worker(path.join(__dirname, '..', 'audio', 'wspr-decode-worker.js'));
  worker.unref();
  const pending = new Map();
  let next = 1;
  worker.on('message', (msg) => {
    const p = pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    if (msg.type === 'decoded') p.resolve({ decodes: msg.decodes, hashtab: msg.hashtab });
    else p.reject(new Error(msg.error));
  });
  worker.on('error', (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });
  return {
    decode(samples, hashtab, deadline) {
      return new Promise((resolve, reject) => {
        const requestId = next++;
        pending.set(requestId, { resolve, reject });
        const copy = Float32Array.from(samples);
        worker.postMessage({ type: 'decode', requestId, samples: copy.buffer, hashtab, deadline }, [copy.buffer]);
      });
    },
    terminate() {
      worker.terminate();
    },
  };
}

class WsprBridge {
  /**
   * @param {object} opts
   * @param {object} opts.controlServer
   * @param {object} opts.audioBridge - {capture, playback, sampleRate}
   * @param {string} [opts.callsign] - STATION_CALLSIGN
   * @param {string} [opts.grid] - WSPR_GRID or STATION_GRID (4 or 6 characters)
   * @param {boolean} [opts.upload=true] - send spots to wsprnet.org
   * @param {boolean} [opts.unattended=false] - receive on our own when nobody is connected
   * @param {number} [opts.unattendedDelayMs=600000]
   * @param {boolean} [opts.bandCycle=true] - unattended receive changes band
   * @param {string[]} [opts.skipBands] - bands left out of the cycle, e.g. ['160m', '6m']
   * @param {number} [opts.bandMinutes=6] - minutes on each band (rounded to whole 2-minute slots)
   * @param {boolean} [opts.tune=true] - start the antenna tuner after each band change
   * @param {string} [opts.version] - sent to wsprnet.org
   * Test hooks: slotClock, decoder ({decode, terminate}), wsprnet, now, random,
   * setTimer/clearTimer, dataSettleMs, dataWatchMs, pttReleaseMarginMs, spectrumIntervalMs.
   */
  constructor({
    controlServer,
    audioBridge,
    callsign,
    grid,
    upload = true,
    unattended = false,
    unattendedDelayMs = UNATTENDED_DELAY_MS,
    bandCycle = true,
    skipBands = [],
    bandMinutes = 6,
    tune = true,
    tuneLimitMs = TUNE_LIMIT_MS,
    tunePollMs = TUNE_POLL_MS,
    tuneStartMs = TUNE_START_MS,
    version = 'PiRO',
    slotClock,
    decoder,
    wsprnet,
    now = Date.now,
    random = Math.random,
    dataSettleMs,
    dataWatchMs,
    pttReleaseMarginMs = PTT_RELEASE_MARGIN_MS,
    spectrumIntervalMs = SPECTRUM_INTERVAL_MS,
    decodeBudgetMs = DECODE_BUDGET_MS,
    amplitude = 1.0, // full scale, as FT8 and the TTY modes, so the same ALC setting works
  } = {}) {
    if (!controlServer) throw new Error('WsprBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('WsprBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.callsign = String(callsign || '').trim().toUpperCase();
    this.grid = String(grid || '').trim().toUpperCase();
    this.uploadEnabled = upload !== false;
    this.unattendedEnabled = unattended === true;
    this.unattendedDelayMs = unattendedDelayMs;
    this.bandCycle = bandCycle !== false;
    this.cycleBands = BAND_ORDER.filter((b) => !skipBands.includes(b));
    if (this.cycleBands.length === 0) this.bandCycle = false; // every band skipped: stay put
    this.bandSlots = Math.max(1, Math.round((Number(bandMinutes) || 6) / 2));
    this.tune = tune !== false;
    this.tuneLimitMs = tuneLimitMs;
    this.tunePollMs = tunePollMs;
    this.tuneStartMs = tuneStartMs;
    this._slotsOnBand = 0;
    this._hop = null; // the band change in progress (unattended band cycle)
    this.version = version;
    this.now = now;
    this.random = random;
    this.dataSettleMs = dataSettleMs;
    this.dataWatchMs = dataWatchMs;
    this.pttReleaseMarginMs = pttReleaseMarginMs;
    this.spectrumIntervalMs = spectrumIntervalMs;
    this.decodeBudgetMs = decodeBudgetMs;
    this.amplitude = amplitude;
    this.slotClock = slotClock ?? new SlotClock({ slotMs: SLOT_MS, now });
    this._decoder = decoder ?? null; // made on first use (a worker thread)
    this.wsprnet = wsprnet ?? new WsprNetClient();

    this._active = false; // a browser has WSPR on
    this._unattended = null; // {saved: {frequency, mode, filter, dataMode}} while receiving unattended
    this._unattendedTimer = null;
    this._starting = null; // the unattended start in progress
    this._pttActive = false; // someone else is transmitting (voice PTT)
    this._tx = null;
    this._attached = false;
    this._capture = null; // {slotStartMs, startMs, dialHz, chunks: Float32Array[], samples}
    this._decimator = null;
    this._spectrum = new Float32Array(SPECTRUM_FFT);
    this._spectrumFill = 0;
    this._spectrumTimer = null;
    this._prevPower = null; // power before WSPR turned it down
    this._powerBusy = Promise.resolve();
    this._hashtab = new Map();
    this.backlog = [];
    this._credit = 0.8; // TX scheduling, see _planNextTx()
    this._lastSlotWasTx = false;
    this._plannedTxSlot = null;

    const plain = codec.isPlainCall(this.callsign);
    const grid4 = /^[A-R]{2}[0-9]{2}/.test(this.grid);
    this.status = {
      phase: 'idle',
      slotStartMs: null,
      slotEndMs: null,
      txEnabled: false,
      txHz: DEFAULT_TX_HZ,
      txPct: TX_PCT,
      canTransmit: plain && grid4,
      txReason: !this.callsign
        ? 'Set STATION_CALLSIGN to transmit.'
        : !plain
          ? `WSPR can only send a plain callsign of up to 6 characters (not ${this.callsign}).`
          : !grid4
            ? 'Set WSPR_GRID (or STATION_GRID) to transmit.'
            : null,
      txMessage: plain && grid4 ? `${this.callsign} ${this.grid.slice(0, 4)}` : null,
      nextTx: null,
      upload: this.uploadEnabled && !!this.callsign && grid4,
      uploadStatus: null,
      unattended: false,
      unattendedEnabled: this.unattendedEnabled,
      bandCycle: this.unattendedEnabled && this.bandCycle,
      cycleBands: this.cycleBands,
      bandMinutes: this.bandSlots * 2,
      tuning: false,
      unattendedBand: null,
      decoding: false,
      lastSlotStartMs: null,
      lastDecodeCount: null,
    };
    controlServer.state.wspr = { ...this.status };

    this._onActive = (on) => this.setActive(on).catch((err) => this._warn(err.message));
    this._onTxRequest = (req) => this.setTx(req);
    this._onPtt = (on) => {
      // our own transmissions also arrive here; only someone else's matter
      if (this._tx) return;
      this._pttActive = on;
      this._syncAttachment();
    };
    this._onBoundary = ({ slotStartMs }) => this._handleBoundary(slotStartMs);
    this._onClientJoined = (ws) => this._clientJoined(ws);
    this._onClientGone = () => this._clientGone();
  }

  start() {
    const cs = this.controlServer;
    cs.on('wspr-active', this._onActive);
    cs.on('wspr-tx', this._onTxRequest);
    cs.on('ptt', this._onPtt);
    cs.on('client-connected', this._onClientJoined);
    cs.on('client-disconnected', this._onClientGone);
    this.slotClock.on('boundary', this._onBoundary);
    this.slotClock.start();
    if (cs.state.wsprActive) this._onActive(true);
    if (this._clientCount() === 0) this._armUnattended();
  }

  stop() {
    const cs = this.controlServer;
    cs.off('wspr-active', this._onActive);
    cs.off('wspr-tx', this._onTxRequest);
    cs.off('ptt', this._onPtt);
    cs.off('client-connected', this._onClientJoined);
    cs.off('client-disconnected', this._onClientGone);
    this.slotClock.off('boundary', this._onBoundary);
    this.slotClock.stop();
    this._cancelUnattendedTimer();
    this._abortTx();
    this._detach();
    if (this._decoder) this._decoder.terminate();
  }

  get attached() {
    return this._attached;
  }

  get transmitting() {
    return this._tx !== null;
  }

  _clientCount() {
    return this.controlServer.clients ? this.controlServer.clients.size : 0;
  }

  _civ() {
    return this.controlServer.civ ?? null;
  }

  _setStatus(patch) {
    Object.assign(this.status, patch);
    this.controlServer.state.wspr = { ...this.status };
    this.controlServer.broadcastJsonEvent(EVENT.WSPR_STATUS, { ...this.status });
  }

  _warn(message) {
    console.warn(`WSPR: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { message: `WSPR: ${message}` });
  }

  // ------------------------------------------------------------ on / off

  /** A browser turned WSPR on or off. */
  async setActive(on) {
    if (on === this._active) return;
    this._active = on;
    if (on) {
      this._cancelUnattendedTimer();
      if (this._unattended) await this._stopUnattended();
      await this._limitPower();
      if (this.status.txEnabled) this._planNextTx(this.slotClock.currentSlotStart());
    } else {
      this._abortTx();
      this._plannedTxSlot = null;
      this._setStatus({ nextTx: null });
      await this._restorePower();
    }
    this._syncAttachment();
  }

  /** SET_WSPR_TX: transmit on/off and the audio frequency. */
  setTx({ enabled, txHz } = {}) {
    const patch = {};
    if (Number.isFinite(txHz)) patch.txHz = clampTxHz(txHz);
    if (typeof enabled === 'boolean') {
      patch.txEnabled = enabled && this.status.canTransmit;
      if (enabled && !this.status.canTransmit) this._warn(this.status.txReason || 'cannot transmit');
    }
    this._setStatus(patch);
    if (patch.txEnabled === false) {
      this._plannedTxSlot = null;
      this._setStatus({ nextTx: null });
      this._abortTx();
    } else if (patch.txEnabled && this._active && this._plannedTxSlot == null) {
      this._planNextTx(this.slotClock.currentSlotStart());
    }
  }

  /** WSPR is low power: hold the radio at 5 W or less while WSPR is on. */
  _limitPower() {
    const civ = this._civ();
    if (!civ || typeof civ.getTxPower !== 'function') return Promise.resolve();
    this._powerBusy = this._powerBusy.then(async () => {
      try {
        const w = await civ.getTxPower();
        if (Number.isFinite(w) && w > MAX_POWER_W) {
          if (this._prevPower == null) this._prevPower = w;
          await civ.setTxPower(MAX_POWER_W);
        }
      } catch (err) {
        this._warn(`could not set the power to ${MAX_POWER_W} W: ${err.message}`);
      }
    });
    return this._powerBusy;
  }

  _restorePower() {
    const civ = this._civ();
    if (!civ || this._prevPower == null) return Promise.resolve();
    this._powerBusy = this._powerBusy.then(async () => {
      const w = this._prevPower;
      this._prevPower = null;
      try {
        await civ.setTxPower(w);
      } catch (err) {
        this._warn(`could not put the power back to ${w} W: ${err.message}`);
      }
    });
    return this._powerBusy;
  }

  // ------------------------------------------------------------ receiving

  _receiving() {
    return (this._active || !!this._unattended) && !this._pttActive && !this._tx;
  }

  _syncAttachment() {
    const want = this._receiving();
    if (want && !this._attached) this._attach();
    else if (!want && this._attached) this._detach();
    const phase = this._tx ? 'tx' : this._attached ? 'rx' : 'idle';
    if (phase !== this.status.phase) this._setStatus({ phase });
  }

  _attach() {
    const rate = this.audioBridge.sampleRate;
    try {
      this._decimator = new StreamDecimator(rate, RATE, { cutoffHz: 3000 });
    } catch (err) {
      this._warn(err.message);
      return;
    }
    this._onPcm = (chunk) => this._pushPcm(chunk);
    this.audioBridge.capture.on('data', this._onPcm);
    this._attached = true;
    this._newCapture(this.slotClock.currentSlotStart(), this.now());
    this._spectrumFill = 0;
    this._spectrumTimer = setInterval(() => this._emitSpectrum(), this.spectrumIntervalMs);
    this._spectrumTimer.unref?.();
  }

  _detach() {
    if (!this._attached) return;
    this.audioBridge.capture.off('data', this._onPcm);
    this._attached = false;
    this._capture = null;
    this._decimator = null;
    if (this._spectrumTimer) clearInterval(this._spectrumTimer);
    this._spectrumTimer = null;
  }

  _newCapture(slotStartMs, startMs) {
    this._capture = {
      slotStartMs,
      startMs,
      dialHz: this.controlServer.state.frequency,
      chunks: [],
      samples: 0,
    };
  }

  _pushPcm(chunk) {
    if (!this._decimator || !this._capture) return;
    const n = Math.floor(chunk.length / 2);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = chunk.readInt16LE(2 * i) / 32768;
    const y = this._decimator.process(x);
    if (y.length === 0) return;
    const cap = this._capture;
    if (cap.samples < DECODE_SECONDS * RATE) {
      cap.chunks.push(y);
      cap.samples += y.length;
    }
    // the last SPECTRUM_FFT samples, for the waterfall
    if (y.length >= SPECTRUM_FFT) this._spectrum.set(y.subarray(y.length - SPECTRUM_FFT));
    else {
      this._spectrum.copyWithin(0, y.length);
      this._spectrum.set(y, SPECTRUM_FFT - y.length);
    }
    this._spectrumFill = Math.min(SPECTRUM_FFT, this._spectrumFill + y.length);
  }

  _emitSpectrum() {
    if (this._spectrumFill < SPECTRUM_FFT || this._clientCount() === 0) return;
    const { magnitudes, binHz } = computeMagnitudeSpectrum(this._spectrum, { fftSize: SPECTRUM_FFT, sampleRate: RATE });
    const binCount = Math.min(magnitudes.length, Math.round(SPECTRUM_MAX_HZ / binHz));
    this.controlServer.broadcastBinary(encodeFt8SpectrumFrame(binHz, _dbToScaledBytes(magnitudes, binCount)));
  }

  _handleBoundary(slotStartMs) {
    const cap = this._capture;
    if (this._attached && cap) {
      this._decodeSlot(cap); // checks the dial first, before the band changes below
      if (this._unattended && this.bandCycle && ++this._slotsOnBand >= this.bandSlots) this._hopBand(slotStartMs);
      else this._newCapture(slotStartMs, slotStartMs);
    }
    this._setStatus({ slotStartMs, slotEndMs: slotStartMs + SLOT_MS });
    if (this._active && this.status.txEnabled && this._plannedTxSlot === slotStartMs) {
      this._plannedTxSlot = null;
      this._lastSlotWasTx = true;
      this._transmit(slotStartMs).catch(() => {});
    } else {
      this._lastSlotWasTx = false;
    }
    if (this._active && this.status.txEnabled) this._planNextTx(slotStartMs);
    else if (this.status.nextTx != null) this._setStatus({ nextTx: null });
  }

  /**
   * Decides, a slot ahead, whether the next slot transmits. Each slot adds
   * TX_PCT/100 credit; a slot transmits at random once there is a whole
   * credit, and for certain at 1.6, never twice running. Over time that is
   * TX_PCT of the slots, spread at random.
   */
  _planNextTx(slotStartMs) {
    const next = slotStartMs + SLOT_MS;
    if (this._plannedTxSlot === next) return;
    this._credit = Math.min(2, this._credit + TX_PCT / 100);
    let tx = false;
    if (!this._lastSlotWasTx && this._credit >= 1 && (this._credit >= 1.6 || this.random() < 0.5)) {
      this._credit -= 1;
      tx = true;
    }
    this._plannedTxSlot = tx ? next : null;
    this._setStatus({ nextTx: tx ? next : null });
  }

  async _decodeSlot(cap) {
    const gapMs = cap.startMs - cap.slotStartMs;
    if (gapMs > MAX_START_GAP_MS || cap.samples < RATE * 60) return;
    const dialHz = cap.dialHz;
    if (!Number.isFinite(dialHz) || this.controlServer.state.frequency !== dialHz) return; // retuned during the slot
    const total = DECODE_SECONDS * RATE;
    const samples = new Float32Array(total);
    let o = Math.max(0, Math.round((gapMs / 1000) * RATE));
    for (const c of cap.chunks) {
      if (o >= total) break;
      const n = Math.min(c.length, total - o);
      samples.set(c.subarray(0, n), o);
      o += n;
    }
    if (!this._decoder) this._decoder = workerDecoder();
    this._setStatus({ decoding: true });
    let result;
    try {
      result = await this._decoder.decode(samples, [...this._hashtab], this.now() + this.decodeBudgetMs);
    } catch (err) {
      this._setStatus({ decoding: false });
      this._warn(`decode failed: ${err.message}`);
      return;
    }
    for (const [h, call] of result.hashtab) this._hashtab.set(h, call);
    while (this._hashtab.size > MAX_HASHES) this._hashtab.delete(this._hashtab.keys().next().value);
    const decodes = result.decodes.map((d) => ({ ...d, slotStartMs: cap.slotStartMs, dialHz }));
    this.backlog.push(...decodes);
    if (this.backlog.length > BACKLOG) this.backlog.splice(0, this.backlog.length - BACKLOG);
    this._setStatus({ decoding: false, lastSlotStartMs: cap.slotStartMs, lastDecodeCount: decodes.length });
    this.controlServer.broadcastJsonEvent(EVENT.WSPR_DECODES, { slotStartMs: cap.slotStartMs, dialHz, decodes });
    // internal: feeds "Current conditions" (server/band-conditions.js), including slots that heard nothing
    this.controlServer.emit('wspr-slot-decoded', { slotStartMs: cap.slotStartMs, dialHz, decodes });
    if (this.status.upload) this._upload(cap.slotStartMs, dialHz, decodes);
  }

  _upload(slotStartMs, dialHz, decodes) {
    const w = this._lastDbm ?? 37;
    this.wsprnet
      .upload({
        rcall: this.callsign,
        rgrid: this.grid,
        dialHz,
        slotStartMs,
        decodes,
        tpct: this.status.txEnabled && !this._unattended ? TX_PCT : 0,
        txHz: this.status.txHz,
        dbm: w,
        version: this.version,
      })
      .then((r) => {
        this._setStatus({ uploadStatus: { time: this.now(), slotStartMs, spots: decodes.length, ok: !r.error, error: r.error || undefined } });
        if (r.error) console.warn(`WSPR: wsprnet.org upload failed: ${r.error}`);
      });
  }

  // ------------------------------------------------------------ transmitting

  async _transmit(slotStartMs) {
    const civ = this._civ();
    const tx = { aborted: false, timer: null, wake: null };
    this._tx = tx;
    this._syncAttachment();
    let keyed = false;
    let stopWatch = null;
    const wait = (ms) =>
      new Promise((resolve) => {
        tx.wake = resolve;
        tx.timer = setTimeout(resolve, Math.max(0, ms));
      });
    try {
      if (this.controlServer.state?.ptt) throw new Error('the radio is already transmitting');
      let watts = MAX_POWER_W;
      if (civ) {
        const { mode } = await civ.getMode();
        if (mode !== 'USB') throw new Error('put the radio on USB (the DIGI button does this)');
        const w = await civ.getTxPower();
        if (Number.isFinite(w)) watts = w;
        if (watts > MAX_POWER_W) {
          if (this._prevPower == null) this._prevPower = watts;
          await civ.setTxPower(MAX_POWER_W);
          watts = MAX_POWER_W;
        }
      }
      const dbm = codec.wattsToDbm(Math.max(watts, 0.001));
      this._lastDbm = dbm;
      const { symbols, message } = codec.encodeMessage(this.callsign, this.grid.slice(0, 4), dbm);
      const pcm = floatToPcm(
        codec.synthesize(symbols, { baseHz: this.status.txHz, sampleRate: this.audioBridge.sampleRate, amplitude: this.amplitude })
      );
      if (tx.aborted) return;
      if (civ) await ensureDataMode(civ, true, { settleMs: this.dataSettleMs });
      if (tx.aborted) return;
      keyed = true;
      await this.controlServer.setPttFromServer(true);
      const durationSec = pcm.length / 2 / this.audioBridge.sampleRate;
      this._setStatus({ phase: 'tx', txMessage: message, txStartMs: slotStartMs + TX_START_MS, txDurationSec: Math.round(durationSec * 10) / 10 });
      await wait(slotStartMs + TX_START_MS - this.now());
      if (tx.aborted) return;
      this.audioBridge.playback.write(pcm);
      if (civ) {
        stopWatch = watchDataMode(civ, {
          intervalMs: this.dataWatchMs,
          onLost: () => this._warn('DATA mode was turned off during the transmission; turned it back on.'),
        });
      }
      await wait(durationSec * 1000 + this.pttReleaseMarginMs);
    } catch (err) {
      this._warn(`transmit failed: ${err.message}`);
    } finally {
      if (stopWatch) await stopWatch().catch(() => {});
      if (keyed) {
        try {
          await this.controlServer.setPttFromServer(false);
        } catch {
          // best effort; the PTT watchdog is still armed
        }
      }
      if (this._tx === tx) this._tx = null;
      this._syncAttachment();
    }
  }

  _abortTx() {
    const tx = this._tx;
    if (!tx || tx.aborted) return;
    tx.aborted = true;
    if (tx.timer) clearTimeout(tx.timer);
    if (typeof this.audioBridge.playback?.restart === 'function') this.audioBridge.playback.restart();
    if (tx.wake) tx.wake();
  }

  // ------------------------------------------------------------ browsers and unattended receive

  _clientJoined(ws) {
    this._cancelUnattendedTimer();
    if (this._unattended || this._starting) this._stopUnattended().catch((err) => this._warn(err.message));
    if (typeof this.controlServer.sendJsonEvent === 'function') {
      if (this.backlog.length) this.controlServer.sendJsonEvent(ws, EVENT.WSPR_DECODES, { decodes: this.backlog, replace: true });
    }
  }

  _clientGone() {
    if (this._clientCount() !== 0) return;
    // ControlServer turns WSPR off (wspr-active false) when the last browser leaves.
    this._abortTx();
    this._armUnattended();
  }

  _armUnattended() {
    if (!this.unattendedEnabled || this._unattendedTimer || this._unattended) return;
    this._unattendedTimer = setTimeout(() => {
      this._unattendedTimer = null;
      this._startUnattended().catch((err) => this._warn(`unattended receive did not start: ${err.message}`));
    }, this.unattendedDelayMs);
    this._unattendedTimer.unref?.();
  }

  _cancelUnattendedTimer() {
    if (this._unattendedTimer) clearTimeout(this._unattendedTimer);
    this._unattendedTimer = null;
  }

  /**
   * Unattended band cycle: moves to the next band's WSPR frequency at a slot
   * boundary. Nothing is captured until the radio is there, so the slot is
   * decoded on the new band (its first fraction of a second is silence; a
   * transmission starts 1 s in).
   */
  _hopBand(slotStartMs) {
    this._capture = null;
    this._slotsOnBand = 0;
    const civ = this._civ();
    const state = this.controlServer.state;
    const dial = WSPR_DIAL_HZ[nextWsprBand(state.frequency, this.cycleBands)];
    this._hop = (async () => {
      let moved = false;
      try {
        if (civ) await civ.setFrequency(dial);
        state.frequency = dial;
        moved = true;
        this._setStatus({ unattendedBand: bandOf(dial) });
      } catch (err) {
        this._warn(`could not change band: ${err.message}`);
      }
      if (moved && civ && this.tune && this._unattended) await this._tune(civ);
      // a slot whose audio starts more than 20 s late (a long tune) is not decoded
      if (this._unattended && this._attached) this._newCapture(slotStartMs, this.now());
    })();
    const hop = this._hop;
    hop.finally(() => {
      if (this._hop === hop) this._hop = null;
    });
  }

  /**
   * Starts the antenna tuner (CI-V 1C 01 02) and waits for it to finish.
   * Tuning transmits a carrier without PTT, so it has its own limit: if the
   * radio still reports tuning or transmitting after tuneLimitMs, the tuner
   * is switched off (which ends the tune), PTT is sent off, and the tuner is
   * switched back on.
   */
  async _tune(civ) {
    if (typeof civ.setTuner !== 'function' || this._clientCount() !== 0 || this.controlServer.state.ptt) return;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now(); // wall time, as the radio's tuner is
    this._setStatus({ tuning: true });
    try {
      await civ.setTuner(2);
      await sleep(this.tuneStartMs);
      for (;;) {
        let busy = true;
        try {
          const tuner = typeof civ.getTuner === 'function' ? await civ.getTuner() : 1;
          const tx = typeof civ.getTransmitting === 'function' ? await civ.getTransmitting() : false;
          busy = tuner === 2 || tx === true;
        } catch {
          // can't tell: keep waiting, up to the limit
        }
        if (!busy) return;
        if (Date.now() - t0 >= this.tuneLimitMs) {
          this._warn(`the tuner was still going after ${Math.round(this.tuneLimitMs / 1000)} s on ${(this.controlServer.state.frequency / 1e6).toFixed(4)} MHz; stopped it.`);
          await civ.setTuner(0).catch(() => {});
          if (typeof civ.setPtt === 'function') await civ.setPtt(false).catch(() => {});
          await civ.setTuner(1).catch(() => {});
          return;
        }
        await sleep(this.tunePollMs);
      }
    } catch (err) {
      this._warn(`could not start the tuner: ${err.message}`);
    } finally {
      this._setStatus({ tuning: false });
    }
  }

  async _startUnattended() {
    if (this._clientCount() !== 0 || this._unattended || this._active || this.controlServer.state.ptt) return;
    const civ = this._civ();
    const state = this.controlServer.state;
    const run = (async () => {
      const saved = { frequency: state.frequency, mode: null, filter: null, dataMode: null };
      if (civ) {
        try {
          saved.frequency = await civ.getFrequency();
        } catch {
          // keep the cached one
        }
        const m = await civ.getMode();
        saved.mode = m.mode;
        saved.filter = m.filter;
        try {
          saved.dataMode = await civ.getDataMode();
        } catch {
          saved.dataMode = state.dataMode ?? false;
        }
        let dial = wsprDialFor(saved.frequency);
        // a skipped band: start on the next one in the cycle
        if (this.bandCycle && !this.cycleBands.includes(bandOf(dial))) dial = WSPR_DIAL_HZ[nextWsprBand(dial, this.cycleBands)];
        await civ.setMode('USB', saved.filter ?? 1);
        await civ.setDataMode(true);
        await civ.setFrequency(dial);
        state.frequency = dial;
        state.dataMode = true;
      }
      return saved;
    })();
    this._starting = run;
    let saved;
    try {
      saved = await run;
    } finally {
      this._starting = null;
    }
    if (this._clientCount() !== 0) {
      // someone arrived while the radio was being set up
      this._unattended = { saved };
      await this._stopUnattended();
      return;
    }
    this._unattended = { saved };
    this._slotsOnBand = 0;
    this._setStatus({ unattended: true, unattendedBand: bandOf(state.frequency) });
    const cycle = this.bandCycle ? `, changing band every ${this.bandSlots * 2} minutes (${this.cycleBands.join(' ')})` : '';
    console.log(`WSPR: receiving unattended, from ${(state.frequency / 1e6).toFixed(4)} MHz${cycle}.`);
    this._syncAttachment();
  }

  async _stopUnattended() {
    if (this._starting) {
      try {
        await this._starting;
      } catch {
        // nothing was changed, or it is put back below as far as it got
      }
    }
    const u = this._unattended;
    if (!u) return;
    this._unattended = null;
    // a band change still going would land after the frequency is put back
    if (this._hop) await this._hop;
    this._syncAttachment();
    this._setStatus({ unattended: false, unattendedBand: null });
    const civ = this._civ();
    const s = u.saved;
    if (!civ) return;
    const state = this.controlServer.state;
    try {
      // (USB was set with the same filter, so only another mode needs setting back)
      if (s.mode && s.mode !== 'USB') await civ.setMode(s.mode, s.filter ?? 1);
      // the mode command turns DATA off, so DATA mode goes after it
      if (s.dataMode !== true) {
        await civ.setDataMode(false);
        state.dataMode = false;
        this.controlServer.broadcastJsonEvent(EVENT.DATA_MODE, { on: false });
      } else if (s.mode && s.mode !== 'USB') {
        await civ.setDataMode(true);
      }
      if (Number.isFinite(s.frequency)) {
        await civ.setFrequency(s.frequency);
        state.frequency = s.frequency;
        this.controlServer.broadcastJsonEvent(EVENT.FREQUENCY, { value: s.frequency });
      }
    } catch (err) {
      this._warn(`could not put the radio back after unattended receive: ${err.message}`);
    }
  }
}

module.exports = { WsprBridge, WSPR_DIAL_HZ, wsprDialFor, nextWsprBand, parseBandList, clampTxHz, SLOT_MS, MAX_POWER_W, TX_PCT };
