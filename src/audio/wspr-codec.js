'use strict';

/**
 * WSPR message coding: packing, the K=32 r=1/2 convolutional code, the
 * interleaver, the sync vector, and the Fano sequential decoder.
 *
 * This is a JavaScript port of parts of wsprd and wsprsim from WSJT-X
 * (lib/wsprd: wsprsim_utils.c, wsprd_utils.c, fano.c, nhash.c, tab.c,
 * metric_tables.c). Copyright 2001-2015 Joe Taylor K1JT, 2014-2015 Steven
 * Franke K9AN, 1994 Phil Karn KA9Q (Fano decoder), 2006 Bob Jenkins
 * (hash, public domain). WSJT-X is GPL-3.0; see third_party/wsjtx-wsprd.
 *
 * A WSPR message is 50 bits: a 28-bit callsign and a 22-bit
 * grid-and-power field. 31 zero tail bits are added, the 81 bits are
 * convolutionally coded to 162 bits, interleaved, and each bit is
 * combined with one bit of a fixed sync vector to make a 4-FSK symbol
 * (0-3).
 */

/** The sync vector. Channel symbol = 2 * data bit + PR3[i]. */
const PR3 = Uint8Array.from(
  ('1100000010001110001001011110000000100101000000101100110100011010000110101010100100101100011010100010' +
    '00001001001110110011010001110000010100110000000110101100011000').split(''),
  Number
);

const POLY1 = 0xf2d05351;
const POLY2 = 0xe4613c47;

/** Fano branch metrics for a received soft symbol 0-255 when a 0 was sent (wsprd's mettab[0], bias 0.45). */
const METTAB0 = Int16Array.from([
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 0, 0, 0, -1, -1, -1,
  -2, -2, -3, -3, -4, -4, -5, -5, -6, -6, -7, -7, -8, -9, -9, -10, -10, -11, -12, -13, -13, -14, -15, -16, -16, -17,
  -18, -19, -20, -20, -21, -22, -23, -24, -25, -26, -27, -28, -28, -29, -30, -31, -32, -33, -34, -35, -36, -37, -38,
  -39, -40, -41, -42, -43, -44, -45, -46, -47, -48, -49, -50, -51, -52, -53, -54, -55, -56, -57, -58, -59, -60, -61,
  -62, -63, -64, -65, -66, -67, -68, -69, -70, -71, -72, -73, -74, -75, -76, -77, -78, -79, -80, -81, -83, -83, -84,
  -86, -87, -87, -89, -90, -91, -92, -93, -94, -95, -96, -97, -97, -99, -100, -101, -102, -103, -104, -105, -106,
  -108, -107, -110, -110, -112, -112, -114, -115, -115, -116, -117, -118, -119, -120, -121, -124, -123, -126, -137,
]);
const METTAB1 = Int16Array.from(METTAB0, (_, i) => METTAB0[255 - i]);

/** Allowed power levels end in 0, 3 or 7 dBm; this rounds the last digit to one of them. */
const NU = [0, -1, 1, 0, -1, 2, 1, 0, -1, 1];

const PARTAB = new Uint8Array(65536);
for (let v = 1; v < 65536; v++) PARTAB[v] = PARTAB[v >> 1] ^ (v & 1);

function parity(x) {
  return PARTAB[(x ^ (x >>> 16)) & 0xffff];
}

/** Both coded bits for a 32-bit encoder state: (POLY1 parity << 1) | POLY2 parity. */
function encodeState(state) {
  return (parity(state & POLY1) << 1) | parity(state & POLY2);
}

/** Interleave order: the bit-reversed byte values below 162. */
const INTERLEAVE = (() => {
  const order = new Uint8Array(162);
  let p = 0;
  for (let i = 0; p < 162; i++) {
    let j = 0;
    for (let b = 0; b < 8; b++) if (i & (1 << b)) j |= 1 << (7 - b);
    if (j < 162) order[p++] = j;
  }
  return order;
})();

function interleave(bits) {
  const out = new Uint8Array(162);
  for (let p = 0; p < 162; p++) out[INTERLEAVE[p]] = bits[p];
  return out;
}

function deinterleave(sym) {
  const out = new Uint8Array(162);
  for (let p = 0; p < 162; p++) out[p] = sym[INTERLEAVE[p]];
  return out;
}

/** Bob Jenkins' hashlittle, as wsprd's nhash() with initval 146, keeping 15 bits. */
function nhash(str) {
  const k = Buffer.from(str, 'latin1');
  let length = k.length;
  let a = (0xdeadbeef + length + 146) >>> 0;
  let b = a;
  let c = a;
  const rot = (x, r) => ((x << r) | (x >>> (32 - r))) >>> 0;
  let o = 0;
  while (length > 12) {
    a = (a + (k[o] | (k[o + 1] << 8) | (k[o + 2] << 16) | (k[o + 3] << 24))) >>> 0;
    b = (b + (k[o + 4] | (k[o + 5] << 8) | (k[o + 6] << 16) | (k[o + 7] << 24))) >>> 0;
    c = (c + (k[o + 8] | (k[o + 9] << 8) | (k[o + 10] << 16) | (k[o + 11] << 24))) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
    length -= 12;
    o += 12;
  }
  if (length === 0) return c & 32767;
  const byte = (i) => (i < length ? k[o + i] : 0);
  a = (a + (byte(0) | (byte(1) << 8) | (byte(2) << 16) | (byte(3) << 24))) >>> 0;
  b = (b + (byte(4) | (byte(5) << 8) | (byte(6) << 16) | (byte(7) << 24))) >>> 0;
  c = (c + (byte(8) | (byte(9) << 8) | (byte(10) << 16) | (byte(11) << 24))) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  return c & 32767;
}

function callCharCode(ch) {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch === ' ') return 36;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
  return -1;
}

/** 28-bit callsign number. The third character must be a digit (a leading space is added if needed). */
function packCall(call) {
  let c6;
  if (/^[A-Z0-9]{2}[0-9]/.test(call)) c6 = call;
  else if (/^[A-Z0-9][0-9]/.test(call)) c6 = ` ${call}`;
  else return null;
  c6 = c6.padEnd(6, ' ');
  if (c6.length > 6) return null;
  const v = [...c6].map(callCharCode);
  if (v.some((x) => x < 0)) return null;
  // the last three characters must be letters or spaces
  if (v.slice(3).some((x) => x < 10)) return null;
  let n = v[0];
  n = n * 36 + v[1];
  n = n * 10 + v[2];
  n = n * 27 + v[3] - 10;
  n = n * 27 + v[4] - 10;
  n = n * 27 + v[5] - 10;
  return n;
}

/** Rounds a power in dBm to the nearest allowed WSPR level (0-60, ending in 0, 3 or 7). */
function normalizeDbm(dbm) {
  let p = Math.max(0, Math.min(60, Math.round(dbm)));
  return p + NU[p % 10];
}

/** Watts to the WSPR power field: 1 W = 30 dBm, rounded to an allowed level. */
function wattsToDbm(watts) {
  return normalizeDbm(10 * Math.log10(watts * 1000));
}

const GRID4 = /^[A-R]{2}[0-9]{2}$/;

/** True for callsigns a plain (type 1) WSPR message can carry. */
function isPlainCall(call) {
  return typeof call === 'string' && call.length <= 6 && packCall(call) !== null;
}

/**
 * Builds the 162 channel symbols (0-3) for a type 1 message: callsign,
 * 4-character grid and power in dBm.
 */
function encodeMessage(callsign, grid, dbm) {
  const call = String(callsign).trim().toUpperCase();
  const g = String(grid).trim().toUpperCase().slice(0, 4);
  const n = packCall(call);
  if (n === null || call.length > 6) throw new Error(`WSPR cannot send the callsign "${callsign}"`);
  if (!GRID4.test(g)) throw new Error(`WSPR needs a Maidenhead grid like QF22, got "${grid}"`);
  const power = normalizeDbm(dbm);
  const gc = [...g].map((ch) => (ch >= 'A' ? ch.charCodeAt(0) - 65 : ch.charCodeAt(0) - 48));
  let m = (179 - 10 * gc[0] - gc[2]) * 180 + 10 * gc[1] + gc[3];
  m = m * 128 + power + 64;
  const data = new Uint8Array(11);
  data[0] = (n >>> 20) & 0xff;
  data[1] = (n >>> 12) & 0xff;
  data[2] = (n >>> 4) & 0xff;
  data[3] = ((n & 0x0f) << 4) | ((m >>> 18) & 0x0f);
  data[4] = (m >>> 10) & 0xff;
  data[5] = (m >>> 2) & 0xff;
  data[6] = (m & 0x03) << 6;
  return { symbols: dataToSymbols(data), message: `${call} ${g} ${power}`, dbm: power };
}

/** Convolutionally codes 81 bits (11 bytes, MSB first), interleaves, and adds the sync vector. */
function dataToSymbols(data) {
  const bits = new Uint8Array(176);
  let state = 0;
  let o = 0;
  for (let byte = 0; byte < 11; byte++) {
    for (let i = 7; i >= 0; i--) {
      state = ((state << 1) | ((data[byte] >> i) & 1)) >>> 0;
      const sym = encodeState(state);
      bits[o++] = sym >> 1;
      bits[o++] = sym & 1;
    }
  }
  const inter = interleave(bits.subarray(0, 162));
  return Uint8Array.from(inter, (b, i) => 2 * b + PR3[i]);
}

/** Channel symbols for a decoded message string (used to subtract a decoded signal). */
function symbolsForDecoded(data) {
  return dataToSymbols(data);
}

/**
 * Fano sequential decoder for 162 deinterleaved soft symbols (0-255,
 * 128 = no information). Returns the 11 decoded bytes, or null when the
 * decoder runs out of cycles.
 */
function fano(symbols, { nbits = 81, delta = 60, maxcycles = 10000 } = {}) {
  const metrics = new Int32Array(nbits * 4);
  for (let n = 0; n < nbits; n++) {
    const s0 = symbols[2 * n];
    const s1 = symbols[2 * n + 1];
    metrics[4 * n] = METTAB0[s0] + METTAB0[s1];
    metrics[4 * n + 1] = METTAB0[s0] + METTAB1[s1];
    metrics[4 * n + 2] = METTAB1[s0] + METTAB0[s1];
    metrics[4 * n + 3] = METTAB1[s0] + METTAB1[s1];
  }
  const encstate = new Uint32Array(nbits + 1);
  const gamma = new Int32Array(nbits + 1);
  const tm = new Int32Array(2 * nbits); // sorted branch metrics: [2n] best, [2n+1] other
  const branch = new Uint8Array(nbits);
  const tail = nbits - 31;
  const lastnode = nbits - 1;

  let np = 0;
  let lsym = encodeState(0);
  let m0 = metrics[lsym];
  let m1 = metrics[3 ^ lsym];
  if (m0 > m1) {
    tm[0] = m0;
    tm[1] = m1;
  } else {
    tm[0] = m1;
    tm[1] = m0;
    encstate[0] = 1;
  }
  let t = 0;
  const limit = maxcycles * nbits;
  let i;
  let done = false;
  for (i = 1; i <= limit; i++) {
    const ngamma = gamma[np] + tm[2 * np + branch[np]];
    if (ngamma >= t) {
      if (gamma[np] < t + delta) while (ngamma >= t + delta) t += delta;
      gamma[np + 1] = ngamma;
      encstate[np + 1] = encstate[np] << 1;
      np++;
      if (np > lastnode) {
        done = true;
        break;
      }
      lsym = encodeState(encstate[np]);
      const base = 4 * np;
      if (np >= tail) {
        tm[2 * np] = metrics[base + lsym];
      } else {
        m0 = metrics[base + lsym];
        m1 = metrics[base + (3 ^ lsym)];
        if (m0 > m1) {
          tm[2 * np] = m0;
          tm[2 * np + 1] = m1;
        } else {
          tm[2 * np] = m1;
          tm[2 * np + 1] = m0;
          encstate[np]++;
        }
      }
      branch[np] = 0;
      continue;
    }
    for (;;) {
      if (np === 0 || gamma[np - 1] < t) {
        t -= delta;
        if (branch[np] !== 0) {
          branch[np] = 0;
          encstate[np] ^= 1;
        }
        break;
      }
      np--;
      if (np < tail && branch[np] !== 1) {
        branch[np] = 1;
        encstate[np] ^= 1;
        break;
      }
    }
  }
  if (!done) return null;
  const data = new Uint8Array(nbits >> 3);
  for (let b = 0; b < data.length; b++) data[b] = encstate[7 + 8 * b] & 0xff;
  // fano() copies 10 bytes for 81 bits; the 11th (tail) byte is zero
  const out = new Uint8Array(11);
  out.set(data);
  return { data: out, metric: gamma[np], cycles: i + 1 };
}

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ';

function unpackCall(ncall) {
  if (ncall >= 262177560) return null;
  // as wsprd: drop leading spaces, and the call ends at the first space after that
  return unpackCallRaw(ncall).replace(/^ +/, '').split(' ')[0];
}

function unpackGrid(ngrid) {
  ngrid >>= 7;
  if (ngrid >= 32400) return null;
  const dlat = (ngrid % 180) - 90;
  let dlong = Math.floor(ngrid / 180) * 2 - 180 + 2;
  if (dlong < -180) dlong += 360;
  if (dlong > 180) dlong += 360;
  const nlong = Math.trunc((60.0 * (180.0 - dlong)) / 5.0);
  let n1 = Math.trunc(nlong / 240);
  let n2 = Math.trunc((nlong - 240 * n1) / 24);
  const g = [CHARS[10 + n1], '', CHARS[n2], ''];
  const nlat = Math.trunc((60.0 * (dlat + 90)) / 2.5);
  n1 = Math.trunc(nlat / 240);
  n2 = Math.trunc((nlat - 240 * n1) / 24);
  g[1] = CHARS[10 + n1];
  g[3] = CHARS[n2];
  return g.join('');
}

function unpackPrefix(nprefix, call) {
  if (nprefix < 60000) {
    let n = nprefix;
    const pfx = ['', '', ''];
    for (let i = 2; i >= 0; i--) {
      const nc = n % 37;
      pfx[i] = nc <= 9 ? String.fromCharCode(nc + 48) : nc <= 35 ? String.fromCharCode(nc + 55) : ' ';
      n = Math.floor(n / 37);
    }
    const s = pfx.join('');
    const sp = s.lastIndexOf(' ');
    return `${sp >= 0 ? s.slice(sp + 1) : s}/${call}`;
  }
  const nc = nprefix - 60000;
  if (nc >= 0 && nc <= 9) return `${call}/${String.fromCharCode(nc + 48)}`;
  if (nc >= 10 && nc <= 35) return `${call}/${String.fromCharCode(nc + 55)}`;
  if (nc >= 36 && nc <= 125) return `${call}/${Math.floor((nc - 26) / 10)}${(nc - 26) % 10}`;
  return null;
}

/**
 * Unpacks 11 decoded bytes. `hashtab` is a Map from 15-bit hash to
 * callsign, updated as plain and compound calls are heard (type 3
 * messages carry only the hash).
 * Returns { message, callsign, grid, dbm, type, print } or null.
 */
function unpackMessage(data, hashtab = new Map()) {
  const n1 = (data[0] << 20) | (data[1] << 12) | (data[2] << 4) | ((data[3] >> 4) & 15);
  const n2 = ((data[3] & 15) << 18) | (data[4] << 10) | (data[5] << 2) | ((data[6] >> 6) & 3);
  let callsign = unpackCall(n1);
  if (callsign === null) return null;
  const grid = unpackGrid(n2);
  if (grid === null) return null;
  const ntype = (n2 & 127) - 64;
  if (ntype >= 0 && ntype <= 62) {
    // A packed callsign only ever has spaces at its ends. One in the middle
    // ("LC0 NS") is the Fano decoder converging on noise; wsprd prints those
    // (cut at the space), this drops them.
    if (/[A-Z0-9] +[A-Z0-9]/.test(unpackCallRaw(n1))) return null;
    const nu = ntype % 10;
    if (nu === 0 || nu === 3 || nu === 7) {
      hashtab.set(nhash(callsign), callsign);
      return { message: `${callsign} ${grid} ${ntype}`, callsign, grid, dbm: ntype, type: 1, print: true };
    }
    let nadd = nu;
    if (nu > 3) nadd = nu - 3;
    if (nu > 7) nadd = nu - 7;
    const n3 = Math.floor(n2 / 128) + 32768 * (nadd - 1);
    callsign = unpackPrefix(n3, callsign);
    if (callsign === null) return null;
    const dbm = ntype - nadd;
    const pu = dbm % 10;
    const ok = pu === 0 || pu === 3 || pu === 7;
    if (ok) hashtab.set(nhash(callsign), callsign);
    return { message: `${callsign} ${dbm}`, callsign, grid: '', dbm, type: 2, print: ok };
  }
  // type 3: hash and 6-character grid
  const dbm = -(ntype + 1);
  const raw = unpackCallRaw(n1);
  const grid6 = (raw[5] + raw.slice(0, 5)).trim();
  const pu = dbm % 10;
  let print = (pu === 0 || pu === 3 || pu === 7) && /^[A-Z]{2}[0-9]{2}/.test(grid6) && ntype !== -64;
  const ihash = (n2 - ntype - 64) / 128;
  const known = hashtab.get(ihash);
  const call = known ? `<${known}>` : '<...>';
  return { message: `${call} ${grid6} ${dbm}`, callsign: known || '', grid: grid6, dbm, type: 3, print };
}

/** Like unpackCall but keeps all six characters (spaces included), for type 3 grids. */
function unpackCallRaw(ncall) {
  let n = ncall;
  const tmp = new Array(6);
  tmp[5] = CHARS[(n % 27) + 10];
  n = Math.floor(n / 27);
  tmp[4] = CHARS[(n % 27) + 10];
  n = Math.floor(n / 27);
  tmp[3] = CHARS[(n % 27) + 10];
  n = Math.floor(n / 27);
  tmp[2] = CHARS[n % 10];
  n = Math.floor(n / 10);
  tmp[1] = CHARS[n % 36];
  n = Math.floor(n / 36);
  tmp[0] = CHARS[n];
  return tmp.join('');
}

/** WSPR timing: 12 kHz audio, 8192 samples (0.683 s) per symbol, 162 symbols. */
const SAMPLE_RATE = 12000;
const SAMPLES_PER_SYMBOL = 8192;
const TONE_SPACING_HZ = SAMPLE_RATE / SAMPLES_PER_SYMBOL; // 1.4648 Hz
const TX_SECONDS = (162 * SAMPLES_PER_SYMBOL) / SAMPLE_RATE; // 110.6 s

/**
 * Audio for one transmission: continuous-phase 4-FSK with the lowest
 * tone at `baseHz - 1.5 * spacing`, so the signal is centred on `baseHz`.
 * A short raised-cosine ramp at each end avoids key clicks.
 */
function synthesize(symbols, { baseHz = 1500, sampleRate = SAMPLE_RATE, amplitude = 0.5, rampMs = 10 } = {}) {
  const sps = Math.round((SAMPLES_PER_SYMBOL * sampleRate) / SAMPLE_RATE);
  const out = new Float32Array(162 * sps);
  let phase = 0;
  for (let i = 0; i < 162; i++) {
    const f = baseHz + (symbols[i] - 1.5) * TONE_SPACING_HZ;
    const dphi = (2 * Math.PI * f) / sampleRate;
    for (let j = 0; j < sps; j++) {
      out[i * sps + j] = amplitude * Math.sin(phase);
      phase += dphi;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  const ramp = Math.round((rampMs / 1000) * sampleRate);
  for (let j = 0; j < ramp; j++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * j) / ramp);
    out[j] *= g;
    out[out.length - 1 - j] *= g;
  }
  return out;
}

module.exports = {
  PR3,
  SAMPLE_RATE,
  SAMPLES_PER_SYMBOL,
  TONE_SPACING_HZ,
  TX_SECONDS,
  nhash,
  packCall,
  isPlainCall,
  normalizeDbm,
  wattsToDbm,
  encodeMessage,
  dataToSymbols,
  symbolsForDecoded,
  interleave,
  deinterleave,
  fano,
  unpackMessage,
  synthesize,
};
