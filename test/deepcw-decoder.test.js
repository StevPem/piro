// Run with: node test/deepcw-decoder.test.js
'use strict';

const { DeepCwDecoder } = require('../src/audio/deepcw-decoder');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

const MORSE = { P: '.--.', A: '.-', R: '.-.', I: '..', S: '...' };

function seqFor(word, repeats) {
  const seq = [];
  for (let r = 0; r < repeats; r++) {
    for (const ch of word) {
      const code = MORSE[ch];
      for (let i = 0; i < code.length; i++) {
        seq.push({ on: true, units: code[i] === '.' ? 1 : 3 });
        if (i < code.length - 1) seq.push({ on: false, units: 1 });
      }
      seq.push({ on: false, units: 3 });
    }
    seq.push({ on: false, units: 7 });
  }
  return seq;
}

function genSamples(sampleRate, pitchHz, unitMs, amplitude, seq, noiseAmp) {
  const samples = [];
  for (const { on, units } of seq) {
    const n = Math.round((sampleRate * units * unitMs) / 1000);
    for (let i = 0; i < n; i++) {
      const noise = noiseAmp ? (Math.random() * 2 - 1) * noiseAmp : 0;
      samples.push(
        on ? Math.round(amplitude * Math.sin((2 * Math.PI * pitchHz * i) / sampleRate) + noise) : Math.round(noise)
      );
    }
  }
  return samples;
}

async function run() {
  // --- Metadata loads and is self-consistent ---
  {
    const decoder = new DeepCwDecoder({ sampleRate: 48000, windowSeconds: 8 });
    check(Array.isArray(decoder.metadata.chars) && decoder.metadata.chars.length > 0, 'bundled model.onnx.json loads with a non-empty character set');
    check(decoder.metadata.sample_rate === 3200, 'bundled model expects 3200Hz audio (as documented)');
  }

  // --- windowSeconds is clamped to the model's validated 5-20s range ---
  {
    const tooShort = new DeepCwDecoder({ sampleRate: 48000, windowSeconds: 1 });
    check(tooShort.windowSeconds === 5, 'windowSeconds below 5 is clamped up to 5');
    const tooLong = new DeepCwDecoder({ sampleRate: 48000, windowSeconds: 100 });
    check(tooLong.windowSeconds === 20, 'windowSeconds above 20 is clamped down to 20');
  }

  // --- Model loads successfully and decodes a clean synthetic signal ---
  {
    const sampleRate = 48000;
    const pitchHz = 650;
    const wpm = 18;
    const unitMs = 1200 / wpm;
    const seq = seqFor('PARIS', 3);
    const samples = new Int16Array(genSamples(sampleRate, pitchHz, unitMs, 9000, seq, 1500));

    const decoder = new DeepCwDecoder({ sampleRate, windowSeconds: 10 });
    let sawError = null;
    decoder.on('error', (err) => (sawError = err));

    await decoder._ready;
    check(sawError === null, `model loads without error, got ${sawError}`);

    let out = '';
    decoder.on('char', (c) => (out += c));
    decoder.on('space', () => (out += ' '));

    const chunkSize = 4096;
    for (let i = 0; i < samples.length; i += chunkSize) {
      decoder.pushSamples(samples.subarray(i, i + chunkSize));
    }
    // The clip (a few seconds of PARIS x3) is shorter than the 10s
    // window, so it never fills on its own — flush what's buffered the
    // same way CwDecoderBridge would on a long enough real transmission.
    if (decoder._bufferFill > 0) {
      await decoder._decodeWindow(decoder._buffer.slice(0, decoder._bufferFill));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    check(out.includes('PARIS'), `a clean synthetic PARIS transmission decodes correctly, got ${JSON.stringify(out)}`);
  }

  // --- Silence never reaches the model (no spurious output, no crash) ---
  {
    const decoder = new DeepCwDecoder({ sampleRate: 48000, windowSeconds: 5 });
    await decoder._ready;
    let out = '';
    decoder.on('char', (c) => (out += c));
    decoder.on('space', () => (out += ' '));

    const silence = new Int16Array(48000 * 6); // 6s of true silence > one 5s window
    decoder.pushSamples(silence);
    await new Promise((resolve) => setTimeout(resolve, 200));
    check(out === '', `a silent window produces no decoded output, got ${JSON.stringify(out)}`);
  }

  // --- reset() clears buffering state without needing to reload the model ---
  {
    const decoder = new DeepCwDecoder({ sampleRate: 48000, windowSeconds: 8 });
    await decoder._ready;
    decoder.pushSamples(new Int16Array(1000).fill(500));
    check(decoder._bufferFill > 0, 'sanity: some samples buffered before reset()');
    decoder.reset();
    check(decoder._bufferFill === 0, 'reset() clears the partially-filled buffer');
    check(decoder._session !== null, 'reset() does not force a model reload');
  }

  // --- API parity with CwDecoder/HamfistCwDecoder ---
  {
    const decoder = new DeepCwDecoder({ sampleRate: 48000 });
    check(typeof decoder.setPitch === 'function', 'setPitch() exists for API parity');
    decoder.setPitch(700); // must not throw
    check(decoder.estimatedWpm === 0, 'estimatedWpm reports 0 (this model has no timing-based speed estimate)');
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
