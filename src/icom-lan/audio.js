'use strict';

const { EventEmitter } = require('node:events');

const RATE = 48000;
const FRAME_BYTES = 1920; // 20 ms mono S16LE; wire split is 1364 + 556.

// Buffers retain chunks, not one concatenated allocation per packet. A finite
// modem waveform is queued intact; voice queues have a much shorter latency
// cap. Both have explicit limits and are flushed when their TX session ends.
class PcmQueue {
  constructor() { this.clear(); }
  clear() { this.chunks = []; this.bytes = 0; this.offset = 0; }
  push(pcm) { if (pcm.length) { this.chunks.push(pcm); this.bytes += pcm.length; } }
  take(count, pad = false) {
    const size = pad ? count : Math.min(count, this.bytes);
    const out = Buffer.alloc(size);
    let at = 0;
    while (at < size && this.chunks.length) {
      const chunk = this.chunks[0];
      const n = Math.min(size - at, chunk.length - this.offset);
      chunk.copy(out, at, this.offset, this.offset + n);
      this.offset += n;
      this.bytes -= n;
      at += n;
      if (this.offset === chunk.length) { this.chunks.shift(); this.offset = 0; }
    }
    return out;
  }
}

class LanCapture extends EventEmitter {
  constructor(session, { jitterMs = 60, maxMs = 300, now = () => performance.now() } = {}) {
    super();
    this.session = session;
    this.jitterMs = jitterMs;
    this.maxBytes = maxMs * 96;
    this.now = now;
    this.queue = new PcmQueue();
    this.active = false;
    this.primed = false;
    this.stats = { droppedBytes: 0, silenceBytes: 0 };
    session.on('rx-audio', (pcm) => {
      if (!this.active) return;
      this.queue.push(pcm);
      if (this.queue.bytes > this.maxBytes) {
        const n = this.queue.bytes - this.maxBytes;
        this.queue.take(n);
        this.stats.droppedBytes += n;
      }
      if (this.queue.bytes >= this.jitterMs * 96) this.primed = true;
    });
    session.on('disconnected', () => this.flush());
  }
  flush() { this.queue.clear(); this.primed = false; this.nextFrameAt = undefined; }
  pump() {
    if (!this.active || !this.primed) return;
    const available = Math.min(FRAME_BYTES, this.queue.bytes);
    this.stats.silenceBytes += FRAME_BYTES - available;
    this.emit('data', this.queue.take(FRAME_BYTES, true));
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.timer = setInterval(() => this.pumpDue(), 5);
  }
  pumpDue() {
    if (!this.active || !this.primed) return;
    const now = this.now();
    if (this.nextFrameAt === undefined) this.nextFrameAt = now;
    const due = Math.floor((now - this.nextFrameAt) / 20) + 1;
    // Recover coalesced callbacks while the jitter buffer still holds the
    // samples. Bound work after a pause longer than the entire buffer.
    const frames = Math.min(due, Math.ceil(this.maxBytes / FRAME_BYTES));
    for (let n = 0; n < frames; n++) this.pump();
    this.nextFrameAt += frames * 20;
    if (due > frames) this.nextFrameAt = now + 20;
  }
  stop() { this.active = false; clearInterval(this.timer); this.flush(); }
}

class LanPlayback extends EventEmitter {
  constructor(session, { maxFiniteMs = 9 * 60 * 1000, maxVoiceMs = 500 } = {}) {
    super();
    this.session = session;
    this.maxFiniteBytes = maxFiniteMs * 96;
    this.maxVoiceBytes = maxVoiceMs * 96;
    this.queue = new PcmQueue();
    this.active = false;
    this.keyed = false;
    this.armed = false;
    this.finite = false;
    this.stats = { sentBytes: 0, droppedBytes: 0, paddedBytes: 0 };
    this.waiters = new Set();
    this.epoch = 0;
    session.on('disconnected', () => this.setKeyed(false));
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.nextFrameAt = undefined;
    this.timer = setInterval(() => {
      const now = performance.now();
      if (!this.keyed) { this.nextFrameAt = undefined; return; }
      if (this.nextFrameAt === undefined) {
        if (this.queue.bytes < FRAME_BYTES) return;
        this.nextFrameAt = now;
      }
      // Keep a sample clock rather than accumulating setInterval drift.
      // A stalled event loop may recover at most two frames per tick.
      for (let n = 0; n < 2 && now >= this.nextFrameAt; n++) {
        this.pump();
        this.nextFrameAt += 20;
      }
      if (now - this.nextFrameAt > 40) this.nextFrameAt = now + 20;
    }, 5);
  }
  setKeyed(on) {
    // Both edges start with an empty queue. Nothing from an earlier voice or
    // modem producer can escape when a later transmission starts.
    if (!on || !this.armed) this.flush();
    this.armed = false;
    this.keyed = on;
  }
  arm() { this.flush(); this.keyed = false; this.armed = true; }
  write(pcm) {
    if (!this.active || (!this.keyed && !this.armed) || !this.session.connected) return;
    if (!Buffer.isBuffer(pcm) || pcm.length % 2) throw new Error('LAN playback requires aligned mono S16LE PCM');
    if (pcm.length > this.maxVoiceBytes) this.finite = true;
    const cap = this.finite ? this.maxFiniteBytes : this.maxVoiceBytes;
    if (this.finite && this.queue.bytes + pcm.length > cap) throw new Error('LAN modem audio exceeds the nine-minute queue limit');
    this.queue.push(pcm);
    if (this.queue.bytes > cap) {
      const drop = this.queue.bytes - cap;
      this.queue.take(drop);
      this.stats.droppedBytes += drop;
    }
  }
  pump() {
    if (!this.active || !this.keyed || !this.session.connected || this.queue.bytes < FRAME_BYTES) return;
    // A native pipe/read or resampler chunk is not a complete modem frame.
    // Preserve partial samples until more arrive; only drain() ends a stream.
    const frame = this.queue.take(FRAME_BYTES);
    this.session.sendAudio(frame.subarray(0, 1364));
    this.session.sendAudio(frame.subarray(1364));
    this.stats.sentBytes += FRAME_BYTES;
    this.lastSentAt = performance.now();
    if (!this.queue.bytes) this.finite = false;
  }
  flush() {
    ++this.epoch;
    this.queue.clear();
    this.finite = false;
    this.session.audio?.invalidate('audio');
    this.nextFrameAt = undefined;
    this.lastSentAt = undefined;
    for (const wake of this.waiters) wake();
  }
  wait(ms) {
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, ms);
      this.waiters.add(wake);
    });
  }
  async drain() {
    const epoch = this.epoch;
    const tail = this.queue.bytes % FRAME_BYTES;
    if (tail) {
      const padding = FRAME_BYTES - tail;
      this.queue.push(Buffer.alloc(padding));
      this.stats.paddedBytes += padding;
    }
    // Drain the audio already queued, not future output. VARA's worker keeps
    // returning silence while receiving, so waiting for an empty queue can
    // keep PTT on indefinitely. Discarded latency-bound bytes also count as
    // consumed; a flush still cancels this drain through the epoch check.
    const consumed = () => this.stats.sentBytes + this.stats.droppedBytes;
    const target = consumed() + this.queue.bytes;
    while (epoch === this.epoch && this.keyed && this.session.connected && consumed() < target) {
      await this.wait(20);
    }
    if (epoch === this.epoch && this.keyed && this.session.connected && this.lastSentAt !== undefined) {
      const remaining = this.lastSentAt + 20 + (this.session.options?.txBufferMs ?? 300) - performance.now();
      if (remaining > 0) await this.wait(remaining);
    }
    return epoch === this.epoch && this.keyed && this.session.connected;
  }
  restart() { this.flush(); }
  stop() { clearInterval(this.timer); this.active = false; this.setKeyed(false); }
}

module.exports = { RATE, FRAME_BYTES, PcmQueue, LanCapture, LanPlayback };
