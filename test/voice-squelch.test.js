'use strict';

// Run with: node test/voice-squelch.test.js
// The voice squelch (src/audio/voice-squelch.js) on synthetic radio audio:
// band-limited noise (with AGC-like swings and static crashes), carriers,
// and a synthetic voice (harmonics of a wandering pitch, shaped by formants,
// in syllables) at several signal-to-noise ratios and SSB mistunings.
// It was also checked by eye against a real 285 s SSB recording; see
// docs/audio-notes.md.

const { VoiceSquelch, PRE_ROLL_SEC, HANG_SEC } = require('../src/audio/voice-squelch');
const { loadSharedCodec } = require('../src/server/audio-codecs');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

const { rand, gauss, bandNoise, voice, toPcm, R } = require('./fixtures/radio-audio');

let lib;
function squelch(opts = {}) {
  return new VoiceSquelch({ sampleRate: R, makeResampler: (a, b) => new lib.StreamResampler(a, b), ...opts });
}

/**
 * Runs audio through a squelch in 80 ms chunks.
 * @returns {{open: Uint8Array, out: Buffer}} per output sample whether it was open, and the output
 */
function run(signal, sq = squelch()) {
  const pcm = toPcm(signal);
  const open = new Uint8Array(signal.length);
  const out = Buffer.alloc(pcm.length);
  let pos = 0;
  for (let o = 0; o < pcm.length; o += 7680) {
    const chunk = pcm.subarray(o, o + 7680);
    const r = sq.process(chunk);
    const n = chunk.length / 2;
    if (r) {
      r.copy(out, pos * 2);
      for (let i = 0; i < n; i++) open[pos + i] = 1;
    }
    pos += n;
  }
  return { open, out };
}

const openFraction = (open) => open.reduce((a, b) => a + b, 0) / open.length;

/** Open stretches, in input time (output time less the pre-roll delay). */
function stretches(open) {
  const segs = [];
  let st = -1;
  for (let i = 0; i <= open.length; i++) {
    const v = i < open.length ? open[i] : 0;
    if (v && st < 0) st = i;
    if (!v && st >= 0) {
      segs.push([st / R - PRE_ROLL_SEC, i / R - PRE_ROLL_SEC]);
      st = -1;
    }
  }
  return segs;
}

(async () => {
  lib = await loadSharedCodec();

  // --- stays shut on noise, crashes and carriers ---
  check(openFraction(run(bandNoise(30, 0.05)).open) === 0, '30 s of band noise: never opens');
  {
    const n = bandNoise(30, 0.05);
    for (let i = 0; i < n.length; i++) n[i] *= 10 ** (0.5 * Math.sin((2 * Math.PI * i) / R / 3)); // AGC pumping, 10 dB either way
    check(openFraction(run(n).open) === 0, 'noise swinging 20 dB in level (AGC): never opens');
  }
  {
    const n = bandNoise(30, 0.03);
    for (let c = 0; c < 150; c++) {
      const at = Math.floor(rand() * (n.length - 500));
      for (let j = 0; j < 300; j++) n[at + j] += 0.6 * Math.exp(-j / 40) * gauss();
    }
    check(openFraction(run(n).open) === 0, 'noise with 5 static crashes a second: never opens');
  }
  {
    const n = bandNoise(20, 0.03);
    for (let i = 0; i < n.length; i++) n[i] += 0.2 * Math.sin((2 * Math.PI * 1000 * i) / R);
    check(openFraction(run(n).open) === 0, 'a steady carrier: never opens');
  }
  {
    const n = bandNoise(20, 0.03);
    for (let i = 0; i < n.length; i++) n[i] += (0.2 * Math.sin((2 * Math.PI * 1000 * i) / R) + 0.15 * Math.sin((2 * Math.PI * 1170 * i) / R)) * (i < R ? i / R : 1);
    const segs = stretches(run(n).open);
    const total = segs.reduce((a, [s, e]) => a + e - s, 0);
    check(total < 1.5 && segs.every(([s]) => s < 2.5), `two carriers beating at 170 Hz (like a voice's pitch, but steady): open only ${total.toFixed(2)} s, at the start, then shut for good`);
  }
  {
    const n = bandNoise(20, 0.03);
    for (let i = 0; i < n.length; i++) n[i] += 0.15 * Math.sin((2 * Math.PI * 700 * i) / R) * (Math.floor((i / R) * 3) % 2);
    check(openFraction(run(n).open) === 0, 'a keyed carrier (CW): never opens');
  }

  // --- opens on a voice ---
  for (const [snr, shift] of [
    [10, 0],
    [0, 0],
    [-3, 0],
    [0, 300],
    [0, -200],
  ]) {
    const n = bandNoise(14, 0.05);
    const v = voice(3, 0.05 * 10 ** (snr / 20), { shift });
    for (let i = 0; i < v.length; i++) {
      n[2 * R + i] += v[i];
      n[8 * R + i] += v[i];
    }
    const segs = stretches(run(n).open);
    const label = `voice at ${snr} dB SNR${shift ? `, mistuned ${shift > 0 ? '+' : ''}${shift} Hz` : ''}`;
    check(segs.length === 2, `${label}: two overs, two openings (${segs.map(([s, e]) => `${s.toFixed(2)}-${e.toFixed(2)}`).join(', ')} s)`);
    if (snr >= 0) check(segs.length === 2 && segs[0][0] <= 2.05 && segs[1][0] <= 8.05, `${label}: open from the start of each over (the pre-roll covers the detection time)`);
    else check(segs.length === 2 && segs[0][0] <= 2.65 && segs[1][0] <= 8.65, `${label}: open within 0.65 s of the start of each over (weaker voices take longer to recognise)`);
    check(segs.length === 2 && Math.abs(segs[0][1] - (5 + HANG_SEC)) < 0.4 && Math.abs(segs[1][1] - (11 + HANG_SEC)) < 0.4, `${label}: shuts about ${HANG_SEC} s after each over`);
  }
  {
    const n = bandNoise(8, 0.05);
    const v = voice(3, 0.05 * 10 ** (-10 / 20));
    for (let i = 0; i < v.length; i++) n[2 * R + i] += v[i];
    check(openFraction(run(n).open) === 0, 'a voice 10 dB below the noise is too weak: stays shut (switch the squelch off for weak stations)');
  }
  {
    // detection time across pitches, mistunings and syllable phases, at 0 dB SNR
    const delays = [];
    for (let k = 0; k < 8; k++) {
      const n = bandNoise(5, 0.05);
      const v = voice(2.5, 0.05, { shift: (rand() - 0.5) * 400, f0: 90 + rand() * 120 });
      const skip = Math.floor(rand() * R * 0.25);
      for (let i = 0; i + skip < v.length; i++) n[2 * R + i] += v[i + skip];
      const segs = stretches(run(n, squelch({ preRollSec: 0 })).open);
      delays.push(segs.length ? segs[0][0] + PRE_ROLL_SEC - 2 : Infinity);
    }
    check(delays.every((d) => d < PRE_ROLL_SEC), `the voice is recognised within the pre-roll (${delays.map((d) => d.toFixed(2)).join(', ')} s after it starts)`);
  }

  // --- the output itself ---
  {
    const n = bandNoise(6, 0.05);
    const v = voice(3, 0.1);
    for (let i = 0; i < v.length; i++) n[R + i] += v[i];
    const pcm = toPcm(n);
    const { out } = run(n);
    const d = Math.round(PRE_ROLL_SEC * R);
    let same = true;
    for (let i = Math.round(1.5 * R); i < Math.round(3.5 * R); i++) if (out.readInt16LE(2 * (i + d)) !== pcm.readInt16LE(2 * i)) same = false;
    check(same, `while open, the output is the input exactly, ${PRE_ROLL_SEC} s later`);
    let maxStep = 0;
    for (let i = 1; i < out.length / 2; i++) maxStep = Math.max(maxStep, Math.abs(out.readInt16LE(2 * i) - out.readInt16LE(2 * i - 2)));
    check(maxStep < 12000, `opening and closing fade, with no clicks (largest step ${maxStep})`);
  }
  {
    const sq = squelch();
    check(sq.process(Buffer.alloc(9600)) === null && sq.process(Buffer.alloc(0)) === null, 'digital silence or an empty chunk: nothing to send');
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
