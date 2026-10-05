// Run with: node test/rtty-decoder.test.js
'use strict';

const {
  RttyDecoder,
  baudotToChar,
  BAUDOT_TABLE,
  FIGS_CODE,
  LTRS_CODE,
  DEFAULT_MARK_HZ,
  DEFAULT_SPACE_HZ,
  DEFAULT_BAUD,
} = require('../src/audio/rtty-decoder');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

// --- Synthetic audio generation helpers ---

// Same deterministic PRNG as test/cw-decoder.test.js, for the same
// reason: reproducible noise trials, not whatever Math.random() happens
// to draw on a given run.
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

const SAMPLE_RATE = 48000;

function genTone(hz, ms, phase, amplitude, noiseAmp, rand) {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const noise = noiseAmp ? (rand() * 2 - 1) * noiseAmp : 0;
    const v = amplitude * Math.sin((2 * Math.PI * hz * phase.t) / SAMPLE_RATE) + noise;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    phase.t++;
  }
  return out;
}

// Reverse-lookup from the real BAUDOT_TABLE, same rationale as
// cw-decoder.test.js's CHAR_TO_MORSE: test fixtures can't silently drift
// out of sync with the real table.
function findCode(ch, shiftState) {
  const key = shiftState === 'FIGS' ? 'figs' : 'ltrs';
  for (let code = 0; code < BAUDOT_TABLE.length; code++) {
    if (BAUDOT_TABLE[code][key] === ch) return code;
  }
  return null;
}

/**
 * Builds a full standard-framed (start + 5 data + 1.5 stop bits) audio
 * character for the given 5-bit code, inserting an automatic LTRS/FIGS
 * shift beforehand if the current `shift` state (mutated in place via
 * the returned value) doesn't already match what's needed for `ch`.
 */
function genChar(code, bitMs, markHz, spaceHz, phase, amplitude, noiseAmp, rand) {
  const chunks = [genTone(spaceHz, bitMs, phase, amplitude, noiseAmp, rand)]; // start bit
  for (let i = 0; i < 5; i++) {
    const isMark = !!(code & (1 << i));
    chunks.push(genTone(isMark ? markHz : spaceHz, bitMs, phase, amplitude, noiseAmp, rand));
  }
  chunks.push(genTone(markHz, bitMs * 1.5, phase, amplitude, noiseAmp, rand)); // 1.5 stop bits
  return chunks;
}

function buildAudio(text, { markHz = DEFAULT_MARK_HZ, spaceHz = DEFAULT_SPACE_HZ, baud = DEFAULT_BAUD, amplitude = 8000, noiseAmp = 0, rand = Math.random } = {}) {
  const bitMs = 1000 / baud;
  const phase = { t: 0 };
  let shift = 'LTRS';
  const chunks = [genTone(markHz, 50, phase, amplitude, noiseAmp, rand)]; // idle mark lead-in
  for (const ch of text) {
    let code = findCode(ch, shift);
    if (code === null) {
      const otherShift = shift === 'LTRS' ? 'FIGS' : 'LTRS';
      code = findCode(ch, otherShift);
      if (code === null) throw new Error(`test helper has no Baudot code for character ${JSON.stringify(ch)}`);
      chunks.push(...genChar(otherShift === 'FIGS' ? FIGS_CODE : LTRS_CODE, bitMs, markHz, spaceHz, phase, amplitude, noiseAmp, rand));
      shift = otherShift;
    }
    chunks.push(...genChar(code, bitMs, markHz, spaceHz, phase, amplitude, noiseAmp, rand));
  }
  return chunks;
}

function decode(decoder, chunks) {
  let output = '';
  const onChar = (c) => (output += c);
  decoder.on('char', onChar);
  for (const chunk of chunks) decoder.pushSamples(chunk);
  decoder.off('char', onChar);
  return output;
}

function run() {
  // --- baudotToChar(): shift-state handling ---
  {
    const { char, shiftState } = baudotToChar(LTRS_CODE, 'FIGS');
    check(char === null && shiftState === 'LTRS', 'LTRS_CODE never produces a character and switches state to LTRS');
  }
  {
    const { char, shiftState } = baudotToChar(FIGS_CODE, 'LTRS');
    check(char === null && shiftState === 'FIGS', 'FIGS_CODE never produces a character and switches state to FIGS');
  }
  {
    const eCode = Object.keys(BAUDOT_TABLE).find((c) => BAUDOT_TABLE[c].ltrs === 'E');
    const { char, shiftState } = baudotToChar(Number(eCode), 'LTRS');
    check(char === 'E' && shiftState === 'LTRS', 'an ordinary letters-case code decodes its letter and leaves shift state unchanged');
  }
  {
    // "2" (W's figures-case slot) — confirms the same code reads
    // differently depending on the current shift state.
    const wCode = Object.keys(BAUDOT_TABLE).find((c) => BAUDOT_TABLE[c].ltrs === 'W');
    const asLetter = baudotToChar(Number(wCode), 'LTRS');
    const asFigure = baudotToChar(Number(wCode), 'FIGS');
    check(asLetter.char === 'W', 'the same 5-bit code reads as "W" in letters case');
    check(asFigure.char === '2', 'and as "2" in figures case — the whole point of the shift mechanism');
  }

  // --- Known US-TTY figures-case assignments that differ between national ITA2 variants ---
  // (see rtty-decoder.js's own doc comment for why these specifically
  // needed a third source to settle) — regression coverage against
  // silently reverting to the wrong (European/plain-ITA2) variant.
  for (const [letter, expectedFigure] of [
    ['S', '\x07'], // BEL, not "'"
    ['J', "'"],
    ['H', '#'], // not "£"
    ['D', '$'],
    ['V', ';'],
    ['Z', '"'], // not "+"
  ]) {
    const code = Number(Object.keys(BAUDOT_TABLE).find((c) => BAUDOT_TABLE[c].ltrs === letter));
    const { char } = baudotToChar(code, 'FIGS');
    check(char === expectedFigure, `US-TTY figures case for "${letter}" is ${JSON.stringify(expectedFigure)}, got ${JSON.stringify(char)}`);
  }

  // --- Constructor defaults match the standard amateur convention ---
  check(DEFAULT_MARK_HZ === 2125, `DEFAULT_MARK_HZ is the standard amateur mark tone (2125Hz), got ${DEFAULT_MARK_HZ}`);
  check(DEFAULT_SPACE_HZ === 2295, `DEFAULT_SPACE_HZ is the standard amateur space tone (2295Hz), got ${DEFAULT_SPACE_HZ}`);
  check(DEFAULT_SPACE_HZ - DEFAULT_MARK_HZ === 170, 'the default mark/space pair is exactly the standard 170Hz shift apart');
  check(Math.abs(DEFAULT_BAUD - 45.45) < 1e-9, `DEFAULT_BAUD is the standard amateur RTTY baud rate (45.45), got ${DEFAULT_BAUD}`);

  {
    const dec = new RttyDecoder();
    check(dec.markHz === DEFAULT_MARK_HZ && dec.spaceHz === DEFAULT_SPACE_HZ, 'RttyDecoder defaults to the standard mark/space tones with no options given');
  }

  // --- Clean-signal decode round trips ---
  {
    const msg = 'CQ CQ DE VK2IO VK2IO K';
    const dec = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    const out = decode(dec, buildAudio(msg));
    check(out === msg, `a clean CQ call round-trips exactly, got ${JSON.stringify(out)}`);
  }

  {
    // Exercises every letter, several FIGS-case digits/punctuation, and
    // multiple LTRS<->FIGS transitions in one message.
    const msg = 'THE QUICK BROWN FOX JUMPS OVER 12345 -/? THE LAZY DOG';
    const dec = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    const out = decode(dec, buildAudio(msg));
    check(out === msg, `a pangram with mixed letters/figures round-trips exactly, got ${JSON.stringify(out)}`);
  }

  {
    // CR/LF pass through as literal control characters — see
    // BAUDOT_TABLE's own doc comment.
    const dec = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    const out = decode(dec, buildAudio('RST 599\r\n73'));
    check(out === 'RST 599\r\n73', `CR/LF decode as literal \\r\\n, got ${JSON.stringify(out)}`);
  }

  // --- Noise robustness (deterministic seeded trials, same convention as cw-decoder.test.js) ---
  {
    const msg = 'RST 599 599 TU 73';
    const rand = mulberry32(12345);
    const dec = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    const out = decode(dec, buildAudio(msg, { noiseAmp: 2000, rand })); // ~4:1 amplitude SNR
    check(out === msg, `a moderately noisy signal (4:1 amplitude SNR) still decodes exactly, got ${JSON.stringify(out)}`);
  }

  {
    // Heavier noise is allowed to garble output, but must never throw.
    const rand = mulberry32(999);
    const dec = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    let threw = false;
    try {
      decode(dec, buildAudio('CQ CQ DE VK2IO', { noiseAmp: 6000, rand }));
    } catch {
      threw = true;
    }
    check(!threw, 'heavy noise degrades gracefully (no exception), even if it garbles the decoded text');
  }

  // --- Pure noise / silence: no false decodes, no exceptions ---
  {
    const rand = mulberry32(7);
    const dec = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    let sawChar = false;
    dec.on('char', () => {
      sawChar = true;
    });
    const n = SAMPLE_RATE; // 1s of pure noise, no tone at all
    const noise = new Int16Array(n);
    for (let i = 0; i < n; i++) noise[i] = Math.round((rand() * 2 - 1) * 3000);
    dec.pushSamples(noise);
    check(!sawChar, 'a full second of pure noise (no real mark/space tone at all) never falsely decodes a character');
  }

  {
    const dec = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    let sawChar = false;
    dec.on('char', () => {
      sawChar = true;
    });
    dec.pushSamples(new Int16Array(SAMPLE_RATE)); // 1s of true silence
    check(!sawChar, 'true silence never falsely decodes a character');
  }

  // --- reset() clears mid-character and shift state ---
  {
    const dec = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    let out = '';
    dec.on('char', (c) => (out += c));
    // Feed a FIGS-shift followed by only a partial next character (cut
    // off mid-frame), so the decoder is left both mid-frame AND in FIGS
    // shift state.
    const bitMs = 1000 / DEFAULT_BAUD;
    const phase = { t: 0 };
    const partial = [
      genTone(DEFAULT_MARK_HZ, 50, phase, 8000, 0, Math.random),
      ...genChar(FIGS_CODE, bitMs, DEFAULT_MARK_HZ, DEFAULT_SPACE_HZ, phase, 8000, 0, Math.random),
      genTone(DEFAULT_SPACE_HZ, bitMs, phase, 8000, 0, Math.random), // start bit of a new char, then nothing more
    ];
    for (const chunk of partial) dec.pushSamples(chunk);
    check(out === '', 'sanity: a FIGS shift alone (and a lone cut-off start bit) produces no character yet');

    dec.reset();

    // If shift state or frame state leaked across reset(), decoding an
    // ordinary letters-only message afterward would come out wrong
    // (either missing/garbled from a still-in-progress frame, or with
    // digits/punctuation instead of letters from a stuck FIGS state).
    const msg = 'HELLO WORLD';
    out = decode(dec, buildAudio(msg));
    check(out === msg, `reset() clears both shift state and any in-progress frame, got ${JSON.stringify(out)}`);
  }

  // --- setTones()/two independent decoders don't share state ---
  {
    const decA = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    const decB = new RttyDecoder({ sampleRate: SAMPLE_RATE, markHz: 1275, spaceHz: 1445 }); // a different (still 170Hz) tone pair
    check(decA.markHz === DEFAULT_MARK_HZ, "decoder A keeps the default tones when B's are overridden");
    check(decB.markHz === 1275 && decB.spaceHz === 1445, 'markHz/spaceHz are independently configurable per instance, not guessed/hardcoded');

    const msg = 'DE VK2IO';
    const outA = decode(decA, buildAudio(msg)); // built with decA's own default tones
    const outB = decode(decB, buildAudio(msg, { markHz: 1275, spaceHz: 1445 })); // built with decB's tones
    check(outA === msg && outB === msg, `both a default-tuned and a custom-tuned decoder correctly decode audio built for their own tones, got ${JSON.stringify({ outA, outB })}`);

    decA.setTones(1275, 1445);
    check(decA.markHz === 1275 && decA.spaceHz === 1445, 'setTones() retunes an existing decoder');
  }

  // --- reversed polarity: real bug found, see rtty-decoder.js's own constructor doc comment ---
  // RTTY normal-vs-reversed polarity genuinely isn't predictable from the
  // radio's mode alone — it depends on both stations' equipment — so a
  // signal transmitted with the opposite polarity from whatever this
  // decoder assumes previously decoded nothing at all, with no way to
  // recover short of code changes. `reversed`/setReversed() fixes that.
  {
    // "Reversed" audio: what a normal-convention decoder would call the
    // stop-bit/mark tone is transmitted at spaceHz here, and vice versa —
    // simulating a real off-air signal using the opposite polarity
    // convention from this decoder's own default assumption.
    const msg = 'CQ CQ DE VK2IO';
    const reversedAudio = buildAudio(msg, { markHz: DEFAULT_SPACE_HZ, spaceHz: DEFAULT_MARK_HZ });

    const normalDec = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    const normalOut = decode(normalDec, reversedAudio);
    check(
      normalOut !== msg,
      `a reversed-polarity signal does NOT decode against a normal (non-reversed) decoder — confirms the bug this fixes actually reproduces, got ${JSON.stringify(normalOut)}`
    );

    const reversedDec = new RttyDecoder({ sampleRate: SAMPLE_RATE, reversed: true });
    check(
      reversedDec.markHz === DEFAULT_SPACE_HZ && reversedDec.spaceHz === DEFAULT_MARK_HZ,
      'reversed: true at construction swaps which base tone is treated as mark vs space'
    );
    const reversedOut = decode(reversedDec, reversedAudio);
    check(
      reversedOut === msg,
      `the same reversed-polarity audio decodes correctly once the decoder is also told to reverse, got ${JSON.stringify(reversedOut)}`
    );

    // setReversed() toggles an existing (already-constructed, non-reversed) decoder.
    const toggled = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    check(toggled.reversed === false, 'reversed defaults to false — no behavior change for a signal that was already decoding fine');
    toggled.setReversed(true);
    check(
      toggled.markHz === DEFAULT_SPACE_HZ && toggled.spaceHz === DEFAULT_MARK_HZ,
      'setReversed(true) swaps markHz/spaceHz on an existing decoder'
    );
    check(decode(toggled, reversedAudio) === msg, 'setReversed(true) makes a previously-failing reversed signal decode correctly');
    toggled.setReversed(false);
    check(
      toggled.markHz === DEFAULT_MARK_HZ && toggled.spaceHz === DEFAULT_SPACE_HZ,
      'setReversed(false) swaps back to the original (non-reversed) tones'
    );

    // setTones() and setReversed() are independent: retuning frequencies
    // doesn't silently un-reverse, and reversing doesn't forget a custom
    // tone pair set via setTones().
    const combined = new RttyDecoder({ sampleRate: SAMPLE_RATE });
    combined.setReversed(true);
    combined.setTones(1275, 1445);
    check(
      combined.markHz === 1445 && combined.spaceHz === 1275,
      'setTones() after setReversed(true) applies the new base frequencies but keeps the reversed swap'
    );
    combined.setReversed(false);
    check(
      combined.markHz === 1275 && combined.spaceHz === 1445,
      'setReversed(false) after setTones() reverts to the (new) base pair in its normal order, not the tones from before setTones() was called'
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

run();
