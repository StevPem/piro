'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StreamDecimator } = require('../audio/decimator');
const { FaxReceiver, FAX_SAMPLE_RATE } = require('../audio/fax-rx');
const { EVENT, BINARY_TYPE } = require('./protocol');
const { encodePngGrey } = require('./png');

const DEFAULT_KEEP_PICTURES = 6; // charts are big (a few hundred kB as PNG)
// The sound card's clock error, as measured on lined-up charts, is kept here
// so a chart started by hand (or after a restart) is straight from its first line.
const DEFAULT_STATE_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'piro', 'fax.json');
const CLOCK_HISTORY = 5;

/** One received line as a BINARY_TYPE.FAX_LINE frame (see protocol.js). */
function encodeFaxLineFrame(id, y, grey) {
  const buf = Buffer.alloc(7 + grey.length);
  buf[0] = BINARY_TYPE.FAX_LINE;
  buf.writeUInt16LE(id & 0xffff, 1);
  buf.writeUInt16LE(y & 0xffff, 3);
  buf.writeUInt16LE(grey.length, 5);
  buf.set(grey, 7);
  return buf;
}

/**
 * Wires the radiofax receiver (audio/fax-rx.js) to the radio's RX audio,
 * like the Feld-Hell bridge: an extra listener on AudioBridge's capture
 * stream, active only while the operator has Fax selected
 * (REQUEST.SET_FAX_ACTIVE) and the radio is not transmitting. The receiver
 * is light (an FM demodulator at 12 kHz), so it runs here rather than in a
 * worker.
 *
 * Each line is broadcast as a binary FAX_LINE frame (EVENT.FAX_START
 * first). When a chart ends it is broadcast as a greyscale PNG
 * (EVENT.FAX_PICTURE), kept for pages that connect later
 * (REQUEST.GET_FAX_PICTURES), and optionally saved to FAX_SAVE_DIR.
 */
class FaxDecoderBridge {
  /**
   * @param {string|null} [opts.stateFile] - where the measured clock error is kept (null: not kept)
   */
  constructor({ controlServer, audioBridge, saveDir, keep = DEFAULT_KEEP_PICTURES, now, stateFile = DEFAULT_STATE_FILE, civ, setUpRadio = true, cleanUp = true } = {}) {
    if (!controlServer) throw new Error('FaxDecoderBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('FaxDecoderBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.saveDir = saveDir || null;
    this.keep = keep;
    this.now = now ?? Date.now;
    const rate = audioBridge.sampleRate;
    this.supported = Number.isInteger(rate / FAX_SAMPLE_RATE) && rate >= FAX_SAMPLE_RATE;
    controlServer.faxPictures = controlServer.faxPictures ?? [];
    controlServer.faxCurrent = () => this._currentSoFar();
    controlServer.state.fax = { state: 'idle', lines: 0, clockPpm: 0 };

    this._active = false;
    this._pttActive = false;
    this._attached = false;
    this._rx = null;
    this._decimator = null;
    this._id = 0;
    this._current = null; // {id, width, time, ..., lines: Uint8Array[]}
    this._pending = Promise.resolve(); // PNG encodes, in order
    this.stateFile = stateFile;
    this._clockHistory = this._loadClock();
    this.civ = civ ?? controlServer.civ ?? null;
    this.setUpRadio = setUpRadio && !!this.civ;
    this.cleanUp = cleanUp;
    this._radio = Promise.resolve(); // radio set-up and restore, in order
    this._saved = null; // what _setUpRadio() changed: {nr, notch, filter, mode}

    this._onPcm = (chunk) => this._handlePcm(chunk);
    this._onActive = (on) => {
      const was = this._active;
      this._active = !!on;
      if (this._active && !was) this._radio = this._radio.then(() => this._setUpRadio());
      if (!this._active && was) this._radio = this._radio.then(() => this._restoreRadio());
      this._sync();
    };
    this._onPtt = (on) => {
      this._pttActive = !!on;
      this._sync();
    };
    this._onStartNow = () => this._rx && this._handle(this._rx.startNow());
    this._onStop = () => this._rx && this._handle(this._rx.flush());
  }

  start() {
    const cs = this.controlServer;
    cs.on('fax-active', this._onActive);
    cs.on('ptt', this._onPtt);
    cs.on('fax-start-now', this._onStartNow);
    cs.on('fax-stop', this._onStop);
    if (cs.state?.faxActive) this._onActive(true);
  }

  stop() {
    const cs = this.controlServer;
    cs.off('fax-active', this._onActive);
    cs.off('ptt', this._onPtt);
    cs.off('fax-start-now', this._onStartNow);
    cs.off('fax-stop', this._onStop);
    this._detach();
    if (this._active) {
      this._active = false;
      this._radio = this._radio.then(() => this._restoreRadio());
    }
  }

  /**
   * Radiofax needs the radio's NR and auto notch off and its widest filter
   * (FIL1): NR smears every quick black/white change (thin vertical lines
   * vanish, strokes go hollow; seen on VMC charts), and the auto notch
   * attacks steady tones, which is what a white or black area is. What is
   * changed here is put back by _restoreRadio() when Radiofax is left (by
   * the browser, or when the last browser goes), and only if it is still as
   * set here (the operator may have changed it since).
   */
  async _setUpRadio() {
    if (!this.setUpRadio || this._saved) return;
    const civ = this.civ;
    const saved = {};
    try {
      if (await civ.getNoiseReduction()) {
        await civ.setNoiseReduction(false);
        saved.nr = true;
      }
      if (await civ.getNotch()) {
        await civ.setNotch(false);
        saved.notch = true;
      }
      const filter = await civ.getFilter();
      if (filter !== 1) {
        saved.mode = (await civ.getMode?.())?.mode;
        await civ.setFilter(1);
        saved.filter = filter;
      }
    } catch (err) {
      this._reportError(`couldn't set the radio up for fax (NR off, notch off, FIL1): ${err.message}`);
    }
    this._saved = saved;
    if (Object.keys(saved).length) console.log(`Radiofax: radio set up for fax (${Object.keys(saved).join(', ')} changed)`);
  }

  async _restoreRadio() {
    const saved = this._saved;
    this._saved = null;
    if (!saved || !this.setUpRadio) return;
    const civ = this.civ;
    try {
      if (saved.nr && !(await civ.getNoiseReduction())) await civ.setNoiseReduction(true);
      if (saved.notch && !(await civ.getNotch())) await civ.setNotch(true);
      // the filter only in the same mode (leaving fax for another mode picks that mode's filter)
      const modeNow = saved.mode && (await civ.getMode?.())?.mode;
      if (saved.filter && (await civ.getFilter()) === 1 && modeNow === saved.mode) await civ.setFilter(saved.filter);
    } catch (err) {
      this._reportError(`couldn't put the radio's settings back after fax: ${err.message}`);
    }
  }

  /** Resolves once any radio set-up or restore has finished (for tests). */
  radioSettled() {
    return this._radio;
  }

  get attached() {
    return this._attached;
  }

  /** Resolves once every chart so far has been encoded and broadcast (for tests). */
  settled() {
    return this._pending;
  }

  _sync() {
    const should = this._active && !this._pttActive;
    if (should && !this._attached) this._attach();
    else if (!should && this._attached) this._detach();
  }

  _status(patch) {
    const s = { ...this.controlServer.state.fax, ...patch };
    this.controlServer.state.fax = s;
    this.controlServer.broadcastJsonEvent(EVENT.FAX_STATUS, s);
  }

  _attach() {
    if (!this.supported) {
      this._reportError(`radiofax needs an audio sample rate that is a multiple of ${FAX_SAMPLE_RATE} Hz (this server captures at ${this.audioBridge.sampleRate} Hz).`);
      return;
    }
    this._decimator = new StreamDecimator(this.audioBridge.sampleRate, FAX_SAMPLE_RATE, { cutoffHz: 3200 });
    // a fresh receiver each time, but it keeps the clock correction measured before
    const ppm = this._rx?.clockPpm || this.clockPpm;
    this._rx = new FaxReceiver({ cleanUp: this.cleanUp });
    if (ppm) {
      this._rx.clockPpm = ppm;
      this._rx.spl = this._rx.nominalSpl * (1 + ppm / 1e6);
    }
    this.audioBridge.capture.on('data', this._onPcm);
    this._attached = true;
    this._status({ state: 'listening', lines: 0 });
  }

  _detach() {
    if (!this._attached) return;
    this.audioBridge.capture.off('data', this._onPcm);
    this._attached = false;
    this._decimator = null;
    // keep what has arrived (our own transmission, or Fax deselected)
    if (this._rx) this._handle(this._rx.flush());
    this._status({ state: 'idle' });
  }

  _handlePcm(chunk) {
    const n = Math.floor(chunk.length / 2);
    if (!n || !this._decimator) return;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = chunk.readInt16LE(2 * i) / 32768;
    const y = this._decimator.process(x);
    if (y.length) this._handle(this._rx.process(y));
  }

  _handle(events) {
    for (const e of events) {
      switch (e.type) {
        case 'state':
          this._status({ state: e.state, lines: this._current?.lines.length ?? 0, clockPpm: this._rx?.clockPpm ?? 0 });
          break;
        case 'start':
          this._id = (this._id + 1) & 0xffff;
          this._current = { id: this._id, width: e.width, lpm: e.lpm, ioc: e.ioc, phased: e.phased, clockPpm: e.clockPpm, time: this.now(), lines: [] };
          this.controlServer.broadcastJsonEvent(EVENT.FAX_START, this._info(this._current));
          break;
        case 'line':
          if (!this._current) break;
          this._current.lines.push(e.grey);
          this.controlServer.broadcastBinary?.(encodeFaxLineFrame(this._current.id, e.y, e.grey));
          if (e.y % 20 === 0) this._status({ lines: e.y + 1 });
          break;
        case 'end':
          this._finish(e);
          break;
        default:
          break;
      }
    }
  }

  _info(c) {
    const { lines, ...rest } = c;
    return rest;
  }

  /** The sound card's clock error (ppm): the median of the last few lined-up charts. */
  get clockPpm() {
    const h = [...this._clockHistory].sort((a, b) => a - b);
    return h.length ? h[h.length >> 1] : 0;
  }

  _loadClock() {
    if (!this.stateFile) return [];
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return Array.isArray(j.clockPpm) ? j.clockPpm.filter(Number.isFinite).slice(-CLOCK_HISTORY) : [];
    } catch {
      return [];
    }
  }

  _rememberClock(ppm) {
    this._clockHistory = [...this._clockHistory, ppm].slice(-CLOCK_HISTORY);
    if (!this.stateFile) return;
    fs.promises
      .mkdir(path.dirname(this.stateFile), { recursive: true })
      .then(() => fs.promises.writeFile(this.stateFile, JSON.stringify({ clockPpm: this._clockHistory }) + '\n'))
      .catch((err) => console.warn(`Radiofax: couldn't keep the clock correction in ${this.stateFile}: ${err.message}`));
  }

  _finish(e) {
    const cur = this._current ?? { id: (this._id = (this._id + 1) & 0xffff), width: e.width, time: this.now() };
    this._current = null;
    // the clock error, as this chart's phasing measured it, or as its slant showed it
    const measured = e.clockMeasured ? e.clockPpm : e.slantPpm;
    if (Number.isFinite(measured)) {
      this._rememberClock(measured);
      // later hand-started charts in this session use the remembered figure too
      if (this._rx && !this._rx._phased) {
        this._rx.clockPpm = this.clockPpm;
        this._rx.spl = this._rx.nominalSpl * (1 + this.clockPpm / 1e6);
      }
    }
    if (!e.lines) return; // nothing arrived
    const endTime = this.now();
    this._pending = this._pending.then(async () => {
      try {
        const png = await encodePngGrey(e.grey, e.width, e.lines);
        const picture = {
          id: cur.id,
          width: e.width,
          lines: e.lines,
          time: cur.time,
          endTime,
          complete: e.complete,
          reason: e.reason,
          phased: e.phased ?? cur.phased ?? false,
          clockPpm: e.clockPpm,
          slantPxPerLine: e.slantPxPerLine || 0,
          repairedLines: e.repairedLines || 0,
          clockMeasured: !!e.clockMeasured,
          png: png.toString('base64'),
        };
        const list = this.controlServer.faxPictures;
        list.push(picture);
        while (list.length > this.keep) list.shift();
        this.controlServer.broadcastJsonEvent(EVENT.FAX_PICTURE, picture);
        if (this.saveDir) await this._save(picture, png);
      } catch (err) {
        this._reportError(`couldn't make the chart picture: ${err.message}`);
      }
    });
  }

  /** The chart coming in, as a PNG of its lines so far (for a page that connects part-way). */
  async _currentSoFar() {
    const c = this._current;
    if (!c || !c.lines.length) return c ? this._info(c) : null;
    const grey = new Uint8Array(c.width * c.lines.length);
    c.lines.forEach((l, y) => grey.set(l, y * c.width));
    const png = await encodePngGrey(grey, c.width, c.lines.length);
    return { ...this._info(c), linesSoFar: c.lines.length, png: png.toString('base64') };
  }

  async _save(picture, png) {
    const d = new Date(picture.time);
    const pad = (n) => String(n).padStart(2, '0');
    const name = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}z-fax.png`;
    try {
      await fs.promises.mkdir(this.saveDir, { recursive: true });
      await fs.promises.writeFile(path.join(this.saveDir, name), png);
    } catch (err) {
      this._reportError(`couldn't save ${name}: ${err.message}`);
    }
  }

  _reportError(message) {
    console.error(`Radiofax receiver: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { message: `Radiofax receiver: ${message}` });
  }
}

module.exports = { FaxDecoderBridge, encodeFaxLineFrame };
