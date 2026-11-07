'use strict';

const dgram = require('node:dgram');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const P = require('./protocol');

// One RS-BA1 UDP association. Each control/serial/audio stream has its own
// socket, random ID, sequence space, replay history and bounded reorder queue.
class IcomStream extends EventEmitter {
  constructor({ host, port, role, localPort = 0, bindAddress = '0.0.0.0', now = () => performance.now(),
    handshakeMs = 500, timeoutMs = 15000, reorderMs = 80, maxPackets = 256 } = {}) {
    super();
    Object.assign(this, { host, port, role, localPort, bindAddress, now, handshakeMs, timeoutMs, reorderMs, maxPackets });
    this.localId = randomBytes(4).readUInt32BE();
    this.remoteId = 0;
    this.socket = null;
    this.ready = false;
    this.txSeq = 1; // zero at startup makes a radio infer a preceding wrap.
    this.pingSeq = 0;
    this.lastDelivered = null;
    this.replay = new Map();
    this.reorder = new Map();
    this.counters = { malformed: 0, stale: 0, duplicates: 0, lost: 0, replayed: 0 };
  }

  async bind() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (p) => this.receive(p));
    await new Promise((resolve, reject) => {
      const fail = (err) => reject(err);
      this.socket.once('error', fail);
      this.socket.bind(this.localPort, this.bindAddress, () => {
        this.socket.connect(this.port, this.host, () => {
          this.socket.off('error', fail);
          this.socket.on('error', () => this.fail(`${this.role} UDP socket error`));
          this.localPort = this.socket.address().port;
          resolve();
        });
      });
    });
  }

  start() {
    const t = this.now();
    this.startedAt = this.lastRx = this.lastHandshake = t;
    this.lastIdle = this.lastPing = t;
    this.handshake();
    this.timer = setInterval(() => this.tick(), 20);
  }

  handshake() {
    const p = P.packet(16, this.remoteId ? P.TYPE.READY : P.TYPE.THERE, this.localId, this.remoteId, this.remoteId ? 1 : 0);
    this.raw(p);
    this.raw(p);
  }

  raw(p) {
    if (!this.socket) return;
    this.socket.send(p, (err) => { if (err && this.socket) this.fail(`${this.role} UDP send failed`); });
  }

  tracked(p, { group, append = false } = {}) {
    if (!this.ready) throw new Error(`${this.role} stream is disconnected`);
    if (group && !append) this.invalidate(group);
    const seq = this.txSeq;
    this.txSeq = (seq + 1) & 0xffff;
    p.writeUInt16LE(seq, 6);
    this.replay.delete(seq);
    this.replay.set(seq, { packet: p, group });
    while (this.replay.size > this.maxPackets) this.replay.delete(this.replay.keys().next().value);
    this.raw(p);
    return seq;
  }

  invalidate(group) {
    for (const retained of this.replay.values()) if (retained.group === group) retained.packet = null;
  }

  receive(p) {
    const h = P.header(p);
    if (!h) { this.counters.malformed++; return; }
    if (h.receiver !== this.localId || (this.remoteId && h.sender !== this.remoteId)) {
      this.counters.stale++;
      return;
    }
    if (!this.remoteId) {
      if (h.type !== P.TYPE.HERE || p.length !== 16 || !h.sender) return;
      this.remoteId = h.sender;
      this.lastRx = this.now();
      this.handshake();
      return;
    }
    this.lastRx = this.now();
    if (!this.ready) {
      if (h.type === P.TYPE.READY && p.length === 16) {
        this.ready = true;
        this.emit('ready');
      }
      return;
    }
    if (h.type === P.TYPE.PING && p.length === 21) {
      if (p[16] === 0) {
        const reply = P.packet(21, P.TYPE.PING, this.localId, this.remoteId, h.seq);
        reply[16] = 1;
        p.copy(reply, 17, 17, 21);
        this.raw(reply);
      }
      return;
    }
    if (h.type === P.TYPE.DISCONNECT) { this.fail(`${this.role} stream closed by radio`); return; }
    if (h.type === P.TYPE.RETRANSMIT) {
      const ranges = p.length === 16 ? [[h.seq, h.seq]] : [];
      for (let at = 16; at + 4 <= p.length; at += 4) {
        const a = p.readUInt16LE(at), b = p.readUInt16LE(at + 2);
        if (a || b) ranges.push([a, b]);
      }
      let budget = 10;
      for (const [a, b] of ranges) {
        for (let n = 0; n <= P.distance(b, a) && budget-- > 0; n++) {
          const seq = (a + n) & 0xffff;
          this.raw(this.replay.get(seq)?.packet || P.packet(16, 0, this.localId, this.remoteId, seq));
          this.counters.replayed++;
        }
        if (budget <= 0) break;
      }
      return;
    }
    if (h.type !== P.TYPE.IDLE) return;
    // The reference clients dispatch control replies directly. Their inner
    // request/token correlation is authoritative; control notifications do
    // not share the media streams' ordered delivery contract (some peers
    // reuse outer sequence zero). Session handlers deduplicate by meaning.
    if (this.role === 'control') { this.deliver(p); return; }
    if (this.lastDelivered === null) {
      this.lastDelivered = h.seq;
      this.deliver(p);
    } else if (P.after(h.seq, this.lastDelivered)) {
      if (!this.reorder.has(h.seq)) this.reorder.set(h.seq, p);
      this.drain();
      if (this.reorder.size && this.gapSince === undefined) this.gapSince = this.now();
      if (this.reorder.size > this.maxPackets) this.skipGap();
    } else this.counters.duplicates++;
  }

  deliver(p) { if (p.length > 16) this.emit('payload', p); }

  drain() {
    let next = (this.lastDelivered + 1) & 0xffff;
    while (this.reorder.has(next)) {
      const p = this.reorder.get(next);
      this.reorder.delete(next);
      this.lastDelivered = next;
      this.deliver(p);
      next = (next + 1) & 0xffff;
    }
    if (!this.reorder.size) this.gapSince = undefined;
  }

  nearest() {
    let best, distance = 0x10000;
    for (const seq of this.reorder.keys()) {
      const d = P.distance(seq, this.lastDelivered);
      if (d < distance) { distance = d; best = seq; }
    }
    return best;
  }

  skipGap() {
    const seq = this.nearest();
    if (seq === undefined) return;
    const lost = P.distance(seq, this.lastDelivered) - 1;
    this.counters.lost += lost;
    this.emit('lost', lost);
    this.lastDelivered = (seq - 1) & 0xffff;
    this.gapSince = undefined;
    this.drain();
    if (this.reorder.size) this.gapSince = this.now();
  }

  tick() {
    const now = this.now();
    if (now - this.lastRx >= this.timeoutMs) { this.fail(`${this.role} stream timed out; check radio address, ports and Network Control`); return; }
    if (!this.ready) {
      if (now - this.lastHandshake >= this.handshakeMs) { this.lastHandshake = now; this.handshake(); }
      return;
    }
    if (now - this.lastPing >= 500) {
      this.lastPing = now;
      const p = P.packet(21, P.TYPE.PING, this.localId, this.remoteId, this.pingSeq++ & 0xffff);
      p.writeUInt32LE(Math.floor(now) >>> 0, 17);
      this.raw(p);
    }
    if (this.role !== 'audio' && now - this.lastIdle >= 100) {
      this.lastIdle = now;
      this.tracked(P.packet(16, 0, this.localId, this.remoteId));
    }
    if (this.gapSince !== undefined && now - this.gapSince >= this.reorderMs) {
      if (now - this.gapSince >= this.reorderMs * 2) this.skipGap();
      else {
        const count = Math.min(10, P.distance(this.nearest(), this.lastDelivered) - 1);
        for (let n = 1; n <= count; n++) this.raw(P.packet(16, P.TYPE.RETRANSMIT, this.localId, this.remoteId, (this.lastDelivered + n) & 0xffff));
      }
    }
  }

  fail(message) {
    if (this.failed) return;
    this.failed = true;
    this.emit('failure', new Error(message));
  }

  async close() {
    clearInterval(this.timer);
    const socket = this.socket;
    if (!socket) return;
    if (this.remoteId) {
      const bye = P.packet(16, P.TYPE.DISCONNECT, this.localId, this.remoteId);
      await new Promise((resolve) => socket.send(bye, () => resolve()));
    }
    this.socket = null;
    this.ready = false;
    this.replay.clear();
    this.reorder.clear();
    await new Promise((resolve) => socket.close(resolve));
  }
}

module.exports = { IcomStream };
