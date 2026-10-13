// Run with: node test/jtty-rx.test.js
//
// JTTY receive: the list decoder (src/audio/jtty-tbcc-decode.js) and the
// streaming receiver (src/audio/jtty-rx.js). Signals come from this app's own
// transmit chain, whose output is checked against WSJT-X's encoder in
// jtty.test.js, plus one real recording distributed with WSJT-X
// (test/fixtures/jtty-wsjtx-sample-260807_134110.wav) whose decode matches
// WSJT-X's own decoder (see test/fixtures/README-jtty.md).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeJtty, tbccEncode } = require('../src/audio/jtty-tx');
const { packText } = require('../src/audio/jtty-codec');
const { tbccDecode, crcValid } = require('../src/audio/jtty-tbcc-decode');
const { JttyReceiver, LoadGovernor, displayText, unpackPayload } = require('../src/audio/jtty-rx');
const { StreamDecimator } = require('../src/audio/decimator');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

// --- deterministic noise ------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  const u = rand() || 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Runs a receiver over audio fed in odd-sized chunks; returns the updates. */
function receive(samples, opts = {}) {
  const updates = [];
  const rx = new JttyReceiver({ onMessage: (u) => updates.push(u), ...opts });
  const chunk = opts.chunk ?? 977;
  for (let i = 0; i < samples.length; i += chunk) rx.push(samples.subarray(i, Math.min(samples.length, i + chunk)));
  if (!opts.noFlush) rx.flush();
  return { updates, rx };
}
const completed = (updates) => updates.filter((u) => u.status === 'complete');

/** Places encoded signals in a buffer with optional white noise at snrDb (2.5 kHz reference). */
function mix(parts, { seconds, snrDb, seed = 1 }) {
  const total = Math.round(seconds * 12000);
  const x = new Float32Array(total);
  let peak = 0;
  for (const { samples, at } of parts) {
    const start = Math.round(at * 12000);
    for (let i = 0; i < samples.length && start + i < total; i++) x[start + i] += samples[i];
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
  }
  if (snrDb !== undefined) {
    const rand = rng(seed);
    const sigma = Math.sqrt(((peak * peak) / 2 / 10 ** (snrDb / 10)) * (6000 / 2500));
    for (let i = 0; i < total; i++) x[i] += sigma * gaussian(rand);
  }
  return x;
}

// --- 1. list decoder ------------------------------------------------------
{
  const frame = packText('CQ K1ABC CQ').frames[0];
  const tones = tbccEncode(frame);
  function correlations(sigma, seed) {
    const rand = rng(seed);
    const zr = new Float64Array(184);
    const zi = new Float64Array(184);
    const h = new Float64Array(184);
    for (let s = 0; s < 46; s++) {
      for (let t = 0; t < 4; t++) {
        const k = t * 46 + s;
        zr[k] = (tones[s] === t ? 1 : 0) + sigma * gaussian(rand);
        zi[k] = sigma * gaussian(rand);
        h[k] = Math.hypot(zr[k], zi[k]);
      }
    }
    return { zr, zi, h };
  }
  const clean = correlations(0, 1);
  const res = tbccDecode(clean.zr, clean.zi, clean.h);
  check(res.success && res.payload.join('') === frame.slice(0, 34) && res.rung === 1, 'FEC: a clean frame decodes at the first (L=1) rung');

  let ok = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const c = correlations(0.4, seed);
    const r = tbccDecode(c.zr, c.zi, c.h);
    if (r.success && r.payload.join('') === frame.slice(0, 34)) ok++;
  }
  check(ok === 12, `FEC: 12/12 noisy frames decode correctly (sigma 0.4), got ${ok}`);

  let accepted = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const c = correlations(50, seed); // essentially pure noise
    if (tbccDecode(c.zr, c.zi, c.h).success) accepted++;
  }
  check(accepted === 0, `FEC: pure noise is rejected (${accepted}/10 accepted)`);

  // A valid codeword whose reserved bit is 1 or whose payload is all zero must not be accepted.
  const badReserved = frame.slice(0, 32) + '1' + frame.slice(33, 34);
  const tonesBad = tbccEncode(badReserved);
  const zr = new Float64Array(184);
  for (let s = 0; s < 46; s++) zr[tonesBad[s] * 46 + s] = 1;
  const rb = tbccDecode(zr, new Float64Array(184), zr);
  check(!rb.success, 'FEC: a frame with the reserved bit set is rejected');
  const tonesZero = tbccEncode('0'.repeat(34));
  const zz = new Float64Array(184);
  for (let s = 0; s < 46; s++) zz[tonesZero[s] * 46 + s] = 1;
  check(!tbccDecode(zz, new Float64Array(184), zz).success, 'FEC: the all-zero payload is rejected');
  check(crcValid(Array.from(frame.padEnd(46, '0'), Number)) === false, 'CRC helper rejects a frame without a valid CRC');
}

// --- 2. frame text -----------------------------------------------------------
{
  const u = unpackPayload(Array.from(packText('CQ K1ABC CQ').frames[0].slice(0, 34), Number));
  check(u.valid && u.text === 'CQ K1ABC CQ' && u.trailingSep && u.isLast, 'unpackPayload: structured frame has a trailing separator and the end-of-message flag');
  const t = packText('RAN ALL NIGHT');
  const first = unpackPayload(Array.from(t.frames[0].slice(0, 34), Number));
  check(first.valid && first.text === 'RAN~A' && !first.trailingSep && !first.isLast, 'unpackPayload: TEXT5 frame carries five characters');
  check(displayText('~~~~~LL NI~') === '... LL NI', 'displayText: gap marker and TEXT5 spaces');
  check(displayText('~599 123') === '599 123', 'displayText: leading space dropped');
  check(!unpackPayload(Array(34).fill(0)).valid, 'unpackPayload: all-zero payload is not a message');
}

// --- 3. receiver on clean synthetic signals ---------------------------------------
{
  const enc = encodeJtty('CQ K1ABC CQ', { f0: 1500, amplitude: 0.3 });
  const x = mix([{ samples: enc.samples, at: 0.35 }], { seconds: 6 });
  const { updates } = receive(x);
  const done = completed(updates);
  check(done.length === 1 && done[0].text === 'CQ K1ABC CQ', 'clean single-frame message decodes: ' + JSON.stringify(done.map((d) => d.text)));
  check(Math.abs(done[0].freqHz - 1500) < 0.5, `frequency estimate within 0.5 Hz (${done[0]?.freqHz.toFixed(2)})`);
  check(Math.abs(done[0].startTime - 0.35) < 0.01, `start time within 10 ms (${done[0]?.startTime.toFixed(3)} s)`);
  check(done[0].snr > 0, `SNR estimate is high for a clean signal (${done[0]?.snr})`);
  check(updates.length === 1, 'one frame, one update (no duplicate reports from overlapping windows)');
}
{
  const text = 'RAN ALL NIGHT ON BAND';
  const enc = encodeJtty(text, { f0: 1400, amplitude: 0.3 });
  const x = mix([{ samples: enc.samples, at: 0.8 }], { seconds: enc.durationSec + 4 });
  const { updates } = receive(x);
  const growing = updates.filter((u) => u.status === 'growing').map((u) => u.text);
  const done = completed(updates);
  check(enc.nframes === 5 && done.length === 1 && done[0].text === text, `five-frame message is assembled: "${done[0]?.text}"`);
  check(growing.length === 4 && growing[0] === 'RAN A' && growing[3] === 'RAN ALL NIGHT ON BAN', `message grows frame by frame: ${JSON.stringify(growing)}`);
  check(new Set(updates.map((u) => u.id)).size === 1, 'all updates share one message id');
}
{
  const a = encodeJtty('CQ K1ABC CQ', { f0: 1200, amplitude: 0.3 });
  const b = encodeJtty('WB9XYZ 599 123', { f0: 1700, amplitude: 0.3 });
  const x = mix([{ samples: a.samples, at: 0.2 }, { samples: b.samples, at: 0.9 }], { seconds: 8, snrDb: 5, seed: 3 });
  const done = completed(receive(x).updates);
  const texts = done.map((d) => d.text).sort();
  check(texts.length === 2 && texts[0] === 'CQ K1ABC CQ' && texts[1] === 'WB9XYZ 599 123', 'two simultaneous signals are both decoded: ' + JSON.stringify(texts));
}
{
  const a = encodeJtty('CQ K1ABC CQ', { f0: 1500, amplitude: 0.3 });
  const b = encodeJtty('CQ DL1XYZ CQ', { f0: 1500, amplitude: 0.3 });
  const x = mix([{ samples: a.samples, at: 0.3 }, { samples: b.samples, at: 5.1 }], { seconds: 10 });
  const done = completed(receive(x).updates);
  check(done.length === 2 && done[0].id !== done[1].id && done[0].text === 'CQ K1ABC CQ' && done[1].text === 'CQ DL1XYZ CQ', 'two messages in turn on one frequency stay separate');
}

// --- 4. noise, silence, chunking, truncation -----------------------------------------
{
  const enc = encodeJtty('CQ K1ABC CQ', { f0: 1500, amplitude: 0.3 });
  let hits = 0;
  for (const seed of [11, 12, 13]) {
    const x = mix([{ samples: enc.samples, at: 0.5 }], { seconds: 6, snrDb: -8, seed });
    if (completed(receive(x).updates).some((u) => u.text === 'CQ K1ABC CQ')) hits++;
  }
  check(hits === 3, `decodes in noise at -8 dB (2.5 kHz reference) on 3/3 seeds, got ${hits}`);
}
{
  const rand = rng(99);
  const noise = new Float32Array(12000 * 12);
  for (let i = 0; i < noise.length; i++) noise[i] = 0.1 * gaussian(rand);
  const { updates } = receive(noise);
  check(updates.length === 0, 'pure noise produces no messages');
  const silence = receive(new Float32Array(12000 * 6));
  check(silence.updates.length === 0 && silence.rx.stats.windows > 0, 'silence is processed without error and produces nothing');
}
{
  const enc = encodeJtty('CQ K1ABC CQ', { f0: 1500, amplitude: 0.3 });
  const x = mix([{ samples: enc.samples, at: 0.35 }], { seconds: 6, snrDb: 0, seed: 5 });
  const small = completed(receive(x, { chunk: 1 + 113 }).updates).map((u) => u.text);
  const large = completed(receive(x, { chunk: 50000 }).updates).map((u) => u.text);
  check(JSON.stringify(small) === JSON.stringify(large) && small.length === 1, 'result does not depend on how the audio is chunked');
}
{
  const enc = encodeJtty('RAN ALL NIGHT ON BAND', { f0: 1400, amplitude: 0.3 });
  const cut = enc.samples.subarray(0, 2 * 59 * 384); // first two of five frames
  const x = mix([{ samples: cut, at: 0.5 }], { seconds: 6 + 4 * 1.888 });
  const { updates } = receive(x);
  const last = updates[updates.length - 1];
  check(last && last.status === 'expired' && last.text === 'RAN ALL NI', 'a message that never finishes is reported as expired with what was received: ' + JSON.stringify(last));
}
{
  // A middle frame lost to a fade: the gap is bridged and marked.
  const enc = encodeJtty('RAN ALL NIGHT ON BAND', { f0: 1400, amplitude: 0.3 });
  const x = mix([{ samples: enc.samples, at: 0.5 }], { seconds: enc.durationSec + 4 });
  const frame = 59 * 384;
  const from = Math.round(0.5 * 12000) + 2 * frame;
  x.fill(0, from, from + frame); // blank frame 3
  const done = completed(receive(x).updates);
  check(done.length === 1 && /^RAN ALL NI +\.\.\. +N BAND$/.test(done[0].text.replace(/\s+/g, ' ').replace(' ... ', '  ...  ')) || (done.length === 1 && done[0].text.includes('...')), 'a lost frame is bridged with "...": ' + JSON.stringify(done.map((d) => d.text)));
}

// --- 5. a real recording distributed with WSJT-X ------------------------------------------
{
  const wav = fs.readFileSync(path.join(__dirname, 'fixtures', 'jtty-wsjtx-sample-260807_134110.wav'));
  const n = (wav.length - 44) >> 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = wav.readInt16LE(44 + 2 * i) / 32768;
  const { updates } = receive(x, { lowHz: 1300, highHz: 1700 });
  const done = completed(updates);
  const main = done.find((u) => u.text.startsWith('RAN ALL NIGHT'));
  check(
    main && main.text === 'RAN ALL NIGHT ON BAND NOISE - NO FALSE DECODES!' && Math.abs(main.freqHz - 1507) < 2,
    'WSJT-X sample recording: the ten-frame message decodes as WSJT-X does: ' + JSON.stringify(main && [main.text, main.freqHz.toFixed(1)])
  );
  check(updates.filter((u) => u.id === main.id).length === 10, 'the sample produces ten updates for the one message');
  for (const level of [1, 2]) {
    const eco = completed(receive(x, { lowHz: 1300, highHz: 1700, light: level }).updates).find((u) => u.text.startsWith('RAN ALL NIGHT'));
    check(eco && eco.text === main.text, `the sample also decodes identically at effort level ${level} (${level === 1 ? 'light' : 'economy'})`);
  }
}

// --- 6. helpers -------------------------------------------------------------------------------
{
  const input = new Float32Array(48000);
  for (let i = 0; i < input.length; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 1500 * i) / 48000) + 0.5 * Math.sin((2 * Math.PI * 9000 * i) / 48000);
  const whole = new StreamDecimator(48000).process(input);
  const rand = rng(7);
  const parts = [];
  const d = new StreamDecimator(48000);
  for (let i = 0; i < input.length; ) {
    const c = 1 + Math.floor(rand() * 997);
    parts.push(d.process(input.subarray(i, Math.min(input.length, i + c))));
    i += c;
  }
  const chunked = Float32Array.from(parts.flatMap((p) => Array.from(p)));
  let same = whole.length === chunked.length;
  for (let i = 0; same && i < whole.length; i++) if (whole[i] !== chunked[i]) same = false;
  check(whole.length === 12000 && same, 'StreamDecimator: 48 kHz -> 12 kHz, identical however the input is chunked');
  let p = 0;
  for (let i = 200; i < whole.length - 200; i++) p += whole[i] * whole[i];
  check(Math.abs(Math.sqrt(p / (whole.length - 400)) - 0.3536) < 0.01, 'StreamDecimator: in-band tone kept, 9 kHz tone filtered out');
  check(new StreamDecimator(12000).process(Int16Array.from([16384, -16384])).join() === '0.5,-0.5', 'StreamDecimator: 12 kHz passes through');
  let threw = false;
  try {
    new StreamDecimator(44100);
  } catch {
    threw = true;
  }
  check(threw, 'StreamDecimator: rejects a rate that is not a multiple of 12 kHz');
}
{
  const g = new LoadGovernor({ stepMs: 100 });
  check(g.update(20) === null && g.update(30) === null, 'LoadGovernor: light load changes nothing');
  let switched = null;
  for (let i = 0; i < 10 && switched === null; i++) switched = g.update(150);
  check(switched === true, 'LoadGovernor: sustained overload switches to light search');
  let back = null;
  for (let i = 0; i < 20 && back === null; i++) back = g.update(5);
  check(back === false, 'LoadGovernor: switches back once the load has fallen');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll JTTY receive checks passed');
