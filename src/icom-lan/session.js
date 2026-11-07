'use strict';

const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { IcomStream } = require('./stream');
const P = require('./protocol');
const { LanCapture, LanPlayback } = require('./audio');

class IcomSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = { controlPort: 50001, civPort: 50002, audioPort: 50003, timeoutMs: 15000,
      renewMs: 60000, initialRenewMs: 30000, tokenGraceMs: 3000, tokenDeadMs: 80000,
      reconnectAttempts: 5, reconnectMs: 1000, txBufferMs: 300, now: () => performance.now(), ...options };
    const o = this.options;
    if (!o.host) throw new Error('ICOM_LAN_HOST is required in LAN mode');
    P.passcode(o.username);
    P.passcode(o.password);
    for (const name of ['controlPort', 'civPort', 'audioPort']) {
      if (!Number.isInteger(o[name]) || o[name] < 1 || o[name] > 65535) throw new Error(`Invalid Icom LAN ${name}`);
    }
    if (new Set([o.controlPort, o.civPort, o.audioPort]).size !== 3) throw new Error('Icom LAN ports must be distinct');
    if ((o.codec !== undefined && o.codec !== P.CODEC) || (o.sampleRate !== undefined && o.sampleRate !== 48000)
      || (o.channels !== undefined && o.channels !== 1)) throw new Error('Icom LAN requires codec 4, 48000 Hz, mono PCM');
    for (const name of ['timeoutMs', 'renewMs', 'initialRenewMs', 'tokenGraceMs', 'tokenDeadMs', 'reconnectMs']) {
      if (!Number.isFinite(o[name]) || o[name] <= 0) throw new Error(`Invalid Icom LAN ${name}`);
    }
    this.capture = new LanCapture(this, { jitterMs: o.jitterMs });
    this.playback = new LanPlayback(this);
    this.connected = false;
    this.state = 'disconnected';
    this.generation = 0;
    this.attempts = 0;
    this.stopped = true;
  }

  status(state, message) {
    this.state = state;
    this.emit('status', { transport: 'lan', state, ...(message ? { message } : {}) });
  }

  open() {
    if (this.connected) return Promise.resolve();
    if (this.openPromise) return this.openPromise;
    this.stopped = false;
    this.openPromise = new Promise((resolve, reject) => { this.resolveOpen = resolve; this.rejectOpen = reject; });
    this.begin().catch((err) => this.fail(err));
    return this.openPromise;
  }

  async begin() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.tearingDown = false;
    this.status('connecting');
    this.innerSeq = this.serialSeq = this.audioSeq = 0;
    this.requestId = randomBytes(2).readUInt16LE() || 1;
    this.authId = this.radioId = null;
    this.authenticated = this.requested = this.granted = this.civSeen = false;
    this.pendingRenewals = new Map();
    this.startedAt = this.options.now();
    const make = (role, port) => {
      const stream = new IcomStream({ host: this.options.host, port, role, now: this.options.now,
        bindAddress: this.options.bindAddress, timeoutMs: this.options.timeoutMs,
        handshakeMs: this.options.handshakeMs, reorderMs: this.options.reorderMs });
      stream.on('failure', (err) => { if (generation === this.generation) this.fail(err); });
      return stream;
    };
    this.control = make('control', this.options.controlPort);
    this.serial = make('CI-V', this.options.civPort);
    this.audio = make('audio', this.options.audioPort);
    this.streams = [this.control, this.serial, this.audio];
    const current = (fn) => (...args) => { if (generation === this.generation && !this.tearingDown) fn(...args); };
    this.control.on('ready', current(() => {
      this.status('authenticating');
      this.control.tracked(P.login(this.control.localId, this.control.remoteId, this.nextInner(), this.requestId,
        this.options.username, this.options.password));
    }));
    this.control.on('payload', current((p) => this.controlPayload(p)));
    this.serial.on('ready', current(() => { this.openSerial(); this.mediaReady(); }));
    this.audio.on('ready', current(() => this.mediaReady()));
    this.serial.on('payload', current((p) => {
      const bytes = P.serialPayload(p);
      if (bytes) { this.civSeen = true; this.emit('civ', bytes); }
    }));
    this.audio.on('payload', current((p) => {
      const pcm = P.audioPayload(p);
      if (pcm) this.emit('rx-audio', pcm);
    }));
    try {
      // Bind before requesting streams: their actual local ports are part of
      // the authenticated stream request, and must remain fixed thereafter.
      for (const stream of this.streams) {
        await stream.bind();
        if (this.stopped || generation !== this.generation) { await stream.close(); return; }
      }
      this.control.start();
      this.timer = setInterval(() => this.tick(), 100);
    } catch {
      await this.fail(new Error('Could not bind/connect Icom LAN UDP sockets; check host and local interface'));
    }
  }

  nextInner() { const seq = this.innerSeq; this.innerSeq = (seq + 1) & 0xffff; return seq; }

  sendAuth(kind) {
    const seq = this.nextInner();
    this.control.tracked(P.auth(this.control.localId, this.control.remoteId, seq, this.authId, kind));
    return seq;
  }

  renew() {
    const seq = this.sendAuth(5);
    this.pendingRenewals.set(seq, this.options.now());
    while (this.pendingRenewals.size > 4) this.pendingRenewals.delete(this.pendingRenewals.keys().next().value);
    this.lastRenewSent = this.options.now();
  }

  controlPayload(p) {
    if (p.length === 96 && !this.authId) {
      if (p.readUInt16LE(26) !== this.requestId) return;
      if (p.readUInt32BE(48) !== 0) { this.fail(new Error('Radio rejected Icom LAN credentials'), false); return; }
      this.authId = Buffer.from(p.subarray(26, 32));
      this.sendAuth(2);
      this.renew();
    } else if (p.length === 64 && p[20] === 2 && p[21] === 5) {
      const seq = p.readUInt16BE(22);
      if (!this.pendingRenewals.has(seq)) return;
      const response = p.readUInt32LE(48);
      const initial = !this.authenticated && !this.granted;
      const same = p.subarray(26, 32).equals(this.authId);
      if (!same && !(initial && response === 0xffffffff)) return;
      if (response && !(initial && response === 0xffffffff)) { this.fail(new Error('Radio rejected Icom LAN token renewal')); return; }
      if (!same) this.authId = Buffer.from(p.subarray(26, 32));
      this.pendingRenewals.clear();
      this.authenticated = true;
      this.lastAuth = this.options.now();
      this.renewDue = this.lastAuth + (initial ? this.options.initialRenewMs : this.options.renewMs);
      this.requestStreams();
    } else if (p.length >= 168 && (p.length - 66) % 102 === 0 && !this.radioId) {
      // Direct-radio target: choose the first advertised radio. The nickname
      // is needed in the grant request, but is not trusted as model identity.
      this.radioId = Buffer.from(p.subarray(66, 82));
      this.radioName = p.subarray(82, 114).toString('ascii').split('\0')[0];
      this.advertisedAddress = p[148];
      this.requestStreams();
    } else if (p.length === 144) {
      // ConnInfo also carries other notifications. A grant must describe
      // the radio requested on this authenticated association. Tokens may
      // rotate here (as in the reference clients), so don't require equality.
      if (!this.granted && this.requested && this.authenticated && p[20] === 3 && p[21] === 0
        && this.radioId && p.subarray(32, 48).equals(this.radioId) && p[96] === 1) {
        this.granted = true;
        this.authId = Buffer.from(p.subarray(26, 32));
        this.status('opening-streams');
        this.serial.start();
        this.audio.start();
      } else if (this.connected && p[20] === 3 && p[21] === 0 && p.readUInt32LE(96) === 0
        && p[100] === 0 && p.readUInt32LE(132) === 0 && p.subarray(26, 32).equals(this.authId)
        && p.subarray(32, 48).equals(this.radioId)) this.fail(new Error('Radio released Icom LAN media streams'));
    } else if (p.length === 80) {
      if (p[48] === 0xff && p[49] === 0xff && p[50] === 0xff) {
        // MK2 can send late teardown status on the new association after
        // granting streams; wfview/AetherSDR ignore that post-grant shape.
        if (!this.granted) this.fail(new Error('Icom LAN authentication failed'), false);
      } else if (p.readUIntLE(48, 3) === 0 && p[64] === 1) this.fail(new Error('Radio ended Icom LAN session'));
    }
  }

  requestStreams() {
    if (this.requested || !this.authenticated || !this.radioId) return;
    this.requested = true;
    this.status('negotiating');
    this.control.tracked(P.streamRequest(this.control.localId, this.control.remoteId, this.nextInner(), {
      authId: this.authId, radioId: this.radioId, radioName: this.radioName, username: this.options.username,
      civPort: this.serial.localPort, audioPort: this.audio.localPort, txBufferMs: this.options.txBufferMs,
    }));
  }

  openSerial() {
    this.lastSerialOpen = this.options.now();
    this.serial.tracked(P.serialOpen(this.serial.localId, this.serial.remoteId, this.serialSeq++));
  }

  mediaReady() {
    if (this.connected || !this.serial.ready || !this.audio.ready) return;
    this.connected = true;
    if (!this.options.deferReady) this.confirmReady();
    else this.status('identifying');
    this.emit('connected');
    this.resolveOpen?.();
    this.resolveOpen = this.rejectOpen = null;
    this.openPromise = null;
  }

  confirmReady() {
    this.attempts = 0;
    this.status('connected');
  }

  tick() {
    const now = this.options.now();
    if (!this.connected && now - this.startedAt > this.options.timeoutMs) {
      this.fail(new Error(`Icom LAN ${this.state} timed out`));
      return;
    }
    if (this.authenticated && now - this.lastAuth >= this.options.tokenDeadMs) {
      this.fail(new Error('Icom LAN session token expired'));
      return;
    }
    if (this.authId && (this.pendingRenewals.size
      ? now - this.lastRenewSent >= this.options.tokenGraceMs
      : this.authenticated && now >= this.renewDue)) this.renew();
    if (this.serial?.ready && !this.civSeen && now - this.lastSerialOpen >= 500) this.openSerial();
  }

  sendCiv(bytes) {
    if (!this.connected) throw new Error('Icom LAN is disconnected');
    const cmd = bytes[4];
    let group, append = false;
    if (cmd === 0x1c && bytes[5] === 0 && bytes.length > 7) group = 'ptt';
    if (cmd === 0x17) {
      append = bytes[5] !== 0xff;
      group = append ? 'cw' : 'cw-stop';
      if (!append) this.serial.invalidate('cw');
      else this.serial.invalidate('cw-stop');
    }
    this.serial.tracked(P.serial(this.serial.localId, this.serial.remoteId, this.serialSeq++, bytes), { group, append });
  }

  sendAudio(pcm) {
    if (this.connected && this.playback.keyed) this.audio.tracked(P.audio(this.audio.localId, this.audio.remoteId, this.audioSeq++, pcm), { group: 'audio', append: true });
  }

  async dispose() {
    clearInterval(this.timer);
    const streams = this.streams || [];
    this.streams = [];
    if (this.control?.ready && this.authId) {
      try { this.sendAuth(1); } catch { /* association already closed */ }
    }
    await Promise.allSettled(streams.map((s) => s.close()));
  }

  async fail(err, retry = true) {
    // A deliberate graceful disconnect disables retries before its unkey/
    // restoration commands finish. A failure must still invalidate an open
    // association, so late ACKs cannot confirm a subsequent cleanup command.
    if (this.tearingDown || (this.stopped && !this.connected)) return;
    this.tearingDown = true;
    this.connected = false;
    ++this.generation;
    this.status('disconnected', err.message);
    this.emit('disconnected', err);
    await this.dispose();
    if (!this.stopped && retry && this.attempts < this.options.reconnectAttempts) {
      const delay = Math.min(10000, this.options.reconnectMs * 2 ** this.attempts++);
      this.status('reconnecting', err.message);
      this.retryTimer = setTimeout(() => this.begin().catch((e) => this.fail(e)), delay);
    } else {
      this.status('failed', err.message);
      this.rejectOpen?.(err);
      this.resolveOpen = this.rejectOpen = null;
      this.openPromise = null;
    }
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    ++this.generation;
    this.connected = false;
    this.playback.stop();
    this.capture.stop();
    this.rejectOpen?.(new Error('Icom LAN connection closed'));
    this.resolveOpen = this.rejectOpen = null;
    this.openPromise = null;
    await this.dispose();
    this.status('disconnected');
  }
}

class CivLanTransport extends EventEmitter {
  constructor(session) {
    super();
    this.session = session;
    this.isOpen = false;
    session.on('civ', (bytes) => { if (this.isOpen) this.emit('data', bytes); });
    session.on('connected', () => { this.isOpen = true; this.emit('open'); });
    session.on('disconnected', () => { this.isOpen = false; this.emit('close'); });
  }
  async open() { await this.session.open(); }
  write(bytes, callback) {
    try { this.session.sendCiv(bytes); callback?.(); }
    catch (err) { callback?.(err); }
  }
  resetSession(message) { this.session.fail(new Error(message)); }
  close(callback) { this.isOpen = false; this.session.close().then(() => callback?.(), (err) => callback?.(err)); }
}

module.exports = { IcomSession, CivLanTransport };
