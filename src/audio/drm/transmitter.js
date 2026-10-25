'use strict';

/**
 * HamDRM (EasyPal / QSSTV "DRM") transmitter: a file in, 48 kHz audio out.
 * Ported from QSSTV's drmtx, which M. (Ties) Bos (PA0MBO) adapted for
 * ham SSTV from Dream, the DRM software of Volker Fischer at Technische
 * Universitaet Darmstadt, and Johan Maes (ON4QZ) built into QSSTV: the MOT
 * encoder and segment schedule (DABMOT.cpp, MOTSlideShow.cpp), packets
 * (DataDecoder.cpp), the FAC (FAC.cpp), multilevel coding (MLC.cpp,
 * ConvEncoder.cpp, ChannelCode.cpp, EnergyDispersal.cpp, BitInterleaver.cpp,
 * QAMMapping.cpp), the symbol interleaver, the cell map with its pilots
 * (CellMappingTable.cpp, OFDMCellMapping.cpp) and the OFDM modulator
 * (OFDM.cpp, DRMSignalIO.cpp).
 *
 * Portions copyright (C) 2001-2007 Technische Universitaet Darmstadt,
 * Institut fuer Nachrichtentechnik (Volker Fischer, Andrew Murphy; Dream);
 * (C) 2009-2012 M. Bos (PA0MBO); (C) 2000-2019 Johan Maes (ON4QZ);
 * GPL-2.0-or-later. See third_party/qsstv-drm/README.md.
 */

const RATE = 48000;
const FRAME_SEC = 0.4; // every robustness mode used here: 15 x 26.67 ms (A, B) or 20 x 20 ms (E)
const RUNINLEN = 24; // segments sent before the file proper (DABMOT.cpp)
const RUNOUTLEN = 10; // and after it
const EXTRA_GROUPS = 5; // data groups sent after the schedule ends (MOTSlideShow.cpp extraBlocks)
const HEADER_PARTITION = 98; // bytes per MOT header segment
const DC_HZ = 350; // where QSSTV puts the OFDM block's centre (SetCarOffset(350))
const VIRTUAL_IF = 6000; // Dream's own centre, at which the IFFT bins are placed

// --- tables (Dream's TableCarrier.h, TableCarMap.h, TableMLC.h, TableQAMMapping.h) ---

const MODES = {
  // robustness mode: FFT size at 48 kHz, guard Tg/Tu, symbols per frame, FAC cells, time pilots, frequency pilots, scattered pilot layout
  A: {
    fft: 1152,
    tgtu: [1, 9],
    spf: 15,
    kmin: [2, 2],
    kmax: [54, 58],
    fac: [[1, 10], [1, 22], [1, 30], [1, 50], [2, 14], [2, 26], [2, 34], [3, 18], [3, 30], [3, 38], [4, 22], [4, 34], [4, 42], [5, 18], [5, 26], [5, 38], [5, 46], [6, 22], [6, 30], [6, 42], [6, 50], [7, 26], [7, 34], [7, 46], [8, 10], [8, 30], [8, 38], [8, 50], [9, 14], [9, 34], [9, 42], [10, 18], [10, 38], [10, 46], [11, 10], [11, 22], [11, 42], [11, 50], [12, 14], [12, 26], [12, 46], [13, 18], [13, 30], [14, 22], [14, 34]],
    timePil: [[6, 973], [7, 205], [11, 717], [12, 264], [15, 357], [16, 357], [23, 952], [29, 440], [30, 856], [33, 88], [34, 88], [38, 68], [39, 836], [41, 836], [45, 836], [46, 1008]],
    freqPil: [[9, 205], [27, 836], [36, 215]],
    freqInt: 4,
    timeInt: 5,
    xyk0: [4, 5, 2],
    W: [[228, 341, 455], [455, 569, 683], [683, 796, 910], [910, 0, 114], [114, 228, 341]],
    Z: [[0, 81, 248], [18, 106, 106], [122, 116, 31], [129, 129, 39], [33, 32, 111]],
    Q: 36,
    boost: [[2, 4, 50, 54], [2, 6, 54, 58]],
  },
  B: {
    fft: 1024,
    tgtu: [1, 4],
    spf: 15,
    kmin: [1, 1],
    kmax: [45, 51],
    fac: [[0, 21], [1, 11], [1, 23], [1, 35], [2, 13], [2, 25], [2, 37], [3, 15], [3, 27], [3, 39], [4, 5], [4, 17], [4, 29], [4, 41], [5, 7], [5, 19], [5, 31], [6, 9], [6, 21], [6, 33], [7, 11], [7, 23], [7, 35], [8, 13], [8, 25], [8, 37], [9, 15], [9, 27], [9, 39], [10, 5], [10, 17], [10, 29], [10, 41], [11, 7], [11, 19], [11, 31], [12, 9], [12, 21], [12, 33], [13, 11], [13, 23], [13, 35], [14, 13], [14, 25], [14, 37]],
    timePil: [[6, 304], [10, 331], [11, 108], [14, 620], [17, 192], [18, 704], [27, 44], [28, 432], [30, 588], [33, 844], [34, 651], [38, 651], [40, 651], [41, 460], [44, 944]],
    freqPil: [[8, 331], [24, 651], [32, 555]],
    freqInt: 2,
    timeInt: 3,
    xyk0: [2, 3, 1],
    W: [[512, 0, 512, 0, 512], [0, 512, 0, 512, 0], [512, 0, 512, 0, 512]],
    Z: [[0, 57, 164, 64, 12], [168, 255, 161, 106, 118], [25, 232, 132, 233, 38]],
    Q: 12,
    boost: [[1, 3, 43, 45], [1, 3, 49, 51]],
  },
  E: {
    fft: 640,
    tgtu: [1, 2],
    spf: 20,
    kmin: [1, 1],
    kmax: [29, 31],
    fac: [[1, 7], [1, 23], [2, 8], [2, 16], [2, 24], [3, 9], [3, 17], [4, 10], [4, 18], [5, 11], [5, 19], [6, 4], [6, 12], [7, 13], [7, 21], [8, 6], [8, 14], [8, 22], [9, 7], [9, 23], [10, 8], [10, 16], [10, 24], [11, 9], [11, 13], [11, 17], [12, 10], [12, 18], [13, 11], [13, 19], [14, 4], [14, 12], [14, 16], [15, 13], [15, 21], [16, 6], [16, 14], [16, 22], [17, 7], [17, 23], [18, 8], [18, 16], [18, 24], [19, 9], [19, 17]],
    timePil: [[7, 432], [8, 331], [13, 108], [14, 620], [21, 192], [22, 704], [26, 44], [27, 304]],
    freqPil: [[5, 788], [15, 1014], [20, 332]],
    freqInt: 1,
    timeInt: 4,
    xyk0: [1, 4, 1],
    W: [[512, 0, 512, 0, 512], [0, 512, 0, 512, 0], [512, 0, 512, 0, 512], [0, 512, 0, 512, 0]],
    Z: [[0, 57, 164, 64, 12], [168, 255, 161, 106, 118], [25, 232, 132, 233, 38], [168, 255, 161, 106, 118]],
    Q: 10,
    boost: [[1, 29, 0, 0], [1, 31, 0, 0]],
  },
};

// puncturing patterns: [info bits per period, code bits per period, then a type per info bit]
const P0000 = 0;
const P1111 = 1;
const P0111 = 2;
const P0011 = 3;
const P0001 = 4;
const P0101 = 5;
const PUNCTURING = [
  [1, 4, P1111],
  [3, 10, P1111, P0111, P0111],
  [1, 3, P0111],
  [4, 11, P0111, P0111, P0111, P0011],
  [1, 2, P0011],
  [4, 7, P0011, P0101, P0011, P0001],
  [3, 5, P0011, P0001, P0011],
  [2, 3, P0011, P0001],
  [8, 11, P0011, P0001, P0001, P0011, P0001, P0001, P0011, P0001],
  [3, 4, P0011, P0001, P0001],
  [4, 5, P0011, P0001, P0001, P0001],
  [7, 8, P0011, P0001, P0001, P0001, P0001, P0001, P0001],
  [8, 9, P0011, P0001, P0001, P0001, P0001, P0001, P0001, P0001],
];
const TAIL_PUNCTURING = [
  [P0011, P0011, P0011, P0011, P0011, P0011],
  [P0111, P0011, P0011, P0011, P0011, P0011],
  [P0111, P0011, P0011, P0111, P0011, P0011],
  [P0111, P0111, P0011, P0111, P0011, P0011],
  [P0111, P0111, P0011, P0111, P0111, P0011],
  [P0111, P0111, P0111, P0111, P0111, P0011],
  [P0111, P0111, P0111, P0111, P0111, P0111],
  [P1111, P0111, P0111, P0111, P0111, P0111],
  [P1111, P0111, P0111, P1111, P0111, P0111],
  [P1111, P1111, P0111, P1111, P0111, P0111],
  [P1111, P1111, P0111, P1111, P0111, P1111],
  [P1111, P1111, P1111, P1111, P0111, P1111],
];
const GENERATORS = [0o155, 0o117, 0o123, 0o155];
const PARITY = new Uint8Array(256);
for (let j = 0; j < 256; j++) {
  let p = 0;
  for (let i = 0; i < 7; i++) p ^= (j >> i) & 1;
  PARITY[j] = p;
}
const CODE_RATE_MSC4 = 6;
const CODE_RATES_MSC16 = [
  [2, 7],
  [4, 9],
];
const CODE_RATES_MSC64 = [
  [0, 4, 9],
  [2, 7, 10],
];
const CODE_RATE_FAC = 6;
const INTERLEAVERS = { 4: [1], 16: [0, 1], 64: [-1, 0, 1] }; // per level: -1 none, 0 t0 = 13, 1 t0 = 21
const QAM4 = [0.7071067811, -0.7071067811];
const QAM16 = [0.948683298, -0.316227766, 0.316227766, -0.948683298];
const QAM64 = [1.0801234497, -0.1543033499, 0.4629100498, -0.7715167498, 0.7715167498, -0.4629100498, 0.1543033499, -1.0801234497];

// --- bits ---

class Bits {
  constructor(n) {
    this.a = new Uint8Array(n);
    this.pos = 0;
  }
  put(value, n) {
    for (let i = 0; i < n; i++) this.a[this.pos + n - 1 - i] = (value >>> i) & 1;
    this.pos += n;
  }
  putBytes(buf) {
    for (const b of buf) this.put(b, 8);
  }
}

const bytesOf = (bits, nBytes) => {
  const out = Buffer.alloc(nBytes);
  for (let i = 0; i < nBytes; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[8 * i + k];
    out[i] = v;
  }
  return out;
};

/** Dream's CRC (CCRC): all ones at the start, complemented at the end. */
function crc(bytes, degree) {
  const masks = { 8: (1 << 2) | (1 << 3) | (1 << 4), 16: (1 << 5) | (1 << 12) };
  const poly = masks[degree];
  const out = 1 << degree;
  let reg = 0xffffffff;
  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      reg = (reg << 1) >>> 0;
      if (reg & out) reg |= 1;
      if (byte & (1 << (7 - i))) reg ^= 1;
      if (reg & 1) reg ^= poly;
    }
  }
  return ~reg & (out - 1);
}

/** Dream's block interleaver table (BlockInterleaver.cpp). */
function interleaverTable(size, t0) {
  let high = size;
  let s = 1 << 17;
  while (!(high & (1 << 16))) {
    high <<= 1;
    s >>= 1;
  }
  const q = s / 4 - 1;
  const t = new Int32Array(size);
  for (let i = 1; i < size; i++) {
    let v = (t0 * t[i - 1] + q) % s;
    while (v >= size) v = (t0 * v + q) % s;
    t[i] = v;
  }
  return t;
}

/** Energy dispersal (PRBS 1 + x^5 + x^9), in place. */
function disperse(bits) {
  let reg = 0x1ff;
  for (let i = 0; i < bits.length; i++) {
    const b = ((reg >> 4) & 1) ^ ((reg >> 8) & 1);
    reg = ((reg << 1) | b) & 0x1ff;
    bits[i] ^= b;
  }
}

/** Per-bit puncturing types for one level (ChannelCode.cpp GenPuncPatTable, part A empty). */
function puncturingTable(nBits, pattern, n2, fac) {
  const p = PUNCTURING[pattern];
  const tailIndex = 2 * n2 - 12 - p[1] * Math.trunc((2 * n2 - 12) / p[1]);
  const tail = TAIL_PUNCTURING[tailIndex];
  const out = new Uint8Array(nBits + 6);
  let c = 0;
  for (let i = 0; i < nBits + 6; i++) {
    if (i < nBits || fac) {
      out[i] = p[2 + c];
      c = (c + 1) % p[0];
    } else {
      if (i === nBits) c = 0;
      out[i] = tail[c++];
    }
  }
  return out;
}

/** Convolutional encoder with puncturing (ConvEncoder.cpp). */
function convEncode(bits, punct, outLen) {
  const out = new Uint8Array(outLen);
  let n = 0;
  let reg = 0;
  const conv = (g) => PARITY[reg & GENERATORS[g]];
  for (let i = 0; i < punct.length; i++) {
    reg = ((reg << 1) | (i < bits.length ? bits[i] : 0)) & 0xff;
    switch (punct[i]) {
      case P0001:
        out[n++] = conv(0);
        break;
      case P0101:
        out[n++] = conv(0);
        out[n++] = conv(2);
        break;
      case P0011:
        out[n++] = conv(0);
        out[n++] = conv(1);
        break;
      case P0111:
        out[n++] = conv(0);
        out[n++] = conv(1);
        out[n++] = conv(2);
        break;
      case P1111:
        out[n++] = conv(0);
        out[n++] = conv(1);
        out[n++] = conv(2);
        out[n++] = conv(3);
        break;
      default:
        break;
    }
  }
  if (n !== outLen) throw new Error(`HamDRM encoder: ${n} code bits where ${outLen} were expected`);
  return out;
}

// --- the cell map (CellMappingTable.cpp) ---

const CM_MSC = 1;
const CM_FAC = 2;
const CM_PILOT = 4;
const CM_DC = 8;

function cellMap(modeName, so) {
  const m = MODES[modeName];
  const kmin = m.kmin[so];
  const kmax = m.kmax[so];
  const nCar = kmax - kmin + 1;
  const nSym = m.spf * 3;
  const type = Array.from({ length: nSym }, () => new Uint8Array(nCar));
  const pilot = Array.from({ length: nSym }, () => new Float64Array(2 * nCar));
  const mod = (a, b) => (a < 0 ? (a % b) + b : a % b);
  const polar = (amp, ph) => [amp * Math.cos((2 * Math.PI * ph) / 1024), amp * Math.sin((2 * Math.PI * ph) / 1024)];
  const [x, y, k0] = m.xyk0;
  const half = Math.trunc(m.freqInt / 2 + 0.5);
  let freqC = 0;
  let timeC = 0;
  let facC = 0;
  for (let s = 0; s < nSym; s++) {
    const fs = s % m.spf;
    if (fs === 0) facC = 0;
    let scatC = Math.trunc((kmin - half - m.freqInt * mod(fs, m.timeInt)) / (m.freqInt * m.timeInt));
    for (let k = kmin; k <= kmax; k++) {
      const c = k - kmin;
      let t = CM_MSC;
      let val = null;
      if (facC < m.fac.length && m.fac[facC][0] * nCar + m.fac[facC][1] === fs * nCar + k) {
        facC++;
        t = CM_FAC;
      }
      if (k === half + m.freqInt * mod(fs, m.timeInt) + m.freqInt * m.timeInt * scatC) {
        scatC++;
        t = CM_PILOT;
        const n = mod(fs, y);
        const mm = Math.trunc(fs / y);
        const p = Math.trunc((k - k0 - n * x) / (x * y));
        const ph = mod(4 * m.Z[n][mm] + p * m.W[n][mm] + p * p * (1 + fs) * m.Q, 1024);
        val = polar(m.boost[so].includes(k) ? 2 : Math.SQRT2, ph);
      }
      if (fs === 0 && m.timePil[timeC][0] === k) {
        t = CM_PILOT;
        val = polar(Math.SQRT2, m.timePil[timeC][1]);
        timeC = (timeC + 1) % m.timePil.length;
      }
      if (m.freqPil[freqC][0] === k) {
        t = CM_PILOT;
        let ph = m.freqPil[freqC][1];
        if (modeName === 'E' && freqC !== m.freqPil.length - 1 && fs % 2 === 1) ph = mod(ph + 512, 1024);
        val = polar(Math.SQRT2, ph);
        freqC = (freqC + 1) % m.freqPil.length;
      }
      if (k === 0) t = CM_DC;
      type[s][c] = t;
      if (val) {
        pilot[s][2 * c] = val[0];
        pilot[s][2 * c + 1] = val[1];
      }
    }
  }
  let msc = 0;
  for (const row of type) for (const t of row) if (t === CM_MSC) msc++;
  return { kmin, kmax, nCar, nSym, type, pilot, nMux: Math.floor(msc / 3) };
}

// --- MOT (DABMOT.cpp, MOTSlideShow.cpp, DataDecoder.cpp) ---

/** QSSTV's transport ID: a hash of the file name. */
function transportId(fileName) {
  const name = Buffer.from(fileName, 'latin1').subarray(0, 80);
  let x = 0;
  let a = 0;
  for (let k = 0; k < name.length; k++) {
    x ^= name[k];
    a = ((a + name[k]) & 0xff) ^ (k & 0xff);
  }
  let tid = 256 * a + x;
  if (tid <= 2) tid += name.length;
  return tid;
}

function contentSubtype(ext) {
  const e = ext.toLowerCase();
  if (e === 'gif') return 0;
  if (e === 'bmp') return 2;
  if (e === 'png') return 3;
  return 1; // jpg, jpeg, jfif, jp2, rs1-rs4 (and anything else)
}

/** The MOT header and body as segments, each with its 2-byte segment header. */
function motSegments(file, fileName, ext, bodySegBytes) {
  const name = Buffer.from(fileName, 'latin1').subarray(0, 80);
  const hsize = 7 + 5 + 3 + name.length + 2;
  const h = new Bits(hsize * 8);
  h.put(file.length, 28);
  h.put(hsize, 13);
  h.put(2, 6); // image
  h.put(contentSubtype(ext), 9);
  h.put(2, 2); // TriggerTime: now
  h.put(5, 6);
  h.put(0, 32);
  h.put(1, 2); // VersionNumber 0
  h.put(6, 6);
  h.put(0, 8);
  h.put(3, 2); // ContentName
  h.put(12, 6);
  h.put(0, 1);
  h.put(1 + name.length, 7);
  h.put(0, 8); // character set
  h.putBytes(name);
  const partition = (data, size) => {
    const n = Math.ceil(data.length / size);
    const out = [];
    for (let i = 0; i < n; i++) {
      const part = data.subarray(i * size, Math.min(data.length, (i + 1) * size));
      const seg = Buffer.alloc(part.length + 2);
      seg.writeUInt16BE(part.length & 0x1fff, 0); // repetition count 0, segment size
      part.copy(seg, 2);
      out.push(seg);
    }
    return out;
  };
  return { header: partition(bytesOf(h.a, hsize), HEADER_PARTITION), body: partition(file, bodySegBytes) };
}

/** QSSTV's order of segments: a run-in, the file (headers every 50), a run-out. Header segments are -1, -2, ... */
function segmentSchedule(nHeader, nBody) {
  const list = [];
  const run = (len) => {
    for (let counter = 0; counter < len; ) {
      for (let k = 0; k < nHeader; k++) list.push(-1 - k);
      list.push(nBody - 1);
      counter++;
      for (let i = 0; i < nBody && counter < len; i++) {
        list.push(i);
        counter++;
      }
    }
  };
  run(RUNINLEN);
  for (let i = 0; i < nBody; i++) {
    if (i % 50 === 0) {
      for (let k = 0; k < nHeader; k++) list.push(-1 - k);
      list.push(nBody - 1);
    }
    list.push(i);
  }
  run(RUNOUTLEN);
  return list;
}

/** An MSC data group (GenMOTObj). */
function dataGroup(seg, isHeader, segNum, last, tid, cont) {
  const g = new Bits((16 + 16 + 8 + 16 + 8 * seg.length + 16));
  g.put(0, 1); // extension
  g.put(1, 1); // CRC
  g.put(1, 1); // segment field
  g.put(1, 1); // user access field
  g.put(isHeader ? 3 : 4, 4);
  g.put(cont, 4);
  g.put(0, 4); // repetition index
  g.put(last ? 1 : 0, 1);
  g.put(segNum, 15);
  g.put(0, 3);
  g.put(1, 1); // transport ID present
  g.put(2, 4);
  g.put(tid, 16);
  g.putBytes(seg);
  const bytes = bytesOf(g.a, g.a.length / 8);
  bytes.writeUInt16BE(crc(bytes.subarray(0, bytes.length - 2), 16), bytes.length - 2);
  return bytes;
}

// --- the transmitter ---

const MODE_NAMES = ['A', 'B', 'E'];

/** Settings: {mode: 'A'|'B'|'E', bandwidth: 2.3|2.5, qam: 4|16|64, protection: 'high'|'normal', interleave: 'long'|'short', callsign}. */
function normaliseSettings(s = {}) {
  const mode = String(s.mode ?? 'B').toUpperCase();
  if (!MODE_NAMES.includes(mode)) throw new Error(`EasyPal mode must be A, B or E (got "${s.mode}")`);
  const bw = Number(s.bandwidth ?? 2.5);
  if (bw !== 2.3 && bw !== 2.5) throw new Error(`EasyPal bandwidth must be 2.3 or 2.5 (got "${s.bandwidth}")`);
  const qam = Number(s.qam ?? 16);
  if (![4, 16, 64].includes(qam)) throw new Error(`EasyPal QAM must be 4, 16 or 64 (got "${s.qam}")`);
  const protection = String(s.protection ?? 'high').toLowerCase();
  if (protection !== 'high' && protection !== 'normal') throw new Error(`EasyPal protection must be high or normal (got "${s.protection}")`);
  const interleave = String(s.interleave ?? 'short').toLowerCase();
  if (interleave !== 'long' && interleave !== 'short') throw new Error(`EasyPal interleave must be long or short (got "${s.interleave}")`);
  return { mode, bandwidth: bw, qam, protection, interleave, callsign: String(s.callsign ?? '').toUpperCase() };
}

class HamDrmTransmitter {
  constructor(settings) {
    const s = normaliseSettings(settings);
    this.settings = s;
    this.so = s.bandwidth === 2.5 ? 1 : 0;
    this.map = cellMap(s.mode, this.so);
    const N = this.map.nMux;
    const plB = s.protection === 'normal' ? 1 : 0;
    // multilevel code (MLC.cpp CalculateParam, part A empty)
    let rates;
    if (s.qam === 4) rates = [CODE_RATE_MSC4];
    else if (s.qam === 16) rates = CODE_RATES_MSC16[plB];
    else rates = CODE_RATES_MSC64[plB];
    this.levels = rates.map((r, l) => {
      const bits = PUNCTURING[r][0] * Math.trunc((2 * N - 12) / PUNCTURING[r][1]);
      return { rate: r, bits, punct: puncturingTable(bits, r, N, false), interleaver: INTERLEAVERS[s.qam][l] };
    });
    this.bitsPerFrame = this.levels.reduce((n, l) => n + l.bits, 0);
    this.bitTables = [interleaverTable(2 * N, 13), interleaverTable(2 * N, 21)];
    this.symbTable = interleaverTable(N, 5);
    this.D = s.interleave === 'long' ? 5 : 1;
    // packets: one a frame, as long as the frame allows (CDRMTransmitter::Init)
    this.packetBytes = Math.trunc(this.bitsPerFrame / 8) - 3;
    this.bodySegBytes = Math.trunc(this.bitsPerFrame / 8) - 14;
    const m = MODES[s.mode];
    this.fft = m.fft;
    this.guard = (m.fft * m.tgtu[0]) / m.tgtu[1];
    this.spf = m.spf;
    // FAC: 45 cells of 4-QAM, rate 3/5
    this.facPunct = puncturingTable(48, CODE_RATE_FAC, 45, true);
    this.facTable = interleaverTable(90, 21);
  }

  /** Body bytes carried by each frame. */
  get bytesPerFrame() {
    return this.bodySegBytes;
  }

  /** Frames needed to send a file of `bytes` called `name`.`ext`. */
  framesFor(bytes, name = 'picture', ext = 'jpg') {
    return this._packets(this._groups(Buffer.alloc(bytes), name, ext)).length + this._flushFrames();
  }

  /** Seconds a file of `bytes` takes to send. */
  secondsFor(bytes, name, ext) {
    return this.framesFor(bytes, name, ext) * FRAME_SEC;
  }

  /** QSSTV stops one frame before its last packet (and, with long interleave, with part of the end still in the interleaver: that is what the extra groups are for). */
  _flushFrames() {
    return -1;
  }

  /** The data group sent in each frame, in order. */
  _groups(file, name, ext) {
    const fileName = `${name}.${ext}`;
    const tid = transportId(fileName);
    const segs = motSegments(file, fileName, ext, this.bodySegBytes);
    const list = segmentSchedule(segs.header.length, segs.body.length);
    const all = [...list, ...list.slice(0, EXTRA_GROUPS)];
    let contH = 0;
    let contB = 0;
    return all.map((n) => {
      if (n < 0) {
        const k = -1 - n;
        const g = dataGroup(segs.header[k], true, k, k === segs.header.length - 1, tid, contH);
        contH = (contH + 1) % 16;
        return g;
      }
      const g = dataGroup(segs.body[n], false, n, n === segs.body.length - 1, tid, contB);
      contB = (contB + 1) % 16;
      return g;
    });
  }

  /**
   * The packets, one a frame (DataDecoder.cpp GeneratePacket): each data
   * group is cut into packets, a short last piece padded and its length given.
   * QSSTV stops 5 groups after the end of its schedule (MOTSlideShow.cpp).
   */
  _packets(groups) {
    const len = this.packetBytes;
    const packets = [];
    let cont = 0;
    for (const g of groups) {
      for (let at = 0; at < g.length; at += len) {
        const remain = g.length - at;
        const p = Buffer.alloc(len + 3);
        p[0] = (at === 0 ? 0x80 : 0) | (remain <= len ? 0x40 : 0) | (remain < len ? 0x08 : 0) | cont; // first, last, packet id 0, padded, continuity
        cont = (cont + 1) % 8;
        if (remain < len) {
          p[1] = remain;
          g.copy(p, 2, at);
        } else g.copy(p, 1, at, at + len);
        p.writeUInt16BE(crc(p.subarray(0, len + 1), 16), len + 1);
        packets.push(p);
      }
    }
    return packets;
  }

  _frameBits(packet) {
    const bits = new Uint8Array(this.bitsPerFrame);
    if (packet) for (let i = 0; i < packet.length * 8; i++) bits[i] = (packet[i >> 3] >> (7 - (i & 7))) & 1;
    return bits;
  }

  /** Multilevel coding of one frame: bits in, N_MUX cells (interleaved re/im) out. */
  _mlc(bits) {
    const N = this.map.nMux;
    disperse(bits);
    let at = 0;
    const coded = this.levels.map((l) => {
      const out = convEncode(bits.subarray(at, at + l.bits), l.punct, 2 * N);
      at += l.bits;
      if (l.interleaver >= 0) {
        const t = this.bitTables[l.interleaver];
        const tmp = Uint8Array.from(out);
        for (let i = 0; i < out.length; i++) out[i] = tmp[t[i]];
      }
      return out;
    });
    const cells = new Float64Array(2 * N);
    const q = this.settings.qam;
    for (let i = 0; i < N; i++) {
      for (let part = 0; part < 2; part++) {
        const j = 2 * i + part;
        let v;
        if (q === 4) v = QAM4[coded[0][j]];
        else if (q === 16) v = QAM16[(coded[0][j] << 1) | coded[1][j]];
        else v = QAM64[(coded[0][j] << 2) | (coded[1][j] << 1) | coded[2][j]];
        cells[j] = v;
      }
    }
    return cells;
  }

  /**
   * The 45 FAC cells for frame `f` (its place in the superframe is f % 3).
   * Bits 31-39 are spare. QSSTV never writes them and scrambles its one FAC
   * buffer in place, so in every other frame they hold the scrambling
   * sequence left from the frame before; done the same here, so the output
   * matches QSSTV's sample for sample (receivers ignore those bits).
   */
  _fac(f) {
    const id = f % 3;
    const s = this.settings;
    const b = new Bits(48);
    b.put([3, 1, 2][id], 2);
    b.put(this.so, 1);
    b.put(s.interleave === 'short' ? 1 : 0, 1);
    b.put(s.qam === 64 ? 0 : 1, 1);
    b.put(s.protection === 'normal' ? 1 : 0, 1);
    b.put(1, 1); // data service
    b.put(0, 2); // packet id
    b.put(s.qam === 4 ? 1 : 0, 1);
    const label = Buffer.from(s.callsign, 'latin1').subarray(0, 9);
    for (let i = 3 * id; i < 3 * id + 3; i++) b.put(i < label.length ? label[i] & 127 : 0, 7);
    if (f % 2 === 1) {
      const prbs = new Uint8Array(40);
      disperse(prbs);
      b.a.set(prbs.subarray(31, 40), 31);
    }
    b.pos = 40;
    b.put(crc(bytesOf(b.a, 5), 8), 8);
    const bits = b.a;
    disperse(bits);
    const coded = convEncode(bits, this.facPunct, 90);
    const cells = new Float64Array(90);
    for (let i = 0; i < 90; i++) cells[i] = QAM4[coded[this.facTable[i]]];
    return cells;
  }

  /**
   * The whole transmission.
   * @param {Buffer} file
   * @param {string} name file name without extension (EasyPal shows it)
   * @param {string} ext extension: jpg, jp2, rs1-rs4, ...
   * @param {object} [opts]
   * @param {number} [opts.amplitude=0.9] peak level of the audio (-1..1)
   * @returns {{audio: Float32Array, frames: number, seconds: number}}
   */
  encode(file, name, ext, { amplitude = 0.9 } = {}) {
    const packets = this._packets(this._groups(file, name, ext));
    const N = this.map.nMux;
    const D = this.D;
    const frames = packets.length + this._flushFrames();
    const mem = Array.from({ length: D }, () => new Float64Array(2 * N));
    const cur = Array.from({ length: D }, (_, i) => i);
    const symLen = this.fft + this.guard;
    const out = new Float32Array(frames * this.spf * symLen);
    const { kmin, nCar, type, pilot } = this.map;
    const shift = (-2 * Math.PI * (VIRTUAL_IF - DC_HZ)) / RATE;
    const base = this.fft / 8; // the IFFT bin of 6 kHz
    let n = 0;
    const cell = new Float64Array(2 * nCar);
    const N_ = this.fft;
    const yr = new Float64Array(N_);
    const yi = new Float64Array(N_);
    const cosT = new Float64Array(N_);
    const sinT = new Float64Array(N_);
    for (let i = 0; i < N_; i++) {
      cosT[i] = Math.cos((2 * Math.PI * i) / N_);
      sinT[i] = Math.sin((2 * Math.PI * i) / N_);
    }
    for (let f = 0; f < frames; f++) {
      const bits = this._frameBits(packets[f]);
      // symbol interleaver
      mem[cur[0]].set(this._mlc(bits));
      const msc = new Float64Array(2 * N);
      for (let i = 0; i < N; i++) {
        const src = mem[cur[i % D]];
        msc[2 * i] = src[2 * this.symbTable[i]];
        msc[2 * i + 1] = src[2 * this.symbTable[i] + 1];
      }
      for (let j = 0; j < D; j++) cur[j] = cur[j] - 1 < 0 ? D - 1 : cur[j] - 1;
      const fac = this._fac(f);
      let mi = 0;
      let fi = 0;
      for (let s = 0; s < this.spf; s++) {
        const sym = (f % 3) * this.spf + s;
        for (let c = 0; c < nCar; c++) {
          const t = type[sym][c];
          if (t === CM_MSC) {
            cell[2 * c] = msc[2 * mi];
            cell[2 * c + 1] = msc[2 * mi + 1];
            mi++;
          } else if (t === CM_FAC) {
            cell[2 * c] = fac[2 * fi];
            cell[2 * c + 1] = fac[2 * fi + 1];
            fi++;
          } else if (t === CM_PILOT) {
            cell[2 * c] = pilot[sym][2 * c];
            cell[2 * c + 1] = pilot[sym][2 * c + 1];
          } else cell[2 * c] = cell[2 * c + 1] = 0;
        }
        // OFDM: the inverse DFT of the few carriers in use (a direct sum, quicker
        // than a full FFT for ~50 of 1152 bins), guard interval first, then the
        // move from 6 kHz to 350 Hz
        yr.fill(0);
        yi.fill(0);
        for (let c = 0; c < nCar; c++) {
          const ar = cell[2 * c];
          const ai = cell[2 * c + 1];
          if (ar === 0 && ai === 0) continue;
          const b = base + kmin + c;
          for (let t = 0, idx = 0; t < N_; t++) {
            yr[t] += ar * cosT[idx] - ai * sinT[idx];
            yi[t] += ar * sinT[idx] + ai * cosT[idx];
            idx += b;
            if (idx >= N_) idx -= N_;
          }
        }
        let rr = Math.cos(shift * n);
        let ri = Math.sin(shift * n);
        const sr = Math.cos(shift);
        const si = Math.sin(shift);
        for (let m = 0; m < symLen; m++, n++) {
          const t = (m - this.guard + this.fft) % this.fft;
          out[n] = yr[t] * rr - yi[t] * ri; // Re{(yr + j yi)(rr + j ri)}
          const nr = rr * sr - ri * si;
          ri = rr * si + ri * sr;
          rr = nr;
        }
      }
    }
    // level: the peak at `amplitude`
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    const g = peak > 0 ? amplitude / peak : 1;
    for (let i = 0; i < out.length; i++) out[i] *= g;
    return { audio: out, frames, seconds: frames * FRAME_SEC };
  }
}

module.exports = { HamDrmTransmitter, normaliseSettings, transportId, segmentSchedule, cellMap, crc, interleaverTable, FRAME_SEC, RATE };
