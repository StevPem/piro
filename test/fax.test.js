// Run with: node test/fax.test.js
'use strict';

const { encodeFax, FAX_WIDTH } = require('../src/audio/fax-tx');
const { FaxReceiver, toneStrength } = require('../src/audio/fax-rx');

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

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall radiofax tests passed');
