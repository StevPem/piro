'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MODEL_DIR = path.join(__dirname, '..', '..', 'models', 'hamnoise');

// Two separately-compiled WASM binaries, not one model with a runtime
// switch — see models/hamnoise/NOTICE.md. 'cw' only understands the CW
// model id below, 'voice' only understands the voice model id; asking
// either one to select the other's id fails (denoise_web_set_model()
// returns nonzero, see denoise_web.c's denoise_web_model_supported()).
const DEFAULT_WASM_PATHS = {
  cw: path.join(MODEL_DIR, 'denoise-cw.wasm'),
  voice: path.join(MODEL_DIR, 'denoise-voice.wasm'),
};

// denoise_web_set_model()'s model-id enum from denoise_web.c:
//   0 = CW (older "classic" single-GRU model)
//   1 = VOICE_REDUCTION (older "classic" single-GRU model)
//   2 = VOICE_V2 (current band-split-RNN model)
//   3 = CW_V2 (current band-split-RNN model)
// HamNoise's own web app (web/src/hooks/useDenoise.ts's effectiveModelId)
// defaults to the v2 ids and only falls back to the classic ones behind an
// opt-in "legacy" toggle most users never touch. This bundle does NOT do
// the same, and that's a deliberate reversal from this feature's first
// version (which did default to v2) — see the 'quality' constructor
// option's own doc comment below for why: v2 is roughly 100x too expensive
// to run in real time on a Raspberry Pi, this app's actual deployment
// target.
const MODEL_ID_BY_TARGET = {
  classic: { cw: 0, voice: 1 },
  v2: { cw: 3, voice: 2 },
};

// Filter radii — tap count per output sample is `2*radius+1`, and
// SincResampler's cost scales linearly with it (confirmed by direct
// profiling: radius 128->32 measured a ~4x reduction in downsample cost).
// HamNoise's own `denoise-worklet.js` originally used 128/16 here,
// appropriate for a general-purpose browser denoiser where CPU headroom
// isn't a concern. This app's actual signal is narrowband ham radio audio
// (CW tones around a few hundred Hz; voice/SSB roughly 300-3000Hz)
// resampled to/from a fixed 9600Hz — nowhere near needing a stopband that
// steep, so these radii are cut to what this bandwidth actually needs,
// trading a wider transition band / slightly higher stopband ripple
// (inaudible on this material) for a large, necessary speedup on a
// Raspberry Pi. See hamnoise-filter.js's own class doc comment and
// docs/audio-notes.md for the full real-time-performance story this is
// part of.
const DOWNSAMPLE_FILTER_RADIUS = 32;
const UPSAMPLE_FILTER_RADIUS = 8;

// Resolution of SincResampler's precomputed weight table: this many table
// entries per unit of tap distance, linearly interpolated between for any
// real-valued distance in between. 64 entries/unit keeps interpolation
// error far below 16-bit audio's own quantization noise floor (the
// windowed-sinc weight function is smooth enough that linear interpolation
// at this density is visually indistinguishable from the exact curve), while
// keeping the table itself small (radius*2*64+1 entries — a few KB even at
// DOWNSAMPLE_FILTER_RADIUS's 128).
const SINC_TABLE_RESOLUTION = 64;

/**
 * Windowed-sinc resampler: ported, essentially verbatim (parameterized on
 * fromRate/toRate instead of reading a global `sampleRate`, since this runs
 * outside an AudioWorkletGlobalScope), from HamNoise's own
 * `web/public/denoise-worklet.js` (`SincResampler`) — same project, same
 * AGPL-3.0 license as the WASM binaries this file loads, so this is already
 * covered by models/hamnoise/NOTICE.md rather than a separate attribution.
 * Used both to bring 48kHz (or whatever the configured AUDIO_SAMPLE_RATE
 * is) capture audio down to the 9600Hz the HamNoise engines are fixed to,
 * and to bring their 9600Hz output back up — unlike RNNoise's integration
 * (rnnoise-filter.js), which has no resampling step at all and simply
 * requires the configured capture rate to already match what RNNoise
 * expects, this filter works at any capture rate.
 *
 * **The filter weight is precomputed into a lookup table, not evaluated
 * per sample.** HamNoise's own original (`denoise-worklet.js`) computes
 * each tap's windowed-sinc weight by calling `Math.sin`/`Math.cos` three
 * times — PER TAP, PER OUTPUT SAMPLE — directly in the hot loop. That's
 * fine on the desktop/laptop-class CPU an AudioWorklet normally runs on,
 * but profiling THIS integration (after a real-time-performance bug report
 * — a Raspberry Pi became unresponsive the moment HamNoise was enabled,
 * CPU pinned at 100%) found it was actually the dominant cost here, not
 * HamNoise's neural model: with DOWNSAMPLE_FILTER_RADIUS=128 (257 taps),
 * that's roughly 771 transcendental function calls per output sample, and
 * measurement showed this resampling step consuming ~98% of write()'s
 * total CPU time even with HamNoise's cheapest ("classic") model selected
 * — the raw `denoise_web_process_hop()` call itself measured under 1% of
 * the real-time budget it covers. Since the windowed-sinc weight is a pure
 * function of tap distance alone (fixed per resampler instance, since it
 * only depends on `cutoffNorm`/`radius`, both constant for the instance's
 * lifetime), it's computed once per instance into `weightTable` here, and
 * `sampleAt()`'s hot loop does a table lookup + linear interpolation
 * instead of calling `Math.sin`/`Math.cos` at all. The resulting values
 * are the same filter — this is a real-time-performance fix, not a design
 * change — see `_computeWeight()` for the exact same math HamNoise's own
 * code uses.
 */
class SincResampler {
  constructor(fromRate, toRate, onSample, radius) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.onSample = onSample;
    this.radius = radius;
    this.step = fromRate / toRate;
    this.position = 0;
    this.baseIndex = -radius;
    this.buffer = new Array(radius).fill(0);
    this.cutoff = Math.min(fromRate, toRate) * 0.475;
    this.cutoffNorm = this.cutoff / fromRate;

    this._tableResolution = SINC_TABLE_RESOLUTION;
    const tableSize = radius * 2 * this._tableResolution + 1;
    this._weightTable = new Float64Array(tableSize);
    for (let i = 0; i < tableSize; i += 1) {
      const distance = i / this._tableResolution - radius;
      this._weightTable[i] = this._computeWeight(distance);
    }
  }

  /** The exact windowed-sinc weight formula HamNoise's own `denoise-worklet.js` evaluates per tap — called only here, at construction time, to fill `_weightTable` once rather than on every `sampleAt()` call. See this class's own doc comment. */
  _computeWeight(distance) {
    const absDistance = Math.abs(distance);
    if (absDistance > this.radius) return 0;
    const sincArg = 2 * this.cutoffNorm * distance;
    const sinc = Math.abs(sincArg) < 1e-8 ? 1 : Math.sin(Math.PI * sincArg) / (Math.PI * sincArg);
    const x = absDistance / this.radius;
    const window = 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
    return 2 * this.cutoffNorm * sinc * window;
  }

  /** Looks up a tap's precomputed weight for an arbitrary real-valued `distance` in [-radius, radius], linearly interpolating between the two nearest table entries — see this class's own doc comment for why this replaces calling `_computeWeight()` directly in the hot path. */
  _weightAt(distance) {
    const idx = (distance + this.radius) * this._tableResolution;
    const i0 = Math.floor(idx);
    const w0 = this._weightTable[i0] ?? 0;
    const w1 = this._weightTable[i0 + 1] ?? w0;
    return w0 + (w1 - w0) * (idx - i0);
  }

  process(input) {
    for (let i = 0; i < input.length; i += 1) this.buffer.push(input[i]);

    const lastIndex = this.baseIndex + this.buffer.length - 1;
    while (this.position + this.radius <= lastIndex) {
      this.onSample(this.sampleAt(this.position));
      this.position += this.step;
    }

    const keepFrom = Math.floor(this.position) - this.radius - 1;
    const drop = Math.max(0, keepFrom - this.baseIndex);
    if (drop > 0) {
      this.buffer.splice(0, drop);
      this.baseIndex += drop;
    }
  }

  sampleAt(position) {
    const center = Math.floor(position);
    let acc = 0;
    let weightSum = 0;

    for (let index = center - this.radius; index <= center + this.radius; index += 1) {
      const sample = this.buffer[index - this.baseIndex] ?? 0;
      const distance = position - index;
      if (Math.abs(distance) > this.radius) continue;

      const weight = this._weightAt(distance);
      acc += sample * weight;
      weightSum += weight;
    }

    return Math.abs(weightSum) > 1e-8 ? acc / weightSum : 0;
  }
}

/**
 * Loads and runs HamNoise's prebuilt WASM denoising engines
 * (https://github.com/e04/HamNoise, AGPL-3.0, see models/hamnoise/
 * NOTICE.md) in-process, with no subprocess/FIFO plumbing at all — unlike
 * every other native-binary integration in this project's audio pipeline
 * (rnnoise-filter.js, rade-pipeline.js), Node has built-in WebAssembly
 * support, and HamNoise's own WASM build turns out to need no imports
 * whatsoever (confirmed via `WebAssembly.Module.imports()` against the
 * actual bundled binaries — `memory` is *exported*, not imported), so
 * `WebAssembly.instantiate(bytes, {})` is all loading requires.
 *
 * **Two engines, not one with a mode switch.** HamNoise ships `denoise-
 * cw.wasm` and `denoise-voice.wasm` as separately-compiled binaries, each
 * understanding only its own model (see models/hamnoise/NOTICE.md and this
 * file's own MODEL_ID_BY_TARGET comment) — there is no single "set CW vs
 * voice" parameter on one instance. `setModel('cw'|'voice')` therefore
 * loads (and, after the first use, reuses) a genuinely separate WASM
 * instance per target rather than reconfiguring one; both instances are
 * cheap enough to keep resident simultaneously once loaded (~19-22MB of
 * WASM linear memory each, confirmed empirically — trivial next to a
 * Raspberry Pi's RAM) so switching back and forth (e.g. the operator
 * flips between CW and a voice mode mid-session) never re-pays
 * instantiation cost after the first time each target is used. Switching
 * targets resets the newly-active engine's internal state (via
 * `denoise_web_reset()`) and this filter's own resamplers, same
 * "never resume with stale state" rule this project applies everywhere
 * else a mode switch happens (e.g. CwDecoderBridge's own `_setVariant()`).
 *
 * **Why this needs no dry/wet mixing, output-latency ramping, or
 * model-fade crossfade**, unlike HamNoise's own `denoise-worklet.js`
 * (which this file's SincResampler is ported from): all of that machinery
 * exists there to keep a live Web Audio *playback* graph glitch-free under
 * real-time scheduling constraints (buffer underruns, click-free parameter
 * changes while actively driving speakers). This filter instead sits in
 * the same role as RnnoiseFilter — a chunk-in/chunk-out transform on
 * whatever PCM AudioBridge hands it, broadcast to clients, never played
 * back through a live low-latency graph
 * here — so none of that complexity is needed: `write()` is always fully
 * wet when enabled (no partial blend), and a `setModel()` switch simply
 * accepts a brief, infrequent discontinuity (the operator changing
 * between CW and a voice mode is not a hot path) rather than carrying over
 * a crossfade implementation to avoid an inaudible-in-practice click.
 *
 * The two v2 engines always report `produced=1` on every hop once
 * running (confirmed from HamNoise's own source,
 * `web/wasm/v2/voice_v2_engine.cpp`'s `bsrnn_process_hop()` — there's no
 * FFT-overlap warm-up period the way HamNoise's older "classic" models
 * have), but `_acceptHopSample()` still defends against a `produced <= 0`
 * reply by emitting silence for that hop rather than assuming success,
 * in case a future HamNoise build changes this.
 *
 * **`quality: 'classic'` (the default) vs `'v2'` — a real-time-performance
 * trade-off, not just a quality one.** HamNoise ships two generations of
 * model per target: the newer band-split-RNN ("v2") models HamNoise's own
 * web app defaults to, and the older, much simpler single-GRU ("classic")
 * models it keeps around behind an opt-in toggle. A user report of the
 * whole server becoming unresponsive (100% CPU, no error logged — because
 * nothing was actually failing, it just couldn't keep up) the moment
 * HamNoise was enabled led to measuring actual per-hop cost directly
 * against these exact bundled binaries: on a fast x86 development machine,
 * a single `denoise_web_process_hop()` call for the v2 models took ~36%
 * (CW) to ~53% (voice) of the real-time budget for the audio it covers —
 * single-threaded, synchronous, directly on `AudioBridge`'s own event-loop
 * thread (see audio-bridge.js's own doc comment on `_writeHamNoiseFilterSafely()`
 * for why that matters). A Raspberry Pi's single-core performance is a
 * fraction of that development machine's, so the v2 models can exceed
 * 100% of real time per hop there — meaning they cannot keep up at all,
 * each new captured chunk arrives before the last one finishes processing,
 * and the backlog (and CPU usage) only grows, pinning the process at 100%
 * CPU and starving everything else on the same thread (CI-V comms, other
 * WebSocket traffic) — exactly the reported symptom, and not something any
 * try/catch can fix, since the event loop is busy rather than throwing.
 * The classic models measured at roughly 100x cheaper per hop on the same
 * machine (~0.4% of real time) — trivial headroom even on much slower
 * hardware — at the cost of real but more dated denoising quality (no
 * band-splitting, a single GRU rather than HamNoise's newer architecture).
 * Given this app's actual deployment target is a Raspberry Pi, not a
 * desktop browser, `quality` defaults to `'classic'`; `'v2'` remains
 * available (`HAMNOISE_QUALITY=v2`, see README.md) for anyone running this
 * on hardware fast enough to keep up with it, at their own risk of
 * hitting the same stall otherwise.
 *
 * Events: 'data' (Buffer, denoised PCM — same S16LE-mono shape as the
 * input), 'error' (Error, from a failed WASM load/init/model-select or a
 * `process_hop` failure — `stop()` is called first, mirroring every other
 * filter in this pipeline), 'ready' (fired once the initially-requested
 * target has finished loading and `write()` calls actually start
 * producing output, useful for tests; not required for normal use since
 * `write()` silently no-ops until ready, same posture as RnnoiseFilter's
 * `write()` no-op-ing before its subprocess is up).
 */
class HamnoiseFilter extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sampleRate=48000] - the PCM rate write() will be called with; resampled internally to/from HamNoise's fixed 9600Hz
   * @param {'cw'|'voice'} [opts.target='voice'] - which model to load first
   * @param {'classic'|'v2'} [opts.quality='classic'] - which model generation to use for BOTH targets (see this class's own doc comment for the real-time-performance reasoning) — fixed for this filter's lifetime, not switchable via setModel()
   * @param {{cw?: string, voice?: string}} [opts.wasmPaths] - override the bundled WASM file paths (for testing)
   * @param {Function} [opts.instantiateFn] - injectable for testing; (bytes) => Promise<WebAssembly.WebAssemblyInstantiatedSource>, defaults to WebAssembly.instantiate
   * @param {Function} [opts.readFileFn] - injectable for testing; defaults to fs.readFileSync
   */
  constructor({ sampleRate = 48000, target = 'voice', quality = 'classic', wasmPaths, instantiateFn, readFileFn } = {}) {
    super();
    this.sampleRate = sampleRate;
    this._target = target === 'cw' ? 'cw' : 'voice';
    this._quality = quality === 'v2' ? 'v2' : 'classic';
    this._wasmPaths = { ...DEFAULT_WASM_PATHS, ...wasmPaths };
    this._instantiate = instantiateFn ?? ((bytes) => WebAssembly.instantiate(bytes, {}));
    this._readFile = readFileFn ?? fs.readFileSync;
    this._engines = {}; // target -> engine view (see _loadEngine()); cached for the filter's lifetime
    this._active = null;
    this._downsampler = null;
    this._upsampler = null;
    this._hopFill = 0;
    this._pendingOutput = [];
    this._running = false;
    this._ready = null;
  }

  /** Begins loading the initially-requested target. Safe to call once; a second call while already running is a no-op. write() silently drops audio until loading finishes. */
  start() {
    if (this._running) return;
    this._running = true;
    this._ready = this._activateTarget(this._target);
  }

  /**
   * Switches between the 'cw' and 'voice' models — see this class's own
   * doc comment for why this loads/reuses a genuinely separate WASM
   * instance rather than reconfiguring the active one. A no-op if not
   * running or already on the requested target.
   */
  setModel(target) {
    const next = target === 'cw' ? 'cw' : 'voice';
    if (!this._running || next === this._target) return;
    this._target = next;
    this._ready = this._activateTarget(next);
  }

  /** Feeds a chunk of raw S16LE mono PCM through the active engine; emits 'data' with however many denoised samples came out the other side of resampling (may be zero for a very short chunk). No-op if not running or still loading. */
  write(buffer) {
    if (!this._running || !this._active) return;
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount === 0) return;

    const floatIn = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) floatIn[i] = buffer.readInt16LE(i * 2) / 32768;

    this._pendingOutput.length = 0;
    this._downsampler.process(floatIn);
    if (this._pendingOutput.length === 0) return;

    const out = Buffer.alloc(this._pendingOutput.length * 2);
    for (let i = 0; i < this._pendingOutput.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, this._pendingOutput[i]));
      out.writeInt16LE(Math.round(clamped * 32767), i * 2);
    }
    this.emit('data', out);
  }

  /** Stops accepting audio and drops all loaded WASM instances (there's no explicit teardown API to call — see this class's own doc comment — they're simply left for GC). Safe to call even if start() was never called. */
  stop() {
    if (!this._running) return;
    this._running = false;
    this._active = null;
    this._downsampler = null;
    this._upsampler = null;
    this._hopFill = 0;
    this._pendingOutput.length = 0;
    this._engines = {};
  }

  async _activateTarget(target) {
    try {
      let engine = this._engines[target];
      if (!engine) {
        engine = await this._loadEngine(target);
        if (!this._running) return; // stop() ran while loading; don't resurrect state
        this._engines[target] = engine;
      }
      if (!this._running) return;
      this._active = engine;
      engine.exports.denoise_web_reset();
      this._hopFill = 0;
      this._pendingOutput.length = 0;
      this._downsampler = new SincResampler(
        this.sampleRate,
        engine.denoiseRate,
        (sample) => this._acceptHopSample(sample),
        DOWNSAMPLE_FILTER_RADIUS
      );
      this._upsampler = new SincResampler(
        engine.denoiseRate,
        this.sampleRate,
        (sample) => this._pendingOutput.push(sample),
        UPSAMPLE_FILTER_RADIUS
      );
      this.emit('ready', target);
    } catch (err) {
      this.emit('error', new Error(`hamnoise-filter: ${err.message}`));
      this.stop();
    }
  }

  async _loadEngine(target) {
    const bytes = this._readFile(this._wasmPaths[target]);
    const { instance } = await this._instantiate(bytes);
    const exports = instance.exports;

    const initStatus = exports.denoise_web_init();
    if (initStatus !== 0) throw new Error(`"${target}" model init failed (status ${initStatus})`);
    const modelStatus = exports.denoise_web_set_model(MODEL_ID_BY_TARGET[this._quality][target]);
    if (modelStatus !== 0) throw new Error(`"${target}" model select failed (status ${modelStatus})`);

    const hopLength = exports.denoise_web_hop_length();
    const inputBins = exports.denoise_web_input_bins();
    return {
      exports,
      denoiseRate: exports.denoise_web_sample_rate(),
      hopLength,
      // Views over the WASM instance's own linear memory — zero-copy I/O,
      // the same contract denoise-worklet.js's refreshWasmViews() uses.
      // Assumes this memory never grows after load (it's exported, not
      // imported, and nothing in HamNoise's own browser integration calls
      // memory.grow() either — see this class's own doc comment); if a
      // future HamNoise build ever did grow its memory, these views would
      // go stale/detached and this would need to re-derive them per call.
      inputHop: new Float32Array(exports.memory.buffer, exports.denoise_web_input_ptr(), hopLength),
      outputHop: new Float32Array(exports.memory.buffer, exports.denoise_web_output_ptr(), hopLength),
      gains: new Float32Array(exports.memory.buffer, exports.denoise_web_gains_ptr(), inputBins),
    };
  }

  _acceptHopSample(sample) {
    // A single write() can feed many samples through the resampler's
    // process() loop in one synchronous pass (see SincResampler.process()).
    // If an earlier sample in that same pass already triggered stop() (a
    // process_hop failure below calls this.stop()), _active is now null —
    // the loop has no way to know that happened partway through and will
    // keep calling this method for the samples still buffered. Bail out
    // rather than dereferencing a null engine.
    if (!this._active) return;
    const engine = this._active;
    engine.inputHop[this._hopFill] = sample;
    this._hopFill += 1;
    if (this._hopFill < engine.hopLength) return;
    this._hopFill = 0;

    let produced;
    try {
      produced = engine.exports.denoise_web_process_hop(1);
    } catch (err) {
      this.emit('error', new Error(`hamnoise-filter: process_hop threw (${err.message})`));
      this.stop();
      return;
    }
    if (produced < 0) {
      this.emit('error', new Error(`hamnoise-filter: process_hop returned error status ${produced}`));
      this.stop();
      return;
    }
    if (produced > 0) {
      this._upsampler.process(engine.outputHop);
    } else {
      // See this class's own doc comment — not expected for the v2
      // engines this filter always uses, but handled defensively.
      this._upsampler.process(new Float32Array(engine.hopLength));
    }
  }
}

module.exports = { HamnoiseFilter, SincResampler };
