'use strict';

/**
 * JTTY forward-error-correction decoder: list WAVA decoding of the
 * tail-biting rate-1/2 K=10 convolutional code, with the CRC-12 and the
 * reserved-zero bit as the acceptance test.
 *
 * A port of lib/jtty/jtty_tbcc_decoder.f90 (the L1 -> L2 -> L4 coherence
 * ladder, then a half-symbol energy fallback) and of the reference path of
 * lib/jtty/jtty_tbcc_list_decoder.f90 (jtty_tbcc_list_wava_reference) from
 * WSJT-X (GPL-3.0, (c) the WSJT Development Group); see
 * third_party/jtty/README.md. Retaining the same survivor, de-duplication
 * and ordering rules keeps the accept/reject decisions the same as the
 * reference receiver's.
 *
 * Input is, per frame, the 46 coded symbols' correlations with each of the
 * four tones: zRe/zIm[tone * 46 + symbol].
 */

const INFO_BITS = 46;
const PAYLOAD_BITS = 34;
const RESERVED_BIT = 33; // 1-based, always transmitted as 0
const MEMORY = 9;
const STATE_COUNT = 1 << MEMORY; // 512
const REGISTER_MASK = (1 << (MEMORY + 1)) - 1;
const G0 = parseInt('1167', 8);
const G1 = parseInt('1545', 8);
const CRC_POLY = 0x80f;
const CRC_TOP = 0x800;
const CRC_MASK = 0xfff;
const CRC_BITS = 12;

const WIDTH = 4; // survivors kept per trellis state ("P4")
const WRAPS = 2;
const HYPOTHESES = 4; // candidates handed to the CRC test ("H4")
const COHERENT_LENGTHS = [1, 2, 4];

function parity(v) {
  let x = v;
  let p = 0;
  while (x) {
    p ^= x & 1;
    x >>>= 1;
  }
  return p;
}

// state, input bit -> next state and tone (shared by every plan)
const NEXT_STATE = new Int32Array(STATE_COUNT * 2);
const TONE = new Int32Array(STATE_COUNT * 2);
for (let s = 0; s < STATE_COUNT; s++) {
  for (let bit = 0; bit < 2; bit++) {
    const reg = ((s << 1) | bit) & REGISTER_MASK;
    const b0 = parity(reg & G0);
    const b1 = parity(reg & G1);
    NEXT_STATE[s * 2 + bit] = reg & (STATE_COUNT - 1);
    TONE[s * 2 + bit] = 2 * b0 + (b0 ^ b1);
  }
}

/** Per-coherent-length trellis geometry (built once, shared by all decodes). */
function buildPlan(L) {
  const blocks = [];
  for (let start = 1; start <= INFO_BITS; start += L) {
    const len = Math.min(L, INFO_BITS - start + 1);
    const branches = 1 << len;
    const endState = new Int32Array(STATE_COUNT * branches);
    const toneWord = new Int32Array(STATE_COUNT * branches);
    for (let s = 0; s < STATE_COUNT; s++) {
      for (let w = 0; w < branches; w++) {
        let state = s;
        let word = 0;
        for (let k = 0; k < len; k++) {
          const bit = (w >> (len - 1 - k)) & 1;
          word = word * 4 + TONE[state * 2 + bit];
          state = NEXT_STATE[state * 2 + bit];
        }
        endState[s * branches + w] = state;
        toneWord[s * branches + w] = word;
      }
    }
    const containsReserved = start <= RESERVED_BIT && start + len > RESERVED_BIT;
    blocks.push({ start, len, branches, endState, toneWord, containsReserved, energies: new Float64Array(1 << (2 * len)) });
  }
  return { L, blocks };
}
const PLANS = new Map(COHERENT_LENGTHS.map((L) => [L, buildPlan(L)]));

/** |sum of the chosen tones' correlations|^2 / n for every tone sequence of every block. */
function precomputeEnergies(plan, zRe, zIm) {
  for (const blk of plan.blocks) {
    const count = 1 << (2 * blk.len);
    for (let word = 0; word < count; word++) {
      let re = 0;
      let im = 0;
      for (let k = 0; k < blk.len; k++) {
        const tone = (word >> (2 * (blk.len - 1 - k))) & 3;
        const idx = tone * INFO_BITS + (blk.start - 1 + k);
        re += zRe[idx];
        im += zIm[idx];
      }
      blk.energies[word] = (re * re + im * im) / blk.len;
    }
  }
}

function crcValid(bits) {
  let reg = 0;
  for (let i = 0; i < INFO_BITS; i++) {
    reg ^= bits[i] << (CRC_BITS - 1);
    reg = reg & CRC_TOP ? (reg << 1) ^ CRC_POLY : reg << 1;
    reg &= CRC_MASK;
  }
  return reg === 0;
}

const POW2 = new Float64Array(INFO_BITS + 1);
for (let i = 0; i <= INFO_BITS; i++) POW2[i] = 2 ** i;

/**
 * Runs the list WAVA decoder for one coherent length. Returns up to
 * HYPOTHESES candidates {bits, cleanMetric, wavaMetric, startState, crcOk},
 * best first.
 *
 * A survivor's input bits are kept as one exact number (bit k, 1-based, has
 * weight 2^(46-k); bits not yet decided are zero), so "same prefix" is key
 * equality and the reference's lexicographic tie-break is plain numeric order.
 */
function listWava(plan, zRe, zIm, pruneReserved) {
  precomputeEnergies(plan, zRe, zIm);
  const W = WIDTH;
  const slots = STATE_COUNT * W;
  let prev = { metric: new Float64Array(slots), origin: new Int16Array(slots), key: new Float64Array(slots), cnt: new Uint8Array(STATE_COUNT) };
  let cur = { metric: new Float64Array(slots), origin: new Int16Array(slots), key: new Float64Array(slots), cnt: new Uint8Array(STATE_COUNT) };

  for (let s = 0; s < STATE_COUNT; s++) {
    prev.cnt[s] = 1;
    prev.metric[s * W] = 0;
    prev.origin[s * W] = s;
    prev.key[s * W] = 0;
  }

  for (let wrap = 0; wrap < WRAPS; wrap++) {
    // reset_frame_identity: forget origins and bits, keep the metrics
    for (let s = 0; s < STATE_COUNT; s++) {
      for (let r = 0; r < prev.cnt[s]; r++) {
        prev.origin[s * W + r] = s;
        prev.key[s * W + r] = 0;
      }
    }

    for (const blk of plan.blocks) {
      const { start, len, branches, endState, toneWord, energies, containsReserved } = blk;
      const scale = POW2[INFO_BITS - (start + len - 1)];
      const cm = cur.metric;
      const co = cur.origin;
      const ck = cur.key;
      const ccnt = cur.cnt;
      ccnt.fill(0);
      const resBitPos = RESERVED_BIT - start; // 0-based position inside the block
      const pm = prev.metric;
      const po = prev.origin;
      const pk = prev.key;
      for (let s = 0; s < STATE_COUNT; s++) {
        const nPrev = prev.cnt[s];
        for (let r = 0; r < nPrev; r++) {
          const pslot = s * W + r;
          const metric0 = pm[pslot];
          const org = po[pslot];
          const key0 = pk[pslot];
          for (let w = 0; w < branches; w++) {
            if (pruneReserved && containsReserved && (w >> (len - 1 - resBitPos)) & 1) continue;
            const idx = s * branches + w;
            const end = endState[idx];
            const m = metric0 + energies[toneWord[idx]];
            const n = ccnt[end];
            const base = end * W;
            if (n === W && m < cm[base + W - 1]) continue;
            const key = key0 + w * scale;

            // de-duplicate: same origin and same determined prefix
            let count = n;
            for (let q = 0; q < count; q++) {
              if (co[base + q] === org && ck[base + q] === key) {
                if (m <= cm[base + q]) {
                  count = -1;
                } else {
                  for (let u = q; u < count - 1; u++) {
                    cm[base + u] = cm[base + u + 1];
                    co[base + u] = co[base + u + 1];
                    ck[base + u] = ck[base + u + 1];
                  }
                  count--;
                  ccnt[end] = count;
                }
                break;
              }
            }
            if (count < 0) continue;

            // insertion point: first slot the candidate precedes (metric, then origin, then key)
            let at = count < W ? count : W;
            for (let q = 0; q < count; q++) {
              const sm = cm[base + q];
              if (m > sm || (m === sm && (org < co[base + q] || (org === co[base + q] && key < ck[base + q])))) {
                at = q;
                break;
              }
            }
            if (at >= W) continue;
            const top = count < W ? count : W - 1;
            for (let q = top; q > at; q--) {
              cm[base + q] = cm[base + q - 1];
              co[base + q] = co[base + q - 1];
              ck[base + q] = ck[base + q - 1];
            }
            cm[base + at] = m;
            co[base + at] = org;
            ck[base + at] = key;
            ccnt[end] = count < W ? count + 1 : W;
          }
        }
      }
      const swap = prev;
      prev = cur;
      cur = swap;
    }
  }

  // Closed (tail-biting) survivors only, one entry per distinct word.
  const pool = new Map();
  for (let s = 0; s < STATE_COUNT; s++) {
    for (let r = 0; r < prev.cnt[s]; r++) {
      const slot = s * W + r;
      if (prev.origin[slot] !== s) continue;
      const key = prev.key[slot];
      const wava = prev.metric[slot];
      const found = pool.get(key);
      if (found) {
        if (wava > found.wavaMetric || (!(wava < found.wavaMetric) && s < found.startState)) {
          found.wavaMetric = wava;
          found.startState = s;
        }
        continue;
      }
      const bits = new Uint8Array(INFO_BITS);
      let rest = key;
      for (let i = 0; i < INFO_BITS; i++) {
        const weight = POW2[INFO_BITS - 1 - i];
        if (rest >= weight) {
          bits[i] = 1;
          rest -= weight;
        }
      }
      const clean = scoreWord(plan, bits);
      if (clean === null) continue; // cannot happen for a closed path; ignore defensively
      pool.set(key, { bits, cleanMetric: clean, wavaMetric: wava, startState: s, crcOk: crcValid(bits) });
    }
  }
  const list = Array.from(pool.values());
  list.sort(candidateOrder);
  return list.slice(0, HYPOTHESES);
}

/** Single-frame score of a complete word; null if its path does not close. */
function scoreWord(plan, bits) {
  let state = 0;
  for (let i = INFO_BITS - MEMORY; i < INFO_BITS; i++) state = ((state << 1) | bits[i]) & (STATE_COUNT - 1);
  const start = state;
  let metric = 0;
  for (const blk of plan.blocks) {
    let w = 0;
    for (let k = 0; k < blk.len; k++) w = w * 2 + bits[blk.start - 1 + k];
    const idx = state * blk.branches + w;
    metric += blk.energies[blk.toneWord[idx]];
    state = blk.endState[idx];
  }
  return state === start ? metric : null;
}

// Identity order: bit 1 is the least-significant bit of the 46-bit word.
function compareIdentity(a, b) {
  for (let i = INFO_BITS - 1; i >= 0; i--) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function candidateOrder(a, b) {
  if (a.cleanMetric !== b.cleanMetric) return a.cleanMetric > b.cleanMetric ? -1 : 1;
  const id = compareIdentity(a.bits, b.bits);
  if (id !== 0) return id;
  if (a.startState !== b.startState) return a.startState - b.startState;
  if (a.wavaMetric !== b.wavaMetric) return a.wavaMetric > b.wavaMetric ? -1 : 1;
  return 0;
}

/** First CRC-clean, non-zero candidate of a rung, or null. */
function acceptRung(list) {
  for (const cand of list) {
    if (!cand.crcOk) continue;
    let allZero = true;
    for (let i = 0; i < PAYLOAD_BITS; i++) {
      if (cand.bits[i]) {
        allZero = false;
        break;
      }
    }
    if (allZero) return null; // the all-zero sentinel ends the search
    return cand;
  }
  return null;
}

/**
 * Decodes one frame's 46 coded symbols.
 *
 * @param {Float64Array|Float32Array} zRe - tone correlations, real part, [tone * 46 + symbol]
 * @param {Float64Array|Float32Array} zIm - imaginary part
 * @param {Float64Array|Float32Array} halfEnergy - half-symbol energy envelope sqrt(E), [tone * 46 + symbol]
 * @returns {{success: boolean, payload: number[]|null, rung: number, coherentLength: number}}
 *   payload is the 34 payload bits (0/1) when success.
 */
function tbccDecode(zRe, zIm, halfEnergy) {
  const zero = new Float64Array(INFO_BITS * 4);
  for (let i = 0; i < COHERENT_LENGTHS.length; i++) {
    const L = COHERENT_LENGTHS[i];
    const found = acceptRung(listWava(PLANS.get(L), zRe, zIm, true));
    if (found) return { success: true, payload: Array.from(found.bits.slice(0, PAYLOAD_BITS)), rung: i + 1, coherentLength: L };
  }
  // Half-symbol energies discard phase, so only the L = 1 trellis applies.
  const found = acceptRung(listWava(PLANS.get(1), halfEnergy, zero, true));
  if (found) return { success: true, payload: Array.from(found.bits.slice(0, PAYLOAD_BITS)), rung: 4, coherentLength: 1 };
  return { success: false, payload: null, rung: 0, coherentLength: 0 };
}

module.exports = {
  INFO_BITS,
  PAYLOAD_BITS,
  RESERVED_BIT,
  WIDTH,
  WRAPS,
  HYPOTHESES,
  COHERENT_LENGTHS,
  crcValid,
  listWava,
  tbccDecode,
  PLANS,
};
