// Regenerates test/fixtures/hell-vectors.json and hell-cq-1000hz.i16 from the
// reference program (feld_ref.cpp, fldigi's own Feld-Hell transmit code). See
// third_party/feldhell/README.md.
//
//   node third_party/feldhell/make-fixtures.js /path/to/feld_ref
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeTestRand } = require('../../src/audio/olivia-tx');

const ref = process.argv[2];
if (!ref) {
  console.error('usage: node third_party/feldhell/make-fixtures.js /path/to/feld_ref');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hell-fix-'));
const FIX = path.join(__dirname, '..', '..', 'test', 'fixtures');

function refTx(bytes, toneHz) {
  fs.writeFileSync(path.join(tmp, 'm.txt'), Buffer.from(bytes));
  execFileSync(ref, [String(toneHz), path.join(tmp, 'm.txt'), path.join(tmp, 'm.f32'), path.join(tmp, 'm.sym')], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const audio = new Float32Array(fs.readFileSync(path.join(tmp, 'm.f32')).buffer.slice(0));
  const symbols = fs.readFileSync(path.join(tmp, 'm.sym'), 'utf8').trim();
  return { audio, symbols };
}

/** '0'/'1' string -> base64 of the bits packed MSB first */
function packBits(s) {
  const out = Buffer.alloc(Math.ceil(s.length / 8));
  for (let i = 0; i < s.length; i++) if (s[i] === '1') out[i >> 3] |= 0x80 >> (i & 7);
  return out.toString('base64');
}

const rnd = makeTestRand(20261017);
const words = ['CQ', 'DE', 'VK3TR', 'K', 'RST', '599', 'QTH', 'MELBOURNE', 'NAME', 'STEVE', 'TNX', 'QSO', '73', 'BK', 'FB', 'OM', 'HW?', '5NN', 'feld', 'hell'];
const messages = [
  [[], 1000],
  [[...Buffer.from('E')], 1000],
  [[...Buffer.from('CQ CQ DE VK3TR VK3TR K')], 1000],
  [Array.from({ length: 95 }, (_, i) => 32 + i), 1500], // the whole font
  [[...Buffer.from('line1\r\nline2\n')], 1234.5], // line breaks are sent as spaces
  [[7, 9, 200, 255], 700], // outside the font: blank columns only
];
while (messages.length < 40) {
  const n = 1 + (rnd() % 8);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + words[rnd() % words.length];
  messages.push([[...Buffer.from(s)], 300 + (rnd() % 2401)]);
}

const vectors = messages.map(([bytes, toneHz]) => {
  const { symbols } = refTx(bytes, toneHz);
  return { bytes, toneHz, nSymbols: symbols.length, symbols: packBits(symbols) };
});
fs.writeFileSync(path.join(FIX, 'hell-vectors.json'), JSON.stringify({ generator: 'third_party/feldhell/feld_ref.cpp (fldigi 4.1.23 feld.cxx)', vectors }) + '\n');

const { audio } = refTx([...Buffer.from('CQ DE VK3TR')], 1000);
const i16 = Int16Array.from(audio, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
fs.writeFileSync(path.join(FIX, 'hell-cq-1000hz.i16'), Buffer.from(i16.buffer));
console.log(`wrote ${vectors.length} vectors and a ${(audio.length / 8000).toFixed(2)} s waveform`);
