'use strict';

// SPDX-License-Identifier: GPL-3.0-only
// The packet layouts and the order of a session follow wfview's network
// server (src/radio/icomserver.cpp and include/packettypes.h, GPL-3.0,
// revision 098568546731aff25c7e9ea93c0f009eeee19137); see
// docs/icom-lan-sources.md and third_party/icom-lan. The code is written
// for PiRO; credential encoding reuses src/icom-lan/protocol.js.

/**
 * An Icom LAN server: PiRO answers the network protocol of Icom's
 * networked radios (as the IC-7300MK2, IC-705, IC-9700 and others do, and
 * as RS-BA1 and wfview's servers do), so programs written for that
 * protocol can use the radio PiRO has, connected by USB or LAN.
 *
 * Three UDP ports: control (login, tokens, the radio's details), CI-V and
 * audio. One client at a time has the radio, and while it does PiRO is
 * paused (ControlServer#pause): PiRO's own features stop and every browser
 * request is refused. The client's CI-V goes straight to the radio and the
 * radio's CI-V (including scope data) straight back (CivDriver
 * pass-through). Received audio goes to the client in the codec and rate
 * it asks for; its transmit audio goes to the radio.
 *
 * PiRO keeps two safety rules over the client:
 * - Australian class licence: a remotely controlled transmission stops
 *   after `txLimitMs` (10 minutes). PTT from the client (1C 00 01), CW
 *   text (17) and the radio reporting it is transmitting all count; at the
 *   limit PiRO sends PTT off and CW stop.
 * - When the client leaves (says goodbye, stops answering for `timeoutMs`,
 *   or PiRO stops), PiRO sends PTT off and CW stop, then takes the radio
 *   back with a confirmed release.
 */

const dgram = require('node:dgram');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { passcode } = require('../icom-lan/protocol');
const { FrameParser, encodeFrame } = require('../civ/frame');
const { EVENT } = require('./protocol');
const { RxConverter, TxConverter, isSupported, CODECS } = require('./icom-lan-audio');

// Packet types (bytes 4-5) and sizes, as in wfview's packettypes.h.
const TYPE = { DATA: 0x00, RETRANSMIT: 0x01, THERE: 0x03, HERE: 0x04, DISCONNECT: 0x05, READY: 0x06, PING: 0x07 };
const SIZE = { CONTROL: 0x10, PING: 0x15, OPENCLOSE: 0x16, TOKEN: 0x40, STATUS: 0x50, LOGIN_RESPONSE: 0x60, LOGIN: 0x80, CONNINFO: 0x90, CAPABILITIES: 0x42, RADIO_CAP: 0x66, CIV: 0x15, AUDIO: 0x18 };

const DEFAULT_PORT = 50001;
const TX_LIMIT_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;
const MAX_ASSOCIATIONS = 12;
const HISTORY = 500; // sent packets kept for retransmit requests
const AUDIO_CHUNK = 1364; // bytes of audio per packet, as wfview sends
const LOGIN_FAILURES = 5; // then that address is ignored for LOCKOUT_MS
const LOCKOUT_MS = 60000;
const CIV_QUEUE = 64; // frames held while PiRO is pausing
const CW_ACTIVE_MS = 90000; // CW text (17) counts as transmitting this long after the last

const REJECTED = Buffer.from([0xff, 0xff, 0xff, 0xfe]); // error field: refused

/** A NUL-terminated string field. */
function cstring(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end);
}

/** Printable ASCII only, at most 16 characters: a client's name is shown to the browsers. */
function cleanName(buf) {
  return cstring(buf).toString('latin1').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 16);
}

class IcomLanServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../civ/driver').CivDriver} opts.civ
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {object} [opts.audioBridge] - capture 'data' (S16LE) and playback.write(); none: no audio
   * @param {number} [opts.port=50001] - control port; CI-V and audio use the next two (0: any free ports, tests)
   * @param {string} [opts.host='0.0.0.0']
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {string} [opts.radioName='IC-7300'] - the name clients show
   * @param {number} [opts.radioAddr] - the CI-V address clients are told (default: the radio's)
   * @param {number} [opts.txLimitMs=600000]
   * @param {number} [opts.timeoutMs=15000]
   */
  constructor({ civ, controlServer, audioBridge = null, port = DEFAULT_PORT, host = '0.0.0.0', username, password, radioName = 'IC-7300', radioAddr, txLimitMs = TX_LIMIT_MS, timeoutMs = TIMEOUT_MS }) {
    super();
    if (!civ || !controlServer) throw new Error('IcomLanServer requires opts.civ and opts.controlServer');
    passcode(username); // 1-16 printable ASCII characters, or throws
    passcode(password);
    Object.assign(this, { civ, controlServer, audioBridge, port, host, radioName, txLimitMs, timeoutMs });
    this._radioAddr = radioAddr;
    this._user = cstring(passcode(username));
    this._pass = cstring(passcode(password));
    this._passPlain = Buffer.from(password, 'latin1');
    this.sockets = {};
    this.ports = {};
    this.assocs = new Map(); // `${role} ${address}:${port}` -> association
    this.failures = new Map(); // address -> {count, until}
    this.holder = null; // the control association that has the radio
    // A fixed identity for the radio, as wfview's server uses: zero GUID,
    // common capability 0x8010 and a locally administered MAC address.
    this.guid = Buffer.alloc(16);
    this.guid.writeUInt16LE(0x8010, 7);
    Buffer.from([0x02, 0x50, 0x69, 0x52, 0x4f, 0x01]).copy(this.guid, 10);
    this._onFrame = (frame) => this._toClient(frame.raw);
    this._onCapture = (chunk) => this._rxAudio(chunk);
  }

  get radioAddr() {
    return this._radioAddr ?? this.civ.radioAddr ?? 0x94;
  }

  /** Binds the three ports. Resolves with {control, civ, audio}. */
  async start() {
    const roles = ['control', 'civ', 'audio'];
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      const socket = dgram.createSocket('udp4');
      socket.on('message', (msg, rinfo) => {
        try {
          this._receive(role, msg, rinfo);
        } catch (err) {
          console.error(`[icom-lan-server] ${role}: ${err.message}`);
        }
      });
      socket.on('error', (err) => console.error(`[icom-lan-server] ${role} socket: ${err.message}`));
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(this.port ? this.port + i : 0, this.host, () => {
          socket.off('error', reject);
          resolve();
        });
      });
      this.sockets[role] = socket;
      this.ports[role] = socket.address().port;
    }
    this.startedAt = Date.now();
    this.timer = setInterval(() => this._tick(), 100);
    return { ...this.ports };
  }

  /** Gives the radio back (if a client has it) and closes the ports. */
  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const a of [...this.assocs.values()]) if (a.role === 'control') await this._endSession(a, 'PiRO stopped');
    for (const a of [...this.assocs.values()]) this._send(a, this._control(a, TYPE.DISCONNECT, 0));
    this.assocs.clear();
    for (const socket of Object.values(this.sockets)) await new Promise((r) => socket.close(r));
    this.sockets = {};
  }

  // ------------------------------------------------------------ packets out

  _header(a, length, type = TYPE.DATA, seq = 0) {
    const p = Buffer.alloc(length);
    p.writeUInt32LE(length, 0);
    p.writeUInt16LE(type, 4);
    p.writeUInt16LE(seq & 0xffff, 6);
    a.myId.copy(p, 8);
    a.remoteId.copy(p, 12);
    return p;
  }

  _control(a, type, seq) {
    return this._header(a, SIZE.CONTROL, type, seq);
  }

  _send(a, p) {
    this.sockets[a.role]?.send(p, a.port, a.address);
  }

  /** Sends a packet with the next sequence number, kept for retransmit requests. */
  _tracked(a, p) {
    const seq = a.txSeq;
    a.txSeq = (a.txSeq + 1) & 0xffff;
    p.writeUInt16LE(seq, 6);
    a.history.set(seq, p);
    if (a.history.size > HISTORY) a.history.delete(a.history.keys().next().value);
    this._send(a, p);
  }

  /** The common header of the login-level packets (0x10-0x1f). */
  _inner(a, length, { reply, type, innerSeq = a.innerSeq }) {
    const p = this._header(a, length);
    p.writeUInt32BE(length - 0x10, 0x10);
    p[0x14] = reply;
    p[0x15] = type;
    innerSeq.copy(p, 0x16);
    a.tokRequest.copy(p, 0x1a);
    a.token.copy(p, 0x1c);
    return p;
  }

  _loginResponse(a, ok) {
    const p = this._inner(a, SIZE.LOGIN_RESPONSE, { reply: 0x01, type: 0x00 });
    if (!ok) REJECTED.copy(p, 0x30);
    p.write('PiRO', 0x40, 'latin1');
    this._tracked(a, p);
  }

  _tokenResponse(a, type) {
    const p = this._inner(a, SIZE.TOKEN, { reply: 0x02, type });
    a.guid.copy(p, 0x20);
    this._tracked(a, p);
  }

  _capabilities(a) {
    const head = this._inner(a, SIZE.CAPABILITIES, { reply: 0x02, type: 0x02 });
    head.writeUInt16BE(1, 0x40); // one radio
    const r = Buffer.alloc(SIZE.RADIO_CAP);
    this.guid.copy(r, 0x00);
    r.write(this.radioName.slice(0, 31), 0x10, 'latin1');
    r.write('ICOM_VAUDIO', 0x30, 'latin1');
    r.writeUInt16LE(0x073f, 0x50); // wired network
    r[0x52] = this.radioAddr;
    r.writeUInt16LE(0x8b01, 0x53); // every receive rate
    r.writeUInt16LE(this.audioBridge ? 0x8b01 : 0, 0x55); // every transmit rate, if there is audio
    r[0x57] = 0x01;
    r[0x58] = 0x01;
    r[0x59] = 0x01;
    r.writeUInt32BE(115200, 0x5a);
    r.writeUInt16LE(0x5001, 0x5e);
    r.writeUInt16LE(0x0190, 0x61);
    const p = Buffer.concat([head, r]);
    p.writeUInt32LE(p.length, 0);
    p.writeUInt32BE(p.length - 0x10, 0x10);
    this._tracked(a, p);
  }

  /** The radio's connection state: busy 0 free, 1 in use (by `holder`). */
  _connInfo(a) {
    const p = this._inner(a, SIZE.CONNINFO, { reply: 0x03, type: 0x00, innerSeq: Buffer.alloc(2) });
    this.guid.copy(p, 0x20);
    p.write(this.radioName.slice(0, 31), 0x40, 'latin1');
    const h = this.holder;
    if (h) {
      p.writeUInt32LE(1, 0x60);
      p.write(h.clientName.slice(0, 16), 0x64, 'latin1');
      const ip = h.address.split('.').map(Number);
      if (ip.length === 4 && ip.every((n) => n >= 0 && n <= 255)) Buffer.from(ip).copy(p, 0x84);
    }
    this._tracked(a, p);
  }

  /** The answer to a stream request: the CI-V and audio ports, or refused. */
  _status(a, ok) {
    const p = this._inner(a, SIZE.STATUS, { reply: 0x02, type: 0x03 });
    a.guid.copy(p, 0x20);
    if (!ok) REJECTED.copy(p, 0x30);
    p.writeUInt16BE(this.ports.civ, 0x42);
    p.writeUInt16BE(this.ports.audio, 0x46);
    this._tracked(a, p);
  }

  // ------------------------------------------------------------ packets in

  _receive(role, p, rinfo) {
    if (p.length < SIZE.CONTROL || p.length > 4096) return;
    const key = `${role} ${rinfo.address}:${rinfo.port}`;
    const type = p.readUInt16LE(4);
    const seq = p.readUInt16LE(6);
    let a = this.assocs.get(key);
    if (!a) {
      if (type !== TYPE.THERE || p.length !== SIZE.CONTROL) return;
      // CI-V and audio streams only for an address that has logged in.
      if (role !== 'control' && !this._sessionFor(rinfo.address)) return;
      if (this.assocs.size >= MAX_ASSOCIATIONS) return;
      a = {
        role,
        key,
        address: rinfo.address,
        port: rinfo.port,
        myId: randomBytes(4),
        remoteId: Buffer.from(p.subarray(8, 12)),
        txSeq: 1,
        history: new Map(),
        seen: new Set(),
        lastHeard: Date.now(),
        lastPing: 0,
        pingSeq: 0,
        ready: false,
        // control: the session
        authenticated: false,
        innerSeq: Buffer.alloc(2),
        tokRequest: Buffer.alloc(2),
        token: Buffer.alloc(4),
        guid: Buffer.alloc(16),
        clientName: '',
        streaming: false,
      };
      this.assocs.set(key, a);
    }
    a.lastHeard = Date.now();
    if (type === TYPE.THERE && p.length === SIZE.CONTROL) {
      a.remoteId = Buffer.from(p.subarray(8, 12));
      this._send(a, this._control(a, TYPE.HERE, seq));
      return;
    }
    if (type === TYPE.READY && p.length === SIZE.CONTROL) {
      a.remoteId = Buffer.from(p.subarray(8, 12));
      a.ready = true;
      this._send(a, this._control(a, TYPE.READY, seq));
      // The session's CI-V and audio streams: linked as soon as they are up.
      if (a.role !== 'control') {
        const control = this._sessionFor(a.address);
        if (control) control[a.role] = a;
      }
      return;
    }
    if (type === TYPE.PING && p.length === SIZE.PING) {
      if (p[0x10] === 0) {
        const r = this._header(a, SIZE.PING, TYPE.PING, seq);
        r[0x10] = 1;
        p.copy(r, 0x11, 0x11, 0x15);
        this._send(a, r);
      }
      return;
    }
    if (type === TYPE.DISCONNECT) {
      this._drop(a, 'the client disconnected');
      return;
    }
    if (type === TYPE.RETRANSMIT) {
      const seqs = p.length === SIZE.CONTROL ? [seq] : [];
      for (let o = 0x10; o + 2 <= p.length; o += 2) seqs.push(p.readUInt16LE(o));
      for (const s of new Set(seqs).values()) {
        const old = a.history.get(s);
        this._send(a, old || this._control(a, TYPE.DATA, s)); // not kept: an idle packet in its place
      }
      return;
    }
    if (type !== TYPE.DATA) return;
    if (seq !== 0) {
      if (a.seen.has(seq)) return; // a duplicate (a retransmit we already have)
      a.seen.add(seq);
      if (a.seen.size > 1024) a.seen.delete(a.seen.values().next().value);
    }
    if (p.length === SIZE.CONTROL) return; // idle
    if (role === 'control') this._controlPacket(a, p);
    else if (role === 'civ') this._civPacket(a, p);
    else this._audioPacket(a, p);
  }

  _sessionFor(address) {
    for (const a of this.assocs.values()) if (a.role === 'control' && a.address === address && a.authenticated) return a;
    return null;
  }

  _controlPacket(a, p) {
    if (p.length === SIZE.LOGIN) this._login(a, p);
    else if (p.length === SIZE.TOKEN && a.authenticated) this._token(a, p);
    else if (p.length === SIZE.CONNINFO && a.authenticated) this._streamRequest(a, p);
  }

  _login(a, p) {
    a.innerSeq = Buffer.from(p.subarray(0x16, 0x18));
    a.tokRequest = Buffer.from(p.subarray(0x1a, 0x1c));
    const f = this.failures.get(a.address);
    if (f && f.until > Date.now()) return; // too many wrong passwords: ignored for a while
    const user = cstring(p.subarray(0x40, 0x50));
    const pass = cstring(p.subarray(0x50, 0x60));
    const ok = user.equals(this._user) && (pass.equals(this._pass) || pass.equals(this._passPlain));
    a.clientName = cleanName(p.subarray(0x60, 0x70)) || a.address;
    if (ok) {
      this.failures.delete(a.address);
      a.authenticated = true;
      a.token = randomBytes(4);
      console.log(`[icom-lan-server] ${a.clientName} (${a.address}) logged in`);
    } else {
      const count = (f?.count || 0) + 1;
      this.failures.set(a.address, { count, until: count >= LOGIN_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
      console.warn(`[icom-lan-server] ${a.address}: wrong username or password`);
    }
    this._loginResponse(a, ok);
  }

  _token(a, p) {
    a.innerSeq = Buffer.from(p.subarray(0x16, 0x18));
    const type = p[0x15];
    if (p[0x14] !== 0x01) return;
    if (!a.guid.some((b) => b)) p.copy(a.guid, 0, 0x20, 0x30);
    if (type === 0x02) {
      // The radio's details, and whether it is in use.
      this._capabilities(a);
      this._connInfo(a);
    } else if (type === 0x01) {
      this._tokenResponse(a, type);
      this._endSession(a, 'the client logged out');
    } else if (type === 0x04) {
      // Stop the streams but stay logged in.
      this._tokenResponse(a, type);
      this._endSession(a, 'the client closed its streams').then(() => this._connInfo(a));
    } else this._tokenResponse(a, type); // renewal and the rest
  }

  /** The client asks for the radio: CI-V, and audio in its codecs and rates. */
  _streamRequest(a, p) {
    a.innerSeq = Buffer.from(p.subarray(0x16, 0x18));
    p.copy(a.guid, 0, 0x20, 0x30);
    if (this.holder === a) {
      this._status(a, true);
      this._connInfo(a);
      return;
    }
    const req = {
      rxEnable: p[0x70] !== 0,
      txEnable: p[0x71] !== 0,
      rxCodec: p[0x72],
      txCodec: p[0x73],
      rxRate: p.readUInt32BE(0x74),
      txRate: p.readUInt32BE(0x78),
    };
    const audio = !!this.audioBridge;
    const refuse = (why) => {
      console.warn(`[icom-lan-server] ${a.clientName} (${a.address}) refused: ${why}`);
      this._status(a, false);
      this._connInfo(a);
    };
    if (this.holder) return refuse(`${this.holder.clientName} has the radio`);
    if (audio && req.rxEnable && !isSupported(req.rxCodec, req.rxRate)) return refuse(`receive audio codec 0x${req.rxCodec.toString(16)} at ${req.rxRate} Hz is not offered`);
    if (audio && req.txEnable && !isSupported(req.txCodec, req.txRate)) return refuse(`transmit audio codec 0x${req.txCodec.toString(16)} at ${req.txRate} Hz is not offered`);
    this.holder = a;
    a.streaming = true;
    a.request = req;
    a.queue = [];
    a.taking = this._takeRadio(a).catch((err) => {
      if (this.holder === a) this.holder = null;
      a.streaming = false;
      refuse(err.message);
    });
  }

  async _takeRadio(a) {
    const name = `${a.clientName} (${a.address})`;
    await this.controlServer.pause(name);
    try {
      await this.civ.beginPassthrough();
    } catch (err) {
      await this.controlServer.resume();
      throw err;
    }
    if (this.holder !== a) {
      // The client left while PiRO was pausing.
      this.civ.endPassthrough();
      await this.controlServer.resume();
      return;
    }
    a.active = true;
    a.tx = { keyed: false, since: 0, cwUntil: 0 };
    this.civ.on('passthrough-frame', this._onFrame);
    const ab = this.audioBridge;
    if (ab) {
      const rate = ab.sampleRate ?? 48000;
      const channels = ab.channels ?? 1;
      if (a.request.rxEnable) {
        a.rx = new RxConverter({ fromRate: rate, channels, toRate: a.request.rxRate, codec: a.request.rxCodec });
        ab.capture?.on('data', this._onCapture);
      }
      if (a.request.txEnable) a.txc = new TxConverter({ codec: a.request.txCodec, fromRate: a.request.txRate, toRate: rate, channels });
    }
    console.log(`[icom-lan-server] ${name} has the radio`);
    this._status(a, true);
    this._connInfo(a);
    for (const bytes of a.queue.splice(0)) this._fromClient(a, bytes);
    this.emit('session', { active: true, client: name });
  }

  _civPacket(a, p) {
    if (p.length <= SIZE.CIV || p[0x10] !== 0xc1) return; // open/close and others
    const len = p.readUInt16LE(0x11);
    if (len !== p.length - SIZE.CIV) return;
    const control = this._sessionFor(a.address);
    if (!control || control !== this.holder) return; // only the client that has the radio
    a.session = control;
    control.civ = a;
    const bytes = Buffer.from(p.subarray(SIZE.CIV));
    if (!control.active) {
      if (control.queue.length < CIV_QUEUE) control.queue.push(bytes);
      return;
    }
    this._fromClient(control, bytes);
  }

  _audioPacket(a, p) {
    if (p.length <= SIZE.AUDIO) return;
    const len = p.readUInt16BE(0x16);
    if (len !== p.length - SIZE.AUDIO) return;
    const control = this._sessionFor(a.address);
    if (!control || control !== this.holder) return;
    control.audio = a;
    if (!control.active || !control.txc) return;
    try {
      const pcm = control.txc.process(p.subarray(SIZE.AUDIO));
      if (pcm.length) this.audioBridge.playback.write(pcm);
    } catch (err) {
      console.error(`[icom-lan-server] transmit audio: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ CI-V and audio

  /** CI-V from the client: watched for transmitting, then to the radio. */
  _fromClient(control, bytes) {
    for (const f of new FrameParser().push(bytes)) {
      if (f.cmd === 0x1c && f.subCmd === 0x00 && f.data.length >= 1) this._keyed(control, f.data[0] === 1);
      else if (f.cmd === 0x17) {
        if (f.payload[0] === 0xff) control.tx.cwUntil = 0;
        else control.tx.cwUntil = Date.now() + CW_ACTIVE_MS;
        this._updateTx(control);
      }
    }
    try {
      this.civ.writePassthrough(bytes);
    } catch (err) {
      console.error(`[icom-lan-server] to the radio: ${err.message}`);
    }
  }

  /** CI-V from the radio: to the client that has it. */
  _toClient(raw) {
    const control = this.holder;
    if (!control || !control.active) return;
    // The radio saying whether it is transmitting (an answer to 1C 00).
    if (raw.length === 8 && raw[4] === 0x1c && raw[5] === 0x00 && (raw[6] === 0 || raw[6] === 1)) this._keyed(control, raw[6] === 1, true);
    const c = control.civ;
    if (!c) return;
    const p = this._header(c, SIZE.CIV + raw.length);
    p[0x10] = 0xc1;
    p.writeUInt16LE(raw.length, 0x11);
    c.civSeq = ((c.civSeq || 0) + 1) & 0xffff;
    p.writeUInt16BE(c.civSeq, 0x13);
    raw.copy(p, SIZE.CIV);
    this._tracked(c, p);
  }

  _keyed(control, on, fromRadio = false) {
    const tx = control.tx;
    if (!tx) return;
    tx.keyed = on;
    // The radio saying it isn't transmitting ends CW too.
    if (fromRadio && !on) tx.cwUntil = 0;
    this._updateTx(control);
    const pb = this.audioBridge?.playback;
    if (!fromRadio && pb && typeof pb.setKeyed === 'function') {
      // LAN audio to a MK2 is only sent while keyed (src/icom-lan/audio.js).
      if (on) {
        pb.arm?.();
        pb.setKeyed(true);
      } else pb.setKeyed(false);
    }
  }

  /** Whether the client is (or may be) transmitting, and since when (continuously). */
  _updateTx(control) {
    const tx = control.tx;
    const active = tx.keyed || tx.cwUntil > Date.now();
    if (active && !tx.active) tx.since = Date.now();
    if (!active) tx.since = 0;
    tx.active = active;
  }

  _rxAudio(chunk) {
    const control = this.holder;
    const a = control?.audio;
    if (!control?.active || !control.rx || !a) return;
    let bytes;
    try {
      bytes = control.rx.process(chunk);
    } catch (err) {
      console.error(`[icom-lan-server] receive audio: ${err.message}`);
      return;
    }
    for (let o = 0; o < bytes.length; o += AUDIO_CHUNK) {
      const part = bytes.subarray(o, o + AUDIO_CHUNK);
      const p = this._header(a, SIZE.AUDIO + part.length);
      p[0x10] = 0x80; // as every Icom audio packet
      p[0x11] = 0x00;
      a.audioSeq = ((a.audioSeq || 0) + 1) & 0xffff;
      p.writeUInt16BE(a.audioSeq, 0x12);
      p.writeUInt16BE(part.length, 0x16);
      part.copy(p, SIZE.AUDIO);
      this._tracked(a, p);
    }
  }

  /** PTT off and CW stop, straight to the radio (pass-through is still on). */
  _unkeyRadio() {
    const to = this.radioAddr;
    try {
      this.civ.writePassthrough(Buffer.concat([
        encodeFrame({ to, from: 0xe0, cmd: 0x1c, subCmd: 0x00, data: Buffer.from([0x00]) }),
        encodeFrame({ to, from: 0xe0, cmd: 0x17, data: Buffer.from([0xff]) }),
      ]));
    } catch (err) {
      console.error(`[icom-lan-server] unkeying: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ the session

  _drop(a, why) {
    if (!this.assocs.has(a.key)) return;
    this.assocs.delete(a.key);
    if (a.role === 'control') this._endSession(a, why);
    else {
      const control = this._sessionFor(a.address);
      if (control && control.civ === a) control.civ = null;
      if (control && control.audio === a) control.audio = null;
    }
  }

  /** The client stops having the radio: unkey, then PiRO takes it back. */
  async _endSession(a, why) {
    if (a.taking) await a.taking;
    if (this.holder !== a) return;
    this.holder = null;
    a.streaming = false;
    const name = `${a.clientName} (${a.address})`;
    if (!a.active) return;
    a.active = false;
    this.civ.off('passthrough-frame', this._onFrame);
    this.audioBridge?.capture?.off('data', this._onCapture);
    const pb = this.audioBridge?.playback;
    if (pb && typeof pb.setKeyed === 'function') pb.setKeyed(false);
    this._unkeyRadio();
    // Let the radio take the unkey before PiRO talks to it again.
    await new Promise((r) => setTimeout(r, 100));
    this.civ.endPassthrough();
    console.log(`[icom-lan-server] ${name} gave back the radio (${why})`);
    // Confirmed: release through PiRO's own PTT path, then resume.
    await this.controlServer.releasePtt().catch(() => {});
    await this.controlServer.resume();
    this.emit('session', { active: false, client: name, why });
  }

  _tick() {
    const now = Date.now();
    for (const a of [...this.assocs.values()]) {
      if (now - a.lastHeard > this.timeoutMs) {
        console.warn(`[icom-lan-server] ${a.role} ${a.address}: no answer for ${this.timeoutMs / 1000} s`);
        this._drop(a, 'it stopped answering');
        continue;
      }
      if (!a.ready) continue;
      if (now - a.lastPing >= 500) {
        a.lastPing = now;
        const p = this._header(a, SIZE.PING, TYPE.PING, a.pingSeq);
        a.pingSeq = (a.pingSeq + 1) & 0xffff;
        p.writeUInt32LE((now - this.startedAt) >>> 0, 0x11);
        this._send(a, p);
      }
      // Idle packets keep the control and CI-V streams' sequence going.
      if (a.role !== 'audio') this._tracked(a, this._control(a, TYPE.DATA, 0));
    }
    // The 10-minute limit on the client's transmissions.
    const h = this.holder;
    if (h?.active && h.tx) {
      this._updateTx(h);
      if (h.tx.active && now - h.tx.since >= this.txLimitMs) {
        const message = `The LAN client ${h.clientName} transmitted for ${Math.round(this.txLimitMs / 60000)} minutes: PiRO unkeyed the radio.`;
        console.warn(`[icom-lan-server] ${message}`);
        this._unkeyRadio();
        h.tx.keyed = false;
        h.tx.cwUntil = 0;
        h.tx.active = false;
        h.tx.since = 0;
        const pb = this.audioBridge?.playback;
        if (pb && typeof pb.setKeyed === 'function') pb.setKeyed(false);
        this.controlServer.broadcastJsonEvent(EVENT.PTT_TIMEOUT, { pttWatchdogMs: this.txLimitMs, lan: true });
        this.emit('tx-limit', { client: h.clientName });
      }
    }
  }
}

module.exports = { IcomLanServer, DEFAULT_PORT, TX_LIMIT_MS, CODECS };
