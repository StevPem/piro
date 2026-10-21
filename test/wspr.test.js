// Run with: node test/wspr.test.js
'use strict';

const codec = require('../src/audio/wspr-codec');
const { decodeWspr } = require('../src/audio/wspr-rx');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

// Channel symbols from WSJT-X's wsprsim -c (the reference encoder).
const WSPRSIM = {
  'K1ABC FN42 37':
    '330020001020131222100323133220200032012322002232110233210221321222033030301210212032132003323032203020201023021112330231212221332000010320132222202332323320031222',
  'PJ4/K1ABC 37':
    '310220001022131020100123131220220230030322022010130031010003323222013010301210032032112203323030223022021023001310310031230021332000010120112222222132323102011022',
  '<PJ4/K1ABC> FK52UD 37':
    '332022223002133202300303131220222012032300200010310013210203103000211010103230210010130021123032201202221203021310130211012201112222032122310020000310101100011202',
  'K1ABC/7 33':
    '330220001022131222100323113020200230032322022232130233030001323220013032301010012030130203123210203222001021001110310211210223132200030122112200202332123120031020',
};

{
  const enc = codec.encodeMessage('K1ABC', 'FN42', 37);
  check(enc.symbols.join('') === WSPRSIM['K1ABC FN42 37'] && enc.message === 'K1ABC FN42 37', 'the encoder matches wsprsim symbol for symbol');
  check(codec.encodeMessage('vk3tr', 'qf22lb', 33).message === 'VK3TR QF22 33', 'callsign and grid are upper-cased; a 6-character grid sends its first 4');
  let threw = false;
  try {
    codec.encodeMessage('VK3TR/P', 'QF22', 30);
  } catch {
    threw = true;
  }
  check(threw && !codec.isPlainCall('VK3TR/P') && codec.isPlainCall('VK3TR') && codec.isPlainCall('G4ABC'), 'only plain callsigns can be sent');
}
{
  check(codec.nhash('K1ABC') === 6521 && codec.nhash('VK3TR') === 1700 && codec.nhash('PJ4/K1ABC') === 19735 && codec.nhash('ABCDEFGHIJKLMNOP') === 15968, 'callsign hash matches wsprd nhash()');
  const dbm = [1, 2, 3, 4, 5].map(codec.wattsToDbm);
  check(dbm.join() === '30,33,37,37,37', `1-5 W go out as ${dbm.join(', ')} dBm`);
  check(codec.normalizeDbm(36) === 37 && codec.normalizeDbm(34) === 33 && codec.normalizeDbm(-3) === 0 && codec.normalizeDbm(99) === 60, 'powers round to the allowed 0/3/7 levels');
}

/** Hard decisions from channel symbols, through the decoder's own deinterleave/Fano/unpack. */
function decodeSymbols(text, hashtab) {
  const sym = [...text].map(Number);
  const soft = Uint8Array.from(sym, (s) => (s >> 1 ? 255 : 0));
  const dec = codec.fano(codec.deinterleave(soft));
  return dec && codec.unpackMessage(dec.data, hashtab);
}
{
  const hashtab = new Map();
  const before = decodeSymbols(WSPRSIM['<PJ4/K1ABC> FK52UD 37'], hashtab);
  check(before && before.message === '<...> FK52UD 37' && before.type === 3, `a type 3 message before its call is known: ${before?.message}`);
  const t1 = decodeSymbols(WSPRSIM['K1ABC FN42 37'], hashtab);
  check(t1 && t1.message === 'K1ABC FN42 37' && t1.type === 1 && t1.grid === 'FN42' && t1.dbm === 37, 'type 1 decodes');
  const t2 = decodeSymbols(WSPRSIM['PJ4/K1ABC 37'], hashtab);
  check(t2 && t2.message === 'PJ4/K1ABC 37' && t2.type === 2, `type 2 (prefix) decodes: ${t2?.message}`);
  const t2s = decodeSymbols(WSPRSIM['K1ABC/7 33'], hashtab);
  check(t2s && t2s.message === 'K1ABC/7 33', `type 2 (suffix) decodes: ${t2s?.message}`);
  const t3 = decodeSymbols(WSPRSIM['<PJ4/K1ABC> FK52UD 37'], hashtab);
  check(t3 && t3.message === '<PJ4/K1ABC> FK52UD 37' && t3.callsign === 'PJ4/K1ABC' && t3.grid === 'FK52UD', `type 3 resolves the hash once the call has been heard: ${t3?.message}`);
}

// A slot of audio: several signals in noise, decoded by the JavaScript port of wsprd.
// mulberry32: a small seeded generator that is white enough for this
let seed = 12345;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
function slot(signals) {
  const n = 114 * 12000;
  const x = new Float32Array(n);
  const sigma = 0.05;
  for (let i = 0; i < n; i++) x[i] = sigma * gauss();
  for (const s of signals) {
    // SNR in 2500 Hz, the WSPR convention
    const amp = Math.sqrt(2 * 10 ** (s.snr / 10) * sigma * sigma * (2500 / 6000));
    const w = codec.synthesize(codec.encodeMessage(...s.msg).symbols, { baseHz: s.hz, amplitude: amp, rampMs: 0 });
    const off = Math.round((1 + s.dt) * 12000);
    for (let i = 0; i < w.length && off + i < n; i++) x[off + i] += w[i];
  }
  return x;
}
{
  const t0 = Date.now();
  const decodes = decodeWspr(
    slot([
      { msg: ['VK3TR', 'QF22', 30], hz: 1460, snr: -20, dt: 0 },
      { msg: ['K1ABC', 'FN42', 37], hz: 1540, snr: -26, dt: 0.6 },
      { msg: ['JA1XYZ', 'PM95', 23], hz: 1541.5, snr: -22, dt: -0.5 },
    ]),
    { deadline: Date.now() + 60000 }
  );
  const ms = Date.now() - t0;
  const by = (call) => decodes.find((d) => d.callsign === call);
  const a = by('VK3TR');
  const b = by('K1ABC');
  const c = by('JA1XYZ');
  check(decodes.length === 3, `three signals decode (${decodes.map((d) => d.message).join(', ')}) in ${ms} ms`);
  check(a && a.message === 'VK3TR QF22 30' && Math.abs(a.audioHz - 1460) < 0.5 && Math.abs(a.dt) <= 0.2 && a.drift === 0, `frequency and time are measured (${a?.audioHz.toFixed(2)} Hz, dt ${a?.dt})`);
  check(b && Math.abs(b.dt - 0.6) <= 0.2 && c && Math.abs(c.dt + 0.5) <= 0.2, 'start-time offsets are found');
  check(b && c && Math.abs(b.audioHz - c.audioHz) < 2, 'two signals 1.5 Hz apart both decode (the stronger is subtracted)');
  check(decodes.every((d, i) => i === 0 || decodes[i - 1].audioHz <= d.audioHz), 'decodes come sorted by frequency');
}
{
  const decodes = decodeWspr(slot([]));
  check(decodes.length === 0, 'noise alone decodes nothing');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall WSPR codec tests passed');
