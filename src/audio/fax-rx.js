'use strict';

/**
 * HF radiofax (WEFAX) receiver, for the Bureau of Meteorology's VMC
 * (Charleville) and VMW (Wiluna) broadcasts and others like them: FM around
 * 1900 Hz (black 1500, white 2300), 120 lines a minute, IOC 576.
 *
 * How it works:
 *  - FM demodulation: the 12 kHz audio is mixed down by 1900 Hz, low-pass
 *    filtered, and the phase step between samples is the frequency, mapped
 *    to a grey level 0 (1500 Hz) ... 1 (2300 Hz).
 *  - The start and stop signals are the grey level alternating at 300 Hz
 *    and 450 Hz. They are found by correlating each quarter second against
 *    those frequencies.
 *  - Phasing (about 30 s of black lines with one white pulse per line)
 *    gives the line start: the pulse's leading edge. How far the pulse
 *    drifts from line to line is the difference between the sender's clock
 *    and ours, so the line length is corrected for it (no slant).
 *  - Then each line (6000 samples nominal) is averaged into 1810 pixels,
 *    until the stop signal, a new start signal, Stop, or 25 minutes.
 *
 * A chart can also be started by hand (startNow()) when the start signal
 * was missed: the line start is then wherever the line happens to begin,
 * and the clock correction is the last one measured.
 *
 * process() returns events:
 *   {type: 'state', state: 'listening'|'phasing'|'receiving'}
 *   {type: 'start', width, lpm, ioc, phased}
 *   {type: 'line', y, grey: Uint8Array(width)}
 *   {type: 'end', width, lines, grey: Uint8Array(width * lines), complete, reason, clockPpm}
 */

const { designLowpassFir } = require('./resample');
const { FAX_SAMPLE_RATE, FAX_CENTRE_HZ, FAX_DEVIATION_HZ, FAX_LPM, FAX_IOC, FAX_WIDTH } = require('./fax-tx');

const RATE = FAX_SAMPLE_RATE;
const BLOCK = RATE / 4; // tone detection in quarter seconds
const TONE_THRESHOLD = 0.35;
const START_BLOCKS = 4; // 1 s of start tone
const STOP_BLOCKS = 4;
const MIN_PHASING_LINES = 6;
const MAX_PHASING_LINES = 120; // 60 s
const MAX_LINES = 25 * FAX_LPM; // 25 minutes
const MAX_CLOCK_ERROR = 0.002; // 2000 ppm: anything more is a bad measurement

/** How strongly a block (mean removed) contains frequency hz: 1 for a pure sine, about 0.8 for a square wave. */
function toneStrength(block, hz) {
  const n = block.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += block[i];
  mean /= n;
  let re = 0;
  let im = 0;
  let energy = 0;
  const w = (2 * Math.PI * hz) / RATE;
  for (let i = 0; i < n; i++) {
    const v = block[i] - mean;
    re += v * Math.cos(w * i);
    im += v * Math.sin(w * i);
    energy += v * v;
  }
  return energy > 1e-9 ? (re * re + im * im) / ((n / 2) * energy) : 0;
}

class FaxReceiver {
  constructor({ lpm = FAX_LPM, width = FAX_WIDTH } = {}) {
    this.lpm = lpm;
    this.width = width;
    this.nominalSpl = (RATE * 60) / lpm;
    this.spl = this.nominalSpl; // corrected by phasing
    this.clockPpm = 0;
    // FM demodulator
    this._taps = designLowpassFir(1100, RATE, 47);
    this._hi = new Float32Array(this._taps.length);
    this._hq = new Float32Array(this._taps.length);
    this._hpos = 0;
    this._lo = 0;
    this._pi = 1;
    this._pq = 0;
    // demodulated grey levels not yet used: buf[0] is sample number bufStart
    this._buf = new Float32Array(RATE * 30);
    this._len = 0;
    this._bufStart = 0;
    this._total = 0; // samples demodulated so far
    // tone detection
    this._blockPos = 0; // next sample number to test as a block
    this._startRun = 0;
    this._stopRun = 0;
    this._toneEnd = null; // sample number where the start tone ended
    // state
    this.state = 'listening';
    this._phasing = null; // {next, positions: []}
    this._lineStart = 0; // sample number where the next line starts
    this._lines = [];
  }

  /** Grey level of sample number n (0..1), or null if not available. */
  _at(n) {
    const i = n - this._bufStart;
    return i >= 0 && i < this._len ? this._buf[i] : null;
  }

  _push(v) {
    if (this._len === this._buf.length) {
      // drop what nothing needs any more
      const keepFrom = Math.min(this._blockPos, this.state === 'receiving' ? Math.floor(this._lineStart) : this._phasing ? this._phasing.next : this._blockPos) - 10;
      const drop = Math.max(0, Math.min(this._len, keepFrom - this._bufStart));
      if (drop > 0) {
        this._buf.copyWithin(0, drop, this._len);
        this._len -= drop;
        this._bufStart += drop;
      }
      if (this._len === this._buf.length) {
        const bigger = new Float32Array(this._buf.length * 2);
        bigger.set(this._buf);
        this._buf = bigger;
      }
    }
    this._buf[this._len++] = v;
    this._total++;
  }

  _demod(x) {
    const w = (2 * Math.PI * FAX_CENTRE_HZ) / RATE;
    const taps = this._taps;
    const n = taps.length;
    for (let k = 0; k < x.length; k++) {
      this._hi[this._hpos] = x[k] * Math.cos(this._lo);
      this._hq[this._hpos] = -x[k] * Math.sin(this._lo);
      this._lo += w;
      if (this._lo > 2 * Math.PI) this._lo -= 2 * Math.PI;
      let i = 0;
      let q = 0;
      let p = this._hpos;
      for (let t = 0; t < n; t++) {
        i += taps[t] * this._hi[p];
        q += taps[t] * this._hq[p];
        p = p === 0 ? n - 1 : p - 1;
      }
      this._hpos = (this._hpos + 1) % n;
      const dphi = Math.atan2(q * this._pi - i * this._pq, i * this._pi + q * this._pq);
      this._pi = i;
      this._pq = q;
      const hz = (dphi * RATE) / (2 * Math.PI);
      this._push(Math.max(0, Math.min(1, (hz + FAX_DEVIATION_HZ) / (2 * FAX_DEVIATION_HZ))));
    }
  }

  /** @param {Float32Array} samples - 12 kHz audio */
  process(samples) {
    const events = [];
    this._demod(samples);
    this._run(events);
    return events;
  }

  _setState(state, events) {
    if (state === this.state) return;
    this.state = state;
    events.push({ type: 'state', state });
  }

  _run(events) {
    // tone detection, block by block
    while (this._blockPos + BLOCK <= this._total) {
      const block = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) block[i] = this._at(this._blockPos + i) ?? 0;
      const start = toneStrength(block, 300) > TONE_THRESHOLD;
      const stop = toneStrength(block, 450) > TONE_THRESHOLD;
      this._blockPos += BLOCK;
      this._startRun = start ? this._startRun + 1 : 0;
      this._stopRun = stop ? this._stopRun + 1 : 0;
      if (this._startRun === START_BLOCKS) {
        // a start signal: end any chart in progress, then wait for it to finish
        if (this.state === 'receiving') this._finish(events, true, 'a new start signal');
        this._setState('phasing', events);
        this._phasing = null;
      } else if (this.state === 'phasing' && !this._phasing && this._startRun === 0) {
        // the start signal has ended: phasing lines follow
        this._phasing = { next: this._blockPos - BLOCK, positions: [], widths: [] };
        this._toneEnd = this._phasing.next;
      }
      if (this._stopRun === STOP_BLOCKS && this.state === 'receiving') {
        // drop the lines the stop signal itself drew
        const toneStartLine = Math.floor((this._blockPos - STOP_BLOCKS * BLOCK - this._lineStart) / this.spl) + this._lines.length;
        this._lines.length = Math.max(0, Math.min(this._lines.length, toneStartLine - 1));
        this._finish(events, true, 'the stop signal');
      }
    }
    if (this.state === 'phasing' && this._phasing) this._runPhasing(events);
    if (this.state === 'receiving') this._runLines(events);
  }

  /** Finds the white pulse in each phasing line; when the lines stop being phasing, the chart starts. */
  _runPhasing(events) {
    const ph = this._phasing;
    const spl = Math.round(this.nominalSpl);
    const win = Math.max(8, Math.round(spl * 0.02));
    while (ph.next + spl <= this._total) {
      const line = new Float32Array(spl);
      for (let i = 0; i < spl; i++) line[i] = this._at(ph.next + i) ?? 0;
      // smoothed (circular) to find the pulse
      let sum = 0;
      for (let i = 0; i < win; i++) sum += line[i];
      let best = -1;
      let bestAt = 0;
      for (let i = 0; i < spl; i++) {
        if (sum > best) {
          best = sum;
          bestAt = i;
        }
        sum += line[(i + win) % spl] - line[i];
      }
      // a phasing line is black but for one short white pulse (5% of the line)
      let bright = 0;
      for (let i = 0; i < spl; i++) if (line[i] > 0.5) bright++;
      const frac = bright / spl;
      const isPhasing = best / win > 0.6 && frac > 0.015 && frac < 0.12;
      if (isPhasing) {
        // The pulse's centre (to a fraction of a sample) less half its
        // width is its leading edge: steadier than one threshold crossing.
        let sumI = 0;
        let count = 0;
        for (let k = -Math.round(spl * 0.1); k <= Math.round(spl * 0.1); k++) {
          const j = (bestAt + Math.round(win / 2) + k + spl) % spl;
          if (line[j] > 0.5) {
            sumI += k;
            count++;
          }
        }
        const centre = bestAt + Math.round(win / 2) + (count ? sumI / count : 0);
        ph.positions.push(ph.next + centre);
        ph.widths.push(count);
      }
      ph.next += spl;
      const enough = ph.positions.length >= MIN_PHASING_LINES;
      if ((!isPhasing && enough) || ph.positions.length >= MAX_PHASING_LINES) {
        this._beginFromPhasing(ph.positions, ph.widths, events);
        return;
      }
      if (!isPhasing && ph.positions.length === 0 && ph.next - (this._toneEnd ?? ph.next) > 90 * RATE) {
        // no phasing came: back to listening
        this._phasing = null;
        this._setState('listening', events);
        return;
      }
    }
  }

  /** Line length from the pulse drift, and the first chart line at the last pulse. */
  _beginFromPhasing(positions, widths, events) {
    const spl = this.nominalSpl;
    // a straight line through the pulse positions: its slope is the line length
    // (sub-sample accurate over 30 s of phasing). Each pulse is numbered by
    // whole lines from the first, so a missed line doesn't matter.
    const k = positions.map((p) => Math.round((p - positions[0]) / spl));
    const n = positions.length;
    const fit = (use) => {
      const idx = [...Array(n).keys()].filter((i) => use[i]);
      const m = idx.length;
      const mk = idx.reduce((a, i) => a + k[i], 0) / m;
      const mp = idx.reduce((a, i) => a + positions[i], 0) / m;
      let num = 0;
      let den = 0;
      for (const i of idx) {
        num += (k[i] - mk) * (positions[i] - mp);
        den += (k[i] - mk) ** 2;
      }
      const slope = den > 0 ? num / den : spl;
      return { slope, at: (i) => mp + (k[i] - mk) * slope };
    };
    let measured = spl;
    let line = null;
    if (n >= 3) {
      // fit, drop the pulses that don't sit on the line (the first and last
      // can be cut by the start signal or the chart), and fit again
      let use = positions.map(() => true);
      line = fit(use);
      const res = positions.map((p, i) => Math.abs(p - line.at(i)));
      const sorted = [...res].sort((a, b) => a - b);
      const limit = Math.max(1.5, 3 * sorted[n >> 1]);
      use = res.map((r) => r <= limit);
      if (use.filter(Boolean).length >= 3) line = fit(use);
      measured = line.slope;
    }
    const err = measured / spl - 1;
    if (Math.abs(err) <= MAX_CLOCK_ERROR) {
      this.spl = measured;
      this.clockPpm = Math.round(err * 1e6);
    }
    this._phasing = null;
    // the chart starts one line after the last phasing line, where the fitted line puts it
    // positions are pulse centres; the line starts at the pulse's leading
    // edge, half its (median) width earlier
    const w = [...widths].sort((a, b) => a - b)[widths.length >> 1] ?? 0;
    const last = (line ? line.at(n - 1) : positions[n - 1]) - w / 2;
    this._startChart(last + this.spl, true, events);
  }

  _startChart(lineStart, phased, events) {
    this._lineStart = lineStart;
    this._lines = [];
    this._setState('receiving', events);
    events.push({ type: 'start', width: this.width, lpm: this.lpm, ioc: FAX_IOC, phased, clockPpm: this.clockPpm });
  }

  _runLines(events) {
    while (this._lineStart + this.spl <= this._total) {
      const grey = new Uint8Array(this.width);
      const per = this.spl / this.width;
      for (let x = 0; x < this.width; x++) {
        const a = this._lineStart + x * per;
        const b = a + per;
        let sum = 0;
        let n = 0;
        for (let s = Math.floor(a); s < b; s++) {
          const v = this._at(s);
          if (v != null) {
            sum += v;
            n++;
          }
        }
        grey[x] = n ? Math.round((sum / n) * 255) : 0;
      }
      this._lineStart += this.spl;
      this._lines.push(grey);
      events.push({ type: 'line', y: this._lines.length - 1, grey });
      if (this._lines.length >= MAX_LINES) {
        this._finish(events, true, 'the 25-minute limit');
        return;
      }
    }
  }

  _finish(events, complete, reason) {
    const lines = this._lines;
    const grey = new Uint8Array(this.width * lines.length);
    lines.forEach((l, y) => grey.set(l, y * this.width));
    events.push({ type: 'end', width: this.width, lines: lines.length, grey, complete, reason, clockPpm: this.clockPpm });
    this._lines = [];
    this._setState('listening', events);
  }

  /** Starts a chart now, without waiting for the start signal (line start unknown). */
  startNow() {
    const events = [];
    if (this.state === 'receiving') this._finish(events, false, 'Start');
    this._phasing = null;
    this._startChart(this._total, false, events);
    return events;
  }

  /** Ends the chart in progress (Stop), keeping what has arrived. */
  flush() {
    const events = [];
    if (this.state === 'receiving') this._finish(events, false, 'Stop');
    else if (this.state === 'phasing') {
      this._phasing = null;
      this._setState('listening', events);
    }
    return events;
  }
}

module.exports = { FaxReceiver, toneStrength, FAX_SAMPLE_RATE, FAX_WIDTH };
