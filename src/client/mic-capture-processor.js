'use strict';

// Runs on the audio rendering thread. Receives 128-sample Float32 render
// quantums from the mic input, converts to 16-bit PCM, and batches them
// into larger frames (matching the server's frameMs, default 20ms) before
// posting to the main thread — posting every single 128-sample quantum
// (every ~2.7ms at 48kHz) would mean hundreds of tiny WebSocket sends per
// second for no benefit, since raw PCM has no per-frame codec requirement
// forcing a specific size; batching is purely to keep the message rate
// sane.
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameSamples = (options.processorOptions && options.processorOptions.frameSamples) || 960;
    this.frameSamples = frameSamples;
    this.buffer = new Int16Array(frameSamples);
    this.writeIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) {
      for (let i = 0; i < channel.length; i++) {
        const s = Math.max(-1, Math.min(1, channel[i]));
        this.buffer[this.writeIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.writeIndex >= this.frameSamples) {
          // Copy out (rather than transfer) so `this.buffer` stays valid
          // and reusable for the next frame.
          this.port.postMessage(this.buffer.buffer.slice(0));
          this.writeIndex = 0;
        }
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
