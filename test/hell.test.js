// Run with: node test/hell.test.js
//
// Checks the Feld-Hell port (src/audio/hell-font.js, hell-tx.js, hell-rx.js):
//   - the font, generated from fldigi's FeldHell-12.cxx;
//   - 40 messages whose complete half-pixel sequences came from the reference
//     transmitter (third_party/feldhell/feld_ref.cpp, fldigi's own feld.cxx
//     code; fixtures from third_party/feldhell/make-fixtures.js), and one
//     reference waveform;
//   - the receiver: its picture matches what was sent, clean, in noise and
//     off tune, in any chunk size, and through the 48 kHz audio path.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FONT_NAME, FONT_ROWS } = require('../src/audio/hell-font');
const tx = require('../src/audio/hell-tx');
const { HellReceiver, DEFAULT_ROWS, MIN_TONE_HZ, MAX_TONE_HZ } = require('../src/audio/hell-rx');
const { upsampleFloatToPcm } = require('../src/audio/resample');
const { StreamDecimator } = require('../src/audio/decimator');
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

const FIX = path.join(__dirname, 'fixtures');

// --- font
check(FONT_NAME === 'FeldHell-12' && FONT_ROWS.length === 95, 'font: FeldHell-12, 95 characters (32..126)');
check(FONT_ROWS.every((g) => g.length === 14), 'font: 14 rows per character');
check(FONT_ROWS[0].every((r) => r === 0), 'font: space is blank');
check(tx.fontColumn(32, 0) === -1 && tx.fontColumn(31, 0) === -1 && tx.fontColumn(127, 0) === -1, 'font: no columns for space or characters outside the font');
check(tx.charColumns(32) === 5, 'space is five blank columns');

// --- constants
check(tx.PIXEL_RATE === 245 && tx.COLUMN_RATE === 17.5 && tx.COLUMN_LEN === 14, 'Feld-Hell timing: 17.5 columns/s, 14 half-pixels, 245 half-pixels/s');
const { on, off } = tx.keyShapes(1);
check(on[0] === 0 && on[16] === 1 && Math.abs(on[8] - 0.5) < 1e-12 && off[31] === 0 && off[15] === 1, 'key shaping: 2 ms raised cosine on and off');

// --- transmit vectors from the reference
const { vectors } = JSON.parse(fs.readFileSync(path.join(FIX, 'hell-vectors.json'), 'utf8'));
function unpackBits(b64, n) {
  const buf = Buffer.from(b64, 'base64');
  let s = '';
  for (let i = 0; i < n; i++) s += buf[i >> 3] & (0x80 >> (i & 7)) ? '1' : '0';
  return s;
}
let symOk = 0;
let durOk = 0;
for (const v of vectors) {
  const codes = v.bytes.map((b) => (b === 13 || b === 10 ? 32 : b >= 32 && b <= 126 ? b : -1));
  const enc = tx.encodeFeldHell(codes, { toneHz: v.toneHz });
  if (enc.symbols.join('') === unpackBits(v.symbols, v.nSymbols)) symOk++;
  const text = Buffer.from(v.bytes).toString('latin1');
  if (Math.abs(tx.hellDurationSec(text) - enc.symbols.length / tx.PIXEL_RATE) < 1e-9) durOk++;
}
check(symOk === vectors.length, `transmit: ${symOk}/${vectors.length} half-pixel sequences match the reference exactly`);
check(durOk === vectors.length, `transmit: hellDurationSec() exact for ${durOk}/${vectors.length}`);

{
  const ref = new Int16Array(fs.readFileSync(path.join(FIX, 'hell-cq-1000hz.i16')).buffer.slice(0));
  const js = tx.encodeFeldHell('CQ DE VK3TR', { toneHz: 1000 }).samples;
  let maxErr = ref.length === js.length ? 0 : Infinity;
  if (Number.isFinite(maxErr)) for (let i = 0; i < ref.length; i++) maxErr = Math.max(maxErr, Math.abs(ref[i] - Math.round(js[i] * 32767)));
  check(maxErr <= 1, `transmit: reference waveform matches to 1 LSB (${js.length} samples, max diff ${maxErr})`);
}

{
  const enc = tx.encodeFeldHell('Ab\u00e9\u20ac\n', { toneHz: 1000 });
  check(enc.unsupported.join('') === '\u00e9\u20ac', 'transmit: characters outside the font are reported');
  check(Math.abs(enc.symbols.length / tx.PIXEL_RATE - tx.hellDurationSec('Ab\u00e9\u20ac\n')) < 1e-6, 'transmit: duration estimate counts them as gaps');
  check(Math.abs(Math.max(...enc.samples.map(Math.abs)) - 1) < 1e-3, 'transmit: full-scale tone');
}

// --- receive: compare the picture with what was sent
/**
 * Correlation between the received ink and the transmitted half-pixels,
 * sampled at each received pixel's centre (the receiver's own delay found by
 * searching small lags).
 */
function pictureMatch(symbols, columns, rows = DEFAULT_ROWS) {
  const ink = [];
  for (const c of columns) for (let i = 0; i < rows; i++) ink.push(c[i] / 255);
  const pxRate = rows * tx.COLUMN_RATE;
  let best = -1;
  for (let lagMs = 0; lagMs <= 40; lagMs += 2) {
    const xs = [];
    const ys = [];
    for (let k = 0; k < ink.length; k++) {
      const t = (k + 0.5) / pxRate - lagMs / 1000;
      const s = Math.floor(t * tx.PIXEL_RATE);
      if (s < 0 || s >= symbols.length) continue;
      xs.push(symbols[s]);
      ys.push(ink[k]);
    }
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    best = Math.max(best, sxy / Math.sqrt(sxx * syy));
  }
  return best;
}

const TEXT = 'CQ CQ DE VK3TR VK3TR PSE K';
const sent = tx.encodeFeldHell(TEXT, { toneHz: 1000 });
function withNoise(samples, amp, noise, seed) {
  const r = makeTestRand(seed);
  const x = new Float32Array(samples.length + 4000);
  for (let i = 0; i < samples.length; i++) x[i] = samples[i] * amp;
  for (let i = 0; i < x.length; i++) x[i] += noise * gauss(r);
  return x;
}

{
  const rx = new HellReceiver({ toneHz: 1000 });
  const cols = rx.process(sent.samples);
  const expectCols = Math.floor(sent.durationSec * tx.COLUMN_RATE);
  check(Math.abs(cols.length - expectCols) <= 1 && cols.every((c) => c.length === DEFAULT_ROWS), `receive: ${cols.length} columns of ${DEFAULT_ROWS} pixels for ${sent.durationSec.toFixed(2)} s`);
  const m = pictureMatch(sent.symbols, cols);
  check(m > 0.9, `receive: clean picture matches what was sent (r = ${m.toFixed(3)})`);
  const quiet = new HellReceiver({ toneHz: 1000 });
  quiet.process(new Float32Array(16000));
  check(rx.level > 0.1 && quiet.level === 0, `receive: signal level reported (${rx.level.toFixed(2)}; 0 on silence)`);
}
{
  // about 0 dB S/N in 3 kHz: 0.3 amplitude tone, noise sigma 0.21 over 4 kHz
  const x = withNoise(sent.samples, 0.3, 0.25, 7);
  const m = pictureMatch(sent.symbols, new HellReceiver({ toneHz: 1000 }).process(x));
  check(m > 0.7, `receive: readable in noise (r = ${m.toFixed(3)})`);
}
{
  const off = tx.encodeFeldHell(TEXT, { toneHz: 1040 });
  const m = pictureMatch(off.symbols, new HellReceiver({ toneHz: 1000 }).process(off.samples));
  check(m > 0.8, `receive: 40 Hz off tune still readable (r = ${m.toFixed(3)})`);
  // the keying sidebands of a 2 ms shaped signal are only ~24 dB down 400 Hz out, so test well clear of it
  const far = tx.encodeFeldHell(TEXT, { toneHz: 1800 });
  const blank = new HellReceiver({ toneHz: 1000 }).process(withNoise(far.samples, 0.3, 0.02, 3));
  const mf = pictureMatch(far.symbols, blank);
  check(mf < 0.3, `receive: a signal 800 Hz away is not painted (r = ${mf.toFixed(3)})`);
}
{
  const whole = new HellReceiver({ toneHz: 1000 }).process(sent.samples);
  const rx = new HellReceiver({ toneHz: 1000 });
  const pieces = [];
  for (let i = 0, n = 1; i < sent.samples.length; i += n, n = (n * 7 + 3) % 997 + 1) pieces.push(...rx.process(sent.samples.subarray(i, i + n)));
  const same = pieces.length === whole.length && pieces.every((c, i) => c.every((v, j) => v === whole[i][j]));
  check(same, 'receive: same picture in any chunk size');
}
{
  const rx = new HellReceiver({ toneHz: 5000 });
  check(rx.toneHz === MAX_TONE_HZ, 'receive: tone clamped to the top of the passband');
  rx.setTone(50);
  check(rx.toneHz === MIN_TONE_HZ, 'receive: tone clamped to the bottom of the passband');
}
{
  // the server's path: 8 kHz TX upsampled to 48 kHz PCM, then decimated back
  const pcm = upsampleFloatToPcm(tx.encodeFeldHell(TEXT, { toneHz: 1500, amplitude: 0.5 }).samples, 8000, 48000);
  const f = new Float32Array(pcm.length / 2);
  for (let i = 0; i < f.length; i++) f[i] = pcm.readInt16LE(i * 2) / 32768;
  const dec = new StreamDecimator(48000, 8000, { cutoffHz: 3000 });
  const x8 = dec.process(f);
  const m = pictureMatch(tx.encodeFeldHell(TEXT, { toneHz: 1500 }).symbols, new HellReceiver({ toneHz: 1500 }).process(x8));
  check(m > 0.85, `receive: through the 48 kHz audio path (r = ${m.toFixed(3)})`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall Feld-Hell tests passed');
