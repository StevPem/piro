'use strict';

/**
 * Audio for LAN clients of icom-lan-server.js: the Icom network protocol's
 * codecs, and streaming sample-rate conversion between PiRO's audio (mono
 * S16LE at AudioBridge's rate, normally 48 kHz) and the rate a client asks
 * for.
 *
 * Codec numbers (as in the stream request a client sends):
 *   0x01 uLaw mono, 0x02 PCM 8-bit mono, 0x04 PCM 16-bit mono,
 *   0x08 PCM 8-bit stereo, 0x10 PCM 16-bit stereo, 0x20 uLaw stereo.
 * 16-bit PCM is little-endian and signed, 8-bit PCM unsigned (128 is
 * silence), uLaw is G.711. Stereo is sent as the same audio in both
 * channels; from a client, the left channel is used. wfview's own Opus and
 * ADPCM codecs (0x40, 0x41, 0x80) are not offered.
 */

const { StreamDecimator } = require('../audio/decimator');
const { designLowpassFir, resampleLinear } = require('../audio/resample');

const CODECS = {
  0x01: { kind: 'ulaw', channels: 1, bytes: 1 },
  0x02: { kind: 'pcm8', channels: 1, bytes: 1 },
  0x04: { kind: 'pcm16', channels: 1, bytes: 2 },
  0x08: { kind: 'pcm8', channels: 2, bytes: 1 },
  0x10: { kind: 'pcm16', channels: 2, bytes: 2 },
  0x20: { kind: 'ulaw', channels: 2, bytes: 1 },
};
const SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

const isSupported = (codec, rate) => !!CODECS[codec] && SAMPLE_RATES.includes(rate);

// G.711 uLaw.
const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;
function ulawEncode(sample) {
  let s = sample;
  let sign = 0;
  if (s < 0) {
    s = -s;
    sign = 0x80;
  }
  if (s > ULAW_CLIP) s = ULAW_CLIP;
  s += ULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
function ulawDecode(byte) {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + ULAW_BIAS) << exponent) - ULAW_BIAS;
  return sign ? -magnitude : magnitude;
}

/** Mono 16-bit samples -> the codec's bytes. */
function encode(samples, codec) {
  const c = CODECS[codec];
  if (!c) throw new Error(`Unsupported Icom audio codec 0x${codec.toString(16)}`);
  const out = Buffer.alloc(samples.length * c.channels * c.bytes);
  let o = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    for (let ch = 0; ch < c.channels; ch++) {
      if (c.kind === 'pcm16') {
        out.writeInt16LE(s, o);
        o += 2;
      } else if (c.kind === 'pcm8') out[o++] = (s >> 8) + 128;
      else out[o++] = ulawEncode(s);
    }
  }
  return out;
}

/** The codec's bytes -> mono 16-bit samples (the left channel of stereo). Incomplete frames at the end are dropped. */
function decode(bytes, codec) {
  const c = CODECS[codec];
  if (!c) throw new Error(`Unsupported Icom audio codec 0x${codec.toString(16)}`);
  const frame = c.channels * c.bytes;
  const n = Math.floor(bytes.length / frame);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * frame;
    if (c.kind === 'pcm16') out[i] = bytes.readInt16LE(o);
    else if (c.kind === 'pcm8') out[i] = (bytes[o] - 128) << 8;
    else out[i] = ulawDecode(bytes[o]);
  }
  return out;
}

const toInt16 = (f) => {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32768)));
  return out;
};

/** Streaming upsampling by a whole factor: zero-stuffing and a low-pass FIR, with state across chunks. */
class StreamInterpolator {
  constructor(factor, inputRate, { taps = 63 } = {}) {
    this.factor = factor;
    this.coeffs = designLowpassFir((inputRate / 2) * 0.9, inputRate * factor, taps);
    this.history = new Float32Array(this.coeffs.length - 1);
  }

  /** @param {Float32Array} x @returns {Float32Array} */
  process(x) {
    const L = this.factor;
    const stuffed = new Float32Array(x.length * L);
    for (let i = 0; i < x.length; i++) stuffed[i * L] = x[i] * L;
    const buf = new Float32Array(this.history.length + stuffed.length);
    buf.set(this.history);
    buf.set(stuffed, this.history.length);
    const taps = this.coeffs.length;
    const out = new Float32Array(stuffed.length);
    for (let k = 0; k < stuffed.length; k++) {
      const pos = this.history.length + k;
      let acc = 0;
      for (let t = 0; t < taps; t++) acc += this.coeffs[t] * buf[pos - t];
      out[k] = acc;
    }
    this.history = buf.slice(buf.length - this.history.length);
    return out;
  }
}

/** A sample-rate converter for one direction, keeping state between chunks. */
function makeResampler(fromRate, toRate) {
  if (fromRate === toRate) return (f) => f;
  if (fromRate > toRate && fromRate % toRate === 0) {
    const d = new StreamDecimator(fromRate, toRate, { cutoffHz: toRate * 0.45 });
    return (f) => d.process(f);
  }
  if (toRate > fromRate && toRate % fromRate === 0) {
    const u = new StreamInterpolator(toRate / fromRate, fromRate);
    return (f) => u.process(f);
  }
  // Not a whole ratio (44.1 kHz from 48 kHz, say): linear, chunk by chunk.
  return (f) => resampleLinear(f, fromRate, toRate);
}

/** PiRO's received audio (S16LE, `channels`, at `fromRate`) -> the client's codec and rate. */
class RxConverter {
  constructor({ fromRate, channels = 1, toRate, codec }) {
    if (!isSupported(codec, toRate)) throw new Error('Unsupported receive codec or rate');
    Object.assign(this, { channels, codec });
    this.resample = makeResampler(fromRate, toRate);
  }

  /** @param {Buffer} pcm S16LE @returns {Buffer} */
  process(pcm) {
    const frames = Math.floor(pcm.length / (2 * this.channels));
    const f = new Float32Array(frames);
    for (let i = 0; i < frames; i++) f[i] = pcm.readInt16LE(i * 2 * this.channels) / 32768;
    return encode(toInt16(this.resample(f)), this.codec);
  }
}

/** A client's transmit audio (its codec and rate) -> S16LE at PiRO's rate and `channels`. */
class TxConverter {
  constructor({ codec, fromRate, toRate, channels = 1 }) {
    if (!isSupported(codec, fromRate)) throw new Error('Unsupported transmit codec or rate');
    Object.assign(this, { codec, channels });
    this.resample = makeResampler(fromRate, toRate);
  }

  /** @param {Buffer} bytes @returns {Buffer} S16LE */
  process(bytes) {
    const mono = decode(bytes, this.codec);
    const f = new Float32Array(mono.length);
    for (let i = 0; i < mono.length; i++) f[i] = mono[i] / 32768;
    const s = toInt16(this.resample(f));
    const out = Buffer.alloc(s.length * 2 * this.channels);
    for (let i = 0; i < s.length; i++) for (let ch = 0; ch < this.channels; ch++) out.writeInt16LE(s[i], (i * this.channels + ch) * 2);
    return out;
  }
}

module.exports = { CODECS, SAMPLE_RATES, isSupported, encode, decode, ulawEncode, ulawDecode, StreamInterpolator, RxConverter, TxConverter };
