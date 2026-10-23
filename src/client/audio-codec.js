// Compressed audio, shared by the browser and the server.
//
// The browser loads this as an ES module; the server loads the same file
// with import() (see server/audio-codecs.js), so both ends always agree on
// the format. Nothing here touches browser or Node globals.
//
// Two compressed formats are used for remote access (see
// docs/audio-notes.md):
// - Opus at 16 kHz (about 24 kbit/s). The server uses opusscript; the
//   browser uses WebCodecs (AudioDecoder / AudioEncoder) when it has them.
// - IMA ADPCM at 12 kHz (48 kbit/s), in plain JavaScript, for browsers
//   without WebCodecs Opus. Each frame carries its own starting state, so
//   a lost or skipped frame does no harm to the next.
// Plain 16-bit PCM at the server's rate (768 kbit/s at 48 kHz) stays the
// default on a LAN.

export const OPUS_RATE = 16000;
export const ADPCM_RATE = 12000;
export const FRAME_MS = 20;
export const ADPCM_FRAME_SAMPLES = (ADPCM_RATE * FRAME_MS) / 1000; // 240
export const OPUS_FRAME_SAMPLES = (OPUS_RATE * FRAME_MS) / 1000; // 320

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
  1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8];

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/**
 * One frame of IMA ADPCM: a 4-byte header (first sample as int16 LE, the
 * step index, a zero byte), then 4 bits per following sample, low nibble
 * first. An odd final nibble is padded with zero.
 * @param {Int16Array} samples
 * @returns {Uint8Array}
 */
export function adpcmEncode(samples) {
  const n = samples.length;
  const out = new Uint8Array(4 + Math.ceil(Math.max(0, n - 1) / 2));
  if (!n) return out.subarray(0, 4);
  let pred = samples[0];
  // start the step near the signal's size, so the first few samples follow it
  let maxDelta = 0;
  for (let i = 1; i < Math.min(n, 16); i++) maxDelta = Math.max(maxDelta, Math.abs(samples[i] - samples[i - 1]));
  let index = 0;
  while (index < 88 && STEPS[index] < maxDelta / 4) index++;
  out[0] = pred & 0xff;
  out[1] = (pred >> 8) & 0xff;
  out[2] = index;
  out[3] = 0;
  for (let i = 1; i < n; i++) {
    const step = STEPS[index];
    let diff = samples[i] - pred;
    let code = 0;
    if (diff < 0) {
      code = 8;
      diff = -diff;
    }
    let delta = step >> 3;
    if (diff >= step) {
      code |= 4;
      diff -= step;
      delta += step;
    }
    if (diff >= step >> 1) {
      code |= 2;
      diff -= step >> 1;
      delta += step >> 1;
    }
    if (diff >= step >> 2) {
      code |= 1;
      delta += step >> 2;
    }
    pred = clamp16(code & 8 ? pred - delta : pred + delta);
    index = Math.min(88, Math.max(0, index + INDEX_ADJUST[code & 7]));
    const k = i - 1;
    out[4 + (k >> 1)] |= k & 1 ? code << 4 : code;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes - one frame from adpcmEncode()
 * @param {number} [count] - samples to return (default: as many as the frame holds)
 * @returns {Int16Array}
 */
export function adpcmDecode(bytes, count) {
  if (bytes.length < 4) return new Int16Array(0);
  const n = count ?? 1 + (bytes.length - 4) * 2;
  const out = new Int16Array(n);
  let pred = (bytes[0] | (bytes[1] << 8)) << 16 >> 16;
  let index = Math.min(88, bytes[2]);
  if (n) out[0] = pred;
  for (let i = 1; i < n; i++) {
    const k = i - 1;
    const b = bytes[4 + (k >> 1)];
    if (b === undefined) break;
    const code = k & 1 ? b >> 4 : b & 15;
    const step = STEPS[index];
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    pred = clamp16(code & 8 ? pred - delta : pred + delta);
    index = Math.min(88, Math.max(0, index + INDEX_ADJUST[code & 7]));
    out[i] = pred;
  }
  return out;
}

/** Windowed-sinc low-pass (Hamming), unity gain at DC. */
function lowpass(cutoffHz, rate, taps) {
  if (taps % 2 === 0) taps++;
  const c = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  const fc = cutoffHz / rate;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const s = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    c[i] = s * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += c[i];
  }
  for (let i = 0; i < taps; i++) c[i] /= sum;
  return c;
}

/**
 * Streaming sample-rate converter for any pair of rates: a low-pass FIR at
 * the input rate (below the lower of the two Nyquist limits), evaluated
 * only where an output sample falls, with linear interpolation between
 * the two nearest input positions. Keeps its history between calls, so
 * chunks of any size can be fed.
 */
export class StreamResampler {
  constructor(inRate, outRate, { taps = 97 } = {}) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    this.passthrough = inRate === outRate;
    const cutoff = 0.4 * Math.min(inRate, outRate);
    this.coeffs = this.passthrough ? null : lowpass(cutoff, inRate, taps);
    // one more sample of history than the filter needs, so an output that
    // falls between the last two samples of one chunk can use both
    this.hist = new Float32Array(this.coeffs ? this.coeffs.length : 0);
    this.p = this.coeffs ? this.coeffs.length - 1 : 0; // next output position, as an index into history + input
  }

  /**
   * @param {Float32Array} x - input samples (-1..1)
   * @returns {Float32Array}
   */
  process(x) {
    if (this.passthrough) return x.slice();
    const c = this.coeffs;
    const taps = c.length;
    const h = this.hist.length;
    const buf = new Float32Array(h + x.length);
    buf.set(this.hist);
    buf.set(x, h);
    const fir = (j) => {
      let acc = 0;
      for (let t = 0; t < taps; t++) acc += c[t] * buf[j - t];
      return acc;
    };
    const out = new Float32Array(Math.max(0, Math.ceil((buf.length - this.p) / this.step)) + 2);
    let k = 0;
    let p = this.p;
    while (true) {
      const j = Math.floor(p);
      const f = p - j;
      if (f > 1e-9 ? j + 1 >= buf.length : j >= buf.length) break;
      out[k++] = f > 1e-9 ? fir(j) * (1 - f) + fir(j + 1) * f : fir(j);
      p += this.step;
    }
    this.p = p - (buf.length - h);
    this.hist = buf.slice(buf.length - h);
    return out.subarray(0, k);
  }
}

export function int16ToFloat(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Collects samples and hands them out in frames of exactly `size`. */
export class FrameBuffer {
  constructor(size, Type = Int16Array) {
    this.size = size;
    this.buf = new Type(size);
    this.fill = 0;
  }

  /** @returns {Array} complete frames (copies) */
  push(x) {
    const frames = [];
    let i = 0;
    while (i < x.length) {
      const n = Math.min(this.size - this.fill, x.length - i);
      this.buf.set(x.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.size) {
        frames.push(this.buf.slice());
        this.fill = 0;
      }
    }
    return frames;
  }
}
