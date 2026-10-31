'use strict';

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { EVENT } = require('./protocol');
const { VoiceSquelch } = require('../audio/voice-squelch');
const { StreamDecimator } = require('../audio/decimator');
const { keepSegments, phoneticCallsigns, HAM_PROMPT } = require('./stt-text');

const RATE = 16000; // Whisper's sample rate
const MAX_OVER_SEC = 28; // Whisper hears 30 s at a time; a longer over is sent in parts
const MIN_OVER_SEC = 0.6; // shorter than this is a click, not an over
const MAX_QUEUE = 2; // overs waiting while one is transcribed; older ones are dropped
const HISTORY_MAX = 40;
const DEFAULT_PORT = 8178;
const START_TIMEOUT_MS = 120 * 1000; // loading a model on a Pi takes a while
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
  let port = DEFAULT_PORT;
  if (env.STT_PORT) {
    const v = Number(env.STT_PORT);
    if (Number.isInteger(v) && v > 0 && v < 65536) port = v;
    else warnings.push(`STT_PORT="${env.STT_PORT}" is not a port; using ${DEFAULT_PORT}.`);
  }
  if (url && !/^https?:\/\//.test(url)) warnings.push(`STT_URL="${url}" must start with http:// or https://.`);
  if (!url && (serverBin || model) && !(serverBin && model)) warnings.push('STT needs both STT_WHISPER_SERVER and STT_MODEL (or STT_URL).');
  return { url: /^https?:\/\//.test(url) ? url : '', serverBin, model, threads, port, warnings };
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

/** POST (or GET without a body) to a URL; resolves {status, text}. */
function httpRequest(url, { method = 'GET', body, type, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method, headers: body ? { 'Content-Type': type, 'Content-Length': body.length } : {}, timeout: timeoutMs },
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
 * - or STT_URL: one already running (on a faster computer, say).
 *
 * Overs are found with the voice squelch's speech detector
 * (audio/voice-squelch.js: the pitch of a voice, with 0.3 s before it and
 * 1.5 s after), on the raw received audio (not what the noise filters
 * leave). Each over, reduced to 16 kHz, is posted to /inference as a WAV;
 * an over longer than 28 s is sent in parts. One is transcribed at a time;
 * if the transcriber falls behind, the oldest waiting is dropped. Nothing
 * is transcribed while transmitting, or outside a voice mode (LSB, USB, AM,
 * FM with DATA mode off and no app mode). STT is unticked when the last
 * browser leaves.
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
   * @param {{url?: string, serverBin?: string, model?: string, threads?: number, port?: number}} [opts.config] - see sttConfig()
   * @param {Function} [opts.request] - injectable httpRequest(url, opts)
   * @param {Function} [opts.spawnFn] - injectable child_process.spawn
   * @param {() => number} [opts.now]
   * @param {number} [opts.pollMs=500] - how often a starting server is checked
   */
  constructor({ controlServer, audioBridge, config = {}, request, spawnFn, now, pollMs = 500 } = {}) {
    if (!controlServer) throw new Error('SttBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('SttBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.config = { threads: 4, port: DEFAULT_PORT, ...config };
    this.request = request ?? httpRequest;
    this.spawnFn = spawnFn ?? spawn;
    this.now = now ?? Date.now;
    this.pollMs = pollMs;

    const rate = audioBridge.sampleRate;
    const local = !this.config.url && this.config.serverBin && this.config.model;
    let unavailable = null;
    if (!this.config.url && !local) unavailable = 'Speech-to-text is not set up on this server: set STT_WHISPER_SERVER and STT_MODEL (or STT_URL). See the README.';
    else if (!Number.isInteger(rate / 8000) || rate < RATE) unavailable = `Speech-to-text needs an audio rate that is a multiple of 16 kHz (this server uses ${rate} Hz).`;
    this.unavailable = unavailable;
    this.local = !!local;
    this.baseUrl = this.config.url || `http://127.0.0.1:${this.config.port}`;

    this._enabled = false;
    this._session = 0;
    this._child = null;
    this._ready = false;
    this._attached = false;
    this._ptt = false;
    this._squelch = null;
    this._decimator = null;
    this._over = []; // 16 kHz chunks of the over now
    this._overLen = 0;
    this._overStart = 0;
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
      engine: this.local ? 'local' : this.config.url ? 'remote' : null,
      phase: 'off', // 'off' | 'starting' | 'listening' | 'paused' | 'error'
      note: null, // why paused, or the error
      busy: false, // an over is being transcribed
      waiting: 0, // overs waiting
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
    this._modeTimer = setInterval(() => this._syncAudio(), 1000); // the mode, DATA mode and app modes have no event of their own
    this._modeTimer.unref?.();
    this.controlServer.broadcastJsonEvent(EVENT.STT_STATUS, this.state);
    if (this.controlServer.state.sttEnabled) this.setEnabled(true).catch(() => {});
  }

  async stop() {
    this.controlServer.off('stt-enabled', this._onEnabled);
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('client-connected', this._onClientJoined);
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
    this._update({ enabled: true, phase: 'starting', note: this.local ? 'loading the speech model…' : `connecting to ${this.baseUrl}…` });
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
    const deadline = this.now() + START_TIMEOUT_MS;
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

  /** Voice mode: LSB/USB/AM/FM, DATA mode off, no app mode. */
  _voiceMode() {
    const cs = this.controlServer.state;
    const mode = cs.mode?.mode ?? cs.mode;
    if (!VOICE_MODES.includes(mode)) return false;
    if (cs.dataMode) return false;
    const m = this.controlServer.appModes?.() ?? {};
    return !Object.entries(m).some(([k, v]) => k.endsWith('Active') && v === true);
  }

  _syncAudio() {
    if (!this._enabled || !this._ready) return;
    let pause = null;
    if (this._ptt) pause = 'transmitting';
    else if (!this._voiceMode()) pause = 'only in voice modes (SSB, AM, FM)';
    if (pause) {
      if (this._attached) this._endOver(); // what was heard before still goes
      this._detach();
      this._update({ phase: 'paused', note: pause });
    } else {
      if (!this._attached) this._attach();
      this._update({ phase: 'listening', note: null });
    }
  }

  _attach() {
    this._squelch = new VoiceSquelch({ sampleRate: this.audioBridge.sampleRate, makeResampler: (a, b) => new StreamDecimator(a, b, { cutoffHz: 3500 }) });
    this._decimator = new StreamDecimator(this.audioBridge.sampleRate, RATE);
    this._over = [];
    this._overLen = 0;
    this._wasOpen = false;
    this.audioBridge.capture.on('data', this._onPcm);
    this._attached = true;
  }

  _detach() {
    if (!this._attached) return;
    this.audioBridge.capture.off('data', this._onPcm);
    this._attached = false;
    this._squelch = null;
    this._decimator = null;
  }

  _handlePcm(chunk) {
    if (!this._squelch) return;
    const gated = this._squelch.process(chunk);
    if (gated) {
      if (!this._wasOpen) this._overStart = this.now() - 300; // the squelch runs 0.3 s behind
      this._wasOpen = true;
      const n = gated.length >> 1;
      const x = new Int16Array(n);
      for (let i = 0; i < n; i++) x[i] = gated.readInt16LE(2 * i);
      const y = this._decimator.process(x);
      this._over.push(y);
      this._overLen += y.length;
      if (this._overLen >= MAX_OVER_SEC * RATE) {
        this._endOver();
        this._wasOpen = true;
        this._overStart = this.now();
      }
    } else if (this._wasOpen) {
      this._wasOpen = false;
      this._endOver();
    }
  }

  _endOver() {
    const len = this._overLen;
    const parts = this._over;
    this._over = [];
    this._overLen = 0;
    if (len < MIN_OVER_SEC * RATE) return;
    const samples = new Float32Array(len);
    let o = 0;
    for (const p of parts) {
      samples.set(p, o);
      o += p.length;
    }
    this._queue.push({ samples, time: this._overStart, durationSec: Math.round((len / RATE) * 10) / 10 });
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
      const { body, type } = multipart(
        {
          response_format: 'verbose_json',
          language: 'en',
          temperature: '0.0',
          temperature_inc: '0.0',
          suppress_nst: 'true',
          no_language_probabilities: 'true',
          audio_ctx: String(audioCtxFor(over.durationSec)),
          prompt: HAM_PROMPT,
        },
        encodeWav(over.samples)
      );
      const started = this.now();
      const res = await this.request(`${this.baseUrl}/inference`, { method: 'POST', body, type });
      if (session !== this._session) return;
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 120)}`);
      const kept = keepSegments(JSON.parse(res.text));
      const seconds = Math.round((this.now() - started) / 100) / 10;
      // One line a over in the journal, so it can be seen what Whisper heard and what was kept.
      console.log(`STT: ${over.durationSec} s over, ${seconds} s to transcribe: ${kept.text ? `"${kept.text}"` : 'nothing kept'}${kept.why.length ? `; dropped ${kept.why.join('; ')}` : ''}`);
      this._update({ last: { durationSec: over.durationSec, seconds, kept: !!kept.text } });
      if (kept.text) {
        const entry = {
          id: this._nextId++,
          time: over.time,
          durationSec: over.durationSec,
          text: kept.text,
          words: kept.words,
          callsigns: phoneticCallsigns(kept.text),
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
}

module.exports = { SttBridge, sttConfig, encodeWav, multipart, httpRequest, audioCtxFor };
