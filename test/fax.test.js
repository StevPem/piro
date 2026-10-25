// Run with: node test/fax.test.js
'use strict';

const { encodeFax, FAX_WIDTH } = require('../src/audio/fax-tx');
const { FaxReceiver, toneStrength, deslant, cleanChart } = require('../src/audio/fax-rx');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

const W = FAX_WIDTH;
/** A test chart: a black left margin, bars every 181 pixels, a diagonal line. */
function chart(lines) {
  const g = new Uint8Array(W * lines);
  for (let y = 0; y < lines; y++) {
    for (let x = 0; x < W; x++) {
      let v = x < 50 ? 0 : Math.floor(x / 181) % 2 ? 230 : 40;
      if (Math.abs(x - 10 * y - 300) < 6) v = 255 - v;
      g[y * W + x] = v;
    }
  }
  return g;
}
// mulberry32
let seed = 7;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
/** Adds noise for an S/N (dB) in 3 kHz; the signal is a 0.5 amplitude sine. */
function noisy(x, snrDb) {
  const sd = 0.5 / Math.sqrt(2) / Math.sqrt(10 ** (snrDb / 10) * 2);
  return x.map((v) => v + sd * gauss());
}
function run(audio, rx = new FaxReceiver(), chunk = 4800) {
  const events = [];
  for (let i = 0; i < audio.length; i += chunk) events.push(...rx.process(audio.subarray(i, i + chunk)));
  return { rx, events, ends: events.filter((e) => e.type === 'end') };
}
function meanError(end, truth, lines) {
  let e = 0;
  const n = Math.min(lines, end.lines);
  for (let i = 0; i < n * W; i++) e += Math.abs(end.grey[i] - truth[i]);
  return e / (n * W);
}
/** The first bright column, averaged over lines a..b (steady in noise). */
const firstBrightAvg = (end, a, b) => {
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = a; y < b; y++) sum += end.grey[y * W + x];
    if (sum / (b - a) > 135) return x;
  }
  return -1;
};
/** How far (pixels, circular) line b is shifted from line a. */
function rowShift(end, a, b) {
  let best = 0;
  let bestSum = -Infinity;
  for (let k = -W / 2; k < W / 2; k++) {
    let sum = 0;
    for (let x = 0; x < W; x += 2) sum += end.grey[a * W + x] * end.grey[b * W + ((((x + k) % W) + W) % W)];
    if (sum > bestSum) {
      bestSum = sum;
      best = k;
    }
  }
  return best;
}
const firstBright = (end, y) => {
  for (let x = 0; x < W; x++) if (end.grey[y * W + x] > 128) return x;
  return -1;
};

{
  const sq = Float32Array.from({ length: 3000 }, (_, i) => (Math.floor(i / 20) % 2 ? 0 : 1)); // 300 Hz square wave at 12 kHz
  check(toneStrength(sq, 300) > 0.7 && toneStrength(sq, 450) < 0.05, `the start signal is found (300 Hz: ${toneStrength(sq, 300).toFixed(2)}, 450 Hz: ${toneStrength(sq, 450).toFixed(2)})`);
}
{
  const H = 120;
  const truth = chart(H);
  const { events, ends } = run(encodeFax({ grey: truth, width: W, lines: H, leadSec: 3 }));
  const states = events.filter((e) => e.type === 'state').map((e) => e.state).join(' ');
  const end = ends[0];
  check(states === 'phasing receiving listening', `start signal, phasing, chart, stop signal: ${states}`);
  check(ends.length === 1 && end.complete && end.reason === 'the stop signal' && end.width === 1810, 'one chart, ended by the stop signal, 1810 pixels wide (IOC 576)');
  check(end.lines >= H - 3 && end.lines <= H, `the stop signal's own lines are dropped (${end.lines} of ${H} lines)`);
  check(meanError(end, truth, end.lines) < 3, `clean: the chart comes back (mean error ${meanError(end, truth, end.lines).toFixed(1)} of 255)`);
  check(firstBright(end, 0) === 181 && firstBright(end, end.lines - 1) === 181, 'lined up by the phasing: the bars start at pixel 181 on every line');
  const starts = events.filter((e) => e.type === 'start');
  check(starts.length === 1 && starts[0].phased === true, 'the chart was started by its start signal');
}
for (const ppm of [300, -150, 1000]) {
  // the sender's clock (or our sound card) off by ppm: the phasing measures it, so no slant
  const H = 120;
  const truth = chart(H);
  const { ends } = run(encodeFax({ grey: truth, width: W, lines: H, rateError: ppm / 1e6 }));
  const end = ends[0];
  const drift = firstBright(end, end.lines - 1) - firstBright(end, 0);
  check(end && Math.abs(end.clockPpm + ppm) <= 30 && Math.abs(drift) <= 2 && meanError(end, truth, end.lines) < 4, `a ${ppm} ppm clock error is measured (${end?.clockPpm} ppm) and corrected (drift ${drift} px over ${end?.lines} lines)`);
}
for (const [snr, maxErr] of [[10, 25], [3, 45]]) {
  const H = 120;
  const truth = chart(H);
  const { ends } = run(noisy(encodeFax({ grey: truth, width: W, lines: H, rateError: 2e-4 }), snr));
  const end = ends[0];
  const err = end ? meanError(end, truth, end.lines) : 255;
  check(end && end.reason === 'the stop signal' && err < maxErr && Math.abs(firstBrightAvg(end, 10, 30) - 181) <= 3 && Math.abs(firstBrightAvg(end, 90, 110) - 181) <= 3, `in noise (S/N ${snr} dB in 3 kHz): found, lined up (bars at ${end && firstBrightAvg(end, 10, 30)} and ${end && firstBrightAvg(end, 90, 110)}), mean error ${err.toFixed(1)}`);
}
{
  // noise alone: no chart
  const { events } = run(noisy(new Float32Array(12000 * 60), -100).map((v) => v * 1));
  check(!events.some((e) => e.type === 'start'), 'a minute of noise starts no chart');
}
{
  // joining part-way: Start now, then Stop
  const H = 40;
  const truth = chart(H);
  const audio = encodeFax({ grey: truth, width: W, lines: H, apt: false, phasingSec: 0 });
  const rx = new FaxReceiver();
  const ev = rx.startNow();
  check(ev.some((e) => e.type === 'start' && e.phased === false) && rx.state === 'receiving', 'Start now begins a chart at once');
  const { events } = run(audio, rx);
  const lines = events.filter((e) => e.type === 'line').length;
  const end = rx.flush().find((e) => e.type === 'end');
  check(Math.abs(lines - H) <= 1 && end && end.lines === lines && end.complete === false && end.reason === 'Stop', `Stop keeps what arrived (${end?.lines} lines)`);
}
{
  // a new start signal ends the chart in progress
  const a = encodeFax({ grey: chart(20), width: W, lines: 20, phasingSec: 10 });
  const b = encodeFax({ grey: chart(20), width: W, lines: 20, phasingSec: 10 });
  const cut = a.subarray(0, a.length - 15 * 12000); // first one loses its stop signal
  const { ends } = run(Float32Array.from([...cut, ...b]));
  check(ends.length === 2 && ends[0].reason === 'a new start signal' && ends[1].reason === 'the stop signal', `a start signal during a chart starts the next one: ${ends.map((e) => e.reason).join(', ')}`);
}

{
  // no start signal heard, but the phasing is: the chart still lines up
  const H = 80;
  const truth = chart(H);
  const { rx, events } = run(encodeFax({ grey: truth, width: W, lines: H, apt: false, rateError: 1.2e-4, leadSec: 2 }));
  const end = rx.flush().find((e) => e.type === 'end'); // no stop signal either
  check(events.some((e) => e.type === 'start' && e.phased) && end && end.phased && Math.abs(end.clockPpm + 120) <= 20, `without a start signal, phasing alone starts and lines up the chart (clock ${end?.clockPpm} ppm)`);
  check(end && Math.abs(firstBright(end, 5) - 181) <= 1 && Math.abs(firstBright(end, H - 10) - 181) <= 1, 'lined up and straight');
}
{
  // Start now pressed during the phasing: the chart is lined up anyway
  const H = 80;
  const truth = chart(H);
  const audio = encodeFax({ grey: truth, width: W, lines: H, rateError: -2e-4 });
  const rx = new FaxReceiver();
  const first = run(audio.subarray(0, 12000 * 12), rx); // start signal and 7 s of phasing
  const ev = rx.startNow();
  const rest = run(audio.subarray(12000 * 12), rx);
  const all = [...first.events, ...ev, ...rest.events];
  const starts = all.filter((e) => e.type === 'start');
  const ends = all.filter((e) => e.type === 'end');
  check(starts.length === 2 && starts[0].phased === false && starts[1].phased === true, 'Start now during phasing: the phasing takes over and lines the chart up');
  check(ends.length === 1 && ends[0].phased && Math.abs(firstBright(ends[0], 5) - 181) <= 1 && meanError(ends[0], truth, ends[0].lines) < 4, `the hand-started bit (only phasing) is dropped; the chart is straight (clock ${ends[0]?.clockPpm} ppm)`);
}
{
  // Start now part-way through a chart (no phasing at all), with a 150 ppm clock error: straightened at the end
  const H = 400;
  const truth = chart(H);
  const audio = encodeFax({ grey: truth, width: W, lines: H, rateError: 1.5e-4, apt: false, phasingSec: 0 });
  const rx = new FaxReceiver();
  rx.startNow();
  run(audio, rx);
  const end = rx.flush().find((e) => e.type === 'end');
  const expected = (6000 - 6000 / 1.00015) / (6000 / W); // pixels a line the features drift
  check(end && !end.phased && Math.abs(Math.abs(end.slantPxPerLine) - expected) < 0.02, `a chart with no phasing is straightened from its own lines (slant ${end?.slantPxPerLine} px/line; sent ${expected.toFixed(3)})`);
  const drift = rowShift(end, 20, end.lines - 20);
  check(Math.abs(drift) <= 2, `and comes out straight (${drift} px between lines 20 and ${end.lines - 20})`);
}
{
  // Seen on VMC: HF noise spoils a few phasing lines. Before v98 the first
  // bad line ended the phasing after 6-10 lines: a poor clock measurement
  // (each chart slanted differently, by up to 0.7 px a line) and the rest
  // of the phasing drawn as a black band at the top.
  for (const [ppm, hits, snr] of [
    [120, [8, 15, 27], 20],
    [-300, [10], 15],
  ]) {
    const H = 200;
    const truth = chart(H);
    const audio = encodeFax({ grey: truth, width: W, lines: H, rateError: ppm * 1e-6 });
    const spl = 6000 / (1 + ppm * 1e-6);
    for (const h of hits) {
      const at = Math.round(5 * 12000 + h * spl + 1500);
      for (let i = 0; i < 2500; i++) audio[at + i] = 0.5 * Math.sin((2 * Math.PI * 2300 * i) / 12000); // a burst of white in that phasing line
    }
    const { ends } = run(noisy(audio, snr));
    const end = ends[0];
    let darkTop = 0;
    for (let y = 0; y < 10; y++) {
      let sum = 0;
      for (let x = 0; x < W; x++) sum += end.grey[y * W + x];
      if (sum / W < 60) darkTop++;
    }
    check(end && end.phased && end.clockMeasured && Math.abs(end.clockPpm + ppm) <= 10, `phasing with ${hits.length} noise-hit line(s), ${ppm} ppm: all of it measured (clock ${end?.clockPpm} ppm)`);
    check(darkTop === 0 && Math.abs(firstBrightAvg(end, 10, 20) - 181) <= 2 && Math.abs(firstBrightAvg(end, H - 30, H - 20) - 181) <= 2, `none of the phasing drawn as chart (${darkTop} dark lines at the top); lined up and straight`);
  }
}
{
  // Real VMC charts, as received slanted (every 4th line kept, each repeated
  // 4 times): a satellite picture (big dark areas) and a page of text (no
  // vertical lines, only a left margin). Straightened by their edges.
  const zlib = require('zlib');
  const fs = require('fs');
  const path = require('path');
  for (const [name, expected] of [
    ['fax-vmc-satellite', 0.665],
    ['fax-vmc-text', 0.19],
  ]) {
    const small = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.grey.gz`)));
    const L = (small.length / W) * 4;
    const g = new Uint8Array(L * W);
    for (let y = 0; y < L; y++) g.set(small.subarray((y >> 2) * W, ((y >> 2) + 1) * W), y * W);
    const d = deslant(g, W, L);
    check(Math.abs(d.pxPerLine - expected) < 0.03, `${name}: slant found (${d.pxPerLine.toFixed(3)} px a line; straight at ${expected}, checked by eye)`);
    check(deslant(d.grey, W, L).pxPerLine === 0, `${name}: and straight afterwards`);
  }
  // and noise is left alone
  const n = new Uint8Array(W * 600);
  for (let i = 0; i < n.length; i++) n[i] = rnd() < 0.5 ? 0 : 255;
  check(deslant(n, W, 600).pxPerLine === 0, 'a chart of pure noise is not "straightened"');
}
{
  // A slanted chart with no phasing tells the clock error too (slantPpm)
  const H = 300;
  const audio = encodeFax({ grey: chart(H), width: W, lines: H, rateError: 1.5e-4, apt: false, phasingSec: 0 });
  const rx = new FaxReceiver();
  rx.startNow();
  run(audio, rx);
  const end = rx.flush().find((e) => e.type === 'end');
  check(end && !end.clockMeasured && Math.abs(end.slantPpm + 150) <= 10, `the slant gives the clock error: ${end?.slantPpm} ppm (phasing would say -150)`);
}

{
  // Noise damage mended at the end of a chart (cleanChart): static crashes
  // spoil whole lines; a fade speckles a few lines. A clean chart, text
  // and grids are left alone.
  const H = 240;
  const text = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ly = y % 30;
      const cx = (x - 100) % 18;
      if (ly >= 5 && ly < 25 && x > 100 && x < 1300 && (cx < 3 || (ly >= 13 && ly < 16 && cx < 12))) text[y * W + x] = 0; // rows of letter-like strokes
      if (x % 300 === 150) text[y * W + x] = 0; // thin vertical lines
    }
  }
  const audio = encodeFax({ grey: text, width: W, lines: H, phasingSec: 20 });
  const start = 25 * 12000;
  for (let i = start; i < audio.length; i++) {
    const l = (i - start) / 6000;
    if (l > 40 && l < 60) audio[i] *= 0.12 + 0.88 * Math.abs(Math.cos((Math.PI * (l - 40)) / 20)); // a fade to -18 dB
  }
  for (const l of [90, 150, 151, 200]) for (let i = 0; i < 6000; i++) audio[start + l * 6000 + i] += 2 * gauss(); // crashes
  const noisyAudio = noisy(audio, 12);
  const measure = (end) => {
    let specks = 0;
    let white = 0;
    let kept = 0;
    let ink = 0;
    const L = Math.min(end.lines, H);
    for (let y = 2; y < L - 2; y++) {
      for (let x = 4; x < W - 4; x++) {
        let far = true;
        for (let dy = -2; dy <= 2 && far; dy++) for (let dx = -4; dx <= 4; dx++) if (text[(y + dy) * W + x + dx] < 128) far = false;
        if (far) {
          white++;
          if (end.grey[y * W + x] < 170) specks++;
        }
        if (text[y * W + x] === 0) {
          ink++;
          if (end.grey[y * W + x] < 128) kept++;
        }
      }
    }
    return { specks: (100 * specks) / white, kept: (100 * kept) / ink };
  };
  const raw = measure(run(noisyAudio, new FaxReceiver({ cleanUp: false })).ends[0]);
  const { ends } = run(noisyAudio);
  const cleaned = measure(ends[0]);
  check(ends[0].repairedLines >= 3 && ends[0].repairedLines <= 5, `crash-hit lines are mended (${ends[0].repairedLines} lines)`);
  check(cleaned.specks < raw.specks / 3 && cleaned.kept >= raw.kept - 0.5, `specks in the white cut from ${raw.specks.toFixed(2)}% to ${cleaned.specks.toFixed(2)}%, strokes kept (${raw.kept.toFixed(1)}% -> ${cleaned.kept.toFixed(1)}%)`);
  for (const [name, g, lines] of [
    ['the test chart (bars, a diagonal)', chart(300), 300],
    ['a page of text and grid lines', text, H],
  ]) {
    const c = cleanChart(g, W, lines);
    let changed = 0;
    for (let i = 0; i < g.length; i++) if (c.grey[i] !== g[i]) changed++;
    check(c.repairedLines === 0 && changed / g.length < 0.001, `clean, ${name} is left alone (${c.repairedLines} lines, ${changed} pixels changed)`);
  }
}

{
  // a straight chart is left alone
  const H = 200;
  const truth = chart(H);
  const rx = new FaxReceiver();
  rx.startNow();
  run(encodeFax({ grey: truth, width: W, lines: H, apt: false, phasingSec: 0 }), rx);
  const end = rx.flush().find((e) => e.type === 'end');
  check(end && end.slantPxPerLine === 0, 'a straight chart is left as it is');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall radiofax tests passed');
