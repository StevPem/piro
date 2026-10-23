'use strict';

const OpusScript = require('opusscript');

const DEFAULTS = { sampleRate: 48000, channels: 1, frameMs: 20 };
// libopus encoder controls (opus_defines.h)
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_COMPLEXITY = 4010;

/**
 * Given sample rate/channels/frame duration, compute how many samples
 * (per channel) and how many raw PCM bytes make up one frame. Opus frame
 * durations must be one of 2.5/5/10/20/40/60 ms; 20ms is the common
 * default for voice.
 */
function computeFrame({ sampleRate, channels, frameMs }) {
  const samplesPerFrame = Math.round((sampleRate * frameMs) / 1000);
  const frameBytes = samplesPerFrame * channels * 2; // 16-bit PCM
  return { samplesPerFrame, frameBytes };
}

/**
 * Thin wrapper around opusscript for encoding/decoding fixed-size 16-bit
 * PCM frames to/from Opus packets, using this project's shared framing
 * conventions (see computeFrame).
 */
class OpusCodec {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sampleRate=48000] - 8000, 12000, 16000, 24000 or 48000
   * @param {number} [opts.channels=1]
   * @param {number} [opts.frameMs=20]
   * @param {'VOIP'|'AUDIO'|'RESTRICTED_LOWDELAY'} [opts.application='VOIP']
   * @param {number} [opts.bitrate] - bits per second (libopus picks one if unset)
   * @param {number} [opts.complexity] - 0 (cheapest) to 10
   * @param {boolean} [opts.encode=true] - make an encoder
   * @param {boolean} [opts.decode=true] - make a decoder
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    const { samplesPerFrame, frameBytes } = computeFrame(this.opts);
    this.samplesPerFrame = samplesPerFrame;
    this.frameBytes = frameBytes;
    const app = OpusScript.Application[this.opts.application || 'VOIP'];
    // Only the halves asked for are made: each holds WASM memory.
    const { encode = true, decode = true } = this.opts;
    this.encoder = encode ? new OpusScript(this.opts.sampleRate, this.opts.channels, app) : null;
    this.decoder = decode ? new OpusScript(this.opts.sampleRate, this.opts.channels, app) : null;
    if (this.encoder && this.opts.bitrate) this.encoder.encoderCTL(OPUS_SET_BITRATE, this.opts.bitrate);
    if (this.encoder && this.opts.complexity != null) this.encoder.encoderCTL(OPUS_SET_COMPLEXITY, this.opts.complexity);
  }

  /** Frees the WASM memory. The codec can't be used afterwards. */
  delete() {
    this.encoder?.delete();
    this.decoder?.delete();
    this.encoder = this.decoder = null;
  }

  /** @param {Buffer} pcmFrame - exactly this.frameBytes long */
  encode(pcmFrame) {
    if (pcmFrame.length !== this.frameBytes) {
      throw new Error(
        `OpusCodec.encode() expects exactly ${this.frameBytes}-byte PCM frames, got ${pcmFrame.length}`
      );
    }
    return this.encoder.encode(pcmFrame, this.samplesPerFrame);
  }

  /** @param {Buffer} opusPacket @returns {Buffer} PCM, this.frameBytes long */
  decode(opusPacket) {
    return this.decoder.decode(opusPacket);
  }
}

module.exports = { OpusCodec, computeFrame, DEFAULTS };
