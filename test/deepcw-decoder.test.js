// Run with: node test/deepcw-decoder.test.js
'use strict';

const { performance, monitorEventLoopDelay } = require('perf_hooks');
const { DeepCwDecoder: RealDeepCwDecoder, selectedDftMagnitudes, tabledDftMagnitudes, dftTables } = require('../src/audio/deepcw-decoder');

// Every decoder made here is closed at the end: its worker thread would
// otherwise keep the test process from exiting.
const made = [];
class DeepCwDecoder extends RealDeepCwDecoder {
  constructor(opts) {
    super(opts);
    made.push(this);
  }
}

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
    check(decoder._loaded === true, 'reset() does not force a model reload');
  }

  // --- API parity with CwDecoder/HamfistCwDecoder ---
  {
    const decoder = new DeepCwDecoder({ sampleRate: 48000 });
    check(typeof decoder.setPitch === 'function', 'setPitch() exists for API parity');
    decoder.setPitch(700); // must not throw
    check(decoder.estimatedWpm === 0, 'estimatedWpm reports 0 (this model has no timing-based speed estimate)');
  }

  // --- The faster DFT gives exactly the same numbers as the original ---
  {
    const length = 256;
    const tables = dftTables(length, 8, 73);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    let identical = true;
    for (let k = 0; k < 20 && identical; k++) {
      const frame = Float32Array.from({ length }, () => rnd());
      const a = selectedDftMagnitudes(frame, 8, 73);
      const b = tabledDftMagnitudes(frame, tables, new Float32Array(65));
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) identical = false;
    }
    check(identical, 'looking up the DFT cos/sin values gives bit-for-bit the same magnitudes as computing them each time');
  }

  // --- In the worker thread: the same text, and the server's main thread stays free ---
  {
    const sampleRate = 48000;
    const samples = new Int16Array(genSamples(sampleRate, 650, 1200 / 18, 9000, seqFor('PARIS', 3), 1500));
    const decodeWith = async (inWorker) => {
      const d = new DeepCwDecoder({ sampleRate, windowSeconds: 10, inWorker });
      await d._ready;
      let out = '';
      d.on('char', (c) => (out += c));
      d.on('space', () => (out += ' '));
      for (let i = 0; i < samples.length; i += 960) d.pushSamples(samples.subarray(i, i + 960));
      const h = monitorEventLoopDelay({ resolution: 1 });
      h.enable();
      // a 1 ms timer on the main thread, as the audio sending would be
      let longest = 0;
      let last = performance.now();
      const tick = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 1);
      const t = performance.now();
      await d._decodeWindow(d._buffer.slice(0, d._bufferFill));
      const took = performance.now() - t;
      await new Promise((r) => setTimeout(r, 20));
      clearInterval(tick);
      h.disable();
      return { out, longest, took };
    };
    const local = await decodeWith(false);
    const inWorker = await decodeWith(true);
    check(inWorker.out === local.out && inWorker.out.includes('PARIS'), `the worker decodes the same text as in-process (${JSON.stringify(inWorker.out)})`);
    check(inWorker.longest < 30, `while the worker decodes (${inWorker.took.toFixed(0)} ms), the main thread is never held more than ${inWorker.longest.toFixed(0)} ms (in-process: held ${local.longest.toFixed(0)} ms)`);
  }

  // --- A model that won't load is reported, from the worker too ---
  {
    const d = new DeepCwDecoder({ sampleRate: 48000, modelPath: '/nonexistent/model.onnx' });
    let err = null;
    d.on('error', (e) => (err = e));
    await d._ready;
    check(/CW3 \(DeepCW\) model failed to load from \/nonexistent\/model.onnx/.test(err?.message || ''), `a missing model is reported as an 'error' (${err?.message})`);
    d.pushSamples(new Int16Array(48000 * 9).map((_, i) => (i % 40 < 20 ? 8000 : -8000)));
    await new Promise((r) => setTimeout(r, 100));
    check(true, 'and decoding after that is skipped, not a crash');
  }

  for (const d of made) d.close();

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
