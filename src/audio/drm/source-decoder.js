'use strict';

/**
 * HamDRM receiver, source decoder: MSC data packets (CRC-16, first/last
 * flags, continuity) into DAB MOT data groups, MOT header (file name) and
 * body segments into files, with Reed-Solomon recovery of missing segments
 * for ".rs1" to ".rs4" files. Follows QSSTV's drmrx/sourcedecoder.cpp
 * (Johan Maes, ON4QZ) and crc16_bytewise.cpp / bits2bytes.cpp (M. Bos,
 * PA0MBO).
 *
 * Portions copyright (C) 2009 M. Bos (PA0MBO), 2000-2019 Johan Maes
 * (ON4QZ); GPL-2.0-or-later. See third_party/qsstv-drm/README.md.
 */

const rs = require('./rs');

const MAX_TRANSPORTS = 5;
const RS_THRESHOLD = 63; // percent of segments before an RS decode is tried (QSSTV)

/** CRC-16 (CCITT) as DRM sends it, the last two bytes being the inverted CRC: 0 when good. */
function crc16(bytes, n = bytes.length) {
  let b = 0xffff;
  for (let i = 0; i < n; i++) {
    const last = i >= n - 2;
    for (let j = 7; j >= 0; j--) {
      let y = ((b >> 15) + ((bytes[i] >> j) & 1)) & 1;
      if (last) y ^= 1;
      b = y ? ((b << 1) ^ 0x1021) & 0xffff : (b << 1) & 0xffff;
    }
  }
  return b;
}

function bitsToBytes(bits, nBytes) {
  const out = Buffer.alloc(nBytes);
  for (let m = 0; m < nBytes; m++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | (bits[8 * m + k] ? 1 : 0);
    out[m] = v;
  }
  return out;
}

class SourceDecoder {
  /**
   * @param {object} handlers
   * @param {(info:object) => void} [handlers.onHeader] a file's name and size are known
   * @param {(info:object) => void} [handlers.onSegment] a body segment arrived
   * @param {(file:object) => void} [handlers.onFile] a file is complete
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.transports = []; // most recent last
    this.init();
  }

  init() {
    this.holding = [];
    this.lastContinuity = -1;
    this.packetsGood = 0;
    this.packetsBad = 0;
  }

  /**
   * One frame of MSC bits from the channel decoder.
   * @param {Uint8Array} bits
   * @param {object} ctx {callsign, modeCode, snr}
   * @returns {boolean} the data packet's CRC was good
   */
  decode(bits, ctx = {}) {
    const n = Math.trunc(bits.length / 8);
    const buf = bitsToBytes(bits, n);
    if (crc16(buf, n) !== 0) {
      this.packetsBad++;
      return false;
    }
    this.packetsGood++;
    const header = buf[0];
    const first = (header & 0x80) !== 0;
    const last = (header & 0x40) !== 0;
    const ppi = (header & 0x08) !== 0;
    const ci = header & 0x07;
    const avail = ppi ? buf[1] : n - 3;
    const start = ppi ? 2 : 1;
    if (first) {
      this.holding = [];
      this.lastContinuity = ci;
    } else {
      if (this.lastContinuity < 0) return true;
      this.lastContinuity = (this.lastContinuity + 1) % 8;
      if (ci !== this.lastContinuity) {
        this.lastContinuity = -1;
        return true;
      }
    }
    this.holding.push(buf.subarray(start, start + avail));
    if (last) this._dataGroup(Buffer.concat(this.holding), ctx);
    return true;
  }

  _transport(tid, ctx) {
    let tb = this.transports.find((t) => t.id === tid);
    if (!tb) {
      if (this.transports.length >= MAX_TRANSPORTS) this.transports.shift();
      tb = { id: tid, fileName: '', header: false, bodySize: 0, total: 0, segSize: 0, lastSeen: false, segments: [], done: false, modeCode: ctx.modeCode, started: Date.now() };
      this.transports.push(tb);
    }
    return tb;
  }

  /** A MOT data group (setupDataPacket, addHeaderSegment, addDataSegment). */
  _dataGroup(ba, ctx) {
    if (ba.length < 2) return;
    const h = ba[0];
    const ext = (h & 0x80) !== 0;
    const crcFlag = (h & 0x40) !== 0;
    const session = (h & 0x20) !== 0;
    const user = (h & 0x10) !== 0;
    const type = h & 0x07;
    if (crcFlag) {
      if (crc16(ba) !== 0) return;
      ba = ba.subarray(0, ba.length - 2);
    }
    let p = 2;
    if (ext) p += 2;
    let segNo = 0;
    let lastSeg = false;
    if (session) {
      segNo = (ba[p] & 0x7f) * 256 + ba[p + 1];
      lastSeg = (ba[p] & 0x80) !== 0;
      p += 2;
    }
    let tid = 0xffff;
    if (user) {
      const uaf = ba[p];
      p++;
      const li = uaf & 0x0f;
      if (uaf & 0x10 && li >= 2) tid = ba[p] * 256 + ba[p + 1];
      p += li;
    }
    const segSize = (ba[p] & 0x1f) * 256 + ba[p + 1];
    p += 2;
    if (p > ba.length) return;
    const data = Buffer.from(ba.subarray(p));
    if (type === 3) this._header(tid, data, ctx);
    else if (type === 4) this._segment(tid, segNo, lastSeg, segSize, data, ctx);
  }

  _header(tid, d, ctx) {
    const tb = this._transport(tid, ctx);
    if (tb.done || d.length < 7) return;
    tb.header = true;
    tb.bodySize = (d[0] << 20) + (d[1] << 12) + (d[2] << 4) + ((d[3] & 0xf0) >> 4);
    tb.contentType = (d[5] & 0x7e) >> 1;
    let q = 7;
    while (q < d.length) {
      const pli = d[q] >> 6;
      const pid = d[q] & 0x3f;
      if (pli === 0) q += 1;
      else if (pli === 1) q += 2;
      else if (pli === 2) q += 5;
      else {
        let len;
        if (d[q + 1] & 0x80) {
          len = (d[q + 1] & 0x7f) * 256 + d[q + 2];
          q += 3;
        } else {
          len = d[q + 1] & 0x7f;
          q += 2;
        }
        // ContentName: a character set byte, then the name
        if (pid === 12 && len > 1) tb.fileName = d.subarray(q + 1, q + len).toString('latin1').replace(/\0.*$/, '');
        q += len;
      }
    }
    if (this.h.onHeader) this.h.onHeader({ transportId: tid, fileName: tb.fileName, bodySize: tb.bodySize });
    this._tryComplete(tb, ctx);
  }

  _segment(tid, segNo, lastSeg, segSize, data, ctx) {
    const tb = this._transport(tid, ctx);
    if (lastSeg) {
      tb.total = segNo + 1;
      tb.lastSeen = true;
    } else tb.segSize = segSize;
    if (tb.total < segNo + 1) tb.total = segNo + 1;
    const fresh = !tb.segments[segNo];
    tb.segments[segNo] = data;
    if (ctx.callsign) tb.callsign = ctx.callsign;
    if (this.h.onSegment) this.h.onSegment(this.progress(tb));
    if (fresh) this._tryComplete(tb, ctx);
  }

  /** Progress of a transport: segments received of the total known so far. */
  progress(tb) {
    let have = 0;
    for (let i = 0; i < tb.segments.length; i++) if (tb.segments[i]) have++;
    return { transportId: tb.id, fileName: tb.fileName, received: have, total: tb.total, lastSeen: tb.lastSeen, done: tb.done, callsign: tb.callsign || '' };
  }

  /** The newest transport, for status. */
  get current() {
    return this.transports.length ? this.transports[this.transports.length - 1] : null;
  }

  _tryComplete(tb, ctx) {
    if (tb.done || !tb.header || !tb.lastSeen || !tb.total) return;
    const { received, total } = this.progress(tb);
    const extension = (tb.fileName.match(/\.([^.]+)$/) || [])[1];
    const type = extension && extension.toLowerCase();
    const segLen = tb.segSize || (tb.segments.find(Boolean) || []).length || 0;
    if (type && rs.DSIZE[type]) {
      if ((received * 100) / total < RS_THRESHOLD) return;
      const parts = [];
      const missing = [];
      for (let i = 0; i < total; i++) {
        if (tb.segments[i]) parts.push(tb.segments[i]);
        else {
          missing.push(i);
          parts.push(Buffer.alloc(segLen));
        }
      }
      const r = rs.decodeFile(Buffer.concat(parts), type, { totalSegments: total, segmentLength: segLen, missing });
      if (!r) return;
      const base = tb.fileName.replace(/\.[^.]+$/, '');
      this._done(tb, `${base}.${r.ext}`, r.data, ctx, { recovered: missing.length });
      return;
    }
    if (received < total) return;
    this._done(tb, tb.fileName, Buffer.concat(tb.segments.slice(0, total)), ctx, { recovered: 0 });
  }

  _done(tb, fileName, data, ctx, extra) {
    tb.done = true;
    tb.segments = []; // free the memory; the file is passed on
    if (tb.fileName === 'bsr.bin') return; // a bad segment report for someone else's transmission
    if (this.h.onFile) {
      this.h.onFile({
        transportId: tb.id,
        fileName,
        data,
        callsign: tb.callsign || ctx.callsign || '',
        modeCode: tb.modeCode,
        segments: tb.total,
        seconds: (Date.now() - tb.started) / 1000,
        ...extra,
      });
    }
  }
}

module.exports = { SourceDecoder, crc16, bitsToBytes };
