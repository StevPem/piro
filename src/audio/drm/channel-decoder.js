'use strict';

/**
 * HamDRM receiver, channel decoder: superframe alignment, FAC decoding
 * (mode, QAM, interleaver, callsign), MSC cell demapping and
 * deinterleaving, and multilevel decoding with iterated hard decisions and
 * a Viterbi decoder. Ported from QSSTV's drmrx (channeldecode.cpp,
 * mkmscmap.cpp, deinterleaver.cpp, msdhardfac.cpp, msdhardmsc.cpp,
 * viterbi_decode.cpp, crc8_c.cpp): M. Bos (PA0MBO) after diorama by
 * Andreas Dittrich and Torsten Schorr.
 *
 * Portions copyright (C) 2009 M. Bos (PA0MBO), 2004 Torsten Schorr,
 * 2000-2019 Johan Maes (ON4QZ); GPL-2.0-or-later. See
 * third_party/qsstv-drm/README.md.
 */

const T = require('./tables');

const MSD_ITER = 4;
const STATES = 64;
const NOOFBF = 32;

/** Bit deinterleaver for parts A and B (deinterleaver.cpp, ETSI ES 201 980 7.3.3). */
function deinterleaver(xinA, tA, xinB, tB) {
  const d = new Int32Array(xinA + xinB);
  const sA = xinA === 0 ? 0 : 2 ** Math.ceil(Math.log(xinA) / Math.log(2));
  const qA = Math.trunc(sA / 4) - 1;
  const sB = xinB === 0 ? 0 : 2 ** Math.ceil(Math.log(xinB) / Math.log(2));
  const qB = Math.trunc(sB / 4) - 1;
  d[0] = 0;
  let PI = 0;
  for (let i = 1; i <= xinA - 1; i++) {
    PI = (tA * PI + qA) % sA;
    while (PI >= xinA) PI = (tA * PI + qA) % sA;
    d[PI] = i;
  }
  d[xinA] = xinA;
  PI = 0;
  for (let i = 1; i <= xinB - 1; i++) {
    PI = (tB * PI + qB) % sB;
    while (PI >= xinB) PI = (tB * PI + qB) % sB;
    d[PI + xinA] = i + xinA;
  }
  return d;
}

/**
 * MSC cell positions in the 6-frame transmission buffer, one row per frame
 * index (mkmscmap.cpp), with the cell interleaver undone.
 * @returns {{N_MUX:number, demapper:Int32Array[]}}
 */
function mkmscmap(mode, so, interleaverDepth, K_dc, K_modulo) {
  const fps = 3;
  const K_min = T.K_min_K_max_list[0][so + mode * 6];
  const K_max = T.K_min_K_max_list[1][so + mode * 6];
  const spf = T.symbols_per_frame_list[mode];
  const x = T.x_list[mode];
  const y = T.y_list[mode];
  const k0 = T.k0_list[mode];
  const gain = [];
  for (let s = 0; s < spf; s++) {
    const n = s % y;
    const p_min = Math.trunc((K_min - k0 - x * n) / (x * y));
    const p_max = Math.trunc((K_max - k0 - x * n) / (x * y));
    for (let p = p_min; p <= p_max; p++) gain.push(k0 + x * n + x * y * p + s * K_modulo);
  }
  const freqRef = T.freq_ref_cells_k_list[mode];
  const timeRef = T.time_ref_cells_k_list[mode].slice(0, T.time_ref_cells_cnt_list[mode]);
  const fac = T.mkfacmap(mode, 0, K_modulo);
  const cells = [];
  for (let m = 0; m < fps; m++) {
    const base = K_modulo * spf * m;
    const skip = new Set();
    for (const k of fac) skip.add(k + base);
    for (const k of timeRef) skip.add(base + k);
    for (const k of gain) skip.add(base + k);
    for (let s = 0; s < spf; s++) {
      const fr = new Set(freqRef.map((k) => base + K_modulo * s + k));
      for (let k = K_min; k <= K_max; k++) {
        const term = k + base + K_modulo * s;
        if (skip.has(term) || fr.has(term)) continue;
        if (term === base + K_modulo * s) continue; // DC (and, in mode A, carrier 0)
        cells.push(term);
      }
    }
  }
  const N_SFA = cells.length;
  const N_L = N_SFA % fps;
  const N_MUX = (N_SFA - N_L) / fps;
  const sf = spf * fps * K_modulo;
  const c3 = new Int32Array(3 * (N_SFA - N_L));
  for (let r = 0; r < 3; r++) for (let i = 0; i < N_SFA - N_L; i++) c3[r * (N_SFA - N_L) + i] = K_dc + r * sf + cells[i];
  const PICMSC_inv = deinterleaver(0, 1, N_MUX, 5);
  const dm = Array.from({ length: 6 }, () => new Int32Array(N_MUX));
  if (interleaverDepth === 0) {
    // long (convolutional) interleaving, ES 201 980 7.6
    const D = 5;
    const step = N_MUX + 1;
    const nc = Math.ceil(N_MUX / D);
    const GI = [];
    for (let j = 0; j < nc; j++) for (let i = 0; i < D; i++) GI.push(1 + i * step + j * D);
    for (let i = 0; i < N_MUX; i++) {
      const cd = GI[PICMSC_inv[i]];
      dm[5][i] = c3[cd - 1];
      dm[0][i] = ((c3[N_MUX + cd - 1] + 1) % (2 * sf)) - 1;
      dm[1][i] = ((c3[2 * N_MUX + cd - 1] + 1) % (2 * sf)) - 1;
      dm[2][i] = ((sf + c3[cd - 1] + 1) % (2 * sf)) - 1;
      dm[3][i] = ((sf + c3[N_MUX + cd - 1] + 1) % (2 * sf)) - 1;
      dm[4][i] = ((sf + c3[2 * N_MUX + cd - 1] + 1) % (2 * sf)) - 1;
    }
  } else {
    for (let i = 0; i < N_MUX; i++) {
      const cd = PICMSC_inv[i];
      dm[1][i] = c3[cd];
      dm[2][i] = c3[N_MUX + cd] % (2 * sf);
      dm[3][i] = c3[2 * N_MUX + cd] % (2 * sf);
      dm[4][i] = (sf + c3[cd]) % (2 * sf);
      dm[5][i] = (sf + c3[N_MUX + cd]) % (2 * sf);
      dm[0][i] = (sf + c3[2 * N_MUX + cd]) % (2 * sf);
    }
  }
  return { N_MUX, demapper: dm };
}

/**
 * Viterbi decoder for one level of the multilevel code (viterbi_decode.cpp).
 * Writes the information bits to infoout and the re-encoded code bits into
 * bit `bitpos` of cwout (through the deinterleaver).
 */
function viterbiDecode(llr, N, N_PartA, p1, p2, p3, infoout, infoOff, cwout, cwOff, bitpos, dint, dintOff, L, N_tail, mem) {
  let old = mem.m1;
  let neu = mem.m2;
  const path = mem.path;
  const acc = mem.acc;
  old.fill(-1e20);
  old[0] = 0;
  let si = 0;
  let pri = 0;
  let pp = p1;
  let pi = 1;
  let N_Part = N_PartA;
  const D = (k) => dint[dintOff + k];
  for (let part = 0; part < 3; part++) {
    while (si < N_Part) {
      let sp = D(si);
      acc[0] = -llr[sp];
      acc[1] = llr[sp];
      acc[2] = -llr[sp];
      acc[3] = llr[sp];
      switch (pp[pi]) {
        case 3:
          sp = D(si + 1);
          acc[0] += -llr[sp];
          acc[1] += -llr[sp];
          acc[2] += llr[sp];
          acc[3] += llr[sp];
          si += 2;
          break;
        case 5:
          sp = D(si + 1);
          acc[0] += -llr[sp];
          acc[1] += -llr[sp];
          acc[2] += -llr[sp];
          acc[3] += -llr[sp];
          si += 2;
          break;
        case 7: {
          sp = D(si + 1);
          const sp2 = D(si + 2);
          acc[0] += -llr[sp] - llr[sp2];
          acc[1] += -llr[sp] - llr[sp2];
          acc[2] += llr[sp] - llr[sp2];
          acc[3] += llr[sp] - llr[sp2];
          si += 3;
          break;
        }
        case 15: {
          sp = D(si + 1);
          const sp2 = D(si + 2);
          const sp3 = D(si + 3);
          acc[0] += -llr[sp] - llr[sp2] - llr[sp3];
          acc[1] += -llr[sp] - llr[sp2] + llr[sp3];
          acc[2] += llr[sp] - llr[sp2] - llr[sp3];
          acc[3] += llr[sp] - llr[sp2] + llr[sp3];
          si += 4;
          break;
        }
        default:
          si++;
      }
      pi += pp[pi + 1];
      acc[7] = -acc[0];
      acc[6] = -acc[1];
      acc[5] = -acc[2];
      acc[4] = -acc[3];
      for (let bf = 0; bf < NOOFBF; bf++) {
        const m1 = old[bf];
        const m2 = old[bf + NOOFBF];
        const inc = acc[T.CODER_OUTPUT[bf]];
        let a = m1 + inc;
        let b = m2 - inc;
        if (b > a) {
          neu[2 * bf] = b;
          path[pri + 2 * bf] = 1;
        } else {
          neu[2 * bf] = a;
          path[pri + 2 * bf] = 0;
        }
        a = m1 - inc;
        b = m2 + inc;
        if (b > a) {
          neu[2 * bf + 1] = b;
          path[pri + 2 * bf + 1] = 1;
        } else {
          neu[2 * bf + 1] = a;
          path[pri + 2 * bf + 1] = 0;
        }
      }
      pri += STATES;
      const tmp = old;
      old = neu;
      neu = tmp;
    }
    if (part === 0) {
      pp = p2;
      pi = 1;
      N_Part = N - N_tail;
    } else {
      pp = p3;
      pi = 1;
      N_Part = N;
    }
  }
  // trace back
  let state = 0;
  si = N - 1;
  let info = L - 1;
  N_Part = N - N_tail;
  pri -= STATES;
  pp = p3;
  pi = 1 - p3[0];
  const set = (k, bit) => {
    const at = cwOff + D(k);
    cwout[at] = (cwout[at] & ~(1 << bitpos)) | (bit << bitpos);
  };
  for (let part = 2; part >= 0; part--) {
    while (si >= N_Part) {
      infoout[infoOff + info] = state & 1;
      info--;
      const sel = path[pri + state];
      const mask = -((state & 1) ^ sel);
      state = (state >> 1) | (sel * NOOFBF);
      const codebits = T.CODER_OUTPUT[state & ~NOOFBF] ^ mask;
      switch (pp[pi]) {
        case 3:
          set(si, (codebits & 2) >> 1);
          si -= 2;
          break;
        case 5:
          set(si, (codebits & 4) >> 2);
          si -= 2;
          break;
        case 7:
          set(si, (codebits & 4) >> 2);
          set(si - 1, (codebits & 2) >> 1);
          si -= 3;
          break;
        case 15:
          set(si, codebits & 1);
          set(si - 1, (codebits & 4) >> 2);
          set(si - 2, (codebits & 2) >> 1);
          si -= 4;
          break;
        default:
          si--;
      }
      set(si + 1, codebits & 1);
      pri -= STATES;
      pi -= pp[pi - 1];
    }
    if (part === 2) {
      pp = p2;
      pi = 1 - p2[0];
      N_Part = N_PartA;
    } else {
      pp = p1;
      pi = 1 - p1[0];
      N_Part = 0;
    }
  }
}

/**
 * Multilevel decoding with iterated hard decisions (msdhardfac.cpp and
 * msdhardmsc.cpp, which differ only in their tail puncturing): standard
 * mapping only, no hierarchical modulation, no very strongly protected
 * part, part A empty (N1 = 0), as HamDRM sends.
 * @param {number} levels 1 (4-QAM), 2 (16-QAM) or 3 (64-QAM)
 * @param {number[]} L2 information bits per level
 * @param {number[]} PL2 protection level (puncturing pattern) per level
 * @param {boolean} msc false for the FAC (no tail puncturing)
 * @returns {{bits: Uint8Array, noise: Float64Array}} decoded bits with energy dispersal removed, and the noise per cell
 */
function msdHard(re, im, N, snr, levels, L2, PL2, dint, maxiter, msc, mem) {
  const metric = levels === 3 ? T.partitioning[0] : levels === 2 ? T.partitioning[2] : T.partitioning[3];
  const rp = [];
  for (let l = 0; l < levels; l++) {
    const ry = T.RY[PL2[l]];
    rp.push(msc ? 2 * N - 12 - ry * Math.trunc((2 * N - 12) / ry) : -12);
  }
  const tailFirst = (l) => (msc ? T.tailpuncturing[rp[l]] : T.tailpuncturing[rp[l] + 12]);
  const NN = 2 * N;
  const llr = new Float64Array(NN);
  const hard = new Uint8Array(NN);
  const last = new Uint8Array(NN);
  const info = levels > 0 ? L2.map((l) => new Uint8Array(l + 6)) : [];
  if (!mem.path || mem.path.length < NN * STATES) mem.path = new Uint8Array(NN * STATES);
  const p0 = T.puncturing[0];

  const decodeLevel = (level, first) => {
    for (let si = 0; si < NN; si++) {
      const sample = si & 1 ? im[si >> 1] : re[si >> 1];
      let c0;
      let c1;
      if (first) {
        c0 = Math.abs(sample - metric[hard[si]]);
        for (let sub = 1 << (level + 1); sub < 1 << levels; sub += 1 << (level + 1)) c0 = Math.min(c0, Math.abs(sample - metric[hard[si] + sub]));
        c1 = Math.abs(sample - metric[hard[si] + (1 << level)]);
        for (let sub = 3 << level; sub < 1 << levels; sub += 1 << (level + 1)) c1 = Math.min(c1, Math.abs(sample - metric[hard[si] + sub]));
      } else {
        c0 = Math.abs(sample - metric[hard[si] & ~(1 << level)]);
        c1 = Math.abs(sample - metric[hard[si] | (1 << level)]);
      }
      llr[si] = (c0 - c1) * snr[si >> 1];
    }
    // QSSTV's first pass and its iterations differ in the tail pattern they use for the FAC; the FAC has no tail, so it makes no difference.
    const p3 = first ? tailFirst(level) : msc ? T.tailpuncturing[rp[level]] : T.tailpuncturing[0];
    viterbiDecode(llr, NN, 0, p0, T.puncturing[PL2[level]], p3, info[level], 0, hard, 0, level, dint, NN * level, L2[level] + 6, rp[level] + 12, mem);
  };

  for (let level = 0; level < levels; level++) decodeLevel(level, true);
  const cmpLen = Math.trunc(NN / 4) * 4; // QSSTV compares whole ints
  for (let it = 0; it < maxiter; it++) {
    last.set(hard);
    let diff = true;
    for (let level = 0; level < levels; level++) {
      decodeLevel(level, false);
      if (level === 0) {
        diff = false;
        for (let k = 0; k < cmpLen; k++) {
          if (hard[k] !== last[k]) {
            diff = true;
            break;
          }
        }
        if (!diff) break;
      }
    }
    if (!diff) break;
  }

  // energy dispersal
  let total = 0;
  for (let l = 0; l < levels; l++) total += L2[l];
  const bits = new Uint8Array(total);
  let reg = 511;
  let n = 0;
  for (let l = 0; l < levels; l++) {
    for (let m = 0; m < L2[l]; m++) {
      bits[n++] = info[l][m] ^ ((reg ^ (reg >> 4)) & 1);
      reg = (((reg ^ (reg >> 4)) & 1) << 8) | (reg >> 1);
    }
  }
  const noise = new Float64Array(2 * N);
  for (let k = 0; k < N; k++) {
    noise[2 * k] = re[k] - metric[hard[2 * k]];
    noise[2 * k + 1] = im[k] - metric[hard[2 * k + 1]];
  }
  return { bits, noise };
}

/** CRC-8 of the FAC (crc8_c.cpp): 0 when the bits (with the CRC inverted) are good. */
function crc8(bits, n) {
  let b = 0xff;
  for (let i = 0; i < n; i++) {
    const y = ((b >> 7) + bits[i]) & 1;
    b = y === 1 ? ((b << 1) ^ 0x1d) & 0xff : (b << 1) & 0xff;
  }
  return b & 0xff;
}

const facChar = (bits, at) => {
  let c = 0;
  for (let i = 0; i < 7; i++) c = (c << 1) | bits[at + i];
  return c;
};

class ChannelDecoder {
  constructor(g) {
    this.g = g;
    this.FAC_Deinterleaver = deinterleaver(0, 1, 90, 21);
    this.mem = { m1: new Float64Array(STATES), m2: new Float64Array(STATES), acc: new Float64Array(8), path: null };
    this.init();
  }

  init() {
    const g = this.g;
    g.transmission_frame_buffer_wptr = 0;
    this.frame_index = 1;
    this.enough_frames = 0;
    this.frame_count = 0;
    this.msc_parameters_valid = 0;
    this.robustness_mode_old = -1;
    this.msc_mode = -1;
    this.interleaver_depth = -1;
    this.lMSC = 0;
    g.fac_valid = -1;
    this.callChars = new Array(9).fill(0);
    this.identityCount = 0;
    this.callsign = '';
    this.fac = null;
  }

  /** Clears everything after a frame that wasn't good enough (QSSTV's data_valid == 0 branch). */
  _reset() {
    const g = this.g;
    this.frame_index = 1;
    this.enough_frames = 0;
    this.frame_count = 0;
    this.msc_parameters_valid = 0;
    g.transmission_frame_buffer_wptr = 0;
    this.msc_mode = -1;
    this.robustness_mode_old = -1;
    this.interleaver_depth = -1;
    g.fac_valid = -1;
  }

  /**
   * Decodes the frame the demodulator has just equalised.
   * @returns {{bits: Uint8Array}|null} MSC bits when a frame was decoded
   */
  decode() {
    const g = this.g;
    if (g.transmission_frame_buffer_data_valid === 0) {
      this._reset();
      return null;
    }
    const mode = g.robustness_mode;
    const Tu = T.Tu_list[mode];
    const spf = g.symbols_per_frame;
    const tfb = g.transmission_frame_buffer;
    const ctf = g.channel_transfer_function_buffer;
    const frameLen = Tu * spf;
    let result = null;

    if (mode !== this.robustness_mode_old) {
      g.FAC_cells_k = T.mkfacmap(mode, g.K_dc, g.K_modulo);
      g.lFAC = g.FAC_cells_k.length;
    }
    // FAC
    g.fac_valid = 1;
    const lFAC = g.lFAC;
    const re = new Float64Array(lFAC);
    const im = new Float64Array(lFAC);
    const snr = new Float64Array(lFAC);
    for (let i = 0; i < lFAC; i++) {
      const p = (this.frame_index - 1) * frameLen + g.FAC_cells_k[i];
      re[i] = tfb[2 * p];
      im[i] = tfb[2 * p + 1];
      snr[i] = Math.hypot(ctf[2 * p], ctf[2 * p + 1]);
    }
    re[9] = 0; // as QSSTV
    im[9] = 0;
    const fac = msdHard(re, im, lFAC, snr, 1, [48], [6], this.FAC_Deinterleaver, 4, false, this.mem).bits;
    const block = Uint8Array.from(fac);
    for (let i = 40; i < 48; i++) block[i] = 1 - fac[i];
    if (crc8(block, 48) !== 0) {
      g.spectrum_occupancy = -1;
      g.fac_valid = 0;
      this.identityCount = 0;
      this.msc_parameters_valid = 0;
      this.fac = null;
      return null; // as QSSTV: the next frame goes in the same place
    }
    this.msc_parameters_valid = 1;
    // frame alignment within the superframe
    const identity = (2 * fac[0] + fac[1]) % 3;
    if (identity !== (this.frame_index - 1) % 3) {
      const old = g.transmission_frame_buffer_wptr;
      const neu = identity * frameLen;
      tfb.copyWithin(2 * neu, 2 * old, 2 * (old + frameLen));
      ctf.copyWithin(2 * neu, 2 * old, 2 * (old + frameLen));
      g.transmission_frame_buffer_wptr = neu;
      this.frame_index = identity + 1;
    }
    const interleaverNew = fac[3];
    let mscModeNew = fac[4];
    if (fac[6] === 1) mscModeNew += 2 * fac[9];
    const soNew = fac[2];
    this.fac = { identity, spectrumOccupancy: soNew, interleaver: interleaverNew, mscMode: mscModeNew, protection: fac[5], dataFlag: fac[6] };
    this.identityCount++;
    this.callChars[3 * identity] = facChar(block, 10);
    this.callChars[3 * identity + 1] = facChar(block, 17);
    this.callChars[3 * identity + 2] = facChar(block, 24);
    if (identity === 2 && this.identityCount >= 3) {
      this.identityCount = 0;
      this.callsign = String.fromCharCode(...this.callChars.filter((c) => c > 0)).trim();
    }

    if (g.spectrum_occupancy !== soNew || this.robustness_mode_old !== mode || this.interleaver_depth !== interleaverNew) {
      g.spectrum_occupancy = soNew;
      this.interleaver_depth = interleaverNew;
      const m = mkmscmap(mode, soNew, interleaverNew, g.K_dc, g.K_modulo);
      this.lMSC = m.N_MUX;
      this.MSC_Demapper = m.demapper;
      this.msc_parameters_changed = true;
    }
    this.robustness_mode_old = mode;

    this.frame_count++;
    if (this.frame_count >= 6 - 4 * this.interleaver_depth) this.enough_frames = 1;
    else if (this.frame_count === 1) {
      this.min_index_equal_samples = g.transmission_frame_buffer_wptr;
      this.max_index_equal_samples = g.transmission_frame_buffer_wptr + frameLen;
    } else {
      this.min_index_equal_samples = Math.min(this.min_index_equal_samples, g.transmission_frame_buffer_wptr);
      this.max_index_equal_samples = Math.max(this.max_index_equal_samples, g.transmission_frame_buffer_wptr + frameLen);
    }
    if (this.msc_mode !== mscModeNew) {
      this.msc_mode = mscModeNew;
      this.msc_parameters_changed = true;
    }
    const plB = fac[5] === 1 ? 1 : 0;

    // MSC
    const N = this.lMSC;
    if (this.msc_parameters_changed || this.plB !== plB) {
      this.msc_parameters_changed = false;
      this.plB = plB;
      this._setUpMsc(mode, soNew, N, plB);
    }
    if (!this.msc) return this._advance(null);
    const dm = this.MSC_Demapper[this.frame_index - 1];
    const mre = new Float64Array(N);
    const mim = new Float64Array(N);
    const msnr = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const p = dm[i];
      mre[i] = tfb[2 * p];
      mim[i] = tfb[2 * p + 1];
      let hr = ctf[2 * p];
      let hi = ctf[2 * p + 1];
      if (!this.enough_frames && (p > this.max_index_equal_samples || p < this.min_index_equal_samples)) hr = hi = 0;
      msnr[i] = Math.hypot(hr, hi);
    }
    const { levels, L2, PL2, dint } = this.msc;
    const out = msdHard(mre, mim, N, msnr, levels, L2, PL2, dint, MSD_ITER, true, this.mem);
    this.lastCells = { re: mre, im: mim, qam: levels };
    if (this.enough_frames) result = { bits: out.bits };
    return this._advance(result);
  }

  _advance(result) {
    const g = this.g;
    const mode = g.robustness_mode;
    const frameLen = T.Tu_list[mode] * g.symbols_per_frame;
    this.frame_index = (this.frame_index % 6) + 1;
    g.transmission_frame_buffer_wptr = (g.transmission_frame_buffer_wptr + frameLen) % (frameLen * 6);
    return result;
  }

  _setUpMsc(mode, so, N, plB) {
    const RatesSM16 = [
      [3, 8],
      [5, 10],
    ];
    const RatesSM64 = [
      [1, 5, 10],
      [3, 8, 11],
      [5, 10, 12],
      [8, 11, 13],
    ];
    const NN = 2 * N;
    this.msc = null;
    if (this.msc_mode === 0) {
      // 64-QAM
      const rates = RatesSM64[plB].map((r) => r - 1);
      const dint = new Int32Array(3 * NN);
      for (let i = 0; i < NN; i++) dint[i] = i;
      dint.set(deinterleaver(0, 13, NN, 13), NN);
      dint.set(deinterleaver(0, 21, NN, 21), 2 * NN);
      this.msc = { levels: 3, L2: rates.map((r) => T.RX[r] * Math.floor((NN - 12) / T.RY[r])), PL2: rates, dint };
    } else if (this.msc_mode === 1) {
      // 16-QAM
      const rates = RatesSM16[plB].map((r) => r - 1);
      const dint = new Int32Array(2 * NN);
      dint.set(deinterleaver(0, 13, NN, 13), 0);
      dint.set(deinterleaver(0, 21, NN, 21), NN);
      this.msc = { levels: 2, L2: rates.map((r) => T.RX[r] * Math.floor((NN - 12) / T.RY[r])), PL2: rates, dint };
    } else if (this.msc_mode === 3) {
      // 4-QAM: QSSTV uses fixed lengths and rate 3/5 (protection level 6)
      const L = [
        [768, 837],
        [537, 627],
        [399, 435],
      ][mode];
      if (!L) return;
      this.msc = { levels: 1, L2: [L[so]], PL2: [6], dint: deinterleaver(0, 21, NN, 21) };
    }
  }
}

module.exports = { ChannelDecoder, deinterleaver, mkmscmap, msdHard, viterbiDecode, crc8 };
