'use strict';

/**
 * Reed-Solomon erasure coding of EasyPal/QSSTV ".rs1" to ".rs4" files:
 * RS(255, k) over GF(256) with k = 224, 192, 160 or 128, the code words
 * interleaved across the file so each missing segment costs every code
 * word only a few bytes. Ported from QSSTV's utils/rs.cpp (Phil Karn,
 * KA9Q, 1996-1999, after Robert Morelos-Zaragoza and Hari Thirumoorthy)
 * and utils/reedsolomoncoder.cpp (Johan Maes, ON4QZ, after PA0MBO).
 *
 * Portions copyright (C) 1999 Phil Karn (KA9Q), 2000-2019 Johan Maes
 * (ON4QZ); GPL. See third_party/qsstv-drm/README.md.
 */

const MM = 8;
const NN = 255;
const A0 = NN;
const B0 = 1;
const PRIM = 1;
const DSIZE = { rs1: 224, rs2: 192, rs3: 160, rs4: 128 };

const Alpha_to = new Int32Array(NN + 1);
const Index_of = new Int32Array(NN + 1);
{
  const Pp = [1, 0, 1, 1, 1, 0, 0, 0, 1]; // 1 + x^2 + x^3 + x^4 + x^8
  let mask = 1;
  Alpha_to[MM] = 0;
  for (let i = 0; i < MM; i++) {
    Alpha_to[i] = mask;
    Index_of[Alpha_to[i]] = i;
    if (Pp[i] !== 0) Alpha_to[MM] ^= mask;
    mask <<= 1;
  }
  Index_of[Alpha_to[MM]] = MM;
  mask >>= 1;
  for (let i = MM + 1; i < NN; i++) {
    if (Alpha_to[i - 1] >= mask) Alpha_to[i] = Alpha_to[MM] ^ ((Alpha_to[i - 1] ^ mask) << 1);
    else Alpha_to[i] = Alpha_to[i - 1] << 1;
    Index_of[Alpha_to[i]] = i;
  }
  Index_of[0] = A0;
  Alpha_to[NN] = 0;
}

function modnn(x) {
  while (x >= NN) {
    x -= NN;
    x = (x >> MM) + (x & NN);
  }
  return x;
}

const genCache = new Map();
/** Generator polynomial (index form) for RS(255, kk). */
function genPoly(kk) {
  if (genCache.has(kk)) return genCache.get(kk);
  const Gg = new Int32Array(NN - kk + 1);
  Gg[0] = 1;
  for (let i = 0; i < NN - kk; i++) {
    Gg[i + 1] = 1;
    for (let j = i; j > 0; j--) {
      if (Gg[j] !== 0) Gg[j] = Gg[j - 1] ^ Alpha_to[modnn(Index_of[Gg[j]] + (B0 + i) * PRIM)];
      else Gg[j] = Gg[j - 1];
    }
    Gg[0] = Alpha_to[modnn(Index_of[Gg[0]] + (B0 + i) * PRIM)];
  }
  for (let i = 0; i <= NN - kk; i++) Gg[i] = Index_of[Gg[i]];
  genCache.set(kk, Gg);
  return Gg;
}

/** Parity of data[0..kk) into bb[0..NN-kk) (encode_rs). */
function encodeRs(data, bb, kk) {
  const Gg = genPoly(kk);
  const np = NN - kk;
  bb.fill(0, 0, np);
  for (let i = kk - 1; i >= 0; i--) {
    const feedback = Index_of[data[i] ^ bb[np - 1]];
    if (feedback !== A0) {
      for (let j = np - 1; j > 0; j--) {
        if (Gg[j] !== A0) bb[j] = bb[j - 1] ^ Alpha_to[modnn(Gg[j] + feedback)];
        else bb[j] = bb[j - 1];
      }
      bb[0] = Alpha_to[modnn(Gg[0] + feedback)];
    } else {
      for (let j = np - 1; j > 0; j--) bb[j] = bb[j - 1];
      bb[0] = 0;
    }
  }
}

/**
 * Errors-and-erasures decoding of one 255-byte code word in place (eras_dec_rs).
 * @returns {number} symbols corrected, or -1 if it can't be
 */
function decodeRs(data, erasPos, noEras, kk) {
  const np = NN - kk;
  const s = new Int32Array(np + 1);
  const lambda = new Int32Array(np + 1);
  const b = new Int32Array(np + 1);
  const t = new Int32Array(np + 1);
  const omega = new Int32Array(np + 1);
  const root = new Int32Array(np);
  const reg = new Int32Array(np + 1);
  const loc = new Int32Array(np);
  for (let i = 1; i <= np; i++) s[i] = data[0];
  for (let j = 1; j < NN; j++) {
    if (data[j] === 0) continue;
    const tmp = Index_of[data[j]];
    for (let i = 1; i <= np; i++) s[i] ^= Alpha_to[modnn(tmp + (B0 + i - 1) * PRIM * j)];
  }
  let synError = 0;
  for (let i = 1; i <= np; i++) {
    synError |= s[i];
    s[i] = Index_of[s[i]];
  }
  if (!synError) return 0;
  lambda[0] = 1;
  if (noEras > 0) {
    lambda[1] = Alpha_to[modnn(PRIM * erasPos[0])];
    for (let i = 1; i < noEras; i++) {
      const u = modnn(PRIM * erasPos[i]);
      for (let j = i + 1; j > 0; j--) {
        const tmp = Index_of[lambda[j - 1]];
        if (tmp !== A0) lambda[j] ^= Alpha_to[modnn(u + tmp)];
      }
    }
  }
  for (let i = 0; i < np + 1; i++) b[i] = Index_of[lambda[i]];
  let r = noEras;
  let el = noEras;
  while (++r <= np) {
    let discr = 0;
    for (let i = 0; i < r; i++) {
      if (lambda[i] !== 0 && s[r - i] !== A0) discr ^= Alpha_to[modnn(Index_of[lambda[i]] + s[r - i])];
    }
    discr = Index_of[discr];
    if (discr === A0) {
      b.copyWithin(1, 0, np);
      b[0] = A0;
    } else {
      t[0] = lambda[0];
      for (let i = 0; i < np; i++) {
        if (b[i] !== A0) t[i + 1] = lambda[i + 1] ^ Alpha_to[modnn(discr + b[i])];
        else t[i + 1] = lambda[i + 1];
      }
      if (2 * el <= r + noEras - 1) {
        el = r + noEras - el;
        for (let i = 0; i <= np; i++) b[i] = lambda[i] === 0 ? A0 : modnn(Index_of[lambda[i]] - discr + NN);
      } else {
        b.copyWithin(1, 0, np);
        b[0] = A0;
      }
      lambda.set(t);
    }
  }
  let degLambda = 0;
  for (let i = 0; i < np + 1; i++) {
    lambda[i] = Index_of[lambda[i]];
    if (lambda[i] !== A0) degLambda = i;
  }
  for (let i = 1; i <= np; i++) reg[i] = lambda[i];
  let count = 0;
  for (let i = 1, k = NN - 1; i <= NN; i++, k = modnn(NN + k - 1)) {
    let q = 1;
    for (let j = degLambda; j > 0; j--) {
      if (reg[j] !== A0) {
        reg[j] = modnn(reg[j] + j);
        q ^= Alpha_to[reg[j]];
      }
    }
    if (q !== 0) continue;
    root[count] = i;
    loc[count] = k;
    if (++count === degLambda) break;
  }
  if (degLambda !== count) return -1;
  let degOmega = 0;
  for (let i = 0; i < np; i++) {
    let tmp = 0;
    for (let j = degLambda < i ? degLambda : i; j >= 0; j--) {
      if (s[i + 1 - j] !== A0 && lambda[j] !== A0) tmp ^= Alpha_to[modnn(s[i + 1 - j] + lambda[j])];
    }
    if (tmp !== 0) degOmega = i;
    omega[i] = Index_of[tmp];
  }
  omega[np] = A0;
  for (let j = count - 1; j >= 0; j--) {
    let num1 = 0;
    for (let i = degOmega; i >= 0; i--) if (omega[i] !== A0) num1 ^= Alpha_to[modnn(omega[i] + i * root[j])];
    const num2 = Alpha_to[modnn(root[j] * (B0 - 1) + NN)];
    let den = 0;
    for (let i = Math.min(degLambda, np - 1) & ~1; i >= 0; i -= 2) {
      if (lambda[i + 1] !== A0) den ^= Alpha_to[modnn(lambda[i + 1] + i * root[j])];
    }
    if (den === 0) return -1;
    if (num1 !== 0) data[loc[j]] ^= Alpha_to[modnn(Index_of[num1] + Index_of[num2] + NN - Index_of[den])];
  }
  return count;
}

/**
 * Encodes a file as QSSTV does for transmission (reedSolomonCoder::encode).
 * @param {Buffer} file
 * @param {string} ext the real file's extension (up to 3 characters)
 * @param {'rs1'|'rs2'|'rs3'|'rs4'} type
 * @returns {Buffer} the bytes to send, as a file named <name>.<type>
 */
function encodeFile(file, ext, type) {
  const kk = DSIZE[type];
  const got = file.length;
  let chunks = Math.trunc((got + 7) / kk);
  if ((got + 7) % kk > 0) chunks++;
  const ec = Buffer.alloc(chunks * NN);
  const head = Buffer.alloc(7);
  head[0] = (kk - (got % kk)) & 0xff;
  head[1] = chunks % 256;
  head[2] = Math.trunc(chunks / 256);
  Buffer.from(ext.padEnd(3, '\0').slice(0, 3), 'latin1').copy(head, 3);
  const data = Buffer.concat([head, file]);
  const bb = new Uint8Array(NN - kk);
  for (let i = 0; i < chunks; i++) {
    const block = ec.subarray(i * NN, (i + 1) * NN);
    data.copy(block, 0, i * kk, Math.min((i + 1) * kk, data.length));
    encodeRs(block, bb, kk);
    block.set(bb, kk);
  }
  // distribute (ENCODE): byte j of code word i goes to j * chunks + i
  const out = Buffer.alloc(chunks * NN);
  for (let i = 0; i < chunks; i++) for (let j = 0; j < NN; j++) out[j * chunks + i] = ec[i * NN + j];
  return out;
}

/**
 * Recovers a file from a received .rsN body (reedSolomonCoder::decode).
 * @param {Buffer} ba received body, missing segments as zeros
 * @param {'rs1'|'rs2'|'rs3'|'rs4'} type
 * @param {{totalSegments:number, segmentLength:number, missing:number[]}} erasures
 * @returns {{data: Buffer, ext: string, corrected: number}|null}
 */
function decodeFile(ba, type, erasures) {
  const kk = DSIZE[type];
  if (!kk) return null;
  const bep = Math.ceil(ba.length / NN);
  const tr = Buffer.alloc(bep * NN);
  ba.copy(tr);
  const { segmentLength, missing } = erasures;
  const erased = new Uint8Array(bep * NN);
  for (const seg of missing) {
    for (let j = 0; j < segmentLength; j++) {
      const idx = seg * segmentLength + j;
      if (idx < erased.length) erased[idx] = 1;
    }
  }
  const out = Buffer.alloc(bep * kk);
  const word = new Uint8Array(NN);
  const eras = new Int32Array(NN);
  let corrected = 0;
  for (let i = 0; i < bep; i++) {
    let n = 0;
    for (let j = 0; j < NN; j++) {
      word[j] = tr[j * bep + i];
      if (erased[j * bep + i]) {
        eras[n++] = j;
        if (n > NN - kk) return null;
      }
    }
    const r = decodeRs(word, eras, n, kk);
    if (r < 0) return null;
    corrected += r;
    out.set(word.subarray(0, kk), i * kk);
  }
  if (bep !== out[1] + out[2] * 256) return null;
  // The first byte is kk - (file length % kk). QSSTV works the length out as
  // bep * kk - that byte (read as a signed char), which leaves up to a block of
  // padding on the end; this finds the one length that fits instead.
  const max = bep * kk - 7;
  const residue = (kk - out[0]) % kk;
  const size = max - ((((max - residue) % kk) + kk) % kk);
  let ext = out.subarray(3, 6).toString('latin1');
  const nul = ext.indexOf('\0');
  if (nul >= 0) ext = ext.slice(0, nul);
  return { data: out.subarray(7, 7 + size), ext, corrected };
}

module.exports = { encodeRs, decodeRs, encodeFile, decodeFile, DSIZE };
