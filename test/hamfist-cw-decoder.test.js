// Run with: node test/hamfist-cw-decoder.test.js
'use strict';

const {
  HamfistCwDecoder,
  getLetterFromCode,
  isStartOfCode,
  autocorrect,
  isValidCallsign,
  preFilterObservations,
} = require('../src/audio/hamfist-cw-decoder');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

// --- Morse binary-tree lookup (ported from cw_data.cpp) ---
check(getLetterFromCode('.-') === 'A', 'getLetterFromCode decodes ".-" as A');
check(getLetterFromCode('-...') === 'B', 'getLetterFromCode decodes "-..." as B');
check(getLetterFromCode('...') === 'S', 'getLetterFromCode decodes "..." as S');
check(getLetterFromCode('---') === 'O', 'getLetterFromCode decodes "---" as O');
check(getLetterFromCode('-----') === '0', 'getLetterFromCode decodes "-----" as 0');
check(getLetterFromCode('.----') === '1', 'getLetterFromCode decodes ".----" as 1');
check(getLetterFromCode('') === '#', 'getLetterFromCode returns the "not yet a code" sentinel for an empty pattern');
check(isStartOfCode('.') === true, '"." is a valid prefix (E, or the start of many other letters)');
check(isStartOfCode('-.-.--') === false, 'a pattern no real/prosign code ever starts with is rejected');

// --- Dictionary / autocorrect (ported from dictionary.cpp) ---
check(autocorrect('THE') === 'THE', 'autocorrect leaves an exact dictionary match untouched');
check(autocorrect('TEH') !== 'TEH', 'autocorrect corrects a single-edit misspelling to some dictionary word');
check(isValidCallsign('VK3TR') === true, 'VK3TR is a valid callsign shape');
check(isValidCallsign('W1AW/P') === true, 'W1AW/P (with a portable suffix) is a valid callsign shape');
check(isValidCallsign('HELLO') === false, 'an ordinary word is not mistaken for a callsign');
check(isValidCallsign('') === false, 'an empty string is not a valid callsign');

// --- pre_filter_observations (ported from cw_decode.cpp) ---
{
  // A single implausibly-short "off" blip between two "on" marks should
  // be merged away (treated as a glitch, not a real inter-element gap).
  const signal = [
    { mark: true, duration: 60 },
    { mark: false, duration: 2 }, // way under the 8ms hard floor
    { mark: true, duration: 60 },
  ];
  const filtered = preFilterObservations(signal);
  check(filtered.length === 1, `a too-short off-blip between two marks is merged into one long mark, got ${JSON.stringify(filtered)}`);
  check(Math.abs(filtered[0].duration - 122) < 1e-6, 'the merged mark duration is the sum of all three original observations');
}

// --- End-to-end synthetic audio decode ---
// Deterministic PRNG so this test's pass/fail never depends on an
// unseeded random draw (same reasoning as cw-decoder.test.js's own
// mulberry32 helper).
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MORSE = {
  P: '.--.',
  A: '.-',
  R: '.-.',
  I: '..',
  S: '...',
};

function wordToSeq(word, repeatCount) {
  const seq = [];
  for (let r = 0; r < repeatCount; r++) {
    for (const ch of word) {
      const code = MORSE[ch];
      for (let si = 0; si < code.length; si++) {
        seq.push({ on: true, units: code[si] === '.' ? 1 : 3 });
        if (si < code.length - 1) seq.push({ on: false, units: 1 });
      }
      seq.push({ on: false, units: 3 }); // letter gap
    }
    seq.push({ on: false, units: 7 }); // word gap
  }
  return seq;
}

function genSamples(sampleRate, pitchHz, unitMs, amplitude, seq, noiseAmp, rand) {
  const samples = [];
  for (const { on, units } of seq) {
    const n = Math.round((sampleRate * units * unitMs) / 1000);
    for (let i = 0; i < n; i++) {
      const noise = noiseAmp ? (rand() * 2 - 1) * noiseAmp : 0;
      if (on) {
        samples.push(Math.round(amplitude * Math.sin((2 * Math.PI * pitchHz * i) / sampleRate) + noise));
      } else {
        samples.push(Math.round(noise));
      }
    }
  }
  return samples;
}

{
  const sampleRate = 48000;
  const pitchHz = 600;
  const wpm = 20;
  const unitMs = 1200 / wpm;
  const rand = mulberry32(42);

  // Enough repeats to get well past Hamfist's own training window
  // (OBSERVATION_BUFFER_SIZE=50 marks/gaps) and see clean steady-state
  // decode, same expectation cw-decoder.test.js has of CW1.
  const seq = wordToSeq('PARIS', 30);
  const samples = genSamples(sampleRate, pitchHz, unitMs, 8000, seq, 400, rand);

  const decoder = new HamfistCwDecoder({ sampleRate });
  let out = '';
  decoder.on('char', (c) => (out += c));
  decoder.on('space', () => (out += ' '));

  const int16 = new Int16Array(samples);
  const chunkSize = 4096; // feed in realistic audio-bridge-sized chunks, not all at once
  for (let i = 0; i < int16.length; i += chunkSize) {
    decoder.pushSamples(int16.subarray(i, i + chunkSize));
  }

  // The first word or two can come out garbled while the histogram
  // classifier is still training (expected, documented Hamfist
  // behavior — see this decoder's own top-of-file doc comment) — so
  // this checks steady-state decode quality via the tail of the
  // transcript, not an exact full-string match.
  const tail = out.trim().split(/\s+/).slice(-10);
  const correct = tail.filter((w) => w === 'PARIS').length;
  check(
    tail.length > 0 && correct / tail.length >= 0.8,
    `at least 80% of the last ${tail.length} decoded words are "PARIS" in steady state, got ${JSON.stringify(tail)}`
  );
  check(decoder.estimatedWpm > 0, `estimatedWpm reports something positive once decoding, got ${decoder.estimatedWpm}`);
}

// --- reset() clears state ---
{
  const decoder = new HamfistCwDecoder({ sampleRate: 48000 });
  let chars = 0;
  decoder.on('char', () => chars++);

  const seq = wordToSeq('PARIS', 10);
  const samples = new Int16Array(genSamples(48000, 600, 60, 8000, seq, 0, Math.random));
  decoder.pushSamples(samples);
  check(chars > 0, 'sanity: some characters decoded before reset()');

  decoder.reset();
  check(decoder.estimatedWpm === 0, 'reset() clears the active channel, so estimatedWpm goes back to 0');
}

// --- setPitch() is a harmless no-op (API parity with CwDecoder) ---
{
  const decoder = new HamfistCwDecoder({ sampleRate: 48000 });
  check(typeof decoder.setPitch === 'function', 'setPitch() exists for API parity with CwDecoder');
  decoder.setPitch(700); // must not throw
  check(true, 'setPitch() does not throw (this decoder has no single target frequency to set)');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
