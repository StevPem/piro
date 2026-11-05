'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

// onnxruntime-node ships prebuilt native bindings for linux-x64/linux-arm64
// (covers a 64-bit Raspberry Pi OS install — Pi 4/5), darwin-x64/arm64, and
// win32-x64/arm64, but NOT 32-bit linux-arm (armv7). Loaded lazily inside
// _loadModel() rather than at module scope, so a platform without a
// matching binary just fails this ONE decoder's model load (surfaced as an
// 'error' event — see CwDecoderBridge) instead of crashing the whole
// server the moment this file is required.
let ort = null;

const DEFAULT_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'deepcw', 'model.onnx');
const DEFAULT_METADATA_PATH = path.join(__dirname, '..', '..', 'models', 'deepcw', 'model.onnx.json');

const MIN_WINDOW_SECONDS = 5.0; // the model was only ever validated on 5-20s clips — see deepcw-engine's own example
const MAX_WINDOW_SECONDS = 20.0;
const DEFAULT_WINDOW_SECONDS = 8.0;

// Skip running inference on a window that's just noise floor/silence —
// there's nothing to decode, and this is pure CPU otherwise spent on every
// single window for the (common) case of CW mode sitting idle between
// transmissions. Peak rather than RMS, and deliberately generous (a weak
// CW tone still peaks well above background hiss) so a weak-but-real
// signal is never the thing that gets skipped.
const SILENCE_PEAK_THRESHOLD = 0.01;

/**
 * "CW 3" — a from-scratch Node.js port of e04/deepcw-engine's reference
 * decoder (https://github.com/e04/deepcw-engine, itself the model/engine
 * behind https://github.com/e04/web-deep-cw-decoder), adapted to decode
 * continuously against PiRO's live RX stream instead of a single
 * pre-recorded WAV file. Fundamentally different from CW1
 * (cw-decoder.js, a Goertzel filter + fixed-ratio timing classifier) and
 * CW2 (hamfist-cw-decoder.js, an FFT/histogram-classifier/beam-search
 * decoder): this one is a neural network (a small CNN+CTC model, run via
 * ONNX Runtime) that reads a log-magnitude spectrogram and emits
 * characters directly — no Morse timing model, dot/dash classification,
 * or dictionary at all. See models/deepcw/NOTICE.md for where the
 * bundled model/metadata came from and the licensing consequence of
 * bundling it (PiRO is AGPL-3.0-only from this decoder onward).
 *
 * The preprocessing (spectrogram generation) and CTC decode below follow
 * the same recipe as deepcw-engine's own `examples/nodejs/decode_morse.mjs`
 * (reflect-padded framing, a Hann window, a band-limited per-frame DFT
 * over just the bins the model's metadata specifies, log1p
 * normalization, greedy CTC decode) — that's what the model was actually
 * validated against, so there's no reason to invent a different recipe.
 * What's different here is everything around it, needed to turn a
 * "decode one offline clip" example into a continuous decoder:
 *
 *  - **Windowing, not streaming.** The model has no notion of state
 *    carried between inferences — each call decodes one self-contained
 *    clip. So this decoder buffers incoming audio into fixed-length,
 *    NON-overlapping windows (`windowSeconds`, clamped to the model's own
 *    validated 5-20s range) and runs one inference per window, emitting
 *    that whole window's decoded text at once rather than character by
 *    character as CW1/CW2 do. A transmission that happens to straddle a
 *    window boundary can come out truncated or split oddly at that
 *    boundary — a real, accepted limitation of this windowed adaptation,
 *    not something the underlying model itself has.
 *  - **Resampling + anti-alias filtering.** The model expects 3200Hz
 *    mono audio (see model.onnx.json's sample_rate); PiRO's capture rate
 *    is typically 48000Hz. decode_morse.mjs only ever resamples from a
 *    WAV file's own (arbitrary but already-reasonable) rate, so it has
 *    no filtering step at all. Decimating 48000Hz straight down to
 *    3200Hz (15x) without filtering first would alias energy from well
 *    above the model's own 400-1200Hz band of interest down into it, so
 *    a two-pole low-pass (two cascaded one-pole filters, ~12dB/octave)
 *    is applied first — ported from this project's own established
 *    pattern for this exact problem, see hamfist-cw-decoder.js's
 *    top-of-file doc comment for the original instance of it.
 *  - **Silence skipping**, so idle CW-mode time between transmissions
 *    doesn't run a full model inference every single window for nothing.
 *
 * Exposes the same minimal event-driven interface as CwDecoder/
 * HamfistCwDecoder (pushSamples(), 'char'/'space' events, reset(),
 * setPitch() — a no-op, see its own doc comment) so CwDecoderBridge can
 * treat all three decoders identically, plus an 'error' event (model
 * load failure — e.g. no onnxruntime-node binary for this platform/
 * architecture) that CW1/CW2 have no equivalent of, since they have no
 * external model file or native binding to fail to load.
 */
class DeepCwDecoder extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sampleRate=48000] - input PCM sample rate
   * @param {number} [opts.windowSeconds=8] - audio buffered per inference, clamped to [5, 20]
   * @param {string} [opts.modelPath] - defaults to the bundled models/deepcw/model.onnx
   * @param {string} [opts.metadataPath] - defaults to the bundled models/deepcw/model.onnx.json
   */
  constructor({
    sampleRate = 48000,
    windowSeconds = DEFAULT_WINDOW_SECONDS,
    modelPath = DEFAULT_MODEL_PATH,
    metadataPath = DEFAULT_METADATA_PATH,
    inWorker = true,
  } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.windowSeconds = Math.min(MAX_WINDOW_SECONDS, Math.max(MIN_WINDOW_SECONDS, windowSeconds));
    this._modelPath = modelPath;
    this._metadataPath = metadataPath;

    this.metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    this._windowSamples = Math.round(this.windowSeconds * this.metadata.sample_rate);

    const { startBin, stopBin } = frequencyBinRange(
      this.metadata.sample_rate,
      this.metadata.fft_length,
      this.metadata.spectrogram_min_freq_hz,
      this.metadata.spectrogram_max_freq_hz
    );
    if (stopBin - startBin !== this.metadata.spectrogram_frequency_bins) {
      throw new Error(
        `models/deepcw/model.onnx.json is internally inconsistent: expected ${this.metadata.spectrogram_frequency_bins} bins, computed ${stopBin - startBin}`
      );
    }
    this._startBin = startBin;
    this._stopBin = stopBin;

    // Two cascaded one-pole low-pass filters ahead of decimation — see
    // this file's top-of-file doc comment, departure #2.
    const cutoffHz = Math.min(1400, this.metadata.sample_rate / 2.2);
    this._lpfAlpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / this.sampleRate);
    this._lpfState1 = 0;
    this._lpfState2 = 0;

    this._sampleRatioF16 = Math.round((this.metadata.sample_rate * 65536) / this.sampleRate);
    this._sampleAccumF16 = 0;

    this._buffer = new Float32Array(this._windowSamples);
    this._bufferFill = 0;

    // The spectrogram and the model run in a worker thread (deepcw-worker.js)
    // by default. On the main thread they held up everything else the
    // server does, including sending audio to the browsers, for 0.5 s
    // every window on a fast PC and longer on a Pi, which was heard as
    // dropouts in CW mode: onnxruntime-node's run() returns at once but
    // then keeps the main thread busy until the inference is done.
    // inWorker: false runs them here (tests compare the two).
    this._engine = inWorker ? new WorkerEngine({ modelPath, metadata: this.metadata }) : new DeepCwEngine({ modelPath, metadata: this.metadata });
    this._loaded = false;
    this._ready = this._engine
      .load()
      .then(() => {
        this._loaded = true;
      })
      .catch((err) => {
        this.emit('error', new Error(`CW3 (DeepCW) model failed to load from ${this._modelPath}: ${err.message}`));
      });
  }

  /** Stops the worker thread. The decoder can't be used after this. */
  close() {
    this._engine.close();
  }

  reset() {
    this._lpfState1 = 0;
    this._lpfState2 = 0;
    this._sampleAccumF16 = 0;
    this._bufferFill = 0;
  }

  // The model has a fixed working band (400-1200Hz, per model.onnx.json)
  // wide enough to cover any real CW pitch without being told where to
  // look, the same reason CW2 (hamfist-cw-decoder.js) has no single
  // target frequency either. Kept as a no-op purely so CwDecoderBridge
  // can treat all three decoder implementations identically.
  setPitch() {}

  // This model has no Morse timing model to derive a speed estimate
  // from — it reads a spectrogram and emits characters directly, with no
  // dot/dash/unit-length concept anywhere in its output. Unlike CW1/CW2,
  // there's no meaningful number to report here.
  get estimatedWpm() {
    return 0;
  }

  pushSamples(samples) {
    for (let n = 0; n < samples.length; n++) {
      const raw = samples[n] / 32768; // normalize to [-1, 1], matching the WAV-reading convention this model was validated against

      this._lpfState1 += this._lpfAlpha * (raw - this._lpfState1);
      this._lpfState2 += this._lpfAlpha * (this._lpfState1 - this._lpfState2);

      this._sampleAccumF16 += this._sampleRatioF16;
      if (this._sampleAccumF16 < 65536) continue;
      this._sampleAccumF16 -= 65536;

      this._buffer[this._bufferFill++] = this._lpfState2;
      if (this._bufferFill === this._windowSamples) {
        this._bufferFill = 0;
        this._decodeWindow(this._buffer.slice()); // snapshot — _buffer keeps filling immediately after this
      }
    }
  }

  async _decodeWindow(window) {
    let peak = 0;
    for (let i = 0; i < window.length; i++) peak = Math.max(peak, Math.abs(window[i]));
    if (peak < SILENCE_PEAK_THRESHOLD) return; // nothing worth running inference on

    await this._ready;
    if (!this._loaded) return; // model never loaded — already reported via 'error'

    try {
      const text = await this._engine.decode(window);
      for (const c of text) {
        if (c === ' ') this.emit('space');
        else this.emit('char', c);
      }
    } catch (err) {
      this.emit('error', new Error(`CW3 (DeepCW) inference failed: ${err.message}`));
    }
  }
}

/**
 * The model's side: an audio window (at the model's sample rate) to text,
 * by spectrogram, inference and CTC decoding. Runs in the worker thread
 * (deepcw-worker.js), or in-process for tests.
 */
class DeepCwEngine {
  constructor({ modelPath = DEFAULT_MODEL_PATH, metadata }) {
    this.modelPath = modelPath;
    this.metadata = metadata;
    const { startBin, stopBin } = frequencyBinRange(metadata.sample_rate, metadata.fft_length, metadata.spectrogram_min_freq_hz, metadata.spectrogram_max_freq_hz);
    this._window = hannWindow(metadata.fft_length);
    // The DFT's cos/sin values for the bins used, worked out once (see
    // dftTables()), instead of about 9 million Math.cos and Math.sin calls
    // per 8 s window: the spectrogram takes about a tenth of the time.
    this._dft = dftTables(metadata.fft_length, startBin, stopBin);
    this._session = null;
  }

  async load() {
    if (!ort) ort = require('onnxruntime-node');
    this._session = await ort.InferenceSession.create(this.modelPath);
  }

  /** @param {Float32Array} window @returns {Promise<string>} */
  async decode(window) {
    const spectrogram = this.spectrogram(window);
    const outputs = await this._session.run({ [this.metadata.onnx_input_name]: spectrogram });
    return greedyCtcDecode(outputs[this.metadata.onnx_output_name], this.metadata.chars, this.metadata.blank_index);
  }

  close() {}

  /** Ported from deepcw-engine's examples/nodejs/decode_morse.mjs#audioToSpectrogram. */
  spectrogram(audio) {
    if (!ort) ort = require('onnxruntime-node');
    const { data, frames, bins } = this.spectrogramData(audio);
    return new ort.Tensor('float32', data, [1, 1, frames, bins]);
  }

  /** The spectrogram as a plain Float32Array (frames x bins), log1p of the magnitudes. */
  spectrogramData(audio) {
    const fftLength = this.metadata.fft_length;
    const hopLength = this.metadata.hop_length;
    const bins = this.metadata.spectrogram_frequency_bins;

    const pad = Math.floor(fftLength / 2);
    const padded = new Float32Array(audio.length + pad * 2);
    for (let i = 0; i < pad; i++) {
      padded[i] = audio[pad - i];
      padded[pad + audio.length + i] = audio[audio.length - 2 - i];
    }
    padded.set(audio, pad);

    const frames = Math.max(0, 1 + Math.floor((padded.length - fftLength) / hopLength));
    const data = new Float32Array(frames * bins);
    const frame = new Float32Array(fftLength);
    const magnitudes = new Float32Array(bins);
    for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
      const start = frameIndex * hopLength;
      for (let i = 0; i < fftLength; i++) frame[i] = padded[start + i] * this._window[i];
      tabledDftMagnitudes(frame, this._dft, magnitudes);
      for (let bin = 0; bin < bins; bin++) data[frameIndex * bins + bin] = Math.log1p(magnitudes[bin]);
    }
    return { data, frames, bins };
  }
}

/** DeepCwEngine in a worker thread (deepcw-worker.js), with the same load()/decode()/close(). */
class WorkerEngine {
  constructor({ modelPath, metadata }) {
    this._worker = new Worker(path.join(__dirname, 'deepcw-worker.js'), { workerData: { modelPath, metadata } });
    this._worker.unref(); // never keeps the server (or a test) running on its own
    this._pending = new Map();
    this._nextId = 1;
    this._closed = false;
    this._loaded = new Promise((resolve, reject) => {
      this._settleLoad = { resolve, reject };
    });
    this._worker.on('message', (msg) => {
      if (msg.type === 'ready') this._settleLoad.resolve();
      else if (msg.type === 'load-error') this._settleLoad.reject(new Error(msg.message));
      else if (msg.type === 'text' || msg.type === 'decode-error') {
        const p = this._pending.get(msg.id);
        if (!p) return;
        this._pending.delete(msg.id);
        if (msg.type === 'text') p.resolve(msg.text);
        else p.reject(new Error(msg.message));
      }
    });
    const fail = (err) => {
      this._settleLoad.reject(err);
      for (const p of this._pending.values()) p.reject(err);
      this._pending.clear();
    };
    this._worker.on('error', fail);
    this._worker.on('exit', (code) => {
      if (!this._closed) fail(new Error(`the DeepCW worker stopped (exit code ${code})`));
    });
  }

  load() {
    return this._loaded;
  }

  decode(window) {
    if (this._closed) return Promise.reject(new Error('the DeepCW worker has been closed'));
    const id = this._nextId++;
    const copy = Float32Array.from(window); // its buffer is handed over, not copied again
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ type: 'decode', id, window: copy.buffer }, [copy.buffer]);
    });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._worker.terminate();
  }
}

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

function frequencyBinRange(sampleRate, fftLength, minHz, maxHz) {
  const binHz = sampleRate / fftLength;
  return {
    startBin: Math.ceil(minHz / binHz),
    stopBin: Math.floor(maxHz / binHz) + 1,
  };
}

/** A plain per-bin DFT restricted to [startBin, stopBin) — cheaper than a full FFT when only a narrow band (65 of 256 bins here) is ever needed. */
/**
 * cos and sin of the DFT angle for each bin in [startBin, stopBin) and each
 * sample, worked out exactly as selectedDftMagnitudes() does, so the result
 * is the same to the bit.
 */
function dftTables(length, startBin, stopBin) {
  const bins = stopBin - startBin;
  const cos = new Float64Array(bins * length);
  const sin = new Float64Array(bins * length);
  for (let bin = startBin; bin < stopBin; bin++) {
    for (let n = 0; n < length; n++) {
      const angle = (-2 * Math.PI * bin * n) / length;
      cos[(bin - startBin) * length + n] = Math.cos(angle);
      sin[(bin - startBin) * length + n] = Math.sin(angle);
    }
  }
  return { length, bins, cos, sin };
}

/** selectedDftMagnitudes() with the cos/sin looked up in dftTables(), into `out`. */
function tabledDftMagnitudes(frame, { length, bins, cos, sin }, out) {
  for (let b = 0; b < bins; b++) {
    let real = 0;
    let imaginary = 0;
    const row = b * length;
    for (let n = 0; n < length; n++) {
      real += frame[n] * cos[row + n];
      imaginary += frame[n] * sin[row + n];
    }
    out[b] = Math.hypot(real, imaginary);
  }
  return out;
}

/** The DFT as ported, computing every cos/sin as it goes; kept as the reference for tabledDftMagnitudes(). */
function selectedDftMagnitudes(frame, startBin, stopBin) {
  const length = frame.length;
  const output = new Float32Array(stopBin - startBin);
  for (let bin = startBin; bin < stopBin; bin++) {
    let real = 0;
    let imaginary = 0;
    for (let n = 0; n < length; n++) {
      const angle = (-2 * Math.PI * bin * n) / length;
      real += frame[n] * Math.cos(angle);
      imaginary += frame[n] * Math.sin(angle);
    }
    output[bin - startBin] = Math.hypot(real, imaginary);
  }
  return output;
}

/** Standard greedy CTC decode: per frame, take the argmax class; collapse repeats; drop blanks. */
function greedyCtcDecode(logProbs, chars, blankIndex) {
  const [batch, frames, classes] = logProbs.dims;
  if (batch !== 1) throw new Error(`Expected batch size 1, got ${batch}.`);

  let previous = null;
  let decoded = '';
  for (let frame = 0; frame < frames; frame++) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let klass = 0; klass < classes; klass++) {
      const value = logProbs.data[frame * classes + klass];
      if (value > bestValue) {
        bestValue = value;
        bestIndex = klass;
      }
    }

    if (bestIndex === blankIndex) {
      previous = null;
    } else {
      if (bestIndex !== previous) decoded += chars[bestIndex];
      previous = bestIndex;
    }
  }

  return decoded;
}

module.exports = { DeepCwDecoder, DeepCwEngine, selectedDftMagnitudes, tabledDftMagnitudes, dftTables };
