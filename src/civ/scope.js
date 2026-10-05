'use strict';

const { EventEmitter } = require('events');
const { bcdToFreq } = require('./frame');
const { SCOPE_MODE } = require('./commands');

/**
 * Decodes/reassembles Icom's chunked spectrum scope waveform data (CI-V
 * command 0x27, sub-command 0x00). Once enabled (see
 * CivDriver#enableScopeOutput), the radio pushes a "line" of waveform
 * data split across multiple chunks (up to 11 over a USB connection);
 * this class buffers chunks by sequence number and emits a complete,
 * reassembled line once every chunk in the sequence has arrived.
 *
 * Payload layout (the bytes after the 0x00 sub-command byte), per Icom's
 * CI-V reference documentation (IC-7300/IC-705) and cross-checked against
 * the wfview project's public protocol notes:
 *
 *   byte[0]            Main/Sub scope select (0x00=main, 0x01=sub)
 *   byte[1]            Sequence number, 1-based, single-byte BCD (e.g. 0x11 = 11)
 *   byte[2]            Total chunk count for this line, single-byte BCD
 *
 *   Sequence 1 (header chunk) continues:
 *   byte[3]            Scope mode: 0x00=Center, 0x01=Fixed, 0x02=Scroll-C, 0x03=Scroll-F
 *   Center/Scroll-C:   byte[4:9]=center frequency (5-byte BCD), byte[9:14]=span (5-byte BCD)
 *   Fixed/Scroll-F:    byte[4:9]=start frequency, byte[9:14]=end frequency (5-byte BCD each),
 *                      optionally byte[14]=in-range flag (0x00=in range, 0x01=out of range)
 *   No waveform sample bytes are included in the header chunk.
 *
 *   Sequence 2+ (data chunks): byte[3:] = raw waveform sample bytes
 *   (one byte per pixel/point) — no header fields repeated.
 *
 * Events:
 *   'line', ({ mainSub, mode, centerFreq?, span?, startFreq?, endFreq?,
 *              inRange?, points: Buffer })  — a fully reassembled line
 *   'error', (Error)  — a malformed chunk was dropped
 *
 * Note: real-world reliability of this feature over a plain CI-V-over-USB
 * connection varies by radio/firmware — see docs/civ-notes.md.
 */
class ScopeLineAssembler extends EventEmitter {
  constructor() {
    super();
    this._active = null;
  }

  /** @param {Buffer} data - the payload after the 0x00 sub-command byte */
  push(data) {
    let chunk;
    try {
      chunk = decodeScopeChunk(data);
    } catch (err) {
      this.emit('error', err);
      return;
    }

    if (chunk.seq === 1) {
      // A new line is starting; any previously in-progress (incomplete)
      // line is discarded — there's no way to usefully complete it once
      // its header chunk has been superseded.
      this._active = {
        mainSub: chunk.mainSub,
        total: chunk.total,
        mode: chunk.mode,
        freqInfo: chunk.freqInfo,
        chunks: new Map([[1, chunk.samples]]),
      };
    } else if (this._active && chunk.mainSub === this._active.mainSub) {
      this._active.chunks.set(chunk.seq, chunk.samples);
    } else {
      // A continuation chunk arrived with no matching in-progress header
      // (e.g. we started listening mid-sequence) — nothing useful to do
      // with it.
      return;
    }

    this._tryEmit();
  }

  _tryEmit() {
    const active = this._active;
    if (!active || active.chunks.size < active.total) return;

    const parts = [];
    for (let i = 1; i <= active.total; i++) {
      const part = active.chunks.get(i);
      if (!part) {
        // A chunk is missing despite having "enough" chunks by count
        // (shouldn't normally happen on a reliable serial link, but be
        // defensive) — give up on this line rather than emit corrupt data.
        this._active = null;
        return;
      }
      parts.push(part);
    }

    this.emit('line', {
      mainSub: active.mainSub,
      mode: active.mode,
      ...active.freqInfo,
      points: Buffer.concat(parts),
    });
    this._active = null;
  }

  reset() {
    this._active = null;
  }
}

function bcdByteToInt(byte) {
  return ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f);
}

function decodeScopeChunk(data) {
  if (data.length < 3) {
    throw new Error(`Scope chunk too short (${data.length} bytes)`);
  }
  const mainSub = data[0];
  const seq = bcdByteToInt(data[1]);
  const total = bcdByteToInt(data[2]);

  if (seq === 1) {
    if (data.length < 4) {
      throw new Error('Scope header chunk missing mode byte');
    }
    const mode = data[3];
    let offset = 4;
    let freqInfo;

    if (mode === SCOPE_MODE.CENTER || mode === SCOPE_MODE.SCROLL_C) {
      if (data.length < offset + 10) throw new Error('Scope header chunk too short for center/span');
      const centerFreq = bcdToFreq(data.subarray(offset, offset + 5));
      offset += 5;
      const span = bcdToFreq(data.subarray(offset, offset + 5));
      offset += 5;
      freqInfo = { centerFreq, span };
    } else {
      if (data.length < offset + 10) throw new Error('Scope header chunk too short for start/end freq');
      const startFreq = bcdToFreq(data.subarray(offset, offset + 5));
      offset += 5;
      const endFreq = bcdToFreq(data.subarray(offset, offset + 5));
      offset += 5;
      freqInfo = { startFreq, endFreq };
      if (offset < data.length) {
        freqInfo.inRange = data[offset] === 0x00;
        offset += 1;
      }
    }

    return { mainSub, seq, total, mode, freqInfo, samples: data.subarray(offset) };
  }

  return { mainSub, seq, total, samples: data.subarray(3) };
}

module.exports = { ScopeLineAssembler, decodeScopeChunk, bcdByteToInt };
