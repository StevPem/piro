// Run with: node test/hamnoise-filter.test.js
'use strict';

const { HamnoiseFilter, SincResampler } = require('../src/audio/hamnoise-filter');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

/**
 * A fake WASM module standing in for HamNoise's real denoise-cw.wasm /
 * denoise-voice.wasm. Real behavior this needs to reproduce for
 * hamnoise-filter.js's own logic to exercise properly:
 *   - a `memory` export backing Float32Array views for input/output/gains
 *   - denoise_web_set_model() only accepting the one model id this fake
 *     instance was built to expect (mirrors the real two-separate-binaries
 *     architecture — see models/hamnoise/NOTICE.md)
 *   - denoise_web_process_hop() actually transforming inputHop into
 *     outputHop (here: a trivial, deterministic "halve the amplitude"
 *     transform) so a write() -> 'data' round trip can be checked for
 *     something other than silence.
 */
function makeFakeInstance({ expectedModelId, hopLength = 32, inputBins = 17, sampleRate = 9600, failInit = false, failModel = false }) {
  const HOP_BYTES = hopLength * 4;
  const GAIN_BYTES = inputBins * 4;
  const memory = { buffer: new ArrayBuffer(HOP_BYTES * 2 + GAIN_BYTES + 64) };
  const inputPtr = 0;
  const outputPtr = HOP_BYTES;
  const gainsPtr = HOP_BYTES * 2;

  const inputView = new Float32Array(memory.buffer, inputPtr, hopLength);
  const outputView = new Float32Array(memory.buffer, outputPtr, hopLength);

  let resetCount = 0;
  let processHopCalls = 0;
  let nextProcessHopResult = null; // override for a single call, for error-path tests
  let processHopShouldThrow = false;

  const exports = {
    memory,
    denoise_web_init: () => (failInit ? -1 : 0),
    denoise_web_set_model: (id) => (failModel || id !== expectedModelId ? -1 : 0),
    denoise_web_reset: () => {
      resetCount += 1;
    },
    denoise_web_input_ptr: () => inputPtr,
    denoise_web_output_ptr: () => outputPtr,
    denoise_web_gains_ptr: () => gainsPtr,
    denoise_web_sample_rate: () => sampleRate,
    denoise_web_hop_length: () => hopLength,
    denoise_web_input_bins: () => inputBins,
    denoise_web_process_hop: (enabled) => {
      processHopCalls += 1;
      if (processHopShouldThrow) throw new Error('simulated native trap');
      if (nextProcessHopResult !== null) {
        const r = nextProcessHopResult;
        nextProcessHopResult = null;
        return r;
      }
      if (!enabled) return 0;
      for (let i = 0; i < hopLength; i += 1) outputView[i] = inputView[i] * 0.5;
      return 1;
    },
  };

  return {
    instance: { exports },
    // test-only introspection, not part of the real WASM instance shape
    _debug: {
      get resetCount() {
        return resetCount;
      },
      get processHopCalls() {
        return processHopCalls;
      },
      forceNextProcessHopResult(v) {
        nextProcessHopResult = v;
      },
      forceProcessHopThrow(v) {
        processHopShouldThrow = v;
      },
    },
  };
}

// Mirrors hamnoise-filter.js's own MODEL_ID_BY_TARGET — 'classic' (0/1) is
// the filter's default quality as of the real-time-performance fix (see
// that file's own doc comment on its `quality` option), 'v2' (2/3) is the
// opt-in. Tests default to 'classic' to match HamnoiseFilter's own
// default, and pass `quality: 'v2'` explicitly wherever they need to
// exercise the other model generation.
const MODEL_ID_BY_TARGET = {
  classic: { cw: 0, voice: 1 },
  v2: { cw: 3, voice: 2 },
};

function makeHarness({ hopLength = 32, sampleRate = 9600, quality = 'classic', failInitFor = null, failModelFor = null } = {}) {
  const readCalls = [];
  const instances = {}; // target -> { instance, _debug }
  const readFileFn = (p) => {
    readCalls.push(p);
    return Buffer.from(`fake-wasm-bytes:${p}`);
  };
  const instantiateFn = async (bytes) => {
    const path = bytes.toString('utf8').replace(/^fake-wasm-bytes:/, '');
    const target = path.includes('voice') ? 'voice' : 'cw';
    const expectedModelId = MODEL_ID_BY_TARGET[quality][target];
    const fake = makeFakeInstance({
      expectedModelId,
      hopLength,
      sampleRate,
      failInit: failInitFor === target,
      failModel: failModelFor === target,
    });
    instances[target] = fake;
    return fake;
  };
  return { readCalls, instances, readFileFn, instantiateFn };
}

async function flush() {
  // _activateTarget's promise chain needs a couple of microtask turns since
  // it awaits both readFile (sync here, but called through an async fn) and
  // the injected instantiateFn.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function run() {
  // --- start() loads the configured initial target and emits 'ready' ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ target: 'cw', ...h });
    const ready = [];
    filter.on('ready', (t) => ready.push(t));
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    filter.start();
    await flush();
    check(errors.length === 0, 'start() with a valid target reports no error');
    check(ready.length === 1 && ready[0] === 'cw', "start() emits 'ready' with the loaded target");
    check(h.readCalls.length === 1 && /denoise-cw\.wasm$/.test(h.readCalls[0]), 'reads the cw wasm path for target cw');
    filter.stop();
  }

  // --- defaults to the 'voice' target when none is specified ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ ...h });
    const ready = [];
    filter.on('ready', (t) => ready.push(t));
    filter.start();
    await flush();
    check(ready[0] === 'voice', "defaults to 'voice' when no target is configured");
    filter.stop();
  }

  // --- defaults to 'classic' quality (model ids 0/1) when none is specified — the real-time-performance fix's whole point; a harness built for the OTHER quality must reject the request ---
  {
    const h = makeHarness({ quality: 'classic' });
    const filter = new HamnoiseFilter({ target: 'cw', ...h }); // no quality specified
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    filter.start();
    await flush();
    check(errors.length === 0, "defaults to 'classic' quality (matches a harness expecting classic model ids), no model-select error");
  }
  {
    const h = makeHarness({ quality: 'v2' }); // harness only accepts the v2 ids
    const filter = new HamnoiseFilter({ target: 'cw', ...h }); // no quality specified -> requests classic ids
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    filter.start();
    await flush();
    check(errors.length === 1 && /model select failed/.test(errors[0].message), "confirms the default really is 'classic': against a harness that only accepts v2 ids, the default-quality filter's model-select is rejected");
  }

  // --- quality: 'v2' explicitly requests the other model generation ---
  {
    const h = makeHarness({ quality: 'v2' });
    const filter = new HamnoiseFilter({ target: 'voice', quality: 'v2', ...h });
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    const ready = [];
    filter.on('ready', (t) => ready.push(t));
    filter.start();
    await flush();
    check(errors.length === 0, "quality: 'v2' successfully selects the v2 model id against a harness expecting v2");
    check(ready.length === 1, "quality: 'v2' still loads and reports ready normally");
    filter.stop();
  }
  {
    // Same mismatch check in the other direction, for full confidence the
    // quality option actually changes which id gets requested rather than
    // the harness just always accepting whatever is asked.
    const h = makeHarness({ quality: 'classic' });
    const filter = new HamnoiseFilter({ target: 'voice', quality: 'v2', ...h });
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    filter.start();
    await flush();
    check(errors.length === 1 && /model select failed/.test(errors[0].message), "quality: 'v2' against a classic-only harness is rejected, confirming the option actually changes the requested model id");
  }

  // --- write() before start() (or before loading finishes) is a safe no-op ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ ...h });
    const received = [];
    filter.on('data', (c) => received.push(c));
    let threw = false;
    try {
      filter.write(Buffer.from([1, 2, 3, 4]));
    } catch {
      threw = true;
    }
    check(!threw, 'write() before start() does not throw');
    check(received.length === 0, 'write() before start() produces no data');

    filter.start();
    // still loading (promise not yet resolved) — write() must still no-op
    let threw2 = false;
    try {
      filter.write(Buffer.from([1, 2, 3, 4]));
    } catch {
      threw2 = true;
    }
    check(!threw2, 'write() while still loading does not throw');
    check(received.length === 0, 'write() while still loading produces no data');
    await flush();
    filter.stop();
  }

  // --- a full write() round trip: enough samples to fill at least one hop produces denoised 'data' output ---
  {
    const hopLength = 32;
    const h = makeHarness({ hopLength, sampleRate: 48000 }); // same rate in/out -> resampler is ~1:1, easy to reason about
    const filter = new HamnoiseFilter({ sampleRate: 48000, target: 'cw', ...h });
    filter.start();
    await flush();

    const received = [];
    filter.on('data', (c) => received.push(c));

    // Enough S16LE samples to clear the resampler's filter radius and fill
    // several hops (radius 128 + plenty of margin).
    const sampleCount = 4096;
    const buf = Buffer.alloc(sampleCount * 2);
    for (let i = 0; i < sampleCount; i += 1) {
      buf.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * 650 * i) / 48000)), i * 2);
    }
    filter.write(buf);

    check(received.length > 0, "write() with enough samples emits at least one 'data' chunk");
    const totalOutBytes = received.reduce((sum, c) => sum + c.length, 0);
    check(totalOutBytes > 0 && totalOutBytes % 2 === 0, 'emitted data is a whole number of S16LE samples');
    check(h.instances.cw._debug.processHopCalls > 0, 'the active engine actually processed at least one hop');
    filter.stop();
  }

  // --- write() with too few samples to fill a single hop produces no 'data' event (not even an empty one) ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ sampleRate: 9600, target: 'cw', ...h });
    filter.start();
    await flush();
    const received = [];
    filter.on('data', (c) => received.push(c));
    filter.write(Buffer.from([1, 2])); // a single S16LE sample
    check(received.length === 0, 'a too-small write() emits no data event');
    filter.stop();
  }

  // --- setModel() switches target, resets the newly active engine, and loads the second engine lazily (not at construction/start time) ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ target: 'cw', ...h });
    filter.start();
    await flush();
    check(h.instances.voice === undefined, 'the voice engine is not loaded before setModel() requests it');

    const ready = [];
    filter.on('ready', (t) => ready.push(t));
    filter.setModel('voice');
    await flush();
    check(ready.includes('voice'), "setModel('voice') emits 'ready' for the new target");
    check(h.instances.voice !== undefined, 'setModel() lazily loads the second engine');
    check(h.instances.voice._debug.resetCount === 1, 'the newly activated engine is reset exactly once');
    filter.stop();
  }

  // --- setModel() reuses a previously-loaded engine instead of reloading it ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ target: 'cw', ...h });
    filter.start();
    await flush();
    filter.setModel('voice');
    await flush();
    const readCountAfterFirstSwitch = h.readCalls.length;
    filter.setModel('cw');
    await flush();
    filter.setModel('voice');
    await flush();
    check(h.readCalls.length === readCountAfterFirstSwitch, 'switching back to an already-loaded target does not re-read its wasm file');
    check(h.instances.voice._debug.resetCount === 2, 'reusing a cached engine still resets it on each activation');
    filter.stop();
  }

  // --- setModel() to the same target it is already on is a no-op ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ target: 'cw', ...h });
    filter.start();
    await flush();
    const ready = [];
    filter.on('ready', (t) => ready.push(t));
    filter.setModel('cw');
    await flush();
    check(ready.length === 0, 'setModel() to the current target emits no additional ready event');
  }

  // --- setModel() before start() is a no-op (nothing running to switch) ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ ...h });
    let threw = false;
    try {
      filter.setModel('cw');
    } catch {
      threw = true;
    }
    check(!threw, 'setModel() before start() does not throw');
    check(Object.keys(h.instances).length === 0, 'setModel() before start() loads nothing');
  }

  // --- a failed model init emits 'error' and leaves the filter stopped, never throwing ---
  {
    const h = makeHarness({ failInitFor: 'cw' });
    const filter = new HamnoiseFilter({ target: 'cw', ...h });
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    filter.start();
    await flush();
    check(errors.length === 1, 'a failed model init emits exactly one error');
    check(/init failed/.test(errors[0].message), 'the error message explains the init failure');
    check(filter._running === false, 'the filter is stopped after a failed init');
  }

  // --- a failed model select emits 'error' the same way ---
  {
    const h = makeHarness({ failModelFor: 'voice' });
    const filter = new HamnoiseFilter({ target: 'voice', ...h });
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    filter.start();
    await flush();
    check(errors.length === 1, 'a failed model select emits exactly one error');
    check(/model select failed/.test(errors[0].message), 'the error message explains the model-select failure');
    check(filter._running === false, 'the filter is stopped after a failed model select');
  }

  // --- a readFile failure (missing wasm file) emits 'error' rather than throwing/rejecting uncaught ---
  {
    const readFileFn = () => {
      throw new Error('ENOENT: no such file');
    };
    const filter = new HamnoiseFilter({ target: 'cw', readFileFn, instantiateFn: async () => ({ instance: { exports: {} } }) });
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    filter.start();
    await flush();
    check(errors.length === 1, 'a readFile failure emits an error');
    check(/ENOENT/.test(errors[0].message), 'the error message includes the underlying failure');
  }

  // --- a process_hop() runtime error (negative status) emits 'error' and stops the filter ---
  {
    const h = makeHarness({ hopLength: 8, sampleRate: 9600 });
    const filter = new HamnoiseFilter({ sampleRate: 9600, target: 'cw', ...h });
    filter.start();
    await flush();
    h.instances.cw._debug.forceNextProcessHopResult(-1);
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    // enough samples at 1:1 rate to fill one 8-sample hop plus resampler radius
    const buf = Buffer.alloc(600);
    for (let i = 0; i < 300; i += 1) buf.writeInt16LE(1000, i * 2);
    filter.write(buf);
    check(errors.length === 1, 'a negative process_hop status emits an error');
    check(/error status/.test(errors[0].message), 'the error message includes the status');
    check(filter._running === false, 'the filter is stopped after a process_hop error status');
  }

  // --- a process_hop() that throws (native trap) emits 'error' and stops the filter, without crashing ---
  {
    const h = makeHarness({ hopLength: 8, sampleRate: 9600 });
    const filter = new HamnoiseFilter({ sampleRate: 9600, target: 'cw', ...h });
    filter.start();
    await flush();
    h.instances.cw._debug.forceProcessHopThrow(true);
    const errors = [];
    filter.on('error', (e) => errors.push(e));
    const buf = Buffer.alloc(600);
    for (let i = 0; i < 300; i += 1) buf.writeInt16LE(1000, i * 2);
    let threw = false;
    try {
      filter.write(buf);
    } catch {
      threw = true;
    }
    check(!threw, 'a throwing process_hop does not propagate as an uncaught exception');
    check(errors.length === 1, 'a throwing process_hop emits an error');
    check(/process_hop threw/.test(errors[0].message), 'the error message says process_hop threw');
    check(filter._running === false, 'the filter is stopped after a throwing process_hop');
  }

  // --- stop() clears state and is safe to call when never started, or twice in a row ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ target: 'cw', ...h });
    filter.start();
    await flush();
    filter.stop();
    check(filter._running === false, 'stop() clears _running');
    check(filter._active === null, 'stop() clears the active engine reference');

    let threw = false;
    try {
      filter.stop();
    } catch {
      threw = true;
    }
    check(!threw, 'a second stop() call is a safe no-op');

    const neverStarted = new HamnoiseFilter({ ...makeHarness() });
    let threw2 = false;
    try {
      neverStarted.stop();
    } catch {
      threw2 = true;
    }
    check(!threw2, 'stop() is safe to call even if start() was never called');
  }

  // --- a second start() call while already running does not reload the active engine ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ target: 'cw', ...h });
    filter.start();
    await flush();
    const readCountAfterFirstStart = h.readCalls.length;
    filter.start();
    await flush();
    check(h.readCalls.length === readCountAfterFirstStart, 'a second start() call while already running does not re-read the wasm file');
    filter.stop();
  }

  // --- stop() while a load is still in flight does not resurrect state once the load resolves ---
  {
    const h = makeHarness();
    const filter = new HamnoiseFilter({ target: 'cw', ...h });
    const ready = [];
    filter.on('ready', (t) => ready.push(t));
    filter.start();
    filter.stop(); // stop before the async load has resolved
    await flush();
    check(ready.length === 0, "stop() during an in-flight load prevents the deferred 'ready' from reflecting an active state");
    check(filter._active === null, 'the filter is left with no active engine after stop() during an in-flight load');
  }

  // --- SincResampler: a constant input of value v converges to output samples near v well past the filter's startup transient ---
  {
    const output = [];
    const resampler = new SincResampler(48000, 9600, (s) => output.push(s), 32);
    const input = new Float32Array(2000).fill(0.5);
    resampler.process(input);
    check(output.length > 0, 'SincResampler produces output for a long-enough constant input');
    const steadyState = output.slice(-10);
    const allClose = steadyState.every((s) => Math.abs(s - 0.5) < 0.05);
    check(allClose, 'SincResampler settles close to a constant input value well after its startup transient');
  }

  // --- SincResampler: upsampling (toRate > fromRate) produces more samples than it was fed, in roughly the expected ratio ---
  {
    const output = [];
    const resampler = new SincResampler(9600, 48000, (s) => output.push(s), 16);
    const input = new Float32Array(1000).fill(0.25);
    resampler.process(input);
    const ratio = output.length / input.length;
    check(ratio > 4 && ratio < 6, `SincResampler upsampling 9600->48000 produces roughly 5x the samples (got ratio ${ratio.toFixed(2)})`);
  }

  await flush();

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
