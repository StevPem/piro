'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { EVENT } = require('./protocol');
const { ensureDataMode, watchDataMode } = require('../civ/data-mode-guard');

const RATE = 48000; // Xara's (and VARA's) sample rate
const BANDWIDTHS = [500, 2300, 2750];
const DEFAULT_LATENCY_MS = 500; // aplay's usual buffer: how far the transmit audio lags what is written
const DEFAULT_LEAD_MS = 50; // the radio's PTT is on before the audio arrives
const MAX_KEY_MS = 30 * 1000; // no VARA frame is anywhere near this long
const IDLE_MS = 10 * 60 * 1000; // a link with nothing sent or received this long is closed
const MAX_BACKLOG_SEC = 1; // the modem must keep up with real time, or its timing fails
const TRANSCRIPT_MAX_CHARS = 6000;
const HEARD_MAX = 10;
const CALLSIGN_RE = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(\/[A-Z0-9]{1,4})?(-[0-9]{1,2})?$/;

/** The VARA settings from the environment (VARA_BW, VARA_AUDIO_LATENCY_MS). Bad values are reported and the default used. */
function varaConfig(env = process.env) {
  const warnings = [];
  let bw = 500;
  if (env.VARA_BW) {
    const v = Number(env.VARA_BW);
    if (BANDWIDTHS.includes(v)) bw = v;
    else warnings.push(`VARA_BW="${env.VARA_BW}" must be 500, 2300 or 2750; using 500.`);
  }
  let latencyMs = DEFAULT_LATENCY_MS;
  if (env.VARA_AUDIO_LATENCY_MS) {
    const v = Number(env.VARA_AUDIO_LATENCY_MS);
    if (v >= 0 && v <= 2000) latencyMs = v;
    else warnings.push(`VARA_AUDIO_LATENCY_MS="${env.VARA_AUDIO_LATENCY_MS}" must be 0 to 2000; using ${DEFAULT_LATENCY_MS}.`);
  }
  return { bw, latencyMs, warnings };
}

/** Text from the link as the transcript shows it: CR as a line break, other control characters dropped. */
function cleanText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x07\x0b-\x1f\x7f]/g, '');
}

/** Text typed in a browser as VARA Chat sends it: Latin-1, one line ending in CR. */
function encodeText(text) {
  const line = String(text).replace(/[\r\n]+/g, ' ');
  const bytes = Buffer.alloc(line.length + 1);
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    bytes[i] = c < 256 ? c : 0x3f; // '?' for what Latin-1 can't carry
  }
  bytes[line.length] = 0x0d;
  return bytes;
}

/**
 * VARA chat: a VARA HF modem (Xara, compiled to WebAssembly; see
 * audio/xara/xara.js) run in a worker on the radio's audio, for
 * keyboard-to-keyboard QSOs with VARA Chat and VarAC.
 *
 * Active while a browser has VARA selected (the TTY button;
 * REQUEST.SET_VARA_ACTIVE, the 'vara-active' event). Then:
 * - DATA mode is turned on and confirmed (and watched), as before any
 *   transmission from audio;
 * - all received audio goes to the modem, and the modem's transmit audio
 *   is written to the radio without a break (silence between frames), so
 *   the delay through the sound card stays the same; the modem is told it
 *   (VARA_AUDIO_LATENCY_MS) and times its replies to suit;
 * - the modem keys PTT itself ('PTT ON'/'PTT OFF'); a frame longer than
 *   30 s is cut off;
 * - the station listens (LISTEN ON), so others can call it, with the
 *   VARA Chat settings (CHAT ON, P2P SESSION, COMPRESSION TEXT).
 *
 * The browsers drive it with REQUEST.VARA ('vara' events): {action:
 * 'cq'|'connect'|'disconnect'|'send', call?, text?}. The state is
 * controlServer.state.vara (in the connect snapshot), broadcast as
 * EVENT.VARA_STATUS when it changes; the conversation is broadcast as
 * EVENT.VARA_TEXT, and sent whole to a browser that connects.
 */
class VaraBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {string} [opts.callsign] - STATION_CALLSIGN (required to work)
   * @param {number} [opts.bw=500] - 500, 2300 or 2750 Hz
   * @param {number} [opts.latencyMs=500]
   * @param {number} [opts.leadMs=50]
   * @param {number} [opts.driveDb=-5]
   * @param {number} [opts.maxKeyMs=30000]
   * @param {number} [opts.idleMs=600000]
   * @param {() => object} [opts.createWorker] - injectable for testing
   * @param {() => number} [opts.now]
   * @param {number} [opts.dataSettleMs]
   * @param {number} [opts.dataWatchMs]
   */
  constructor({ controlServer, audioBridge, callsign, bw = 500, latencyMs = DEFAULT_LATENCY_MS, leadMs = DEFAULT_LEAD_MS, driveDb = -5, maxKeyMs = MAX_KEY_MS, idleMs = IDLE_MS, createWorker, now, dataSettleMs, dataWatchMs } = {}) {
    if (!controlServer) throw new Error('VaraBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('VaraBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.callsign = String(callsign || '').toUpperCase();
    this.bw = BANDWIDTHS.includes(bw) ? bw : 500;
    this.latencyMs = latencyMs;
    this.leadMs = leadMs;
    this.driveDb = driveDb;
    this.maxKeyMs = maxKeyMs;
    this.idleMs = idleMs;
    this.createWorker = createWorker ?? (() => new Worker(path.join(__dirname, '..', 'audio', 'vara-worker.js')));
    this.now = now ?? Date.now;
    this.dataSettleMs = dataSettleMs;
    this.dataWatchMs = dataWatchMs;

    let unavailable = null;
    if (!this.callsign) unavailable = 'VARA needs STATION_CALLSIGN set on the server.';
    else if (audioBridge.sampleRate !== RATE) unavailable = `VARA needs audio at ${RATE} Hz (this server uses ${audioBridge.sampleRate} Hz).`;
    this.unavailable = unavailable;

    this._worker = null;
    this._active = false;
    this._session = 0; // bumped on every start/stop, so late replies from an old modem are ignored
    this._keyed = false;
    this._keyTimer = null;
    this._idleTimer = null;
    this._dataReady = false;
    this._stopWatch = null;
    this._sent = 0; // samples sent to the worker and not yet returned
    this._dropping = false;
    this._awaiting = []; // commands waiting for OK/WRONG
    this._transcript = []; // [{text, own?, note?}]
    this._transcriptChars = 0;
    this._warnedKey = false;

    controlServer.state.vara = this._freshState();

    this._onActive = (active) => (active ? this.activate() : this.deactivate()).catch(() => {});
    this._onRequest = (req) => this.request(req);
    this._onPcm = (chunk) => this._handlePcm(chunk);
    this._onClientJoined = (ws) => {
      if (this._transcript.length && typeof this.controlServer.sendJsonEvent === 'function') {
        this.controlServer.sendJsonEvent(ws, EVENT.VARA_TEXT, { replace: true, segments: this._transcript });
      }
    };
  }

  _freshState() {
    return {
      available: !this.unavailable,
      reason: this.unavailable,
      callsign: this.callsign,
      bw: this.bw,
      state: 'off', // 'off' | 'starting' | 'listening' | 'calling' | 'connected' | 'disconnecting'
      peer: null,
      linkBw: null,
      pending: false,
      busy: false,
      ptt: false,
      sn: null,
      bitrate: null,
      buffer: 0,
      heard: [], // CQ frames heard: [{call, bw, time}], newest first
    };
  }

  start() {
    this.controlServer.on('vara-active', this._onActive);
    this.controlServer.on('vara', this._onRequest);
    this.controlServer.on('client-connected', this._onClientJoined);
    // A browser that connected while the server was still starting has a
    // snapshot without this state: send it now.
    this.controlServer.broadcastJsonEvent(EVENT.VARA_STATUS, this.state);
    if (this.controlServer.state.varaActive) this.activate().catch(() => {});
  }

  stop() {
    this.controlServer.off('vara-active', this._onActive);
    this.controlServer.off('vara', this._onRequest);
    this.controlServer.off('client-connected', this._onClientJoined);
    return this.deactivate();
  }

  get active() {
    return this._active;
  }

  get state() {
    return this.controlServer.state.vara;
  }

  _update(changes) {
    const s = this.controlServer.state.vara;
    let changed = false;
    for (const [k, v] of Object.entries(changes)) {
      if (s[k] !== v) {
        s[k] = v;
        changed = true;
      }
    }
    if (changed) this.controlServer.broadcastJsonEvent(EVENT.VARA_STATUS, s);
  }

  _error(message) {
    console.warn(`VARA: ${message}`);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { context: 'vara', message: `VARA: ${message}` });
  }

  _addText(text, { own = false, note = false } = {}) {
    if (!text) return;
    const last = this._transcript[this._transcript.length - 1];
    if (last && !!last.own === own && !!last.note === note && !note) last.text += text;
    else this._transcript.push({ text, ...(own ? { own: true } : {}), ...(note ? { note: true } : {}) });
    this._transcriptChars += text.length;
    while (this._transcriptChars > TRANSCRIPT_MAX_CHARS && this._transcript.length > 1) {
      this._transcriptChars -= this._transcript.shift().text.length;
    }
    this.controlServer.broadcastJsonEvent(EVENT.VARA_TEXT, { text, own, note, time: this.now() });
  }

  async activate() {
    if (this._active) return;
    if (this.unavailable) {
      this._error(this.unavailable);
      this.controlServer.broadcastJsonEvent(EVENT.VARA_STATUS, this.state); // the panel shows the reason too
      return;
    }
    this._active = true;
    const session = ++this._session;
    this._update({ ...this._freshState(), heard: this.state.heard, state: 'starting' });
    const civ = this.controlServer.civ;
    this._dataReady = !civ;
    if (civ) {
      // As before any transmission from audio: DATA mode on and read back,
      // or PTT could put the microphone on the air.
      try {
        await ensureDataMode(civ, true, { settleMs: this.dataSettleMs });
        if (session !== this._session) return;
        this._dataReady = true;
        this._stopWatch = watchDataMode(civ, {
          intervalMs: this.dataWatchMs,
          onLost: () => this._error('DATA mode was turned off; turned it back on.'),
        });
      } catch (err) {
        if (session !== this._session) return;
        this._error(`${err.message} VARA will receive but not transmit.`);
      }
    }
    const w = this.createWorker();
    this._worker = w;
    w.on('message', (msg) => {
      if (session === this._session) this._handleWorker(msg);
    });
    w.on('error', (err) => {
      if (session === this._session) this._error(`The modem stopped: ${err.message}`);
    });
    w.postMessage({ type: 'init', call: this.callsign, bw: this.bw, leadMs: this.leadMs, latencyMs: this.latencyMs, driveDb: this.driveDb });
    // VARA Chat's settings. LISTEN ON: others can call this station.
    for (const c of [`MYCALL ${this.callsign}`, `BW${this.bw}`, 'CHAT ON', 'P2P SESSION', 'COMPRESSION TEXT', 'LISTEN ON']) this._command(c);
    this._sent = 0;
    this._dropping = false;
    this.audioBridge.capture.on('data', this._onPcm);
    this._update({ state: 'listening' });
  }

  async deactivate() {
    if (!this._active) return;
    this._active = false;
    this._session++;
    this.audioBridge.capture.off('data', this._onPcm);
    const w = this._worker;
    this._worker = null;
    // ABORT, not DISCONNECT: the modem is going now, and the other station's times out.
    if (w) {
      w.postMessage({ type: 'command', line: 'ABORT' });
      w.terminate();
    }
    this._awaiting = [];
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    await this._unkey();
    if (this._stopWatch) await this._stopWatch().catch(() => {});
    this._stopWatch = null;
    this._dataReady = false;
    if (typeof this.audioBridge.playback.restart === 'function') this.audioBridge.playback.restart();
    this._update({ state: 'off', peer: null, linkBw: null, pending: false, busy: false, ptt: false, sn: null, bitrate: null, buffer: 0 });
  }

  _command(line) {
    if (!this._worker) return;
    // Every command Xara is sent here answers OK or WRONG (VERSION answers with the version).
    if (!/^VERSION/.test(line)) this._awaiting.push(line);
    this._worker.postMessage({ type: 'command', line });
  }

  /**
   * A browser's VARA request: {action: 'cq'|'connect'|'disconnect'|'send', call?, text?}.
   * Throws if it can't be done (ws-server.js sends the message back to that browser).
   */
  request({ action, call, text } = {}) {
    if (!this._active || !this._worker) throw new Error(this.unavailable || 'VARA is not running.');
    const s = this.state;
    if (action === 'cq') {
      if (s.state !== 'listening') throw new Error('Calling CQ needs the station free (not in a QSO).');
      this._command(`CQFRAME ${this.callsign} ${this.bw}`);
      this._addText(`Calling CQ (${this.bw} Hz)\n`, { note: true });
    } else if (action === 'connect') {
      const to = String(call || '').trim().toUpperCase();
      if (!CALLSIGN_RE.test(to)) throw new Error(`"${call}" is not a callsign.`);
      if (to === this.callsign) throw new Error('That is this station\'s own callsign.');
      if (s.state !== 'listening') throw new Error('Already in a QSO, or calling.');
      this._command(`CONNECT ${this.callsign} ${to}`);
      this._update({ state: 'calling', peer: to });
      this._addText(`Calling ${to}\n`, { note: true });
    } else if (action === 'disconnect') {
      if (s.state === 'connected') {
        this._command('DISCONNECT');
        this._update({ state: 'disconnecting' });
      } else if (s.state === 'calling' || s.state === 'disconnecting') {
        // Stop calling (or stop waiting for the other station to agree to end).
        this._command('ABORT');
      }
    } else if (action === 'send') {
      if (s.state !== 'connected') throw new Error('Connect to a station first.');
      const line = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
      if (!line) return;
      this._worker.postMessage({ type: 'send', data: Uint8Array.from(encodeText(line)).buffer });
      this._addText(`${line}\n`, { own: true });
      this._touch();
    } else {
      throw new Error(`Unknown VARA request "${action}".`);
    }
  }

  _handlePcm(chunk) {
    const w = this._worker;
    if (!w) return;
    const n = Math.floor(chunk.length / 2);
    if (!n) return;
    // The modem must hear in real time; if its worker falls behind, drop
    // audio (its timing is lost either way) rather than queue it.
    const backlog = this._sent / RATE;
    if (this._dropping) {
      if (backlog > MAX_BACKLOG_SEC / 4) return;
      this._dropping = false;
    } else if (backlog > MAX_BACKLOG_SEC) {
      this._dropping = true;
      this._error('The modem is falling behind; dropping audio until it catches up.');
      return;
    }
    const samples = new Float32Array(n);
    // While transmitting, the radio's receive audio is meaningless: the modem hears silence.
    if (!this._keyed && !this.controlServer.state.ptt) {
      for (let i = 0; i < n; i++) samples[i] = chunk.readInt16LE(i * 2) / 32768;
    }
    this._sent += n;
    w.postMessage({ type: 'audio', samples: samples.buffer }, [samples.buffer]);
  }

  _handleWorker(msg) {
    switch (msg.type) {
      case 'audio': {
        const s = new Float32Array(msg.samples);
        this._sent = Math.max(0, this._sent - s.length);
        const pcm = Buffer.alloc(s.length * 2);
        for (let i = 0; i < s.length; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s[i] * 32767))), i * 2);
        this.audioBridge.playback.write(pcm);
        break;
      }
      case 'lines':
        for (const line of msg.lines) this._handleLine(line);
        break;
      case 'data':
        this._addText(cleanText(Buffer.from(msg.data).toString('latin1')));
        this._touch();
        break;
      case 'buffer':
        this._update({ buffer: msg.bytes });
        break;
      case 'error':
        this._error(`The modem reported: ${msg.error}`);
        break;
      default:
        break;
    }
  }

  _handleLine(line) {
    const [word, ...rest] = line.split(/\s+/);
    switch (word) {
      case 'OK':
        this._awaiting.shift();
        break;
      case 'WRONG': {
        const cmd = this._awaiting.shift();
        if (cmd?.startsWith('CONNECT')) {
          this._update({ state: 'listening', peer: null });
          this._error('The modem would not call: it is busy. Try again in a moment.');
        } else if (cmd?.startsWith('CQFRAME')) this._error('The modem would not call CQ: it is busy.');
        else if (cmd) console.warn(`VARA: the modem refused "${cmd}".`);
        break;
      }
      case 'PTT':
        if (rest[0] === 'ON') this._key().catch(() => {});
        else this._unkey().catch(() => {});
        break;
      case 'CONNECTED': {
        const [caller, answerer, width] = rest;
        const peer = caller === this.callsign ? answerer : caller;
        this._update({ state: 'connected', peer, linkBw: Number(width) || null, pending: false });
        this._addText(`Connected to ${peer}${Number(width) ? ` (${width} Hz)` : ''}\n`, { note: true });
        this._touch();
        break;
      }
      case 'DISCONNECTED': {
        const s = this.state;
        const msg = s.state === 'calling' ? `No answer from ${s.peer}` : s.peer ? `Disconnected from ${s.peer}` : 'Disconnected';
        this._update({ state: 'listening', peer: null, linkBw: null, pending: false, sn: null, bitrate: null, buffer: 0 });
        this._addText(`${msg}\n`, { note: true });
        clearTimeout(this._idleTimer);
        this._idleTimer = null;
        break;
      }
      case 'PENDING':
        this._update({ pending: true });
        break;
      case 'CANCELPENDING':
        this._update({ pending: false });
        break;
      case 'BUSY':
        this._update({ busy: rest[0] === 'ON' });
        break;
      case 'SN':
        this._update({ sn: Number(rest[0]) });
        break;
      case 'BITRATE': {
        // "BITRATE (level)  bps TX|RX"
        const bps = Number(rest.find((v) => /^\d+$/.test(v)));
        if (Number.isFinite(bps)) this._update({ bitrate: bps });
        break;
      }
      case 'BUFFER':
        this._update({ buffer: Number(rest[0]) || 0 });
        break;
      case 'CQFRAME': {
        const [call, bw] = rest;
        if (!call) break;
        const heard = [{ call, bw: Number(bw) || null, time: this.now() }, ...this.state.heard.filter((h) => h.call !== call)].slice(0, HEARD_MAX);
        this.state.heard = heard;
        this.controlServer.broadcastJsonEvent(EVENT.VARA_STATUS, this.state);
        this._addText(`CQ from ${call}${Number(bw) ? ` (${bw} Hz)` : ''}\n`, { note: true });
        break;
      }
      default:
        break; // IAMALIVE, REGISTERED, LINK (UN)REGISTERED, ENCRYPTION DISABLED, VERSION ...
    }
  }

  async _key() {
    if (this._keyed || !this._active) return;
    if (!this._dataReady) {
      if (!this._warnedKey) this._error('Not transmitting: DATA mode is not confirmed on.');
      this._warnedKey = true;
      return;
    }
    if (this.controlServer.state.ptt) return; // someone else is transmitting
    this._keyed = true;
    this._update({ ptt: true });
    this._keyTimer = setTimeout(() => {
      this._error(`A transmission ran past ${Math.round(this.maxKeyMs / 1000)} s; stopped it.`);
      this._command('ABORT');
      this._unkey().catch(() => {});
    }, this.maxKeyMs);
    this._keyTimer.unref?.();
    try {
      await this.controlServer.setPttFromServer(true);
    } catch (err) {
      this._error(`Couldn't key the radio: ${err.message}`);
      await this._unkey();
    }
  }

  async _unkey() {
    clearTimeout(this._keyTimer);
    this._keyTimer = null;
    if (!this._keyed) return;
    this._keyed = false;
    this._update({ ptt: false });
    try {
      await this.controlServer.setPttFromServer(false);
    } catch (err) {
      this._error(`Couldn't unkey the radio: ${err.message}`);
    }
  }

  /** Something was sent or received: restart the idle clock. */
  _touch() {
    clearTimeout(this._idleTimer);
    if (this.state.state !== 'connected' && this.state.state !== 'calling') return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.state.state !== 'connected') return;
      this._addText(`Nothing sent or received for ${Math.round(this.idleMs / 60000)} minutes; disconnecting.\n`, { note: true });
      this._command('DISCONNECT');
      this._update({ state: 'disconnecting' });
    }, this.idleMs);
    this._idleTimer.unref?.();
  }
}

module.exports = { VaraBridge, varaConfig, encodeText, cleanText, CALLSIGN_RE, BANDWIDTHS };
