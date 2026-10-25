'use strict';

/**
 * HamDRM receiver, demodulator: finds the robustness mode, the frequency
 * offset, the spectrum occupancy and the frame start, then estimates the
 * channel from the pilots with a 2-D Wiener filter and equalises each
 * frame into the transmission frame buffer. Ported from QSSTV's
 * drmrx/demodulator.cpp (M. Bos, PA0MBO, after Andreas Dittrich's diorama;
 * Johan Maes, ON4QZ).
 *
 * Portions copyright (C) 2009 M. Bos (PA0MBO), 2000-2019 Johan Maes (ON4QZ);
 * GPL-2.0-or-later. See third_party/qsstv-drm/README.md.
 */

const T = require('./tables');
const { Dft, getmode, getofdm, OfdmSync, getfoffsint, getsymbolidx } = require('./dsp');

// Bad frames in a row (S/N under 3 dB) before the receiver starts looking
// afresh. QSSTV waits 10 (4 s in mode B), which misses the start of the next
// transmission when one follows another; 3 made no difference on fading tests.
const SNR_TIMEOUT = 3;
const FACVALIDCNTR = 10;
const SNR_MIN_DB = 3;
const MIN_ABS_H = 8.0e-5 * 8.0e-5;
const N_SYMBOLS_MODE_DETECTION = 20;
const N_SYMBOLS_FREQUENCY_PILOT_SEARCH = 15;
const RS_BUFFER = 60000; // complex samples (QSSTV: 40000)
const Tu_A = 288;
const SRO_INIT_LIMIT = 300e-6; // see frequencySync()

/** Solves for the inverse of a symmetric positive matrix (n x n, row-major), by LU decomposition with partial pivoting. */
function invert(a, n) {
  const m = Float64Array.from(a);
  const inv = new Float64Array(n * n);
  for (let i = 0; i < n; i++) inv[i * n + i] = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    let big = Math.abs(m[c * n + c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(m[r * n + c]);
      if (v > big) {
        big = v;
        p = r;
      }
    }
    if (big === 0) m[c * n + c] = 1e-20;
    if (p !== c) {
      for (let k = 0; k < n; k++) {
        let t = m[c * n + k];
        m[c * n + k] = m[p * n + k];
        m[p * n + k] = t;
        t = inv[c * n + k];
        inv[c * n + k] = inv[p * n + k];
        inv[p * n + k] = t;
      }
    }
    const d = 1 / m[c * n + c];
    for (let k = 0; k < n; k++) {
      m[c * n + k] *= d;
      inv[c * n + k] *= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r * n + c];
      if (f === 0) continue;
      for (let k = 0; k < n; k++) {
        m[r * n + k] -= f * m[c * n + k];
        inv[r * n + k] -= f * inv[c * n + k];
      }
    }
  }
  return inv;
}

const sinc = (x) => (Math.abs(x) < Number.EPSILON ? 1.0 : Math.sin(Math.PI * x) / (Math.PI * x));

class Demodulator {
  /** @param {object} g state shared with the channel decoder (frame buffers, mode, FAC cells, SNR) */
  constructor(g) {
    this.g = g;
    this.rs = new Float64Array(2 * RS_BUFFER);
    this.symbol_buffer = new Float64Array(Tu_A * 2 * 26);
    this.symbol_temp = new Float64Array(2 * Tu_A);
    this.Zi = new Float64Array(6);
    this.no_of_used_cells_per_frame_list = new Int32Array(24);
    let k = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 6; j++) {
        this.no_of_used_cells_per_frame_list[k++] = (T.K_min_K_max_list[1][j + i * 6] - T.K_min_K_max_list[0][j + i * 6] + 1 - T.no_of_unused_carriers_list[i]) * T.symbols_per_frame_list[i];
      }
    }
    this.sigmaq_noise_list = [10 ** (-16 / 10), 10 ** (-14 / 10), 10 ** (-14 / 10), 10 ** (-12 / 10)];
    this.samplerate_offset_estimation = 0;
    this.spectrum_occupancy_estimation = 0;
    this.init();
  }

  init() {
    const g = this.g;
    this.N_samples_needed = N_SYMBOLS_MODE_DETECTION * 320;
    this.input_samples_buffer_request = this.N_samples_needed;
    this.fac_not_valid_counter = FACVALIDCNTR;
    this.mode_and_occupancy_code_last = -1;
    this.timeSyncFlag = false;
    this.frequencySyncFlag = false;
    this.frameSyncFlag = false;
    this.doSynchronize = false;
    this.rsbufwidx = 0;
    this.symbufwidx = 0;
    this.samplerate_offset_estimation = 0;
    g.transmission_frame_buffer_data_valid = 0;
    this.SNR_timeout_counter = 0;
    this.delta_freq_offset = 0;
    this.frequencyOffsetHz = 0;
    this.sampleRateOffset = 0;
  }

  /** Status for display. */
  get stage() {
    if (!this.timeSyncFlag) return 'search';
    if (!this.frameSyncFlag) return 'sync';
    return 'locked';
  }

  /**
   * Adds complex samples (12 kHz, interleaved re/im) and runs as far as it can.
   * @param {Float64Array|Float32Array|null} sigin
   * @param {number} numSamples complex samples in sigin (0: just run)
   * @param {() => void} onFrame called after each equalised frame
   * @returns {boolean}
   */
  demodulate(sigin, numSamples, onFrame) {
    const g = this.g;
    g.transmission_frame_buffer_data_valid = 0;
    if (this.doSynchronize) {
      this.doSynchronize = false;
      this.init();
      if (this.onResync) this.onResync();
    }
    if (numSamples > 0) {
      if (this.rsbufwidx + numSamples > RS_BUFFER) {
        // never happens in normal running; start again rather than overflow
        this.init();
        if (this.onResync) this.onResync();
      }
      this.rs.set(sigin.subarray(0, 2 * numSamples), 2 * this.rsbufwidx);
      this.rsbufwidx += numSamples;
    }
    if (!this.timeSync()) return false;
    if (!this.frequencySync()) return false;
    if (!this.frameSync()) return false;
    if (this.channelEstimation()) onFrame();
    return true;
  }

  _shift(n) {
    // drop the first n complex samples of rs
    this.rsbufwidx -= n;
    this.rs.copyWithin(0, 2 * n, 2 * (n + this.rsbufwidx));
  }

  timeSync() {
    const g = this.g;
    if (this.timeSyncFlag) return true;
    this.frequencySyncFlag = false;
    const need = N_SYMBOLS_MODE_DETECTION * 320 - this.rsbufwidx;
    if (need > 0) {
      this.input_samples_buffer_request = need;
      return false;
    }
    g.spectrum_occupancy = -1;
    const r = getmode(this.rs, N_SYMBOLS_MODE_DETECTION * 320);
    this.lastModeScores = r.scores;
    g.robustness_mode = r.mode;
    this.time_offset = r.timeOffset;
    this.samplerate_offset_estimation = r.sampleRateOffset;
    this.frequency_offset_fractional_init = r.freqOffsetFract;
    this.time_offset_integer = Math.floor(this.time_offset + 0.5);
    if (Math.abs(this.samplerate_offset_estimation) > 200.0e-5 && r.mode !== 99) {
      this.input_samples_buffer_request = N_SYMBOLS_MODE_DETECTION * 320;
      this.rsbufwidx = 0;
      return false;
    }
    if (r.mode !== 99) {
      const m = r.mode;
      this.timeSyncFlag = true;
      this.Ts = T.Ts_list[m];
      this.Tu = T.Tu_list[m];
      this.Tg = T.Tg_list[m];
      g.symbols_per_frame = T.symbols_per_frame_list[m];
      g.K_dc = this.Tu / 2;
      g.K_modulo = this.Tu;
      this.time_ref_cells_k = T.time_ref_cells_k_list[m].slice();
      this.time_ref_cells_theta_1024 = T.time_ref_cells_theta_1024_list[m].slice();
      this.y = T.y_list[m];
      this.symbols_per_2D_window = T.symbols_per_2D_window_list[m];
      this.symbols_to_delay = T.symbols_to_delay_list[m];
      this.ofdm = { dft: new Dft(this.Tu), s: new Float64Array(2 * this.Tu), S: new Float64Array(2 * this.Tu) };
      let toi = this.time_offset_integer;
      if (toi < 0) toi += this.Ts; // QSSTV would read before its buffer here
      this._shift(toi);
      return true;
    }
    this.samplerate_offset_estimation = 0.0;
    this._shift(N_SYMBOLS_MODE_DETECTION * 320);
    const n2 = N_SYMBOLS_MODE_DETECTION * 320 - this.rsbufwidx;
    this.input_samples_buffer_request = n2 > 0 ? n2 : 0;
    return false;
  }

  frequencySync() {
    const g = this.g;
    if (this.frequencySyncFlag) return true;
    this.frameSyncFlag = false;
    const { Ts, Tu } = this;
    const K_modulo = g.K_modulo;
    const need = (N_SYMBOLS_FREQUENCY_PILOT_SEARCH + 1) * Ts - this.rsbufwidx;
    if (need > 0) {
      this.input_samples_buffer_request = need;
      return false;
    }
    const Zi = this.Zi;
    Zi[0] = -1.0;
    this.freq_offset_init = this.frequency_offset_fractional_init;
    this.time_offset_fractional_init = this.time_offset - this.time_offset_integer;
    // QSSTV starts the timing loop at getmode's sample rate offset estimate, which
    // on a noisy signal can be several hundred ppm out; the loop then takes so long
    // to unlearn it that the receiver loses the signal (tested at 10-13 dB SNR,
    // with an echo, and with fading). Real sound cards are within a few hundred ppm.
    const sro = Math.max(-SRO_INIT_LIMIT, Math.min(SRO_INIT_LIMIT, this.samplerate_offset_estimation));
    this.delta_time_offset_I_init = sro * Ts;
    let t = 0;
    for (let i = 0; i < N_SYMBOLS_FREQUENCY_PILOT_SEARCH; i++) {
      const d = getofdm(this.rs, 2 * t, this.time_offset_fractional_init, this.freq_offset_init, this.delta_time_offset_I_init, Ts, Tu, Zi, this.symbol_temp, this.ofdm);
      this.symbol_buffer.set(this.symbol_temp.subarray(0, 2 * K_modulo), 2 * i * K_modulo);
      t += Ts + d;
    }
    this.freq_offset_integer = getfoffsint(this.symbol_buffer, N_SYMBOLS_FREQUENCY_PILOT_SEARCH, g.K_dc, K_modulo, Tu);
    this.freq_offset_init = -this.freq_offset_integer + this.frequency_offset_fractional_init;
    this.time_offset_fractional_init = 0.0;
    Zi[0] = -1.0;

    // spectrum occupancy: energy just inside versus just outside each edge
    const sb = this.symbol_buffer;
    const energy = (k) => {
      let e = 0;
      for (let i = 0; i < N_SYMBOLS_FREQUENCY_PILOT_SEARCH; i++) {
        const a = 2 * (k + i * K_modulo);
        e += sb[a] * sb[a] + sb[a + 1] * sb[a + 1];
      }
      return e;
    };
    const indicator = [0, 0];
    for (let sp = 0; sp < 2; sp++) {
      const Kmin = T.K_min_K_max_list[0][sp + g.robustness_mode * 6];
      const Kmax = T.K_min_K_max_list[1][sp + g.robustness_mode * 6];
      if (Kmin === Kmax) continue;
      const Kdc = (Math.floor(this.freq_offset_integer / (2.0 * Math.PI) + 0.5) + Tu / 2) % Tu;
      const KminI = (Kdc + Kmin + Tu) % Tu;
      const KminM4 = (KminI - 4 + Tu) % Tu;
      const KmaxI = (Kdc + Kmax + Tu) % Tu;
      const KmaxP1 = (KmaxI + 1 + Tu) % Tu;
      indicator[sp] = energy(KminI) / energy(KminM4) + energy(KmaxI) / energy(KmaxP1);
    }
    let best = 0.0;
    for (let sp = 0; sp < 2; sp++) {
      if (indicator[sp] > best) {
        best = indicator[sp];
        this.spectrum_occupancy_estimation = sp;
      }
    }
    g.spectrum_occupancy_estimation = this.spectrum_occupancy_estimation;
    this.frequencySyncFlag = true;
    return true;
  }

  frameSync() {
    const g = this.g;
    if (this.frameSyncFlag) return true;
    const { Ts, Tu } = this;
    const K_modulo = g.K_modulo;
    const spf = g.symbols_per_frame;
    const need = (spf + this.symbols_per_2D_window - 1 + 1) * Ts - this.rsbufwidx;
    if (need > 0) {
      this.input_samples_buffer_request = need;
      return false;
    }
    const Zi = this.Zi;
    let t = 0;
    for (let i = 0; i < spf; i++) {
      const d = getofdm(this.rs, 2 * t, this.time_offset_fractional_init, this.freq_offset_init, this.delta_time_offset_I_init, Ts, Tu, Zi, this.symbol_temp, this.ofdm);
      this.symbol_buffer.set(this.symbol_temp.subarray(0, 2 * K_modulo), 2 * i * K_modulo);
      t += Ts + d;
    }
    const symbol0 = getsymbolidx(this.symbol_buffer, spf, this.time_ref_cells_k, this.time_ref_cells_theta_1024, g.K_dc, K_modulo, 21);
    const toEqualize = ((symbol0 - this.symbols_to_delay + spf) % spf) + 1;
    this.frameSyncFlag = true;
    if (toEqualize !== 1) this._shift((toEqualize - 1) * Ts);
    this.symbufwidx = 0;
    Zi[0] = -1.0;
    t = 0;
    this.symbol_buffer.fill(0);
    for (let i = 0; i < this.symbols_per_2D_window; i++) {
      const d = getofdm(this.rs, 2 * t, this.time_offset_fractional_init, this.freq_offset_init, this.delta_time_offset_I_init, Ts, Tu, Zi, this.symbol_temp, this.ofdm);
      this.symbol_buffer.set(this.symbol_temp.subarray(0, 2 * K_modulo), 2 * i * K_modulo);
      this.symbufwidx++;
      t += Ts + d;
    }
    this._shift(t);
    this.next_pilots = new Float64Array(2 * 70).fill(1.1);
    this.actual_pilots = new Float64Array(458);
    if (this.W_pilots_blk) for (const w of this.W_pilots_blk) if (w) w.fill(0);
    return true;
  }

  /** Pilot tables and the Wiener filter for a robustness mode and spectrum occupancy. */
  _setUpChannelEstimation() {
    const g = this.g;
    const mode = g.robustness_mode;
    const soE = this.spectrum_occupancy_estimation;
    const Tu = T.Tu_list[mode];
    const Ts = T.Ts_list[mode];
    const Tg = Ts - Tu;
    const sigmaq_noise = this.sigmaq_noise_list[mode];
    const spf = T.symbols_per_frame_list[mode];
    g.symbols_per_frame = spf;
    const K_modulo = g.K_modulo;
    const K_dc = g.K_dc;
    const freq_ref_cells_k = T.freq_ref_cells_k_list[mode];
    const freq_ref_cells_theta_1024 = T.freq_ref_cells_theta_1024_list[mode];
    const cnt_time_ref_cells = T.time_ref_cells_cnt_list[mode];
    const time_ref_cells_k = T.time_ref_cells_k_list[mode];
    const time_ref_cells_theta_1024 = T.time_ref_cells_theta_1024_list[mode];
    const K_min = T.K_min_K_max_list[0][soE + mode * 6];
    const K_max = T.K_min_K_max_list[1][soE + mode * 6];
    const cps = K_max - K_min + 1;
    this.K_min = K_min;
    this.K_max = K_max;
    this.carrier_per_symbol = cps;
    this.ofdmSync = new OfdmSync(Ts, Tu, cps);
    const power_boost = T.power_boost_list[mode][soE] || [0, 0, 0, 0];
    const x = T.x_list[mode];
    const y = T.y_list[mode];
    const k0 = T.k0_list[mode];
    const Q_1024 = T.Q_1024_list[mode];
    let mean_energy = this.no_of_used_cells_per_frame_list[soE + mode * 6] + 3 + cnt_time_ref_cells;
    const grK = [];
    const grTheta = [];
    const grA = [];
    for (let s = 0; s < spf; s++) {
      const nnn = s % y;
      const m = Math.trunc(s / y);
      const p_min = Math.trunc((K_min - k0 - x * nnn) / (x * y));
      const p_max = Math.trunc((K_max - k0 - x * nnn) / (x * y));
      for (let p = p_min; p <= p_max; p++) {
        const k = k0 + x * nnn + x * y * p;
        let theta = (4 * T.Z_256_list[mode][nnn][m] + p * T.W_1024_list[mode][nnn][m] + p * p * (1 + s) * Q_1024) % 1024;
        let a = Math.SQRT2;
        for (let i = 0; i < 4; i++) if (k === power_boost[i]) a = 2;
        if (s === 0) {
          for (let i = 0; i < cnt_time_ref_cells; i++) {
            if (k === time_ref_cells_k[i]) {
              theta = time_ref_cells_theta_1024[i];
              a = Math.SQRT2;
              mean_energy -= 1.0;
            }
          }
        }
        for (let i = 0; i < 3; i++) {
          if (k === freq_ref_cells_k[i]) {
            theta = freq_ref_cells_theta_1024[i];
            if (mode === 3) theta = (theta + 512 * s) % 1024;
            a = Math.SQRT2;
            mean_energy -= 1.0;
          }
        }
        grK.push(k + s * cps);
        grTheta.push(theta);
        grA.push(a);
        mean_energy = mean_energy - 1.0 + a * a;
      }
    }
    const rndcnt = grK.length;
    mean_energy /= this.no_of_used_cells_per_frame_list[soE + mode * 6];
    g.mean_energy_of_used_cells = mean_energy;

    // 2-D Wiener filter
    const win = T.symbols_per_2D_window_list[mode];
    const std = T.symbols_to_delay_list[mode];
    const f_cut_t = 0.0675 / y;
    const f_cut_k = (1.75 * Tg) / Tu;
    this.cnt_tr_cells = [];
    this.gain_ref_cells_subset_index = [];
    this.W_symbol_blk = [];
    this.W_pilots_blk = [];
    this.WJ = 205; // W_pilots_blk row stride, as QSSTV's [5][208][205]
    for (let nnn = 0; nnn < y; nnn++) {
      const training = grK.map((v) => ((v - K_min + (spf - nnn) * cps) % (spf * cps)) + K_min);
      let subset = [];
      let subsetIdx = [];
      for (let i = 0; i < rndcnt; i++) {
        if (training[i] - K_min < cps * win) {
          subsetIdx.push(i);
          subset.push(training[i]);
        }
      }
      const nextK = [];
      for (let i = 0; i < rndcnt; i++) {
        const v = training[i] - K_min;
        if (v >= cps * win && v < cps * (win + 1)) nextK.push((v % cps) + K_min);
      }
      // rotate the subset so it is in order (it wraps once at most)
      let brk = 0;
      for (let i = 1; i < subset.length; i++) if (subset[i] < subset[i - 1]) brk = i;
      if (brk > 0) {
        subset = subset.slice(brk).concat(subset.slice(0, brk));
        subsetIdx = subsetIdx.slice(brk).concat(subsetIdx.slice(0, brk));
      }
      const NP = subset.length;
      const kpos = subset.map((v) => ((v - K_min) % cps) + K_min);
      const tpos = subset.map((v) => Math.trunc((v - K_min) / cps));
      const PHI = new Float64Array(NP * NP);
      for (let a = 0; a < NP; a++) {
        for (let b = 0; b < NP; b++) PHI[a * NP + b] = sinc((kpos[a] - kpos[b]) * f_cut_k) * sinc((tpos[a] - tpos[b]) * f_cut_t);
      }
      for (let i = 0; i < NP; i++) {
        const a = grA[subsetIdx[i]];
        PHI[i * NP + i] += (sigmaq_noise * 2.0) / (a * a);
      }
      const PHI_INV = invert(PHI, NP);
      const theta = new Float64Array(NP);
      const weights = (k1, t1, out, stride, col) => {
        for (let b = 0; b < NP; b++) theta[b] = sinc((k1 - kpos[b]) * f_cut_k) * sinc((t1 - tpos[b]) * f_cut_t);
        for (let j = 0; j < NP; j++) {
          let w = 0;
          for (let k = 0; k < NP; k++) w += theta[k] * PHI_INV[k * NP + j];
          out[j * stride + col] = w;
        }
      };
      const Ws = new Float64Array(NP * cps);
      for (let k1 = 0; k1 < cps; k1++) weights(k1 + K_min, std, Ws, cps, k1);
      const Wp = new Float64Array(NP * this.WJ);
      for (let k1 = 0; k1 < nextK.length; k1++) weights(nextK[k1], win - 1, Wp, this.WJ, k1);
      this.cnt_tr_cells[nnn] = NP;
      this.gain_ref_cells_subset_index[nnn] = subsetIdx;
      this.W_symbol_blk[nnn] = Ws;
      this.W_pilots_blk[nnn] = Wp;
    }

    // gain reference cells as indexes into a K_modulo-wide frame
    this.gain_ref_cells_k = grK.map((v) => v + Math.trunc((v - K_min) / cps) * (K_modulo - cps) + K_dc - 1);
    this.gain_ref_cells_theta_1024 = grTheta;
    this.gain_ref_cells_a = grA;
    g.FAC_cells_k = T.mkfacmap(mode, K_dc, K_modulo);
    g.lFAC = g.FAC_cells_k.length;
    for (let i = 0; i < this.cnt_tr_cells[y - 1]; i++) this.next_pilots[2 * i] = this.next_pilots[2 * i + 1] = 0;
    this.gain_ref_cells_per_frame = rndcnt;
    this.gain_ref_cells_per_y_symbols = Math.trunc(rndcnt / Math.trunc(spf / y));
  }

  channelEstimation() {
    const g = this.g;
    const { Ts } = this;
    const spf = g.symbols_per_frame;
    const K_modulo = g.K_modulo;
    const K_dc = g.K_dc;
    const win = this.symbols_per_2D_window;
    const N_symbols_needed = spf + win - this.symbufwidx;
    const need = (N_symbols_needed + 1) * Ts - this.rsbufwidx;
    if (need > 0) {
      this.input_samples_buffer_request = need;
      return false;
    }
    if (g.spectrum_occupancy <= 0) g.spectrum_occupancy = this.spectrum_occupancy_estimation < 0 ? 3 : this.spectrum_occupancy_estimation;
    if (g.spectrum_occupancy > 3) g.spectrum_occupancy = 3;
    let code = g.robustness_mode * 6 + g.spectrum_occupancy;
    if (code > 13) {
      g.spectrum_occupancy = 1;
      code = g.robustness_mode * 6 + 1;
    }
    if (code !== this.mode_and_occupancy_code_last) {
      this._setUpChannelEstimation();
      this.mode_and_occupancy_code_last = code;
    }

    const y = T.y_list[g.robustness_mode];
    const std = this.symbols_to_delay;
    const { K_min, K_max } = this;
    const ncar = K_max - K_min + 1;
    const sb = this.symbol_buffer;
    const tfb = g.transmission_frame_buffer;
    const ctf = g.channel_transfer_function_buffer;
    const wptr = g.transmission_frame_buffer_wptr;
    const H = new Float64Array(2 * ncar);
    const ntc = new Float64Array(2 * 712);
    const next = this.next_pilots;
    const actual = this.actual_pilots;
    let t = 0;
    for (let i = 0; i < spf; i++) {
      const nn = (i - std + spf) % spf;
      const ntwee = nn % y;
      const mtwee = Math.trunc(nn / y);
      const cnt = this.cnt_tr_cells[ntwee];
      const subsetIdx = this.gain_ref_cells_subset_index[ntwee];
      const actualIdx = [];
      for (let j = 0; j < cnt; j++) {
        const gnn = (mtwee * this.gain_ref_cells_per_y_symbols + subsetIdx[j]) % this.gain_ref_cells_per_frame;
        const rel = (this.gain_ref_cells_k[gnn] + (spf - nn) * K_modulo) % (K_modulo * spf);
        if (rel - (win - 1) * K_modulo >= 0) actualIdx.push(j);
        const idx = rel + i * K_modulo + 1;
        const hoek = (2.0 * Math.PI * this.gain_ref_cells_theta_1024[gnn]) / 1024.0;
        const a = this.gain_ref_cells_a[gnn];
        const tr = Math.cos(hoek) / a;
        const ti = -Math.sin(hoek) / a;
        ntc[2 * j] = sb[2 * idx] * tr - sb[2 * idx + 1] * ti;
        ntc[2 * j + 1] = sb[2 * idx + 1] * tr + sb[2 * idx] * ti;
      }
      let t1 = 0;
      let t2 = 0;
      for (let j = 0; j < actualIdx.length; j++) {
        actual[2 * j] = ntc[2 * actualIdx[j]];
        actual[2 * j + 1] = ntc[2 * actualIdx[j] + 1];
        t1 += actual[2 * j] * next[2 * j] + actual[2 * j + 1] * next[2 * j + 1];
        t2 += actual[2 * j] * next[2 * j + 1] - actual[2 * j + 1] * next[2 * j];
      }
      if (i !== 0) this.delta_freq_offset = Math.atan2(t2, t1 + MIN_ABS_H);

      const Ws = this.W_symbol_blk[ntwee];
      for (let j = 0; j < ncar; j++) {
        let hr = 0;
        let hi = 0;
        for (let k = 0; k < cnt; k++) {
          const w = Ws[k * ncar + j];
          hr += ntc[2 * k] * w;
          hi += ntc[2 * k + 1] * w;
        }
        H[2 * j] = hr;
        H[2 * j + 1] = hi;
      }
      const Wp = this.W_pilots_blk[ntwee];
      const WJ = this.WJ;
      for (let j = 0; j < actualIdx.length; j++) {
        let nr = 0;
        let ni = 0;
        for (let k = 0; k < cnt; k++) {
          const w = Wp[k * WJ + j];
          nr += ntc[2 * k] * w;
          ni += ntc[2 * k + 1] * w;
        }
        next[2 * j] = nr;
        next[2 * j + 1] = ni;
      }
      // equalise
      for (let j = K_min; j <= K_max; j++) {
        const ti = wptr + i * K_modulo + K_dc + j;
        const si = (i + std) * K_modulo + K_dc + j;
        const hr = H[2 * (j - K_min)];
        const hi = H[2 * (j - K_min) + 1];
        const m = hr * hr + hi * hi + MIN_ABS_H;
        const a = hr / m;
        const b = -hi / m;
        tfb[2 * ti] = sb[2 * si] * a - sb[2 * si + 1] * b;
        tfb[2 * ti + 1] = sb[2 * si] * b + sb[2 * si + 1] * a;
        ctf[2 * ti] = hr;
        ctf[2 * ti + 1] = hi;
      }
      // next symbol
      const d = this.ofdmSync.next(this.rs, 2 * t, H, this.delta_freq_offset, this.Zi, this.symbol_temp);
      sb.set(this.symbol_temp.subarray(0, 2 * K_modulo), 2 * this.symbufwidx * K_modulo);
      this.symbufwidx++;
      t += Ts + d;
    }

    const Zi = this.Zi;
    this.frequencyOffsetHz = (-Zi[4] * 12000.0) / this.Tu / (2.0 * Math.PI);
    this.sampleRateOffset = Zi[2] / Ts;

    this.symbufwidx -= spf;
    sb.copyWithin(0, 2 * spf * K_modulo, 2 * (spf + this.symbufwidx) * K_modulo);

    // SNR from the FAC cells
    let sumW = 0;
    let sumWeight = 0;
    let sumM = 0;
    const lFAC = g.lFAC;
    for (let i = 0; i < lFAC; i++) {
      const ti = wptr + g.FAC_cells_k[i];
      const a = Math.abs(tfb[2 * ti]) - Math.SQRT1_2;
      const b = Math.abs(tfb[2 * ti + 1]) - Math.SQRT1_2;
      const noise = a * a + b * b;
      const w = ctf[2 * ti] * ctf[2 * ti] + ctf[2 * ti + 1] * ctf[2 * ti + 1];
      sumM += noise;
      sumW += noise * (w + 1.0e-10);
      sumWeight += w;
    }
    g.MERFAC = -10 * Math.log10(sumM / lFAC + 1.0e-10);
    g.WMERFAC = -10 * Math.log10(sumW / (g.mean_energy_of_used_cells * (sumWeight + lFAC * 1.0e-10)));
    const SNR_dB = g.WMERFAC;
    if (!(SNR_dB >= SNR_MIN_DB)) {
      this.SNR_timeout_counter--;
      if (this.SNR_timeout_counter <= 0) {
        this.doSynchronize = true;
        this.SNR_timeout_counter = SNR_TIMEOUT;
      }
      g.transmission_frame_buffer_data_valid = 0;
      this.fac_not_valid_counter--;
      if (this.fac_not_valid_counter <= 0) {
        this.doSynchronize = true;
        this.fac_not_valid_counter = FACVALIDCNTR;
      }
    } else {
      this.SNR_timeout_counter = SNR_TIMEOUT;
      g.transmission_frame_buffer_data_valid = 1;
      g.fac_valid = 1;
    }
    let need2;
    if (this.doSynchronize) need2 = N_SYMBOLS_MODE_DETECTION * 320 - this.rsbufwidx;
    else {
      this._shift(t);
      need2 = (spf + 1) * Ts - this.rsbufwidx;
    }
    this.input_samples_buffer_request = need2 > 0 ? need2 : 0;
    return true;
  }
}

module.exports = { Demodulator, invert };
