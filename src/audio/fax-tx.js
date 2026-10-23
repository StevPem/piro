'use strict';

/**
 * HF radiofax (WEFAX) audio, the way the Bureau of Meteorology's VMC and
 * VMW send it: frequency modulated around 1900 Hz, black 1500 Hz and white
 * 2300 Hz, 120 lines a minute at IOC 576 (1810 pixels a line). A chart is:
 *
 *   start signal   5 s, black/white alternating at 300 Hz
 *   phasing       30 s, black lines with one white pulse at each line start
 *   the chart     line by line
 *   stop signal    5 s, black/white alternating at 450 Hz, then 10 s black
 *
 * PiRO only receives radiofax; this encoder makes test signals for
 * audio/fax-rx.js (and could one day transmit).
 */

const FAX_SAMPLE_RATE = 12000;
const FAX_CENTRE_HZ = 1900;
const FAX_DEVIATION_HZ = 400;
const FAX_LPM = 120;
const FAX_IOC = 576;
const FAX_WIDTH = Math.round(FAX_IOC * Math.PI); // 1810
const PHASING_PULSE = 0.05; // the white pulse is 5% of the line

/**
 * @param {object} opts
 * @param {Uint8Array} opts.grey - width * lines grey levels (0 black ... 255 white)
 * @param {number} opts.width
 * @param {number} opts.lines
 * @param {number} [opts.sampleRate=12000]
 * @param {number} [opts.rateError=0] - the sender's clock error (e.g. 1e-4 = 100 ppm fast)
 * @param {boolean} [opts.apt=true] - start and stop signals
 * @param {number} [opts.phasingSec=30]
 * @param {number} [opts.leadSec=0] - silence-free carrier (white) before the start signal
 */
function encodeFax({ grey, width, lines, sampleRate = FAX_SAMPLE_RATE, rateError = 0, apt = true, phasingSec = 30, leadSec = 0, amplitude = 0.5 } = {}) {
  const spl = (sampleRate * 60) / FAX_LPM / (1 + rateError); // samples per line as sent
  const values = []; // [value 0..1, count]
  const push = (v, n) => values.push([v, n]);
  if (leadSec) push(1, Math.round(leadSec * sampleRate));
  const tone = (hz, sec) => {
    const n = Math.round(sec * sampleRate);
    const half = sampleRate / hz / 2;
    for (let i = 0; i < n; i++) push(Math.floor(i / half) % 2 ? 0 : 1, 1);
  };
  if (apt) tone(300, 5);
  const phasingLines = Math.round(phasingSec * (FAX_LPM / 60));
  let pos = 0; // fractional sample position, so line boundaries stay exact
  const emitLine = (fn) => {
    const start = Math.round(pos);
    pos += spl;
    const n = Math.round(pos) - start;
    for (let i = 0; i < n; i++) push(fn(i / n), 1);
  };
  for (let l = 0; l < phasingLines; l++) emitLine((x) => (x < PHASING_PULSE ? 1 : 0));
  for (let y = 0; y < lines; y++) emitLine((x) => grey[y * width + Math.min(width - 1, Math.floor(x * width))] / 255);
  if (apt) {
    tone(450, 5);
    push(0, 10 * sampleRate);
  }
  let total = 0;
  for (const [, n] of values) total += n;
  const out = new Float32Array(total);
  let phase = 0;
  let o = 0;
  for (const [v, n] of values) {
    const dphi = (2 * Math.PI * (FAX_CENTRE_HZ + (v * 2 - 1) * FAX_DEVIATION_HZ)) / sampleRate;
    for (let i = 0; i < n; i++) {
      out[o++] = amplitude * Math.sin(phase);
      phase += dphi;
    }
    phase %= 2 * Math.PI;
  }
  return out;
}

module.exports = { encodeFax, FAX_SAMPLE_RATE, FAX_CENTRE_HZ, FAX_DEVIATION_HZ, FAX_LPM, FAX_IOC, FAX_WIDTH, PHASING_PULSE };
