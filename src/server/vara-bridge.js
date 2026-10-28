'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { EVENT } = require('./protocol');
const { ensureDataMode, watchDataMode } = require('../civ/data-mode-guard');
const { CALLSIGN_RE: PSK_CALLSIGN_RE } = require('../audio/psk-reporter');
const varac = require('./varac');

const RATE = 48000; // Xara's (and VARA's) sample rate
const BANDWIDTHS = [500, 2300, 2750];
const DEFAULT_LATENCY_MS = 500; // aplay's usual buffer: how far the transmit audio lags what is written
const DEFAULT_LEAD_MS = 50; // the radio's PTT is on before the audio arrives
const MAX_KEY_MS = 30 * 1000; // no VARA frame is anywhere near this long
const IDLE_MS = 10 * 60 * 1000; // a link with nothing sent or received this long is closed
const MAX_BACKLOG_SEC = 1; // the modem must keep up with real time, or its timing fails
const TRANSCRIPT_MAX_CHARS = 6000;
const HEARD_MAX = 10;
const DISC_DRAIN_MS = 20 * 1000; // after sending <DISC>: the longest to wait for it to go before DISCONNECT
// VarAC's QSY handshake (hfmodem, contact/varac.py): how long each step may take.
const QSY_ACK_MS = 8 * 1000; // after a request arrives: for our modem's acknowledgement to go out
const QSY_SEND_MS = 45 * 1000; // after sending a request: for it to be delivered
const QSY_STEP_MS = 60 * 1000; // on the new frequency: for <TL>, <QSYR> or the opening report
const QSY_MAX_HZ = 4000; // a VarAC slot is at most 3750 Hz from the calling frequency
// Calling on the calling frequency, PiRO moves the QSO to a slot itself, as stock VarAC
// does: the first of these not used by a CQ heard there in the last SLOT_RECENT_MS.
const SLOT_ORDER_HZ = [750, -750, 1500, -1500, 2250, -2250, 3000, -3000, 3750, -3750];
const SLOT_RECENT_MS = 15 * 60 * 1000;
const SPOT_SN_MS = 2000; // the modem reports a frame's S/N just before the frame (a CQ, a connection)
const SIGNAL_CENTRE_HZ = 1500; // VARA HF is centred on 1500 Hz audio: the spot frequency is dial + this
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

/** 14105750 -> "14.10575" */
function mhzText(hz) {
  return (hz / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** Text from the link as the transcript shows it: CR as a line break, other control characters dropped. */
function cleanText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x07\x0b-\x1f\x7f]/g, '');
}

/** Text typed in a browser as plain VARA text (a station that doesn't use VarAC's framing): Latin-1, one line ending in CR. */
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
   * @param {{name?: string, qth?: string, loc?: string}} [opts.profile] - sent after the opening report, as VarAC does (<NAME:..>, <QTH:..>, <LOC:..>)
   * @param {{addSpot: Function}} [opts.pskReporter] - where "PSK Spot" reports go (the FT8 bridge's PskReporterClient); none, no spots
   * @param {() => number} [opts.now]
   * @param {number} [opts.dataSettleMs]
   * @param {number} [opts.dataWatchMs]
   */
  constructor({ controlServer, audioBridge, callsign, bw = 500, latencyMs = DEFAULT_LATENCY_MS, leadMs = DEFAULT_LEAD_MS, driveDb = -5, maxKeyMs = MAX_KEY_MS, idleMs = IDLE_MS, createWorker, pskReporter, profile, now, dataSettleMs, dataWatchMs } = {}) {
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
    this.pskReporter = pskReporter ?? null;
    // Tag values can't hold <, > or line breaks.
    this.profile = Object.fromEntries(
      Object.entries(profile || {})
        .map(([k, v]) => [k, String(v ?? '').replace(/[<>\r\n]/g, ' ').trim()])
        .filter(([, v]) => v)
    );
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
    this._lastSn = null; // {sn, time}: the modem's latest S/N report
    this._link = null; // the QSO now: {parser, openingSent, disc: {at, timer}|null}
    this._slotsHeard = []; // slots VarAC CQs were heard waiting on: [{cfHz, offsetHz, time}]

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
      qsyReady: false, // the other station has said it is ready to QSY (<Q> or <AWQ>)
      qsy: null, // a QSY under way: {role: 'requester'|'receiver', target, phase}
      heard: [], // CQ frames heard, newest first: [{call, raw, slot, offsetHz, beacon, bw, sn, time}] (see varac.decodeCqCall())
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
    this._endLink();
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
   * A browser's VARA request: {action: 'cq'|'connect'|'disconnect'|'send'|'qsy', call?, text?, offsetHz?}.
   * Throws if it can't be done (ws-server.js sends the message back to that browser).
   */
  request({ action, call, text, offsetHz } = {}) {
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
      if (s.state === 'connected') this._closeLink();
      else if (s.state === 'calling' || s.state === 'disconnecting') {
        // Stop calling (or stop waiting for the other station to agree to end).
        this._command('ABORT');
      }
    } else if (action === 'send') {
      if (s.state !== 'connected') throw new Error('Connect to a station first.');
      const line = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
      if (!line) return;
      this._sendText(line);
      this._addText(`${line}\n`, { own: true });
      this._touch();
    } else if (action === 'qsy') {
      // VarAC's QSY in a QSO: ask the other station to move with us (QSYD/QSYU).
      const link = this._link;
      if (s.state !== 'connected' || !link) throw new Error('QSY in a QSO needs a QSO.');
      if (link.parser.plain) throw new Error(`${s.peer} doesn't use VarAC's messages, so it can't be asked to QSY. Agree a frequency in the chat instead.`);
      if (link.qsy) throw new Error('A QSY is already under way.');
      if (!link.ready) throw new Error(`${s.peer} hasn't said it is ready to QSY yet.`);
      const dial = this.controlServer.state.frequency;
      const off = Number(offsetHz);
      if (!Number.isFinite(dial) || !Number.isFinite(off) || !off || Math.abs(off) > QSY_MAX_HZ) throw new Error('No frequency to QSY to.');
      this._requestQsy(dial + off);
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
        this._received(Buffer.from(msg.data));
        this._touch();
        break;
      case 'buffer':
        this._update({ buffer: msg.bytes });
        this._drained();
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
        else {
          this._unkey().catch(() => {});
          if (this._link?.qsy?.phase === 'ack') this._qsyMove();
        }
        break;
      case 'KISS':
        this._kiss(Number(rest[0]), Buffer.from(rest[1] || '', 'hex'));
        break;
      case 'CONNECTED': {
        const [caller, answerer, width] = rest;
        const peer = caller === this.callsign ? answerer : caller;
        const sn = this._takeSn();
        this._update({ state: 'connected', peer, linkBw: Number(width) || null, pending: false, ...(sn != null ? { sn } : {}) });
        this._spot(peer, sn);
        this._addText(`Connected to ${peer}${Number(width) ? ` (${width} Hz)` : ''}\n`, { note: true });
        this._endLink();
        // VarAC keeps the opening report off the calling frequency: there the
        // answering station only says it is ready to QSY (<Q>), and the reports
        // follow once both have moved (hfmodem, REL V11.4).
        const onCf = varac.CALLING_HZ.includes(this.controlServer.state.frequency);
        // homeHz: where to go back to if a QSY moves this QSO off the calling frequency.
        this._link = { parser: new varac.MessageParser(), openingSent: false, disc: null, onCf, ready: false, qsy: null, homeHz: onCf ? this.controlServer.state.frequency : null, moved: false, caller: caller === this.callsign, autoQsy: false };
        if (onCf) {
          if (caller !== this.callsign) this._sendText('<Q>');
        } else if (sn != null) this._sendOpening(sn);
        this._touch();
        break;
      }
      case 'DISCONNECTED': {
        const s = this.state;
        const msg = s.state === 'calling' ? `No answer from ${s.peer}` : s.peer ? `Disconnected from ${s.peer}` : 'Disconnected';
        this._update({ state: 'listening', peer: null, linkBw: null, pending: false, sn: null, bitrate: null, buffer: 0 });
        this._addText(`${msg}\n`, { note: true });
        // A QSO moved off the calling frequency by a QSY: back to it, as VarAC does.
        const home = this._link?.moved ? this._link.homeHz : null;
        this._endLink();
        if (home && this.controlServer.state.frequency !== home) {
          this._tune(home)
            .then(() => this._addText(`Back on the calling frequency (${mhzText(home)} MHz)\n`, { note: true }))
            .catch((err) => this._error(`Couldn't go back to the calling frequency: ${err.message}`));
        }
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
      case 'SN': {
        const sn = Number(rest[0]);
        this._lastSn = Number.isFinite(sn) ? { sn, time: this.now() } : null;
        // Outside a QSO it is the S/N of a CQ or a call just heard, not of a link.
        if (this.state.state === 'connected') {
          this._update({ sn });
          // VarAC opens with the S/N it hears the other station at: the first one, if it wasn't known at CONNECTED.
          if (this._link && !this._link.onCf && !this._link.qsy && !this._link.openingSent && Number.isFinite(sn)) this._sendOpening(sn);
        }
        break;
      }
      case 'BITRATE': {
        // "BITRATE (level)  bps TX|RX"
        const bps = Number(rest.find((v) => /^\d+$/.test(v)));
        if (Number.isFinite(bps)) this._update({ bitrate: bps });
        break;
      }
      case 'BUFFER':
        this._update({ buffer: Number(rest[0]) || 0 });
        this._drained();
        break;
      case 'CQFRAME': {
        const [raw, bw] = rest;
        if (!raw) break;
        const sn = this._takeSn();
        // VarAC's CQ names the slot its caller waits on as the callsign's suffix; -9 is a beacon.
        const cq = varac.decodeCqCall(raw);
        const entry = { call: cq.call, raw: raw.toUpperCase(), slot: cq.slot, offsetHz: cq.offsetHz, beacon: cq.beacon, bw: Number(bw) || null, sn, time: this.now() };
        if (cq.slot && !cq.beacon) {
          const now = this.now();
          this._slotsHeard = [...this._slotsHeard.filter((h) => now - h.time < SLOT_RECENT_MS), { cfHz: this.controlServer.state.frequency, offsetHz: cq.offsetHz, time: now }];
        }
        this.state.heard = [entry, ...this.state.heard.filter((h) => h.call !== cq.call)].slice(0, HEARD_MAX);
        this._spot(cq.call, sn);
        this.controlServer.broadcastJsonEvent(EVENT.VARA_STATUS, this.state);
        const where = cq.beacon ? 'on the calling frequency' : cq.slot ? `waiting ${cq.offsetHz > 0 ? '+' : '−'}${Math.abs(cq.offsetHz)} Hz from the calling frequency (slot ${cq.slot})` : '';
        const bwText = Number(bw) ? `${bw} Hz` : '';
        const detail = [where, bwText].filter(Boolean).join(', ');
        this._addText(`${cq.beacon ? 'Beacon' : 'CQ'} from ${cq.call}${detail ? ` (${detail})` : ''}\n`, { note: true });
        break;
      }
      default:
        break; // IAMALIVE, REGISTERED, LINK (UN)REGISTERED, ENCRYPTION DISABLED, VERSION ...
    }
  }

  /** The S/N the modem reported just now, for the frame that came with it (once), or null. */
  _takeSn() {
    const l = this._lastSn;
    this._lastSn = null;
    return l && this.now() - l.time <= SPOT_SN_MS ? l.sn : null;
  }

  /**
   * "PSK Spot": reports a station heard (a CQ or beacon, or the station
   * connected to) to pskreporter.info, as FT8 does, when the PSK Spot box is
   * ticked. Mode "VARAC", the name VarAC's own reports use (its manual,
   * V13.2.7), so they appear together on the map. The frequency is the dial
   * plus VARA's 1500 Hz centre. Needs the frame's S/N.
   */
  _spot(call, sn) {
    if (!this.pskReporter || !this.controlServer.state.pskSpotEnabled || sn == null) return;
    const base = String(call || '').replace(/-\d+$/, ''); // no SSID
    if (!PSK_CALLSIGN_RE.test(base)) return;
    const dialHz = this.controlServer.state.frequency;
    if (!Number.isFinite(dialHz) || dialHz <= 0) return;
    this.pskReporter.addSpot({ call: base, grid: null, freqHz: dialHz + SIGNAL_CENTRE_HZ, snr: sn, mode: 'VARAC', timeSec: Math.floor(this.now() / 1000) });
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

  /** Sends one line in the QSO: as a VarAC message, or as plain text (CR) to a station that doesn't frame its messages. */
  _sendText(line) {
    const link = this._link;
    const data = link?.parser.plain ? encodeText(line) : varac.frameMessage(line);
    this._worker?.postMessage({ type: 'send', data: Uint8Array.from(data).buffer });
  }

  /** VarAC's opening: "de CALL <R+05>" (the S/N we hear them at), then the profile tags, if any. */
  _sendOpening(sn) {
    const link = this._link;
    if (!link || link.openingSent || !this._worker) return;
    link.openingSent = true;
    this._sendText(varac.openingMessage(this.callsign, sn));
    const p = this.profile;
    const tags = [p.name && `<NAME:${p.name}>`, p.qth && `<QTH:${p.qth}>`, p.loc && `<LOC:${p.loc}>`].filter(Boolean);
    if (tags.length) this._sendText(tags.join('\r\n'));
  }

  /** Bytes from the other station: VarAC messages (put into words), or plain text. */
  _received(bytes) {
    const link = this._link;
    if (!link) {
      this._addText(cleanText(bytes.toString('latin1')));
      return;
    }
    const { messages, plain } = link.parser.feed(bytes);
    for (const m of messages) {
      const r = varac.renderMessage(m, this.state.peer);
      if (r.text) this._addText(r.text, { note: r.note });
      if (this._link === link) this._varacControl(m);
    }
    if (plain) this._addText(cleanText(plain));
  }

  /**
   * Ends the QSO politely: VarAC's <DISC> first (not to a plain-text
   * station), then DISCONNECT once it has gone (or after DISC_DRAIN_MS).
   */
  _closeLink() {
    const link = this._link;
    this._update({ state: 'disconnecting' });
    if (!link || link.parser.plain || link.disc) {
      if (!link?.disc) this._command('DISCONNECT');
      return;
    }
    this._sendText('<DISC>');
    link.disc = { at: this.now(), timer: setTimeout(() => this._finishClose(), DISC_DRAIN_MS) };
    link.disc.timer.unref?.();
  }

  /** The send buffer changed: once <DISC> has been queued and then gone, DISCONNECT. */
  _drained() {
    const q = this._link?.qsy;
    if (q?.phase === 'sending') {
      if (this.state.buffer > 0) q.queued = true;
      else if (q.queued) this._qsyMove();
    }
    const disc = this._link?.disc;
    if (!disc || disc.done) return;
    if (this.state.buffer > 0) disc.queued = true;
    else if (disc.queued) this._finishClose();
  }

  _finishClose() {
    const disc = this._link?.disc;
    if (!disc || disc.done) return;
    disc.done = true;
    clearTimeout(disc.timer);
    this._command('DISCONNECT');
  }

  _endLink() {
    if (this._link?.disc) clearTimeout(this._link.disc.timer);
    if (this._link?.qsy) clearTimeout(this._link.qsy.timer);
    this._link = null;
    if (this.state.qsy || this.state.qsyReady) this._update({ qsy: null, qsyReady: false });
  }

  /** VarAC's control messages in the QSO: readiness to QSY, a QSY request, and the steps of the QSY handshake. */
  _varacControl(m) {
    const link = this._link;
    const q = link.qsy;
    if (q?.phase === 'tl' && /<TL>/.test(m)) {
      this._sendText('<QSYR>');
      this._qsyPhase('opening');
      return;
    }
    if (q?.phase === 'qsyr' && /<QSYR>/.test(m)) {
      this._qsyDone();
      return;
    }
    if (q?.phase === 'opening' && varac.isOpening(m)) {
      this._qsyDone();
      return;
    }
    if (/<(Q|AWQ)>/.test(m) && !link.ready) {
      link.ready = true;
      this._update({ qsyReady: true });
      if (link.onCf && !q) {
        // Our call, on the calling frequency: move the QSO to a slot now, as stock VarAC does.
        const offset = link.caller && !link.autoQsy && !link.parser.plain ? this._freeSlotOffset() : null;
        if (offset != null) {
          link.autoQsy = true;
          this._requestQsy(this.controlServer.state.frequency + offset, { auto: true });
          return;
        }
        this._addText(`${this.state.peer} is ready to QSY off the calling frequency (QSYD/QSYU)\n`, { note: true });
      }
    }
    const dial = this.controlServer.state.frequency;
    const target = varac.qsyTarget(m, dial);
    if (target != null && !q) {
      if (!Number.isFinite(dial) || target === dial || Math.abs(target - dial) > QSY_MAX_HZ) {
        this._addText(`Not following: ${mhzText(target)} MHz is not a nearby slot\n`, { note: true });
        return;
      }
      // Our modem acknowledges the request first; move once it has (hfmodem: answer_qsy_steps()).
      link.qsy = { role: 'receiver', target, phase: null, timer: null };
      this._addText(`Moving to ${mhzText(target)} MHz with ${this.state.peer}\n`, { note: true });
      this._qsyPhase('ack', QSY_ACK_MS, () => (this._keyed ? this._qsyFail('our modem was still transmitting') : this._qsyMove()));
    }
  }

  /** QSYD/QSYU in a QSO: send VarAC's <Q:n>, move once it has been delivered, then <TL> and wait for <QSYR>. */
  _requestQsy(target, { auto = false } = {}) {
    const link = this._link;
    link.qsy = { role: 'requester', target, phase: null, timer: null, queued: false };
    this._sendText(varac.qsyRequest(target - this.controlServer.state.frequency));
    this._addText(`Asking ${this.state.peer} to QSY to ${mhzText(target)} MHz${auto ? ' (off the calling frequency, as VarAC does)' : ''}\n`, { note: true });
    this._qsyPhase('sending', QSY_SEND_MS, () => this._qsyFail(`${this.state.peer} didn't receive the request`));
  }

  /** The first slot (offset from this calling frequency) no CQ was heard waiting on lately, or null. */
  _freeSlotOffset() {
    const cf = this.controlServer.state.frequency;
    const now = this.now();
    const taken = new Set(this._slotsHeard.filter((h) => h.cfHz === cf && now - h.time < SLOT_RECENT_MS).map((h) => h.offsetHz));
    return SLOT_ORDER_HZ.find((o) => !taken.has(o)) ?? null;
  }

  _qsyPhase(phase, ms = QSY_STEP_MS, onTimeout) {
    const q = this._link?.qsy;
    if (!q) return;
    clearTimeout(q.timer);
    q.phase = phase;
    const what = { ack: `waiting for our acknowledgement`, sending: `sending the request`, tl: `waiting for ${this.state.peer}`, qsyr: `waiting for ${this.state.peer}`, opening: `waiting for ${this.state.peer}'s report` }[phase];
    q.timer = setTimeout(onTimeout || (() => this._qsyFail(`${what} timed out`)), ms);
    q.timer.unref?.();
    this._update({ qsy: { role: q.role, target: q.target, phase } });
  }

  /** Both sides' move: retune, then the requester says it has arrived (<TL>). */
  async _qsyMove() {
    const link = this._link;
    const q = link?.qsy;
    if (!q || (q.phase !== 'ack' && q.phase !== 'sending') || q.moving) return;
    q.moving = true;
    clearTimeout(q.timer);
    try {
      await this._tune(q.target);
    } catch (err) {
      this._qsyFail(`couldn't retune: ${err.message}`);
      return;
    }
    if (this._link !== link) return;
    link.moved = true;
    link.onCf = varac.CALLING_HZ.includes(q.target);
    link.openingSent = false;
    if (q.role === 'requester') {
      this._sendText('<TL>');
      this._qsyPhase('qsyr');
    } else this._qsyPhase('tl');
  }

  /** The handshake is complete: our opening report on the new frequency. */
  _qsyDone() {
    const link = this._link;
    const q = link?.qsy;
    if (!q) return;
    clearTimeout(q.timer);
    link.qsy = null;
    this._update({ qsy: null });
    this._addText(`QSY done: on ${mhzText(q.target)} MHz with ${this.state.peer}\n`, { note: true });
    this._sendOpening(this.state.sn ?? 0);
  }

  _qsyFail(why) {
    const link = this._link;
    const q = link?.qsy;
    if (!q) return;
    clearTimeout(q.timer);
    link.qsy = null;
    this._update({ qsy: null });
    this._addText(`QSY to ${mhzText(q.target)} MHz didn't complete: ${why}\n`, { note: true });
  }

  /** Retunes the radio (the server's own change: the browsers are told). */
  async _tune(hz) {
    const civ = this.controlServer.civ;
    if (civ) await civ.setFrequency(hz);
    this.controlServer.state.frequency = hz;
    this.controlServer.broadcastJsonEvent(EVENT.FREQUENCY, { value: hz });
    this.controlServer.emit?.('frequency', hz);
  }

  /** A KISS broadcast heard on air: VarAC's beacon (command 2) or an addressed notice such as "VMail waiting" (AX.25 UI, command 1). */
  _kiss(command, bytes) {
    const sn = this._takeSn();
    if (command === 2) {
      const b = varac.decodeBeacon(bytes.toString('latin1'));
      if (!b) return;
      const entry = { call: b.call, raw: b.call, slot: null, offsetHz: 0, beacon: true, grid: b.grid, services: b.services, bw: null, sn, time: this.now() };
      this.state.heard = [entry, ...this.state.heard.filter((h) => h.call !== b.call)].slice(0, HEARD_MAX);
      this._spot(b.call, sn);
      this.controlServer.broadcastJsonEvent(EVENT.VARA_STATUS, this.state);
      this._addText(`Beacon from ${b.call} (${[b.grid, b.services.length ? `offers ${b.services.join(', ')}` : ''].filter(Boolean).join('; ')})\n`, { note: true });
      return;
    }
    const ui = varac.decodeUi(bytes, command);
    if (!ui) return;
    if (/^<SMP>/.test(ui.info)) {
      const forUs = ui.to.replace(/-\d+$/, '') === this.callsign;
      this._addText(forUs ? `${ui.from} has VMail waiting for you (PiRO can't collect VMail yet)\n` : `${ui.from} has VMail waiting for ${ui.to}\n`, { note: true });
    } else this._addText(`${ui.from} to ${ui.to}: ${cleanText(ui.info)}\n`, { note: true });
  }

  /** Something was sent or received: restart the idle clock. */
  _touch() {
    clearTimeout(this._idleTimer);
    if (this.state.state !== 'connected' && this.state.state !== 'calling') return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.state.state !== 'connected') return;
      this._addText(`Nothing sent or received for ${Math.round(this.idleMs / 60000)} minutes; disconnecting.\n`, { note: true });
      this._closeLink();
    }, this.idleMs);
    this._idleTimer.unref?.();
  }
}

module.exports = { VaraBridge, varaConfig, encodeText, cleanText, CALLSIGN_RE, BANDWIDTHS };
