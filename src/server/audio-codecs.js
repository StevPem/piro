'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { OpusCodec } = require('../audio/opus-codec');

/**
 * The server's half of compressed audio for remote use. The formats live
 * in ../client/audio-codec.js, which the browser loads too, so both ends
 * share one copy; it is an ES module, hence import() (loadSharedCodec()).
 *
 * RX (radio -> browsers): one RxEncoder per format, shared by every
 * browser that asked for that format, and only while at least one does.
 * TX (browser -> radio): one TxDecoder per browser sending compressed mic
 * audio (Opus decoders keep state between packets).
 */

const SHARED_URL = pathToFileURL(path.join(__dirname, '..', 'client', 'audio-codec.js')).href;
const DEFAULT_OPUS_BITRATE = 24000;
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];

let sharedPromise = null;
/** @returns {Promise<object>} the exports of src/client/audio-codec.js */
function loadSharedCodec() {
  sharedPromise ??= import(SHARED_URL);
  return sharedPromise;
}

/** S16LE Buffer (any byte offset) -> Float32Array. */
function bufferToFloat(buf) {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(2 * i) / 32768;
  return out;
}

function int16ToBuffer(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
}

class RxEncoder {
  /**
   * @param {'opus'|'adpcm'} kind
   * @param {number} sampleRate - the server's audio rate
   * @param {object} lib - loadSharedCodec()'s result
   * @param {object} [opts]
   * @param {number} [opts.opusBitrate]
   */
  constructor(kind, sampleRate, lib, { opusBitrate = DEFAULT_OPUS_BITRATE } = {}) {
    this.kind = kind;
    this.lib = lib;
    if (kind === 'opus') {
      this.rate = lib.OPUS_RATE;
      this.frames = new lib.FrameBuffer(lib.OPUS_FRAME_SAMPLES);
      // AUDIO rather than VOIP: radio audio is often tones (CW, data), not speech.
      // Complexity 5 keeps the Pi's CPU use low; the quality loss is slight.
      this.opus = new OpusCodec({
        sampleRate: lib.OPUS_RATE,
        frameMs: lib.FRAME_MS,
        application: 'AUDIO',
        bitrate: opusBitrate,
        complexity: 5,
        decode: false,
      });
    } else if (kind === 'adpcm') {
      this.rate = lib.ADPCM_RATE;
      this.frames = new lib.FrameBuffer(lib.ADPCM_FRAME_SAMPLES);
    } else {
      throw new Error(`unknown audio format ${kind}`);
    }
    this.resampler = new lib.StreamResampler(sampleRate, this.rate);
  }

  /**
   * @param {Buffer} pcm - S16LE mono at the server's rate
   * @returns {Buffer[]} zero or more packets (one per 20 ms)
   */
  encode(pcm) {
    const frames = this.frames.push(this.lib.floatToInt16(this.resampler.process(bufferToFloat(pcm))));
    return frames.map((f) => (this.kind === 'opus' ? this.opus.encode(int16ToBuffer(f)) : Buffer.from(this.lib.adpcmEncode(f))));
  }

  close() {
    this.opus?.delete();
    this.opus = null;
  }
}

class TxDecoder {
  /**
   * @param {'opus'|'adpcm'} kind
   * @param {number} sampleRate - the server's audio rate (what aplay plays)
   * @param {object} lib - loadSharedCodec()'s result
   */
  constructor(kind, sampleRate, lib) {
    this.kind = kind;
    this.lib = lib;
    let inRate;
    if (kind === 'opus') {
      // Opus packets decode at any of its rates; pick the server's if it can
      inRate = OPUS_RATES.includes(sampleRate) ? sampleRate : 48000;
      this.opus = new OpusCodec({ sampleRate: inRate, encode: false });
    } else if (kind === 'adpcm') {
      inRate = lib.ADPCM_RATE;
    } else {
      throw new Error(`unknown audio format ${kind}`);
    }
    this.resampler = inRate === sampleRate ? null : new lib.StreamResampler(inRate, sampleRate);
  }

  /**
   * @param {Buffer} packet
   * @returns {Buffer} S16LE mono at the server's rate
   */
  decode(packet) {
    if (this.kind === 'opus') {
      const pcm = this.opus.decode(packet);
      return this.resampler ? int16ToBuffer(this.lib.floatToInt16(this.resampler.process(bufferToFloat(pcm)))) : pcm;
    }
    const int16 = this.lib.adpcmDecode(new Uint8Array(packet.buffer, packet.byteOffset, packet.length));
    return int16ToBuffer(this.resampler ? this.lib.floatToInt16(this.resampler.process(this.lib.int16ToFloat(int16))) : int16);
  }

  close() {
    this.opus?.delete();
    this.opus = null;
  }
}

module.exports = { loadSharedCodec, RxEncoder, TxDecoder, DEFAULT_OPUS_BITRATE };
