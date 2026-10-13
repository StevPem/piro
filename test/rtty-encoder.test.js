// Run with: node test/rtty-encoder.test.js
'use strict';

const { encodeRtty, textToBaudot, MAX_CHARS } = require('../src/audio/rtty-encoder');
const { RttyDecoder, FIGS_CODE, LTRS_CODE } = require('../src/audio/rtty-decoder');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = Math.round(f32[i] * 20000);
  return out;
}

function roundTrip(text, { reversedTx = false, reversedRx = false, sampleRate = 48000, noise = 0 } = {}) {
  const enc = encodeRtty(text, { sampleRate, reversed: reversedTx });
  const dec = new RttyDecoder({ sampleRate, reversed: reversedRx });
  let got = '';
  dec.on('char', (c) => (got += c));
  // Idle mark before and after, as on a real band.
  const pcm = toInt16(enc.samples);
  if (noise) {
    let s = 7;
    for (let i = 0; i < pcm.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      pcm[i] = Math.max(-32768, Math.min(32767, pcm[i] + (s / 0x7fffffff - 0.5) * noise));
    }
  }
  dec.pushSamples(pcm);
  dec.pushSamples(new Int16Array(sampleRate / 4));
  return { got, enc };
}

// --- text -> Baudot ---
{
  const r = textToBaudot('cq 73');
  check(r.sent === 'CQ 73', 'lowercase is folded to uppercase');
  check(r.codes.includes(FIGS_CODE), 'digits are preceded by a FIGS shift');
  check(!textToBaudot('CQ').codes.includes(FIGS_CODE) && !textToBaudot('CQ').codes.includes(LTRS_CODE), 'letters alone need no shift code (the transmission opens in LTRS case)');
  const mixed = textToBaudot('A1B');
  const shifts = mixed.codes.filter((c) => c === FIGS_CODE || c === LTRS_CODE);
  check(shifts.length === 2 && shifts[0] === FIGS_CODE && shifts[1] === LTRS_CODE, 'switching to figures and back emits FIGS then LTRS');
  check(textToBaudot('A\nB').codes.filter((c) => c === 8 || c === 2).length === 2, 'newline is sent as CR LF');
  check(textToBaudot('A\r\nB').codes.filter((c) => c === 8 || c === 2).length === 2, 'CRLF is sent as one CR LF, not two');
  const d = textToBaudot('A~Bé');
  check(d.dropped === '~\u00c9' && d.sent === 'AB', 'characters with no ITA2 code are dropped and reported');
  check(textToBaudot('x'.repeat(MAX_CHARS + 50)).sent.length === MAX_CHARS, 'input is capped');
  check(encodeRtty('').samples.length === 0 && encodeRtty('~~~').samples.length === 0, 'nothing sendable produces no audio');
}

// --- audio shape ---
{
  const e = encodeRtty('E', { sampleRate: 48000, leadMs: 100, tailMs: 50 });
  // lead 100ms + LTRS frame + E frame (7.5 bits each) + tail 50ms
  const expected = 0.1 + (2 * 7.5) / 45.45 + 0.05;
  check(Math.abs(e.durationSec - expected) < 0.002, `duration matches the frame arithmetic (${e.durationSec.toFixed(4)} s)`);
  let pk = 0;
  for (const v of e.samples) pk = Math.max(pk, Math.abs(v));
  check(pk <= 0.9 + 1e-6 && pk > 0.85, 'amplitude is honoured');
  check(Math.abs(e.samples[0]) < 1e-6 && Math.abs(e.samples.at(-1)) < 1e-3, 'edges are ramped');
}

// --- round trip through the app's own RTTY decoder ---
for (const text of ['CQ CQ DE VK3TR VK3TR K', 'RYRYRY THE QUICK BROWN FOX 0123456789', 'TEST 599 73 DE VK3TR\r\n']) {
  const { got } = roundTrip(text);
  check(got.replace(/\r/g, '') === text.replace(/\r/g, ''), `round trip: ${JSON.stringify(text)} -> ${JSON.stringify(got)}`);
}
{
  const { got } = roundTrip('CQ DE VK3TR', { reversedTx: true, reversedRx: true });
  check(got === 'CQ DE VK3TR', 'round trip with both ends reversed');
  const wrong = roundTrip('CQ DE VK3TR', { reversedTx: true, reversedRx: false });
  check(wrong.got !== 'CQ DE VK3TR', 'opposite polarity does not decode (the Reverse setting matters)');
  const hi = roundTrip('CQ DE VK3TR', { sampleRate: 12000 });
  check(hi.got === 'CQ DE VK3TR', 'works at a 12 kHz sample rate too');
}
{
  const { got } = roundTrip('CQ CQ DE VK3TR K', { noise: 4000 });
  check(got === 'CQ CQ DE VK3TR K', 'copies with moderate added noise');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll RTTY encoder checks passed');
