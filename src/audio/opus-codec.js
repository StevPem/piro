'use strict';

const OpusScript = require('opusscript');

const DEFAULTS = { sampleRate: 48000, channels: 1, frameMs: 20 };

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
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    const { samplesPerFrame, frameBytes } = computeFrame(this.opts);
    this.samplesPerFrame = samplesPerFrame;
    this.frameBytes = frameBytes;
    this.encoder = new OpusScript(this.opts.sampleRate, this.opts.channels, OpusScript.Application.VOIP);
    this.decoder = new OpusScript(this.opts.sampleRate, this.opts.channels, OpusScript.Application.VOIP);
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
