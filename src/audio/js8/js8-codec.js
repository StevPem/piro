'use strict';

/**
 * JS8 frame coding: the 87-bit frame (twelve 6-bit characters, a 3-bit
 * frame type and a 12-bit CRC), its LDPC (174,87) code, the 79 tones, and
 * the belief-propagation decoder.
 *
 * Ported from JS8Call-improved (JS8_Mode/JS8.cpp: encode(), CRC12(),
 * checkCRC12(), extractmessage174(), bpdecode174(); JS8_Mode/bp_math.h;
 * JS8_Mode/ldpc_feedback.h), GPL-3.0. The code tables are JS8Call's, which
 * came from WSJT-X's original FT8 (174,87) code (ldpc_174_87_params.f90).
 * See third_party/js8call/README.md.
 */

const N = 174; // codeword bits
const K = 87; // message bits (75 + CRC-12)
const M = N - K; // checks
const NN = 79; // channel symbols
const ND = 58; // data symbols

/** The 64 characters a frame is written in (6 bits each). */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+';
const WORD = new Map([...ALPHABET].map((c, i) => [c, i]));

/**
 * The three 7x7 Costas arrays at symbols 0, 36 and 72. Normal speed uses
 * the original arrays (three the same); the faster speeds the modified set.
 */
const COSTAS_ORIGINAL = [
  [4, 2, 5, 6, 1, 3, 0],
  [4, 2, 5, 6, 1, 3, 0],
  [4, 2, 5, 6, 1, 3, 0],
];
const COSTAS_MODIFIED = [
  [0, 6, 2, 3, 5, 4, 1],
  [1, 5, 0, 2, 3, 6, 4],
  [2, 5, 0, 6, 4, 1, 3],
];

// Mn: the three checks each codeword bit takes part in.
const Mn = [
  [0, 24, 68], [1, 4, 72], [2, 31, 67], [3, 50, 60], [5, 62, 69], [6, 32, 78], [7, 49, 85], [8, 36, 42], [9, 40, 64], [10, 13, 63],
  [11, 74, 76], [12, 22, 80], [14, 15, 81], [16, 55, 65], [17, 52, 59], [18, 30, 51], [19, 66, 83], [20, 28, 71], [21, 23, 43], [25, 34, 75],
  [26, 35, 37], [27, 39, 41], [29, 53, 54], [33, 48, 86], [38, 56, 57], [44, 73, 82], [45, 61, 79], [46, 47, 84], [58, 70, 77], [0, 49, 52],
  [1, 46, 83], [2, 24, 78], [3, 5, 13], [4, 6, 79], [7, 33, 54], [8, 35, 68], [9, 42, 82], [10, 22, 73], [11, 16, 43], [12, 56, 75],
  [14, 26, 55], [15, 27, 28], [17, 18, 58], [19, 39, 62], [20, 34, 51], [21, 53, 63], [23, 61, 77], [25, 31, 76], [29, 71, 84], [30, 64, 86],
  [32, 38, 50], [36, 47, 74], [37, 69, 70], [40, 41, 67], [44, 66, 85], [45, 80, 81], [48, 65, 72], [57, 59, 65], [60, 64, 84], [0, 13, 20],
  [1, 12, 58], [2, 66, 81], [3, 31, 72], [4, 35, 53], [5, 42, 45], [6, 27, 74], [7, 32, 70], [8, 48, 75], [9, 57, 63], [10, 47, 67],
  [11, 18, 44], [14, 49, 60], [15, 21, 25], [16, 71, 79], [17, 39, 54], [19, 34, 50], [22, 24, 33], [23, 62, 86], [26, 38, 73], [28, 77, 82],
  [29, 69, 76], [30, 68, 83], [21, 36, 85], [37, 40, 80], [41, 43, 56], [46, 52, 61], [51, 55, 78], [59, 74, 80], [0, 38, 76], [1, 15, 40],
  [2, 30, 53], [3, 35, 77], [4, 44, 64], [5, 56, 84], [6, 13, 48], [7, 20, 45], [8, 14, 71], [9, 19, 61], [10, 16, 70], [11, 33, 46],
  [12, 67, 85], [17, 22, 42], [18, 63, 72], [23, 47, 78], [24, 69, 82], [25, 79, 86], [26, 31, 39], [27, 55, 68], [28, 62, 65], [29, 41, 49],
  [32, 36, 81], [34, 59, 73], [37, 54, 83], [43, 51, 60], [50, 52, 71], [57, 58, 66], [46, 55, 75], [0, 18, 36], [1, 60, 74], [2, 7, 65],
  [3, 59, 83], [4, 33, 38], [5, 25, 52], [6, 31, 56], [8, 51, 66], [9, 11, 14], [10, 50, 68], [12, 13, 64], [15, 30, 42], [16, 19, 35],
  [17, 79, 85], [20, 47, 58], [21, 39, 45], [22, 32, 61], [23, 29, 73], [24, 41, 63], [26, 48, 84], [27, 37, 72], [28, 43, 80], [34, 67, 69],
  [40, 62, 75], [44, 48, 70], [49, 57, 86], [47, 53, 82], [12, 54, 78], [76, 77, 81], [0, 1, 23], [2, 5, 74], [3, 55, 86], [4, 43, 52],
  [6, 49, 82], [7, 9, 27], [8, 54, 61], [10, 28, 66], [11, 32, 39], [13, 15, 19], [14, 34, 72], [16, 30, 38], [17, 35, 56], [18, 45, 75],
  [20, 41, 83], [21, 33, 58], [22, 25, 60], [24, 59, 64], [26, 63, 79], [29, 36, 65], [31, 44, 71], [37, 50, 85], [40, 76, 78], [42, 55, 67],
  [46, 73, 81], [39, 51, 77], [53, 60, 70], [45, 57, 68],
];

// Nm: the bits in each check (6 or 7), in bit order.
const Nm = Array.from({ length: M }, () => []);
for (let bit = 0; bit < N; bit++) for (const check of Mn[bit]) Nm[check].push(bit);
// For each edge (check i, slot j), which of its bit's three checks it is.
const NmSlot = Nm.map((bits, i) => bits.map((bit) => Mn[bit].indexOf(i)));

// The generator: row i (87 hex-coded bits) says which message bits sum,
// modulo 2, to parity bit i.
const GENERATOR_HEX = [
  '23bba830e23b6b6f50982e', '1f8e55da218c5df3309052',
  'ca7b3217cd92bd59a5ae20', '56f78313537d0f4382964e',
  '6be396b5e2e819e373340c', '293548a138858328af4210',
  'cb6c6afcdc28bb3f7c6e86', '3f2a86f5c5bd225c961150',
  '849dd2d63673481860f62c', '56cdaec6e7ae14b43feeee',
  '04ef5cfa3766ba778f45a4', 'c525ae4bd4f627320a3974',
  '41fd9520b2e4abeb2f989c', '7fb36c24085a34d8c1dbc4',
  '40fc3e44bb7d2bb2756e44', 'd38ab0a1d2e52a8ec3bc76',
  '3d0f929ef3949bd84d4734', '45d3814f504064f80549ae',
  'f14dbf263825d0bd04b05e', 'db714f8f64e8ac7af1a76e',
  '8d0274de71e7c1a8055eb0', '51f81573dd4049b082de14',
  'd8f937f31822e57c562370', 'b6537f417e61d1a7085336',
  'ecbd7c73b9cd34c3720c8a', '3d188ea477f6fa41317a4e',
  '1ac4672b549cd6dba79bcc', 'a377253773ea678367c3f6',
  '0dbd816fba1543f721dc72', 'ca4186dd44c3121565cf5c',
  '29c29dba9c545e267762fe', '1616d78018d0b4745ca0f2',
  'fe37802941d66dde02b99c', 'a9fa8e50bcb032c85e3304',
  '83f640f1a48a8ebc0443ea', '3776af54ccfbae916afde6',
  'a8fc906976c35669e79ce0', 'f08a91fb2e1f78290619a8',
  'cc9da55fe046d0cb3a770c', 'd36d662a69ae24b74dcbd8',
  '40907b01280f03c0323946', 'd037db825175d851f3af00',
  '1bf1490607c54032660ede', '0af7723161ec223080be86',
  'eca9afa0f6b01d92305edc', '7a8dec79a51e8ac5388022',
  '9059dfa2bb20ef7ef73ad4', '6abb212d9739dfc02580f2',
  'f6ad4824b87c80ebfce466', 'd747bfc5fd65ef70fbd9bc',
  '612f63acc025b6ab476f7c', '05209a0abb530b9e7e34b0',
  '45b7ab6242b77474d9f11a', '6c280d2a0523d9c4bc5946',
  'f1627701a2d692fd9449e6', '8d9071b7e7a6a2eed6965e',
  'bf4f56e073271f6ab4bf80', 'c0fc3ec4fb7d2bb2756644',
  '57da6d13cb96a7689b2790', 'a9fa2eefa6f8796a355772',
  '164cc861bdd803c547f2ac', 'cc6de59755420925f90ed2',
  'a0c0033a52ab6299802fd2', 'b274db8abd3c6f396ea356',
  '97d4169cb33e7435718d90', '81cfc6f18c35b1e1f17114',
  '481a2a0df8a23583f82d6c', '081c29a10d468ccdbcecb6',
  '2c4142bf42b01e71076acc', 'a6573f3dc8b16c9d19f746',
  'c87af9a5d5206abca532a8', '012dee2198eba82b19a1da',
  'b1ca4ea2e3d173bad4379c', 'b33ec97be83ce413f9acc8',
  '5b0f7742bca86b8012609a', '37d8e0af9258b9e8c5f9b2',
  '35ad3fb0faeb5f1b0c30dc', '6114e08483043fd3f38a8a',
  'cd921fdf59e882683763f6', '95e45ecd0135aca9d6e6ae',
  '2e547dd7a05f6597aac516', '14cd0f642fc0c5fe3a65ca',
  '3a0a1dfd7eee29c2e827e0', 'c8b5dffc335095dcdcaf2a',
  '3dd01a59d86310743ec752', '8abdb889efbe39a510a118',
  '3f231f212055371cf3e2a2',
];
const GENERATOR = GENERATOR_HEX.map((hex) => {
  const row = new Uint8Array(K);
  for (let col = 0; col < K; col++) {
    const nibble = parseInt(hex[col >> 2], 16);
    row[col] = (nibble >> (3 - (col & 3))) & 1;
  }
  return row;
});

/** boost::augmented_crc<12, 0xc06> over whole bytes, then ^ 42 (JS8's change from FT8 1.x). */
function crc12(bytes) {
  let rem = 0;
  for (const byte of bytes) {
    for (let b = 7; b >= 0; b--) {
      const top = (rem >> 11) & 1;
      rem = ((rem << 1) | ((byte >> b) & 1)) & 0xfff;
      if (top) rem ^= 0xc06;
    }
  }
  return rem ^ 42;
}

/** The 87 message bits for a 12-character frame and its 3-bit type, CRC included. */
function frameBits(frame, type) {
  if (typeof frame !== 'string' || frame.length !== 12) throw new Error('A JS8 frame is 12 characters');
  const bytes = new Uint8Array(11);
  for (let i = 0, j = 0; i < 12; i += 4, j += 3) {
    let words = 0;
    for (let k = 0; k < 4; k++) {
      const w = WORD.get(frame[i + k]);
      if (w === undefined) throw new Error(`Invalid character in JS8 frame: ${frame[i + k]}`);
      words = words * 64 + w;
    }
    bytes[j] = (words >> 16) & 0xff;
    bytes[j + 1] = (words >> 8) & 0xff;
    bytes[j + 2] = words & 0xff;
  }
  bytes[9] = (type & 7) << 5;
  const crc = crc12(bytes);
  bytes[9] |= (crc >> 7) & 0x1f;
  bytes[10] = (crc & 0x7f) << 1;
  const bits = new Uint8Array(K);
  for (let i = 0; i < K; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return bits;
}

/** The 174-bit codeword: 87 parity bits, then the 87 message bits. */
function encodeCodeword(messageBits) {
  const cw = new Uint8Array(N);
  for (let i = 0; i < K; i++) {
    let sum = 0;
    const row = GENERATOR[i];
    for (let j = 0; j < K; j++) sum += row[j] & messageBits[j];
    cw[i] = sum & 1;
    cw[K + i] = messageBits[i];
  }
  return cw;
}

/**
 * The 79 tones (0-7) for a frame: Costas, 29 parity symbols, Costas, 29
 * message symbols, Costas. Three bits a tone, most significant first.
 */
function encodeTones(frame, type, costas = COSTAS_ORIGINAL) {
  const cw = encodeCodeword(frameBits(frame, type));
  const tones = new Array(NN);
  for (let b = 0; b < 3; b++) for (let i = 0; i < 7; i++) tones[b * 36 + i] = costas[b][i];
  for (let j = 0; j < 29; j++) {
    tones[7 + j] = (cw[3 * j] << 2) | (cw[3 * j + 1] << 1) | cw[3 * j + 2];
    tones[43 + j] = (cw[K + 3 * j] << 2) | (cw[K + 3 * j + 1] << 1) | cw[K + 3 * j + 2];
  }
  return tones;
}

/** True if 87 decoded bits carry a good CRC. */
function checkCrc12(decoded) {
  const bytes = new Uint8Array(11);
  for (let i = 0; i < K; i++) if (decoded[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  const crc = ((bytes[9] & 0x1f) << 7) | (bytes[10] >> 1);
  bytes[9] &= 0xe0;
  bytes[10] = 0;
  return crc === crc12(bytes);
}

/** The 12 characters from 87 decoded bits (the CRC already checked). */
function extractFrame(decoded) {
  let s = '';
  for (let i = 0; i < 12; i++) {
    let w = 0;
    for (let b = 0; b < 6; b++) w = (w << 1) | decoded[i * 6 + b];
    s += ALPHABET[w];
  }
  return s;
}

/** The frame type bits (first/last/data flags) from 87 decoded bits. */
function frameType(decoded) {
  return (decoded[72] << 2) | (decoded[73] << 1) | decoded[74];
}

const FLT_EPSILON = 1.1920928955078125e-7;
const BP_MAX_ITERATIONS = 30;

/**
 * Belief-propagation decoding of 174 LLRs (positive means 1). Returns
 * {decoded, cw, hardErrors}: on success `decoded` is the 87 message bits
 * and hardErrors the number of LLRs the codeword disagrees with; on
 * failure hardErrors is -1 and `cw` the last iteration's hard decisions.
 */
function bpDecode(llr, { maxIterations = BP_MAX_ITERATIONS } = {}) {
  const scaled = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const v = llr[i];
    scaled[i] = Number.isNaN(v) ? 0 : Math.max(-8, Math.min(8, v));
  }
  const tov = Array.from({ length: N }, () => new Float64Array(3));
  const toc = Nm.map((bits) => Float64Array.from(bits, (b) => scaled[b]));
  const tanhtoc = Nm.map((bits) => new Float64Array(bits.length));
  const zn = new Float64Array(N);
  const cw = new Uint8Array(N);
  let ncnt = 0;
  let nclast = 0;
  const limit = 1 - FLT_EPSILON;
  for (let iter = 0; iter <= maxIterations; iter++) {
    for (let i = 0; i < N; i++) {
      zn[i] = scaled[i] + tov[i][0] + tov[i][1] + tov[i][2];
      cw[i] = zn[i] > 0 ? 1 : 0;
    }
    let ncheck = 0;
    for (let i = 0; i < M; i++) {
      let synd = 0;
      for (const b of Nm[i]) synd += cw[b];
      if (synd & 1) ncheck++;
    }
    if (ncheck === 0) {
      let hardErrors = 0;
      for (let i = 0; i < N; i++) if ((2 * cw[i] - 1) * llr[i] < 0) hardErrors++;
      return { decoded: cw.slice(M), cw, hardErrors };
    }
    if (iter > 0) {
      const nd = ncheck - nclast;
      ncnt = nd < 0 ? 0 : ncnt + 1;
      if (ncnt >= 5 && iter >= 10 && ncheck > 15) break;
    }
    nclast = ncheck;
    for (let i = 0; i < M; i++) {
      const bits = Nm[i];
      const slots = NmSlot[i];
      for (let j = 0; j < bits.length; j++) {
        toc[i][j] = zn[bits[j]] - tov[bits[j]][slots[j]];
        tanhtoc[i][j] = Math.tanh(-toc[i][j] / 2);
      }
    }
    for (let i = 0; i < M; i++) {
      const bits = Nm[i];
      const slots = NmSlot[i];
      const t = tanhtoc[i];
      for (let edge = 0; edge < bits.length; edge++) {
        let prod = 1;
        for (let k = 0; k < bits.length; k++) if (k !== edge) prod *= t[k];
        const p = Math.max(-limit, Math.min(limit, prod));
        tov[bits[edge]][slots[edge]] = 2 * Math.atanh(-p);
      }
    }
  }
  return { decoded: null, cw, hardErrors: -1 };
}

/**
 * JS8Call's LDPC feedback: after a failed pass, firm up the LLRs that the
 * last iteration agrees with strongly and soften the doubtful ones.
 */
function refineLlrs(llr, cw) {
  const out = Float64Array.from(llr);
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (!Number.isFinite(v)) {
      out[i] = 0;
      continue;
    }
    const one = cw[i] !== 0;
    const mag = Math.abs(v);
    const match = v >= 0 === one;
    if (match && mag >= 3) {
      const boosted = Math.min(6, mag * 1.2);
      out[i] = one ? boosted : -boosted;
    } else if (!match || mag <= 1) {
      const shrunk = mag * 0.5;
      out[i] = one ? shrunk : -shrunk;
    }
  }
  return out;
}

module.exports = {
  N,
  K,
  M,
  NN,
  ND,
  ALPHABET,
  COSTAS_ORIGINAL,
  COSTAS_MODIFIED,
  Mn,
  Nm,
  crc12,
  frameBits,
  encodeCodeword,
  encodeTones,
  checkCrc12,
  extractFrame,
  frameType,
  bpDecode,
  refineLlrs,
};
