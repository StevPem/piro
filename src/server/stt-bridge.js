'use strict';

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { EVENT } = require('./protocol');
const { VoiceSquelch } = require('../audio/voice-squelch');
const { StreamDecimator } = require('../audio/decimator');
const { keepSegments, keepDeepgram, phoneticCallsigns, HAM_PROMPT } = require('./stt-text');
const { CONNECT_OPTIONS } = require('./net-options');

const RATE = 16000; // Whisper's sample rate
// A long over is sent in pieces, so its text comes as it goes. Each piece
// is cut at the quietest moment of its last CUT_SEARCH_SEC (usually a gap
// between words). STT_MAX_SEGMENT_SEC sets the length: 5 to 28 s (Whisper
// hears 30 s at a time), 10 by default.
const DEFAULT_SEGMENT_SEC = 10;
const MIN_SEGMENT_SEC = 5;
const MAX_SEGMENT_SEC = 28;
const CUT_SEARCH_SEC = 2;
const CUT_WINDOW = 320; // 20 ms at 16 kHz
const CONTEXT_CHARS = 200; // of the previous piece's text, given to Whisper as context
const MIN_OVER_SEC = 0.6; // shorter than this is a click, not an over
const MAX_QUEUE = 2; // overs waiting while one is transcribed; older ones are dropped
const HISTORY_MAX = 40;
const DEFAULT_PORT = 8178;
const START_TIMEOUT_MS = 120 * 1000; // loading a model on a Pi takes a while
const DEEPGRAM_START_TIMEOUT_MS = 30 * 1000; // reaching api.deepgram.com
const DEEPGRAM_URL = 'https://api.deepgram.com';
const DEEPGRAM_MODEL = 'nova-3';
const DEEPGRAM_MAX_KEYTERMS = 100; // Deepgram allows 500 tokens of keyterms a request
// What Deepgram is told to listen for (DEEPGRAM_KEYTERMS replaces it):
// the phonetic alphabet, numbers as said on air, and the usual words of a QSO.
const DEEPGRAM_KEYTERMS = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike',
  'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'X-ray', 'Yankee', 'Zulu',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'niner',
  'five nine', 'five and nine', 'CQ', 'QSL', 'QRZ', 'QTH', 'QSY', 'seventy three', 'over', 'roger', 'copy',
];
const REQUEST_TIMEOUT_MS = 120 * 1000;
const VOICE_MODES = ['LSB', 'USB', 'AM', 'FM', 'WFM'];
// Whisper's encoder works on 30 s (1500 frames, 50 a second) whatever the
// length of the audio, so a short over costs as much as a long one. Telling
// it the over's length (audio_ctx), plus a little, cuts that: a 5 s over
// is about three times faster. Not below 512 frames (about 10 s), where
// whisper.cpp's accuracy starts to suffer.
const MIN_AUDIO_CTX = 512;
const FULL_AUDIO_CTX = 1500;

/** whisper.cpp's audio_ctx for an over this long (seconds). */
function audioCtxFor(durationSec) {
  return Math.min(FULL_AUDIO_CTX, Math.max(MIN_AUDIO_CTX, Math.ceil((durationSec + 2) * 50)));
}

/** The STT settings from the environment. */
function sttConfig(env = process.env) {
  const warnings = [];
  const url = (env.STT_URL || '').trim().replace(/\/+$/, '');
  const serverBin = (env.STT_WHISPER_SERVER || '').trim();
  const model = (env.STT_MODEL || '').trim();
  let threads = 4;
  if (env.STT_THREADS) {
    const v = Number(env.STT_THREADS);
    if (Number.isInteger(v) && v >= 1 && v <= 16) threads = v;
    else warnings.push(`STT_THREADS="${env.STT_THREADS}" must be 1 to 16; using 4.`);
  }
  let maxSegmentSec = DEFAULT_SEGMENT_SEC;
  if (env.STT_MAX_SEGMENT_SEC) {
    const v = Number(env.STT_MAX_SEGMENT_SEC);
    if (Number.isFinite(v) && v >= MIN_SEGMENT_SEC && v <= MAX_SEGMENT_SEC) maxSegmentSec = v;
    else warnings.push(`STT_MAX_SEGMENT_SEC="${env.STT_MAX_SEGMENT_SEC}" must be ${MIN_SEGMENT_SEC} to ${MAX_SEGMENT_SEC}; using ${DEFAULT_SEGMENT_SEC}.`);
  }
  let port = DEFAULT_PORT;
  if (env.STT_PORT) {
    const v = Number(env.STT_PORT);
    if (Number.isInteger(v) && v > 0 && v < 65536) port = v;
    else warnings.push(`STT_PORT="${env.STT_PORT}" is not a port; using ${DEFAULT_PORT}.`);
  }
  // Deepgram, in the cloud: STT_ENGINE=deepgram, or DEEPGRAM_API_KEY with no whisper.cpp set up.
  const unquote = (v) => String(v ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  const deepgramKey = unquote(env.DEEPGRAM_API_KEY);
  const deepgramModel = unquote(env.DEEPGRAM_MODEL) || DEEPGRAM_MODEL;
  const deepgramLanguage = unquote(env.DEEPGRAM_LANGUAGE) || 'en';
  let deepgramUrl = unquote(env.DEEPGRAM_URL).replace(/\/+$/, '') || DEEPGRAM_URL;
  if (!/^https?:\/\//.test(deepgramUrl)) {
    warnings.push(`DEEPGRAM_URL="${deepgramUrl}" must start with https://; using ${DEEPGRAM_URL}.`);
    deepgramUrl = DEEPGRAM_URL;
  }
  let deepgramKeyterms = DEEPGRAM_KEYTERMS;
  if (unquote(env.DEEPGRAM_KEYTERMS) !== '') {
    deepgramKeyterms = unquote(env.DEEPGRAM_KEYTERMS)
      .split(',')
      .map((t) => {
        try {
          return decodeURIComponent(t).trim(); // "five%20nine" works as well as "five nine"
        } catch {
          return t.trim();
        }
      })
      .filter(Boolean);
    if (deepgramKeyterms.length > DEEPGRAM_MAX_KEYTERMS) {
      warnings.push(`DEEPGRAM_KEYTERMS has ${deepgramKeyterms.length} terms; using the first ${DEEPGRAM_MAX_KEYTERMS}.`);
      deepgramKeyterms = deepgramKeyterms.slice(0, DEEPGRAM_MAX_KEYTERMS);
    }
  }
  const whisperSet = !!(url || serverBin || model);
  let engine = unquote(env.STT_ENGINE).toLowerCase();
  if (engine && engine !== 'whisper' && engine !== 'deepgram') {
    warnings.push(`STT_ENGINE="${env.STT_ENGINE}" must be whisper or deepgram.`);
    engine = '';
  }
  if (!engine) engine = deepgramKey && !whisperSet ? 'deepgram' : 'whisper';
  if (engine === 'deepgram' && !deepgramKey) warnings.push('STT_ENGINE=deepgram needs DEEPGRAM_API_KEY.');
  if (url && !/^https?:\/\//.test(url)) warnings.push(`STT_URL="${url}" must start with http:// or https://.`);
  if (engine === 'whisper' && !url && (serverBin || model) && !(serverBin && model)) warnings.push('STT needs both STT_WHISPER_SERVER and STT_MODEL (or STT_URL).');
  return {
    engine,
    url: /^https?:\/\//.test(url) ? url : '',
    serverBin,
    model,
    threads,
    port,
    maxSegmentSec,
    deepgram: { key: deepgramKey, model: deepgramModel, language: deepgramLanguage, url: deepgramUrl, keyterms: deepgramKeyterms },
    warnings,
  };
}

/** 16-bit mono WAV at `rate` from Float32 samples (-1..1). */
function encodeWav(samples, rate = RATE) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
    buf.writeInt16LE(v, 44 + 2 * i);
  }
  return buf;
}

/** A multipart/form-data body: fields {name: string}, and the WAV as "file". */
function multipart(fields, wav) {
  const boundary = `----piro${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="over.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(wav);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Deepgram's pre-recorded endpoint for one over: the model, punctuation
 * and number formatting, and the keyterms (one parameter each; Nova-3 and
 * Flux take "keyterm", older models "keywords").
 */
function deepgramListenUrl({ url = DEEPGRAM_URL, model = DEEPGRAM_MODEL, language = 'en', keyterms = DEEPGRAM_KEYTERMS } = {}) {
  const q = new URLSearchParams({ model, language, punctuate: 'true', smart_format: 'true' });
  const name = /^(nova-3|flux)/i.test(model) ? 'keyterm' : 'keywords';
  for (const t of keyterms) q.append(name, t);
  return `${url}/v1/listen?${q.toString().replace(/\+/g, '%20')}`;
}

/** POST (or GET without a body) to a URL; resolves {status, text}. */
function httpRequest(url, { method = 'GET', body, type, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { ...CONNECT_OPTIONS, method, headers: { ...headers, ...(body ? { 'Content-Type': type, 'Content-Length': body.length } : {}) }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Speech-to-text "copy assist": while a browser has STT ticked
 * (REQUEST.SET_STT_ENABLED, the 'stt-enabled' event), received speech in a
 * voice mode is transcribed by whisper.cpp and shown as text under the
 * S-meter. An aid to copying, not a log: nothing is saved.
 *
 * The speech engine is whisper.cpp's own HTTP server, `whisper-server`:
 * - STT_WHISPER_SERVER and STT_MODEL: PiRO starts it on this machine
 *   (127.0.0.1:STT_PORT, STT_THREADS threads) when STT is ticked, and stops
 *   it when it is unticked, so the model's memory is only used then;
 * - or STT_URL: one already running (on a faster computer, say);
 * - or Deepgram, in the cloud (STT_ENGINE=deepgram, DEEPGRAM_API_KEY): each
 *   over is posted to its /v1/listen with the keyterms DEEPGRAM_KEYTERMS
 *   (phonetics and numbers by default). Nothing runs on this machine, but
 *   the audio leaves it, and it needs the internet and a paid key.
 *
 * Overs are found with the voice squelch's speech detector
 * (audio/voice-squelch.js: the pitch of a voice, with 0.3 s before it and
 * 1.5 s after), on the raw received audio (not what the noise filters
 * leave). Each over, reduced to 16 kHz, is posted to /inference as a WAV;
 * an over longer than STT_MAX_SEGMENT_SEC (10 s) is sent in pieces as it
 * goes, each cut at a quiet moment and transcribed with the text before it
 * as context. One piece is transcribed at a time;
 * if the transcriber falls behind, the oldest waiting is dropped. Nothing
 * is transcribed while transmitting, or outside a voice mode: LSB, USB, AM
 * or FM with DATA mode off and no app mode, or FreeDV (RADE), where it
 * hears RadeBridge's decoded speech, not the modem tones. state.stt.voice
 * says whether this is a voice mode, ticked or not, and the page shows the
 * STT checkbox only then. STT is unticked when the last browser leaves.
 *
 * What comes back is filtered (stt-text.js keepSegments(): no text Whisper
 * makes up from noise) and broadcast as EVENT.STT_TEXT, with the
 * callsigns spelled in it (phoneticCallsigns()). Its state is
 * controlServer.state.stt, broadcast as EVENT.STT_STATUS.
 */
class SttBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {import('events').EventEmitter} [opts.radeBridge] - FreeDV's RadeBridge: its 'decoded-speech' is heard in FreeDV
   * @param {{url?: string, serverBin?: string, model?: string, threads?: number, port?: number}} [opts.config] - see sttConfig()
   * @param {Function} [opts.request] - injectable httpRequest(url, opts)
   * @param {Function} [opts.spawnFn] - injectable child_process.spawn
   * @param {() => number} [opts.now]
   * @param {number} [opts.pollMs=500] - how often a starting server is checked
   */
  constructor({ controlServer, audioBridge, radeBridge = null, config = {}, request, spawnFn, now, pollMs = 500 } = {}) {
    if (!controlServer) throw new Error('SttBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('SttBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.radeBridge = radeBridge;
    this.config = { threads: 4, port: DEFAULT_PORT, maxSegmentSec: DEFAULT_SEGMENT_SEC, ...config };
    this.request = request ?? httpRequest;
    this.spawnFn = spawnFn ?? spawn;
    this.now = now ?? Date.now;
    this.pollMs = pollMs;

    const rate = audioBridge.sampleRate;
    this.engine = this.config.engine === 'deepgram' ? 'deepgram' : 'whisper';
    this.deepgram = { key: '', model: DEEPGRAM_MODEL, language: 'en', url: DEEPGRAM_URL, keyterms: DEEPGRAM_KEYTERMS, ...this.config.deepgram };
    const local = this.engine === 'whisper' && !this.config.url && this.config.serverBin && this.config.model;
    let unavailable = null;
    if (this.engine === 'deepgram') {
      if (!this.deepgram.key) unavailable = 'Speech-to-text with Deepgram needs DEEPGRAM_API_KEY. See the README.';
    } else if (!this.config.url && !local) unavailable = 'Speech-to-text is not set up on this server: set STT_WHISPER_SERVER and STT_MODEL (or STT_URL), or DEEPGRAM_API_KEY. See the README.';
    else if (!Number.isInteger(rate / 8000) || rate < RATE) unavailable = `Speech-to-text needs an audio rate that is a multiple of 16 kHz (this server uses ${rate} Hz).`;
    this.unavailable = unavailable;
    this.local = !!local;
    this.baseUrl = this.engine === 'deepgram' ? this.deepgram.url : this.config.url || `http://127.0.0.1:${this.config.port}`;

    this._enabled = false;
    this._session = 0;
    this._child = null;
    this._ready = false;
    this._attached = false;
    this._source = null; // what is heard: audioBridge.capture, or radeBridge in FreeDV
    this._ptt = false;
    this._squelch = null;
    this._decimator = null;
    this._over = []; // 16 kHz chunks of the over now
    this._overLen = 0;
    this._overStart = 0; // when the piece now being gathered began (epoch ms)
    this._overId = 0; // which over the piece belongs to
    this._part = 0; // which piece of it
    this._overText = new Map(); // overId -> {text, callsigns}: what its pieces have said so far
    this._wasOpen = false;
    this._queue = [];
    this._busy = false;
    this._history = [];
    this._nextId = 1;

    controlServer.state.stt = this._freshState();

    this._onEnabled = (on) => this.setEnabled(!!on).catch(() => {});
    this._onPtt = (on) => {
      this._ptt = !!on;
      this._syncAudio();
    };
    this._onPcm = (chunk) => this._handlePcm(chunk);
    this._onModeChanged = () => setImmediate(() => this._syncAudio());
    this._onClientJoined = (ws) => {
      if (this._history.length && typeof this.controlServer.sendJsonEvent === 'function') {
        this.controlServer.sendJsonEvent(ws, EVENT.STT_TEXT, { replace: true, overs: this._history });
      }
    };
  }

  _freshState() {
    return {
      available: !this.unavailable,
      reason: this.unavailable,
      enabled: false,
      engine: this.engine === 'deepgram' ? 'deepgram' : this.local ? 'local' : this.config.url ? 'remote' : null,
      phase: 'off', // 'off' | 'starting' | 'listening' | 'paused' | 'error'
      note: null, // why paused, or the error
      busy: false, // an over is being transcribed
      waiting: 0, // overs waiting
      voice: false, // a voice mode now (the page shows the checkbox only then)
      last: null, // the last over: {durationSec, seconds, kept}
    };
  }

  get state() {
    return this.controlServer.state.stt;
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
    if (changed) this.controlServer.broadcastJsonEvent(EVENT.STT_STATUS, s);
  }

  start() {
    this.controlServer.on('stt-enabled', this._onEnabled);
    this.controlServer.on('ptt', this._onPtt);
    this.controlServer.on('client-connected', this._onClientJoined);
    this.controlServer.on('mode-changed', this._onModeChanged);
    this._modeTimer = setInterval(() => this._syncAudio(), 1000); // and a check each second, in case a change has no event
    this._modeTimer.unref?.();
    this._syncAudio();
    this.controlServer.broadcastJsonEvent(EVENT.STT_STATUS, this.state);
    if (this.controlServer.state.sttEnabled) this.setEnabled(true).catch(() => {});
  }

  async stop() {
    this.controlServer.off('stt-enabled', this._onEnabled);
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('client-connected', this._onClientJoined);
    this.controlServer.off('mode-changed', this._onModeChanged);
    clearInterval(this._modeTimer);
    await this.setEnabled(false);
  }

  /** Ticked: start the engine (if local) and listen. Unticked: stop both. */
  async setEnabled(on) {
    if (on === this._enabled) return;
    this._enabled = on;
    const session = ++this._session;
    if (!on) {
      this._detach();
      this._queue = [];
      this._stopChild();
      this._ready = false;
      this._update({ enabled: false, phase: 'off', note: null, busy: false, waiting: 0 });
      return;
    }
    if (this.unavailable) {
      this._update({ enabled: true, phase: 'error', note: this.unavailable });
      return;
    }
    this._update({ enabled: true, phase: 'starting', note: this.local ? 'loading the speech model…' : this.engine === 'deepgram' ? 'connecting to Deepgram…' : `connecting to ${this.baseUrl}…` });
    try {
      if (this.local) this._startChild(session);
      await this._waitReady(session);
      if (session !== this._session) return;
      this._ready = true;
      this._syncAudio();
    } catch (err) {
      if (session !== this._session) return;
      this._stopChild();
      this._update({ phase: 'error', note: `The speech engine didn't start: ${err.message}` });
    }
  }

  _startChild(session) {
    const { serverBin, model, threads, port } = this.config;
    const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'en', '-nlp'];
    const child = this.spawnFn(serverBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this._child = child;
    let tail = '';
    child.stderr?.on('data', (d) => {
      tail = (tail + d.toString()).slice(-400);
    });
    child.on('error', (err) => {
      if (this._child === child) this._childFailed(session, err.message);
    });
    child.on('exit', (code, signal) => {
      if (this._child !== child) return;
      this._child = null;
      const last = tail.trim().split('\n').pop() || '';
      this._childFailed(session, `whisper-server stopped (${signal || `exit ${code}`})${last ? `: ${last}` : ''}`);
    });
  }

  _childFailed(session, message) {
    this._child = null;
    this._ready = false;
    this._detach();
    if (session === this._session && this._enabled) this._update({ phase: 'error', note: message, busy: false });
  }

  _stopChild() {
    const child = this._child;
    this._child = null;
    if (child && child.exitCode == null) child.kill('SIGTERM');
  }

  /** Waits until the engine answers (GET / on whisper-server). */
  async _waitReady(session) {
    const deadline = this.now() + (this.engine === 'deepgram' ? DEEPGRAM_START_TIMEOUT_MS : START_TIMEOUT_MS);
    let lastErr = null;
    while (session === this._session) {
      try {
        const res = await this.request(`${this.baseUrl}/`, { timeoutMs: 5000 });
        if (res.status >= 200 && res.status < 500) return;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (this.local && !this._child) throw new Error(this.state.note || 'whisper-server stopped');
      if (this.now() > deadline) throw lastErr || new Error('timed out');
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /**
   * Where speech is heard now: the radio's audio in LSB/USB/AM/FM with DATA
   * mode off and no app mode, FreeDV's decoded speech in FreeDV (RADE), or
   * null (not a voice mode).
   */
  _voiceSource() {
    const cs = this.controlServer.state;
    const m = this.controlServer.appModes?.() ?? {};
    if (Object.entries(m).some(([k, v]) => k.endsWith('Active') && k !== 'freeDvActive' && v === true)) return null;
    if (m.freeDvActive) return this.radeBridge && cs.freeDvVariant !== '700E' ? this.radeBridge : null;
    const mode = cs.mode?.mode ?? cs.mode;
    if (!VOICE_MODES.includes(mode) || cs.dataMode) return null;
    return this.audioBridge.capture;
  }

  _syncAudio() {
    const source = this._voiceSource();
    this._update({ voice: !!source });
    if (!this._enabled || !this._ready) return;
    let pause = null;
    if (this._ptt) pause = 'transmitting';
    else if (!source) pause = 'only in voice modes (SSB, AM, FM, FreeDV)';
    if (this._attached && (pause || source !== this._source)) {
      this._endOver(true); // what was heard before still goes
      this._detach();
    }
    if (pause) this._update({ phase: 'paused', note: pause });
    else {
      if (!this._attached) this._attach(source);
      this._update({ phase: 'listening', note: null });
    }
  }

  _attach(source) {
    this._squelch = new VoiceSquelch({ sampleRate: this.audioBridge.sampleRate, makeResampler: (a, b) => new StreamDecimator(a, b, { cutoffHz: 3500 }) });
    this._decimator = new StreamDecimator(this.audioBridge.sampleRate, RATE);
    this._over = [];
    this._overLen = 0;
    this._wasOpen = false;
    this._source = source;
    source.on(source === this.radeBridge ? 'decoded-speech' : 'data', this._onPcm);
    this._attached = true;
  }

  _detach() {
    if (!this._attached) return;
    this._source.off(this._source === this.radeBridge ? 'decoded-speech' : 'data', this._onPcm);
    this._source = null;
    this._attached = false;
    this._squelch = null;
    this._decimator = null;
  }

  _handlePcm(chunk) {
    if (!this._squelch) return;
    const gated = this._squelch.process(chunk);
    if (gated) {
      if (!this._wasOpen) {
        // A new over (the squelch runs 0.3 s behind).
        this._overStart = this.now() - 300;
        this._overId++;
        this._part = 0;
      }
      this._wasOpen = true;
      const n = gated.length >> 1;
      const x = new Int16Array(n);
      for (let i = 0; i < n; i++) x[i] = gated.readInt16LE(2 * i);
      const y = this._decimator.process(x);
      this._over.push(y);
      this._overLen += y.length;
      if (this._overLen >= this.config.maxSegmentSec * RATE) this._cutPiece();
    } else if (this._wasOpen) {
      this._wasOpen = false;
      this._endOver(true);
    }
  }

  /** The over now, as one array. */
  _gathered() {
    const samples = new Float32Array(this._overLen);
    let o = 0;
    for (const p of this._over) {
      samples.set(p, o);
      o += p.length;
    }
    return samples;
  }

  /** A long over: send what it has so far, cut at its quietest moment near the end, and carry on. */
  _cutPiece() {
    const all = this._gathered();
    const from = Math.max(0, all.length - CUT_SEARCH_SEC * RATE);
    let best = all.length;
    let bestEnergy = Infinity;
    for (let i = from; i + CUT_WINDOW <= all.length; i += CUT_WINDOW / 2) {
      let e = 0;
      for (let j = i; j < i + CUT_WINDOW; j++) e += all[j] * all[j];
      if (e < bestEnergy) {
        bestEnergy = e;
        best = i + CUT_WINDOW / 2;
      }
    }
    const head = all.subarray(0, best);
    const tail = all.slice(best);
    this._over = [head];
    this._overLen = head.length;
    this._endOver(false);
    this._over = tail.length ? [tail] : [];
    this._overLen = tail.length;
    this._overStart += Math.round((best / RATE) * 1000);
    this._part++;
  }

  /** Queues the piece gathered so far; `last`: the over has ended. */
  _endOver(last) {
    const len = this._overLen;
    const samples = this._gathered();
    this._over = [];
    this._overLen = 0;
    if (len < MIN_OVER_SEC * RATE) return;
    this._queue.push({ samples, time: this._overStart, durationSec: Math.round((len / RATE) * 10) / 10, overId: this._overId, part: this._part, last });
    while (this._queue.length > MAX_QUEUE) this._queue.shift();
    this._update({ waiting: this._queue.length });
    this._pump();
  }

  async _pump() {
    if (this._busy || !this._queue.length) return;
    const over = this._queue.shift();
    const session = this._session;
    this._busy = true;
    this._update({ busy: true, waiting: this._queue.length });
    try {
      const started = this.now();
      const kept = this.engine === 'deepgram' ? await this._deepgram(over) : await this._whisper(over);
      if (session !== this._session) return;
      const seconds = Math.round((this.now() - started) / 100) / 10;
      // One line an over in the journal, so it can be seen what was heard and what was kept.
      console.log(`STT: ${over.durationSec} s ${over.part || !over.last ? `piece ${over.part + 1} of an over` : 'over'}, ${seconds} s to transcribe: ${kept.text ? `"${kept.text}"` : 'nothing kept'}${kept.why.length ? `; dropped ${kept.why.join('; ')}` : ''}`);
      this._update({ last: { durationSec: over.durationSec, seconds, kept: !!kept.text } });
      // Callsigns are looked for in the whole over so far, so one spelled across a cut is found.
      const said = this._overText.get(over.overId) || { text: '', callsigns: [] };
      if (kept.text) said.text = said.text ? `${said.text} ${kept.text}` : kept.text;
      const callsigns = phoneticCallsigns(said.text).filter((c) => !said.callsigns.includes(c));
      said.callsigns.push(...callsigns);
      if (over.last) this._overText.delete(over.overId);
      else this._overText.set(over.overId, said);
      while (this._overText.size > 8) this._overText.delete(this._overText.keys().next().value);
      if (kept.text || callsigns.length) {
        const entry = {
          id: this._nextId++,
          overId: over.overId,
          part: over.part,
          time: over.time,
          durationSec: over.durationSec,
          text: kept.text,
          words: kept.words,
          callsigns,
          seconds,
        };
        this._history.push(entry);
        if (this._history.length > HISTORY_MAX) this._history.shift();
        this.controlServer.broadcastJsonEvent(EVENT.STT_TEXT, entry);
      }
      if (this.state.phase === 'error') this._syncAudio();
    } catch (err) {
      if (session === this._session) {
        console.warn(`STT: ${err.message}`);
        this._update({ note: `Transcription failed: ${err.message}` });
      }
    } finally {
      if (session === this._session) {
        this._busy = false;
        this._update({ busy: false, waiting: this._queue.length });
        this._pump();
      }
    }
  }

  /** One over to whisper-server's /inference; resolves what to show (keepSegments()). */
  async _whisper(over) {
    const { body, type } = multipart(
      {
        response_format: 'verbose_json',
        language: 'en',
        temperature: '0.0',
        temperature_inc: '0.0',
        suppress_nst: 'true',
        no_language_probabilities: 'true',
        audio_ctx: String(audioCtxFor(over.durationSec)),
        // A later piece of an over: what the earlier ones said, so Whisper carries on the sentence.
        prompt: over.part > 0 && this._overText.get(over.overId)?.text ? `${HAM_PROMPT} ${this._overText.get(over.overId).text.slice(-CONTEXT_CHARS)}` : HAM_PROMPT,
      },
      encodeWav(over.samples)
    );
    const res = await this.request(`${this.baseUrl}/inference`, { method: 'POST', body, type });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 120)}`);
    return keepSegments(JSON.parse(res.text));
  }

  /** One over to Deepgram's /v1/listen; resolves what to show (keepDeepgram()). The key is never logged. */
  async _deepgram(over) {
    const res = await this.request(deepgramListenUrl(this.deepgram), {
      method: 'POST',
      body: encodeWav(over.samples),
      type: 'audio/wav',
      headers: { Authorization: `Token ${this.deepgram.key}` },
    });
    if (res.status !== 200) {
      let why = res.text.slice(0, 120);
      try {
        const e = JSON.parse(res.text);
        why = e.err_msg || e.message || why;
      } catch {}
      const hint = res.status === 401 ? ' (check DEEPGRAM_API_KEY)' : res.status === 402 ? ' (no credit left)' : '';
      throw new Error(`Deepgram: HTTP ${res.status}${hint}: ${why}`);
    }
    return keepDeepgram(JSON.parse(res.text));
  }
}

module.exports = { SttBridge, sttConfig, encodeWav, multipart, httpRequest, audioCtxFor, deepgramListenUrl, DEEPGRAM_KEYTERMS };
