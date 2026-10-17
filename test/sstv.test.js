// Run with: node test/sstv.test.js
//
// Checks the SSTV receiver (src/audio/sstv-rx.js, after slowrx) and the
// encoder used to test it (src/audio/sstv-tx.js):
//   - the mode table: VIS codes, line layouts;
//   - every mode, end to end through the receiver (the first lines of each,
//     and whole pictures for a representative set);
//   - audio made by PySSTV, an independent encoder (fixtures from
//     third_party/sstv/make-fixtures.py);
//   - mistuning, sound-card clock error (slant), noise, no false pictures
//     from noise, chunk-size invariance, a signal that stops part-way,
//     and two pictures back to back.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/audio/sstv-modes');
const { encodeSstv } = require('../src/audio/sstv-tx');
const { SstvReceiver, SSTV_SAMPLE_RATE } = require('../src/audio/sstv-rx');
const { makeTestRand } = require('../src/audio/olivia-tx');
const { gauss } = require('./olivia-fixture-input');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

/** The same picture as third_party/sstv/make-fixtures.py: colour bars over a gradient. */
function testImage(w, h) {
  const rgb = new Uint8Array(w * h * 3);
  const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      if (y < Math.floor(h / 4)) rgb.set(bars[Math.floor((x * 8) / w)], o);
      else {
        const v = Math.floor((x * 255) / (w - 1));
        rgb.set([v, Math.floor((y * 255) / h), 255 - v], o);
      }
    }
  }
  return rgb;
}

function decode(samples, { chunk = 4096, tail = 1.0, opts } = {}) {
  const rx = new SstvReceiver(opts);
  const events = [];
  for (let i = 0; i < samples.length; i += chunk) events.push(...rx.process(samples.subarray(i, i + chunk)));
  events.push(...rx.process(new Float32Array(Math.round(tail * SSTV_SAMPLE_RATE))));
  events.push(...rx.flush());
  return events;
}

/** Mean absolute difference over rows [y0, y1) between a decoded picture and the source scaled to it. */
function meanErr(src, sw, sh, rgb, w, h, y0 = 0, y1 = h, { bw = false } = {}) {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / w));
      const a = (sy * sw + sx) * 3;
      const b = (y * w + x) * 3;
      if (bw) {
        const la = 0.299 * src[a] + 0.587 * src[a + 1] + 0.114 * src[a + 2];
        sum += Math.abs(la - rgb[b]);
        n++;
      } else {
        for (let c = 0; c < 3; c++) sum += Math.abs(src[a + c] - rgb[b + c]);
        n += 3;
      }
    }
  }
  return sum / n;
}

const withNoise = (x, amp, sigma, seed) => {
  const r = makeTestRand(seed);
  return Float32Array.from(x, (v) => v * amp + sigma * gauss(r));
};
const lead = (x, sec = 0.7) => {
  const out = new Float32Array(Math.round(sec * SSTV_SAMPLE_RATE) + x.length);
  out.set(x, out.length - x.length);
  return out;
};

// --- mode table
{
  const ids = Object.keys(M.MODES);
  check(ids.length === 25 && ids.every((id) => M.VIS_CODES[M.VIS_OF_MODE[id]] === id), `25 modes, each with its VIS code (${ids.join(' ')})`);
  const fits = ids.every((id) => {
    const { start, len } = M.channelLayout(id);
    const n = M.numChannels(id);
    const end = Math.max(...start.slice(0, n).map((s, c) => s + len[c]));
    return end <= M.MODES[id].line + 1e-3;
  });
  check(fits, 'every line layout fits its line period (to 1 ms, as slowrx\'s table)');
  check(M.MODES.PD120.width === 640 && M.MODES.PD120.lines === 496 && M.MODES.M1.width === 320 && M.MODES.R36.lines === 240, 'picture sizes: PD-120 640 x 496, Martin 320 x 256, Robot 36 320 x 240');
}

// --- every mode, first lines
{
  const bad = [];
  for (const id of Object.keys(M.MODES)) {
    const m = M.MODES[id];
    const img = testImage(m.width, m.lines);
    const periods = M.isPd(id) ? 8 : 16;
    const enc = encodeSstv(img, m.width, m.lines, id, { periods, amplitude: 0.5 });
    const ev = decode(lead(enc.samples), { opts: { lostSyncLines: 0 } });
    const st = ev.find((e) => e.type === 'start');
    const end = ev.find((e) => e.type === 'end');
    const rows = M.isPd(id) ? 2 * periods : periods;
    const err = end ? meanErr(img, m.width, m.lines, end.rgb, m.width, m.lines, 1, rows - 2, { bw: m.color === 'BW' }) : Infinity;
    const limit = (id.startsWith('R') && m.color !== 'BW') || M.isPd(id) ? 10 : 6;
    if (!(st && st.mode === id && end && err < limit)) bad.push(`${id}: ${st?.mode} err ${err.toFixed?.(1)}`);
  }
  check(bad.length === 0, `all 25 modes: VIS recognised and the first lines decode (${bad.join('; ') || 'mean error under 6; Robot colour and PD, with their shared chroma, under 10'})`);
}

// --- whole pictures
const whole = {};
for (const id of ['M2', 'S2', 'R36', 'PD50', 'R8BW']) {
  const m = M.MODES[id];
  const img = testImage(m.width, m.lines);
  const enc = encodeSstv(img, m.width, m.lines, id, { amplitude: 0.5 });
  const ev = decode(lead(enc.samples), { chunk: 997 });
  const st = ev.find((e) => e.type === 'start');
  const lines = ev.filter((e) => e.type === 'line');
  const end = ev.find((e) => e.type === 'end');
  const err = end ? meanErr(img, m.width, m.lines, end.rgb, m.width, m.lines, 0, m.lines, { bw: m.color === 'BW' }) : Infinity;
  whole[id] = { ev, enc, img };
  check(
    st && st.shiftHz === 0 && lines.length === m.lines && lines.every((l, i) => l.y === i && l.rgb.length === m.width * 3) && end?.complete && end.rate === SSTV_SAMPLE_RATE && err < (id === 'R36' ? 8 : 5),
    `${m.name}: ${lines.length} lines live, then the whole ${m.width} x ${m.lines} picture (mean error ${err.toFixed(1)})`
  );
}
{
  // live lines are the picture as received; the final one is the same when nothing needed correcting
  const { ev } = whole.M2;
  const end = ev.find((e) => e.type === 'end');
  const live = new Uint8Array(end.rgb.length);
  for (const l of ev.filter((e) => e.type === 'line')) live.set(l.rgb, l.y * 320 * 3);
  let diff = 0;
  for (let i = 0; i < live.length; i++) diff += Math.abs(live[i] - end.rgb[i]);
  check(diff / live.length < 5, `live lines match the final picture when there is no slant (${(diff / live.length).toFixed(2)})`);
}
{
  const a = decode(lead(whole.R36.enc.samples), { chunk: 4096 });
  const b = decode(lead(whole.R36.enc.samples), { chunk: 173 });
  const ea = a.find((e) => e.type === 'end').rgb;
  const eb = b.find((e) => e.type === 'end').rgb;
  check(ea.length === eb.length && ea.every((v, i) => v === eb[i]), 'same picture whatever the chunk size');
}

// --- PySSTV
{
  const FIX = path.join(__dirname, 'fixtures');
  const { cases } = JSON.parse(fs.readFileSync(path.join(FIX, 'sstv-pysstv.json'), 'utf8'));
  for (const c of cases) {
    const pcm = new Int16Array(fs.readFileSync(path.join(FIX, c.file)).buffer.slice(0));
    const x = Float32Array.from(pcm, (v) => v / 32768);
    const ev = decode(x, { tail: 0.2, opts: { lostSyncLines: 0 } });
    const st = ev.find((e) => e.type === 'start');
    const end = ev.find((e) => e.type === 'end');
    const m = M.MODES[c.mode];
    const src = testImage(c.width, c.height);
    const rows = end ? end.linesReceived - 3 : 0;
    const err = end ? meanErr(src, c.width, c.height, end.rgb, m.width, m.lines, 1, rows) : Infinity;
    check(st?.mode === c.mode && rows > 15 && err < (c.mode === 'R36' ? 9 : 6), `PySSTV ${c.pysstv}: recognised, ${rows} lines checked, mean error ${err.toFixed(1)}`);
  }
}

// --- mistuning, slant, noise
{
  const m = M.MODES.M2;
  const img = testImage(m.width, m.lines);
  for (const off of [110, -150]) {
    const enc = encodeSstv(img, m.width, m.lines, 'M2', { freqOffsetHz: off, periods: 60, amplitude: 0.5 });
    const ev = decode(lead(enc.samples), { opts: { lostSyncLines: 0 } });
    const st = ev.find((e) => e.type === 'start');
    const end = ev.find((e) => e.type === 'end');
    const err = meanErr(img, m.width, m.lines, end.rgb, m.width, m.lines, 1, 57);
    check(Math.abs(st.shiftHz - off) <= 10 && err < 6, `${off > 0 ? '+' : ''}${off} Hz mistuned: offset measured as ${st.shiftHz} Hz, picture fine (${err.toFixed(1)})`);
  }
}
for (const [id, clk] of [['M1', 0.004], ['S1', -0.003], ['PD90', 0.0025], ['R36', -0.004]]) {
  const m = M.MODES[id];
  const img = testImage(m.width, m.lines);
  const enc = encodeSstv(img, m.width, m.lines, id, { clockError: clk, amplitude: 0.5 });
  const ev = decode(lead(enc.samples), { opts: { lostSyncLines: 0 } });
  const end = ev.find((e) => e.type === 'end');
  // the uncorrected picture, for comparison
  const live = new Uint8Array(end.rgb.length);
  for (const l of ev.filter((e) => e.type === 'line')) live.set(l.rgb, l.y * m.width * 3);
  const errLive = meanErr(img, m.width, m.lines, live, m.width, m.lines);
  const err = meanErr(img, m.width, m.lines, end.rgb, m.width, m.lines);
  const want = SSTV_SAMPLE_RATE * (1 + clk);
  check(Math.abs(end.rate - want) / want < 3e-4 && err < 10 && err < errLive / 3, `${m.name}, sender's clock ${clk > 0 ? '+' : ''}${clk * 100}%: rate corrected to ${end.rate.toFixed(1)} Hz, error ${errLive.toFixed(1)} -> ${err.toFixed(1)}`);
}
{
  const m = M.MODES.S2;
  const img = testImage(m.width, m.lines);
  const enc = encodeSstv(img, m.width, m.lines, 'S2', { periods: 80 });
  // signal 0.5 peak (0.125 W), noise 0.35 rms over 6 kHz: about +3 dB in 3 kHz
  const ev = decode(withNoise(lead(enc.samples), 0.5, 0.35, 11), { opts: { lostSyncLines: 0 } });
  const end = ev.find((e) => e.type === 'end');
  const err = end ? meanErr(img, m.width, m.lines, end.rgb, m.width, m.lines, 2, 76) : Infinity;
  check(err < 25, `Scottie 2 at about +3 dB S/N: still a recognisable picture (mean error ${err.toFixed(1)})`);
  const noAdapt = decode(withNoise(lead(enc.samples), 0.5, 0.35, 11), { opts: { lostSyncLines: 0, adaptive: false } }).find((e) => e.type === 'end');
  const err2 = meanErr(img, m.width, m.lines, noAdapt.rgb, m.width, m.lines, 2, 76);
  check(err < err2, `slowrx's S/N-adaptive window helps (${err2.toFixed(1)} without, ${err.toFixed(1)} with)`);
}
{
  const r = makeTestRand(5);
  const noise = Float32Array.from({ length: 120 * SSTV_SAMPLE_RATE }, () => 0.3 * gauss(r));
  const ev = decode(noise);
  check(ev.length === 0, 'two minutes of noise: no picture started');
}

// --- a signal that stops, and two pictures in a row
{
  const m = M.MODES.M2;
  const img = testImage(m.width, m.lines);
  const enc = encodeSstv(img, m.width, m.lines, 'M2', { periods: 40, amplitude: 0.5 });
  const ev = decode(lead(enc.samples), { tail: 5 });
  const end = ev.find((e) => e.type === 'end');
  check(end && end.complete === false && end.linesReceived < 60 && end.linesReceived >= 40, `transmission stops after 40 lines: picture ended early (${end?.linesReceived} lines, complete=false)`);
  const rx = new SstvReceiver();
  const evs = [...rx.process(lead(enc.samples)), ...rx.flush()];
  check(evs.at(-1).type === 'end' && evs.at(-1).complete === false && rx.state === 'listening', 'flush() ends a picture in progress and goes back to listening');
}
{
  const a = whole.R8BW.enc.samples;
  const two = new Float32Array(a.length * 2 + 6000);
  two.set(a, 0);
  two.set(a, a.length + 6000);
  const ev = decode(two);
  check(ev.filter((e) => e.type === 'start').length === 2 && ev.filter((e) => e.type === 'end' && e.complete).length === 2, 'two Robot 8 B/W pictures back to back: both received');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall SSTV tests passed');
