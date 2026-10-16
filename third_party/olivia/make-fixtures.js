// Regenerates test/fixtures/olivia-vectors.json and olivia-k-1000hz.i16 from
// the reference program (olivia_ref.cpp, built against fldigi's
// src/include/jalocha headers). See third_party/olivia/README.md.
//
//   node third_party/olivia/make-fixtures.js /path/to/olivia_ref
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeTestRand } = require('../../src/audio/olivia-tx');
const { rxInput } = require('../../test/olivia-fixture-input');

const ref = process.argv[2];
if (!ref) {
  console.error('usage: node third_party/olivia/make-fixtures.js /path/to/olivia_ref');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-fix-'));
const FIX = path.join(__dirname, '..', '..', 'test', 'fixtures');

function refTx(bytes, centre, seed) {
  fs.writeFileSync(path.join(tmp, 'm.txt'), Buffer.from(bytes));
  execFileSync(ref, ['tx', '8', '250', String(centre), String(seed), path.join(tmp, 'm.txt'), path.join(tmp, 'm.f32'), path.join(tmp, 'm.sym')], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const audio = new Float32Array(fs.readFileSync(path.join(tmp, 'm.f32')).buffer.slice(0));
  const symbols = fs
    .readFileSync(path.join(tmp, 'm.sym'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => Number(l.split(' ')[0]));
  return { audio, symbols };
}

function refRx(samples, centre) {
  fs.writeFileSync(path.join(tmp, 'r.f32'), Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  const lines = execFileSync(ref, ['rx', '8', '250', String(centre), path.join(tmp, 'r.f32')]).toString().trim().split('\n');
  const [, snr, , foff] = lines.pop().split(' ');
  return { bytes: lines.map(Number), snr: Number(snr), foffHz: Number(foff) };
}

// --- transmit vectors: [bytes, centreHz, seed, symbols (one digit 0-7 each)]
const rnd = makeTestRand(20261017);
const words = ['CQ', 'DE', 'VK3TR', 'K', 'RST', '599', 'QTH', 'MELBOURNE', 'NAME', 'STEVE', 'TNX', 'QSO', '73', 'BK', 'RIG', 'IC-7300', 'ANT', 'DIPOLE', 'PWR', '50W', 'WX', 'FB', 'OM', 'HW?'];
const messages = [
  [],
  [65],
  [65, 66],
  [65, 66, 67],
  [...Buffer.from('CQ CQ DE VK3TR VK3TR K\r\n')],
  [...Buffer.from('The quick brown fox jumps over the lazy dog. 0123456789')],
  Array.from({ length: 128 }, (_, i) => i), // every 7-bit code
  Array.from({ length: 64 }, (_, i) => 128 + i * 2), // high bytes: the encoder keeps the low 7 bits
];
while (messages.length < 160) {
  const n = 1 + (rnd() % 14);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + words[rnd() % words.length];
  if (rnd() % 3 === 0) s = s.toLowerCase();
  if (rnd() % 4 === 0) s += '\r\n';
  messages.push([...Buffer.from(s)]);
}
const tx = messages.map((bytes, i) => {
  const centre = i < 4 ? 1500 : 400 + (rnd() % 2201);
  const seed = 1 + (rnd() % 100000);
  const r = refTx(bytes, centre, seed);
  return [Buffer.from(bytes).toString('base64'), centre, seed, r.symbols.join('')];
});

// --- one reference waveform: "K" at 1000 Hz, seed 7, as 16-bit samples
{
  const r = refTx([75], 1000, 7);
  const i16 = Int16Array.from(r.audio, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));
  fs.writeFileSync(path.join(FIX, 'olivia-k-1000hz.i16'), Buffer.from(i16.buffer));
}

// --- receive cases: audio made by the (verified) JS encoder plus seeded noise
// (test/olivia-fixture-input.js, shared with the test), decoded by the
// reference receiver with its squelch off, as fldigi with the squelch off
const rxCases = [
  { text: 'CQ CQ DE VK3TR VK3TR K\r\n', txHz: 1500, rxHz: 1500, seed: 1, noise: 0, noiseSeed: 0, leadSec: 1 },
  { text: 'CQ CQ DE VK3TR VK3TR K\r\n', txHz: 1560, rxHz: 1500, seed: 2, noise: 0, noiseSeed: 0, leadSec: 0.3 },
  { text: 'RIG IC-7300 ANT DIPOLE PWR 50W 73 73\r\n', txHz: 1440, rxHz: 1500, seed: 3, noise: 0.5, noiseSeed: 31, leadSec: 2 },
  { text: 'WEAK SIGNAL TEST 1234567890\r\n', txHz: 1500, rxHz: 1500, seed: 4, noise: 2, noiseSeed: 41, leadSec: 1.7 },
  { text: 'NOISY ONE 9876543210\r\n', txHz: 1610, rxHz: 1500, seed: 5, noise: 4, noiseSeed: 51, leadSec: 0.5 },
  { text: 'LOW IN THE BAND\r\n', txHz: 700, rxHz: 700, seed: 6, noise: 1, noiseSeed: 61, leadSec: 0.9 },
  { text: 'HIGH IN THE BAND\r\n', txHz: 2500, rxHz: 2480, seed: 7, noise: 1, noiseSeed: 71, leadSec: 1.1 },
].map((c) => ({ ...c, ref: refRx(rxInput(c), c.rxHz) }));

fs.writeFileSync(
  path.join(FIX, 'olivia-vectors.json'),
  JSON.stringify({ generator: 'third_party/olivia/make-fixtures.js', variant: '8/250', tx, rxCases }) + '\n'
);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${tx.length} transmit vectors, ${rxCases.length} receive cases and olivia-k-1000hz.i16`);

