// Run with: node test/olivia.test.js
//
// Checks the Olivia port (src/audio/olivia-dsp.js, olivia-tx.js, olivia-rx.js)
// against the reference program built from fldigi's own MFSK code
// (third_party/olivia/olivia_ref.cpp; fixtures from third_party/olivia/make-fixtures.js):
//   - the building blocks (Hadamard transform, Gray code, FFT, parameters);
//   - 160 messages whose complete symbol sequences came from the reference
//     transmitter, and one reference waveform;
//   - receive cases decoded by the reference receiver: same text, same S/N
//     and frequency-offset readings;
//   - PiRO's receiver defaults: no junk around messages, none on plain noise,
//     full copy at -13 dB, the tuning range, chunk-size invariance and the
//     48 kHz audio path.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dsp = require('../src/audio/olivia-dsp');
const { encodeOlivia, oliviaDurationSec, textToOliviaBytes, makeTestRand, OliviaEncoder } = require('../src/audio/olivia-tx');
const { OliviaReceiver, OliviaTextDecoder } = require('../src/audio/olivia-rx');
const { upsampleFloatToPcm } = require('../src/audio/resample');
const { StreamDecimator } = require('../src/audio/decimator');
const { rxInput, gauss } = require('./olivia-fixture-input');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

const FIX = path.join(__dirname, 'fixtures');
const vectors = JSON.parse(fs.readFileSync(path.join(FIX, 'olivia-vectors.json'), 'utf8'));

// fldigi's own behaviour: integrated threshold 3 (squelch off), none of PiRO's extra checks
const FLDIGI = { syncThreshold: 3, blockSnrMin: 0, dropControlBlocks: false };

/** Decodes a whole buffer; returns the text (as OliviaTextDecoder shows it) and the receiver. */
function decode(samples, opts = {}, chunk = 1024) {
  const rx = new OliviaReceiver(opts);
  const td = new OliviaTextDecoder();
  const bytes = [];
  let text = '';
  let snr = 0;
  let foff = 0;
  for (let i = 0; i < samples.length; i += chunk) {
    const b = rx.process(samples.subarray(i, Math.min(samples.length, i + chunk)));
    bytes.push(...b);
    text += td.push(b);
    if (rx.signalToNoise > 0) {
      snr = rx.signalToNoise;
      foff = rx.freqOffsetHz;
    }
  }
  const b = rx.flush();
  bytes.push(...b);
  text += td.push(b);
  return { text, bytes, snr, foff, rx };
}

/** Signal at `snrDb` in a 2.5 kHz bandwidth, after 3 s of noise, followed by 6 s of noise. */
function noisy(text, snrDb, seed, { centreHz = 1500 } = {}) {
  const enc = encodeOlivia(text, { centreHz, rand: makeTestRand(seed) });
  let p = 0;
  for (const v of enc.samples) p += v * v;
  p /= enc.samples.length;
  const lead = 8000 * 3;
  const x = new Float32Array(lead + enc.samples.length + 8000 * 6);
  const sig = snrDb === null ? 0 : 1;
  for (let i = 0; i < enc.samples.length; i++) x[lead + i] = sig * enc.samples[i] * 0.1;
  const noisePow = snrDb === null ? 1e-2 : (p / Math.pow(10, snrDb / 10)) * (4000 / 2500);
  const sd = Math.sqrt(noisePow) * 0.1;
  const r = makeTestRand(seed * 131 + 7);
  for (let i = 0; i < x.length; i++) x[i] += sd * gauss(r);
  return x;
}

// --- 1. building blocks -----------------------------------------------------
{
  const v = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i * 1.7) * 10);
  const w = Float64Array.from(v);
  dsp.ifht(w, 64);
  dsp.fht(w, 64);
  check(w.every((x, i) => Math.abs(x / 64 - v[i]) < 1e-9), 'Hadamard: FHT(IFHT(x)) = 64 x');
  let gray = true;
  for (let b = 0; b < 256; b++) gray = gray && dsp.binaryCode(dsp.grayCode(b)) === b;
  check(gray, 'Gray code: binaryCode(grayCode(b)) = b for every byte');
  let adj = true;
  for (let b = 0; b < 7; b++) {
    const d = dsp.grayCode(b) ^ dsp.grayCode(b + 1);
    adj = adj && (d & (d - 1)) === 0;
  }
  check(adj, 'Gray code: neighbouring tones differ in one bit');

  const n = 64;
  const fft = new dsp.R2FFT(n);
  const re = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.3) + 0.2 * i);
  const im = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.11));
  const xr = Float64Array.from(re);
  const xi = Float64Array.from(im);
  fft.process(xr, xi);
  let err = 0;
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
    err = Math.max(err, Math.abs(sr - xr[k]), Math.abs(si - xi[k]));
  }
  check(err < 1e-9, `FFT matches a direct DFT (max error ${err.toExponential(1)})`);

  const p = dsp.oliviaParams({ tones: 8, bandwidth: 250, centreHz: 1500 });
  check(
    p.bitsPerSymbol === 3 && p.symbolLen === 512 && p.baud === 31.25 && p.binHz === 15.625 && p.firstCarrier === 89,
    'parameters for 8/250: 3 bits/symbol, 512-sample symbols, 31.25 baud, first tone in FFT bin 89 at 1500 Hz'
  );
  check(
    p.lowToneHz === 1390.625 && p.highToneHz === 1609.375 && p.centreActualHz === 1500 && Math.abs(p.charsPerSec - 1.4648) < 1e-3 && p.blockSec === 2.048,
    'tones 1390.6-1609.4 Hz, 31.25 Hz apart; one 2.048 s block per 3 characters (~1.46 chars/s)'
  );
  check(dsp.oliviaParams({ centreHz: 1500, intOffset: true }).firstCarrier === 89, 'the receiver (integer offset, as fldigi) puts the tones in the same bins');
}

// --- 2. transmitter against the reference -------------------------------------
{
  let bad = 0;
  for (const [b64, centre, seed, symbols] of vectors.tx) {
    const bytes = [...Buffer.from(b64, 'base64')];
    const enc = encodeOlivia(bytes, { centreHz: centre, rand: makeTestRand(seed) });
    const got = enc.symbols.join('');
    if (got !== symbols) {
      bad++;
      if (bad <= 3) console.error(`  mismatch for ${JSON.stringify(Buffer.from(bytes).toString('latin1')).slice(0, 40)} at ${centre} Hz`);
    }
  }
  check(bad === 0, `symbol sequences match the reference transmitter (${vectors.tx.length} messages, ${bad} differing)`);

  const ref = new Int16Array(fs.readFileSync(path.join(FIX, 'olivia-k-1000hz.i16')).buffer.slice(0));
  const enc = encodeOlivia([75], { centreHz: 1000, rand: makeTestRand(7) });
  let maxErr = ref.length === enc.samples.length ? 0 : Infinity;
  for (let i = 0; i < ref.length && maxErr < Infinity; i++) maxErr = Math.max(maxErr, Math.abs(ref[i] - Math.round(enc.samples[i] * 32767)));
  check(maxErr <= 1, `waveform for "K" at 1000 Hz matches the reference to 1 LSB (${enc.samples.length} samples, max diff ${maxErr})`);

  const t = encodeOlivia('CQ CQ DE VK3TR VK3TR K', {});
  check(t.symbols.length === 8 * 64 && t.tones.every((x) => x >= 0 && x < 8), '22 characters: a first block with NUL + 1 character (as fldigi), then 7 full blocks');
  let durOk = true;
  for (const n of [0, 1, 2, 3, 4, 5, 22, 100]) durOk = durOk && Math.abs(encodeOlivia('x'.repeat(n), {}).durationSec - oliviaDurationSec(n)) < 0.05;
  check(durOk, `oliviaDurationSec() predicts the encoded length (${t.durationSec.toFixed(2)} s for 22 characters)`);
  const peak = t.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  check(peak <= 1.0001 && peak > 0.9, `audio peaks at full scale (${peak.toFixed(3)})`);
  const a = encodeOlivia('TEST', {});
  const b = encodeOlivia('TEST', {});
  check(a.symbols.join('') === b.symbols.join('') && a.samples.some((v, i) => v !== b.samples[i]), 'without a test seed the symbols are fixed but the phase steps are random, as fldigi');

  check(JSON.stringify(textToOliviaBytes('A\nB')) === JSON.stringify([65, 13, 10, 66]), 'line breaks are sent as CR LF');
  check(JSON.stringify(textToOliviaBytes('é')) === JSON.stringify([127, 0xe9 & 127]), 'characters 128-255 use fldigi\'s 8-bit escape (127 + low 7 bits)');
  check(JSON.stringify(textToOliviaBytes('€')) === JSON.stringify([46]), 'characters beyond 255 become "."');
  const e = new OliviaEncoder(3);
  check(e.encodeBlock([0, 0, 0]).length === 64, 'one block is 64 symbols');
}

// --- 3. receiver against the reference --------------------------------------
for (const c of vectors.rxCases) {
  const x = rxInput(c);
  const js = decode(x, { centreHz: c.rxHz, ...FLDIGI });
  const refText = String.fromCharCode(...c.ref.bytes.filter((b) => b > 7));
  const sent = c.text;
  const label = `${c.txHz} Hz signal, receiver at ${c.rxHz} Hz, noise ${c.noise}`;
  check(refText.includes(sent) && js.text.includes(sent), `${label}: both receivers decode ${JSON.stringify(sent.trim())}`);
  check(Math.abs(js.snr - c.ref.snr) < 2e-3 && js.foff === c.ref.foffHz, `${label}: same S/N (${js.snr.toFixed(3)} vs ${c.ref.snr}) and offset (${js.foff} Hz)`);
}

// --- 4. PiRO's defaults --------------------------------------------------------
{
  for (const c of vectors.rxCases) {
    const got = decode(rxInput(c), { centreHz: c.rxHz }).text;
    check(got === c.text, `defaults, ${c.txHz} Hz / noise ${c.noise}: exactly the message, no junk (${JSON.stringify(got)})`);
  }

  let falseChars = 0;
  let fldigiChars = 0;
  let secs = 0;
  for (let s = 1; s <= 6; s++) {
    const x = noisy('X', null, 500 + s);
    secs += x.length / 8000;
    falseChars += decode(x).text.length;
    fldigiChars += decode(x, FLDIGI).text.length;
  }
  check(falseChars === 0, `no characters from ${secs.toFixed(0)} s of plain noise (${falseChars})`);
  check(fldigiChars > 0, `with PiRO's checks off (fldigi, squelch off) the same noise gives junk (${fldigiChars} characters)`);

  const text = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789 ';
  for (const snr of [-10, -13]) {
    const got = decode(noisy(text, snr, 9)).text;
    check(got.includes(text), `full copy at ${snr} dB S/N in 2.5 kHz (${JSON.stringify(got.slice(0, 30))}...)`);
  }

  const msg = 'OFFSET TEST\r\n';
  for (const off of [-120, -60, 0, 60, 120]) {
    const got = decode(noisy(msg, -6, 3, { centreHz: 1500 + off }), { centreHz: 1500 });
    check(got.text === msg && Math.abs(got.foff - off) <= 8, `tuned ${off >= 0 ? '+' : ''}${off} Hz off: decodes, offset read as ${got.foff} Hz`);
  }
  const far = decode(noisy(msg, -6, 3, { centreHz: 1800 }), { centreHz: 1500 });
  check(far.text === '', 'a signal 300 Hz away (well outside the +/-125 Hz search) gives nothing');
  // A neighbour whose tones partly overlap the search window is not decoded,
  // but can leave a few stray characters; the control-code filter removes most.
  let stray = 0;
  let strayFl = 0;
  for (let s = 1; s <= 6; s++) {
    const x = noisy('OFFSET TEST QUICK BROWN FOX\r\n', 8, s, { centreHz: 1720 });
    const a = decode(x, { centreHz: 1500 }).text;
    const b = decode(x, { centreHz: 1500, dropControlBlocks: false }).text;
    if (a.includes('OFFSET')) stray += 1000;
    stray += a.length;
    strayFl += b.length;
  }
  check(stray <= 18 && stray < strayFl, `a strong neighbour 220 Hz away is not decoded; stray characters ${stray} over 6 runs with the filter, ${strayFl} without`);

  const x = noisy(msg, -8, 4);
  const big = decode(x, {}, 8192).text;
  const small = decode(x, {}, 333).text;
  check(big === msg && small === msg, 'output does not depend on how the audio is chunked');

  // 48 kHz path: what the radio gets (TtyBridge upsamples) and what the receive bridge feeds back
  const enc = encodeOlivia('CQ CQ DE VK3TR VK3TR K\r\n', { centreHz: 1800 });
  const pcm = upsampleFloatToPcm(enc.samples, 8000, 48000);
  const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const back = new StreamDecimator(48000, 8000, { cutoffHz: 3000 }).process(Int16Array.from(i16));
  check(decode(back, { centreHz: 1800 }).text === 'CQ CQ DE VK3TR VK3TR K\r\n', 'round trip through 48 kHz audio decodes exactly');
}

// --- 5. text decoding -------------------------------------------------------------
{
  const { hasStrayControl } = require('../src/audio/olivia-rx');
  check(!hasStrayControl([0, 65, 13]) && !hasStrayControl([8, 9, 10]) && hasStrayControl([65, 15, 66]) && hasStrayControl([31, 0, 0]), 'control-code filter: NUL, BS, TAB, LF and CR pass; other codes below 32 drop the block');
  const td = new OliviaTextDecoder();
  check(td.push([0, 72, 105, 1, 7, 8, 13, 10]) === 'Hi\b\r\n', 'NUL and control codes below 8 are dropped; backspace, CR and LF kept');
  check(td.push([127]) === '' && td.push([0x69]) === 'é', 'the 8-bit escape works across calls');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll Olivia checks passed');
