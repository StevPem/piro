// Run with: node test/hell-ocr.test.js
// The Feld-Hell text reader, through the real chain: PiRO's transmitter
// (hell-tx.js), noise, the receiver (hell-rx.js), then the reader.
'use strict';

const { encodeFeldHell } = require('../src/audio/hell-tx');
const { HellReceiver } = require('../src/audio/hell-rx');
const { HellTextReader, renderColumn } = require('../src/audio/hell-ocr');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

let seed = 1;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/?';
function message() {
  const w = [];
  for (let i = 0; i < 7; i++) {
    let s = '';
    for (let j = 2 + Math.floor(rnd() * 5); j > 0; j--) s += ALPH[Math.floor(rnd() * ALPH.length)];
    w.push(s);
  }
  return w.join(' ');
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Sends `text` after `leadSec` of noise, at `snrDb` (in 3 kHz); `clock` scales the receiver's column rate. */
function readBack(text, { snrDb = 30, clock = 1, leadSec = 1.3, offHz = 0, preamble = false, reader } = {}) {
  const enc = encodeFeldHell(text, { toneHz: 1000 + offHz, amplitude: 0.5, preamble });
  const pre = Math.round(8000 * leadSec);
  const x = new Float32Array(pre + enc.samples.length + 8000 * 3);
  x.set(enc.samples, pre);
  const sigma = Math.sqrt((0.125 / 10 ** (snrDb / 10)) * (4000 / 3000));
  for (let i = 0; i < x.length; i++) x[i] += sigma * gauss();
  const rx = new HellReceiver({ toneHz: 1000, columnRate: 17.5 * clock });
  const rd = reader ?? new HellTextReader();
  let out = '';
  for (let i = 0; i < x.length; i += 800) out += rd.push(rx.process(x.subarray(i, i + 800)));
  return (out + rd.flush()).trim();
}

function cer(snrDb, clock = 1, n = 6) {
  let errors = 0;
  let chars = 0;
  for (let k = 0; k < n; k++) {
    const m = message();
    errors += editDistance(m, readBack(m, { snrDb, clock, leadSec: 1 + rnd() }));
    chars += m.length;
  }
  return (100 * errors) / chars;
}

// --- the templates ---
{
  const t = renderColumn(0b11111111111111, 20);
  const half = renderColumn(0b00000001111111, 20);
  check(t.every((v) => v === 1) && half.slice(0, 10).every((v) => v === 1) && half.slice(10).every((v) => v === 0), 'a column renders to 20 samples in time order (bit 0 first)');
}

// --- clean signals ---
{
  seed = 1;
  const text = 'CQ CQ DE VK2IO VK2IO QF56 PSE K';
  check(readBack(text) === text, 'a clean message reads back exactly');
  check(readBack(text, { preamble: true }) === `${text}...`, "with fldigi's . . . before and after: the closing dots are read, the opening ones are too small to start the text");
  check(readBack('cq de vk2io') === 'CQ De Vk2IO', 'lower case reads as capitals where the font draws it like them, and as lower case where it does not (e, k)');
  check(readBack('A  B') === 'A B', 'a gap of a space or more is one space');
}

// --- noise, timing and tuning ---
{
  seed = 7;
  const rows = [
    [20, 1, 2],
    [5, 1, 3],
    [0, 1, 6],
    [-3, 1, 15],
    [10, 0.999, 3],
    [10, 1.001, 3],
    [10, 0.997, 5],
    [10, 1.003, 5],
  ];
  for (const [snr, clock, limit] of rows) {
    const e = cer(snr, clock);
    check(e <= limit, `${snr} dB, receiver timing ${((clock - 1) * 100).toFixed(1)}%: ${e.toFixed(1)}% of characters wrong (limit ${limit}%)`);
  }
  const e6 = cer(-6);
  console.log(`  (-6 dB: ${e6.toFixed(1)}% wrong; by then the picture is the thing to read)`);
  seed = 3;
  const text = 'CQ CQ DE VK2IO VK2IO QF56 PSE K';
  check(readBack(text, { snrDb: 10, offHz: 20 }) === text && readBack(text, { snrDb: 10, offHz: -20 }) === text, 'a signal 20 Hz off the tone reads the same');
}

// --- noise alone prints nothing ---
{
  seed = 11;
  const rx = new HellReceiver({ toneHz: 1000 });
  const rd = new HellTextReader();
  const block = new Float32Array(8000);
  let out = '';
  for (let s = 0; s < 120; s++) {
    for (let i = 0; i < block.length; i++) block[i] = 0.1 * gauss();
    out += rd.push(rx.process(block));
  }
  out += rd.flush();
  check(out.trim() === '', `two minutes of noise alone: no characters (${JSON.stringify(out)})`);
}

// --- a long stream: memory is trimmed and reading carries on ---
{
  seed = 5;
  const rd = new HellTextReader();
  const rx = new HellReceiver({ toneHz: 1000 });
  const parts = [];
  let out = '';
  for (let k = 0; k < 4; k++) {
    const m = message();
    parts.push(m);
    const enc = encodeFeldHell(m, { toneHz: 1000, amplitude: 0.5, preamble: false });
    const x = new Float32Array(enc.samples.length + 8000 * 4);
    x.set(enc.samples, 8000);
    const sigma = Math.sqrt((0.125 / 10 ** 1) * (4000 / 3000));
    for (let i = 0; i < x.length; i++) x[i] += sigma * gauss();
    for (let i = 0; i < x.length; i += 800) out += rd.push(rx.process(x.subarray(i, i + 800)));
  }
  out += rd.flush();
  check(rd.base > 0 && rd.y.length < 20000, `old samples are dropped as it goes (${rd.y.length} kept)`);
  const e = editDistance(parts.join(' '), out.trim().replace(/ +/g, ' '));
  check(e <= 4, `four messages one after another all read (${e} differences): ${JSON.stringify(out.trim())}`);
}

// --- the trace ---
{
  seed = 2;
  const rd = new HellTextReader({ trace: true });
  readBack('HELLO', { reader: rd });
  const printed = rd.trace.filter((t) => t.printed).map((t) => t.ch).join('');
  check(printed === 'HELLO' && rd.trace.every((t) => t.q <= 1), 'with opts.trace, every character read is recorded with its quality');
}

console.log(failures ? `\n${failures} test(s) failed.` : '\nall Feld-Hell text reader tests passed');
process.exit(failures ? 1 : 0);
