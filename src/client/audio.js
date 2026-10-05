'use strict';

// Client-side audio pipeline using the standard Web Audio API — no WASM,
// no WebCodecs, works the same way in every modern browser including
// Safari/iOS. Matches the server's default 'pcm' AudioBridge mode: raw
// 16-bit PCM straight over the WebSocket binary channel, no codec.
//
// RX (speaker): incoming PCM chunks are turned into AudioBuffers and
// scheduled back-to-back on a running "next start time" cursor, which
// gives simple, adequate streaming playback on a LAN (no real jitter
// buffer beyond that — see docs/audio-notes.md).
//
// TX (mic): mic audio is captured via an AudioWorklet (see
// mic-capture-processor.js) that batches samples into ~20ms frames and
// posts them to the main thread, which forwards them over the WebSocket
// only while transmitting is active.

export class AudioPipeline {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate - must match the server's AUDIO_SAMPLE_RATE
   * @param {number} opts.channels - must match the server's AUDIO_CHANNELS
   * @param {(buffer: ArrayBuffer) => void} opts.onMicFrame - called with each
   *   captured mic frame while transmitting; caller decides whether/how to send it
   */
  constructor({ sampleRate, channels = 1, onMicFrame }) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.onMicFrame = onMicFrame;

    this.audioContext = null;
    this.micStream = null;
    this.micNode = null;
    this.workletNode = null;
    this.transmitting = false;

    this._nextPlayTime = 0;
    this._speakerEnabled = false;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async enableSpeaker() {
    await this._ensureContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    this._speakerEnabled = true;
    this._nextPlayTime = this.audioContext.currentTime;
  }

  disableSpeaker() {
    this._speakerEnabled = false;
  }

  /** Feed one incoming RX PCM chunk (ArrayBuffer of 16-bit samples) for playback. */
  playChunk(arrayBuffer) {
    if (!this._speakerEnabled || !this.audioContext) return;

    const int16 = new Int16Array(arrayBuffer);
    const frameCount = int16.length / this.channels;
    if (frameCount <= 0) return;

    // createBuffer's sampleRate can differ from the context's running
    // sample rate — the browser resamples automatically on playback, so
    // this works even if the context ended up at a different actual rate
    // than requested (see docs/audio-notes.md).
    const audioBuffer = this.audioContext.createBuffer(this.channels, frameCount, this.sampleRate);
    for (let ch = 0; ch < this.channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = int16[i * this.channels + ch] / 0x8000;
      }
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const now = this.audioContext.currentTime;
    const startAt = Math.max(this._nextPlayTime, now);
    source.start(startAt);
    this._nextPlayTime = startAt + audioBuffer.duration;
  }

  /** Must be called from a user gesture (mic permission prompt + autoplay policy). */
  async startTransmitting() {
    await this._ensureContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    if (!this.micStream) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'Microphone access requires HTTPS (or localhost) — see docs/pwa-notes.md for how to enable it.'
        );
      }
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: this.channels,
          sampleRate: this.sampleRate,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.micNode = this.audioContext.createMediaStreamSource(this.micStream);

      await this.audioContext.audioWorklet.addModule('/mic-capture-processor.js');
      const frameSamples = Math.round(this.sampleRate * 0.02); // 20ms
      this.workletNode = new AudioWorkletNode(this.audioContext, 'mic-capture-processor', {
        processorOptions: { frameSamples },
      });
      this.workletNode.port.onmessage = (event) => {
        if (this.transmitting && this.onMicFrame) this.onMicFrame(event.data);
      };
      // Not connected to destination: we don't want local monitoring
      // (would risk audible feedback into the radio's own audio loop).
      this.micNode.connect(this.workletNode);
    }
    this.transmitting = true;
  }

  stopTransmitting() {
    this.transmitting = false;
  }

  /** Fully release the mic (stops the browser's mic-in-use indicator). */
  releaseMic() {
    this.transmitting = false;
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.micNode) {
      this.micNode.disconnect();
      this.micNode = null;
    }
  }

  async _ensureContext() {
    if (this.audioContext) return;
    // Request the server's sample rate explicitly; most modern
    // browsers honor it. If a given device silently doesn't, RX
    // playback still works correctly (createBuffer resamples), but TX
    // audio sent to the radio could end up mildly pitch-shifted — a
    // known, documented limitation (docs/audio-notes.md), not a crash.
    this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
  }
}
