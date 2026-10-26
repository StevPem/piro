'use strict';

import {
  ADPCM_RATE,
  ADPCM_FRAME_SAMPLES,
  adpcmEncode,
  adpcmDecode,
  StreamResampler,
  FrameBuffer,
  int16ToFloat,
  floatToInt16,
} from './audio-codec.js';

// Client-side audio pipeline using the standard Web Audio API.
//
// Three formats each way (see server/audio-bridge.js and audio-codec.js):
// - 'pcm': raw 16-bit PCM at the server's rate. No codec; works in every
//   browser. The default on a LAN.
// - 'opus': Opus packets, decoded and encoded with WebCodecs
//   (AudioDecoder / AudioEncoder) where the browser has them.
// - 'adpcm': 12 kHz IMA ADPCM in plain JavaScript, for browsers without
//   WebCodecs Opus.
// RX and TX formats are set separately (setCodecs()): a browser may decode
// Opus but not encode it.
//
// RX (speaker): incoming chunks are turned into AudioBuffers and
// scheduled back-to-back on a running "next start time" cursor. After a
// gap, playback restarts `jitterSec` ahead of now (0 on a LAN; 0.2 s for
// compressed audio, which usually comes over the internet), so a late
// packet doesn't cause a gap every time. If more than half a second
// beyond that has queued up, chunks are dropped until it catches up, so
// the delay can't keep growing.
//
// TX (mic): mic audio is captured via an AudioWorklet (see
// mic-capture-processor.js) that batches samples into ~20ms frames and
// posts them to the main thread, which encodes them in the TX format and
// forwards them over the WebSocket only while transmitting is active.

// Mirrors BINARY_TYPE in server/protocol.js (and rpc.js).
export const AUDIO_TAG = { pcm: 0x01, opus: 0x07, adpcm: 0x08 };

const OPUS_BITRATE = 24000;
const MAX_EXTRA_DELAY_SEC = 0.5;

/** Whether this browser can decode (rx) and encode (tx) Opus with WebCodecs. */
export async function opusSupport(sampleRate = 48000) {
  const cfg = { codec: 'opus', sampleRate, numberOfChannels: 1 };
  const check = async (cls, extra) => {
    try {
      return typeof cls === 'function' && !!(await cls.isConfigSupported({ ...cfg, ...extra })).supported;
    } catch {
      return false;
    }
  };
  return {
    rx: await check(globalThis.AudioDecoder, {}),
    tx: await check(globalThis.AudioEncoder, { bitrate: OPUS_BITRATE }),
  };
}

/** Whether the page was opened on the LAN: a private address, a .local/.lan name or a single-label name (e.g. "piro"). */
export function isLanHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || /\.(local|lan|home\.arpa|internal)$/.test(h)) return true;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return /^f[cd]|^fe80/.test(h); // IPv6 unique-local or link-local
  return !h.includes('.');
}

/**
 * Multiplies 16-bit samples by `gain` (a new array). Up to 0.8 of full scale
 * the audio is just scaled; above that it bends smoothly towards full scale,
 * so a high Mic setting rounds off peaks instead of clipping them hard.
 */
export function applyMicGain(samples, gain) {
  const out = new Int16Array(samples.length);
  const knee = 0.8;
  for (let i = 0; i < samples.length; i++) {
    let x = (samples[i] / 32768) * gain;
    const a = Math.abs(x);
    if (a > knee) x = Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
    out[i] = Math.max(-32768, Math.min(32767, Math.round(x * 32768)));
  }
  return out;
}

export class AudioPipeline {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate - must match the server's AUDIO_SAMPLE_RATE
   * @param {number} opts.channels - must match the server's AUDIO_CHANNELS
   * @param {(type: number, data: ArrayBuffer|Uint8Array) => void} opts.onMicFrame - called with
   *   each encoded mic frame while transmitting (type: an AUDIO_TAG value);
   *   caller decides whether/how to send it
   * @param {(direction: 'rx'|'tx', err: Error) => void} [opts.onCodecError] - an Opus
   *   decoder/encoder failed; the pipeline has already switched that direction to ADPCM
   */
  constructor({ sampleRate, channels = 1, onMicFrame, onCodecError }) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.onMicFrame = onMicFrame;
    this.onCodecError = onCodecError;
    this.rxCodec = 'pcm';
    this.txCodec = 'pcm';
    this.micGain = 1; // linear; see setMicGainDb()
    this.jitterSec = 0;
    this._opusDecoder = null;
    this._opusTs = 0;
    this._resetTx();

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

  /**
   * The formats in use. RX must match what the server was asked for
   * (setAudioCodec); compressed RX adds a 0.2 s cushion against network jitter.
   * @param {'pcm'|'opus'|'adpcm'} rx
   * @param {'pcm'|'opus'|'adpcm'} tx
   */
  setCodecs(rx, tx) {
    if (rx !== this.rxCodec && this._opusDecoder) this._closeOpusDecoder();
    this.rxCodec = rx;
    if (tx !== this.txCodec) this._resetTx();
    this.txCodec = tx;
    this.jitterSec = rx === 'pcm' ? 0 : 0.2;
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
    this._schedule(audioBuffer);
  }

  /** Feed one RX ADPCM frame (ArrayBuffer). */
  playAdpcm(arrayBuffer) {
    if (!this._speakerEnabled || !this.audioContext) return;
    const samples = adpcmDecode(new Uint8Array(arrayBuffer), ADPCM_FRAME_SAMPLES);
    this._playFloat(int16ToFloat(samples), ADPCM_RATE);
  }

  /** Feed one RX Opus packet (ArrayBuffer). Decoded by WebCodecs; played when it comes out. */
  playOpus(arrayBuffer) {
    if (!this._speakerEnabled || !this.audioContext) return;
    if (!this._opusDecoder) {
      try {
        const dec = new AudioDecoder({
          output: (data) => {
            try {
              const f = new Float32Array(data.numberOfFrames);
              data.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
              this._playFloat(f, data.sampleRate);
            } finally {
              data.close();
            }
          },
          error: (err) => this._codecFailed('rx', err),
        });
        dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
        this._opusDecoder = dec;
        this._opusTs = 0;
      } catch (err) {
        this._codecFailed('rx', err);
        return;
      }
    }
    try {
      this._opusDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this._opusTs, data: arrayBuffer }));
      this._opusTs += 20000; // microseconds; only needs to increase
    } catch (err) {
      this._codecFailed('rx', err);
    }
  }

  _playFloat(f32, rate) {
    if (!f32.length) return;
    const audioBuffer = this.audioContext.createBuffer(1, f32.length, rate);
    audioBuffer.getChannelData(0).set(f32);
    this._schedule(audioBuffer);
  }

  _schedule(audioBuffer) {
    const now = this.audioContext.currentTime;
    if (this._nextPlayTime < now) {
      this._nextPlayTime = now + this.jitterSec; // after a gap: rebuild the cushion
    } else if (this._nextPlayTime > now + this.jitterSec + MAX_EXTRA_DELAY_SEC) {
      return; // too much queued (e.g. a burst after a stall): drop until it catches up
    }
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    source.start(this._nextPlayTime);
    this._nextPlayTime += audioBuffer.duration;
  }

  _closeOpusDecoder() {
    try {
      this._opusDecoder?.close();
    } catch {
      // already closed by its own error
    }
    this._opusDecoder = null;
  }

  /** An Opus decoder/encoder failed: switch that direction to ADPCM and tell the app. */
  _codecFailed(direction, err) {
    if (direction === 'rx') {
      this._closeOpusDecoder();
      if (this.rxCodec === 'opus') this.rxCodec = 'adpcm';
    } else {
      this._resetTx();
      if (this.txCodec === 'opus') this.txCodec = 'adpcm';
    }
    this.onCodecError?.(direction, err);
  }

  _resetTx() {
    if (this._opusEncoder) {
      try {
        this._opusEncoder.close();
      } catch {
        // already closed
      }
    }
    this._opusEncoder = null;
    this._txResampler = null;
    this._txFrames = null;
    this._txTs = 0;
  }

  /** One captured mic frame (Int16 PCM at the AudioContext's rate), encoded in the TX format. */
  /**
   * Microphone gain for this browser, in dB (the Mic menu): applied to the
   * microphone audio before it is compressed and sent. Above 0 dB, peaks
   * are rounded off near full scale rather than clipped hard.
   */
  setMicGainDb(db) {
    this.micGain = 10 ** ((Number(db) || 0) / 20);
  }

  _sendMic(buffer) {
    if (this.micGain !== 1) buffer = applyMicGain(new Int16Array(buffer), this.micGain).buffer;
    if (this.txCodec === 'pcm') {
      this.onMicFrame(AUDIO_TAG.pcm, buffer);
      return;
    }
    const rate = this.audioContext.sampleRate;
    const int16 = new Int16Array(buffer);
    if (this.txCodec === 'adpcm') {
      this._txResampler ??= new StreamResampler(rate, ADPCM_RATE);
      this._txFrames ??= new FrameBuffer(ADPCM_FRAME_SAMPLES);
      const frames = this._txFrames.push(floatToInt16(this._txResampler.process(int16ToFloat(int16))));
      for (const f of frames) this.onMicFrame(AUDIO_TAG.adpcm, adpcmEncode(f));
      return;
    }
    try {
      if (!this._opusEncoder) {
        const enc = new AudioEncoder({
          output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            if (this.transmitting) this.onMicFrame(AUDIO_TAG.opus, data);
          },
          error: (err) => this._codecFailed('tx', err),
        });
        enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: OPUS_BITRATE, opus: { frameDuration: 20000 } });
        this._opusEncoder = enc;
      }
      const data = new AudioData({ format: 's16', sampleRate: rate, numberOfFrames: int16.length, numberOfChannels: 1, timestamp: this._txTs, data: int16 });
      this._txTs += Math.round((int16.length * 1e6) / rate);
      this._opusEncoder.encode(data);
      data.close();
    } catch (err) {
      this._codecFailed('tx', err);
    }
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
        if (this.transmitting && this.onMicFrame) this._sendMic(event.data);
      };
      // Not connected to destination: we don't want local monitoring
      // (would risk audible feedback into the radio's own audio loop).
      this.micNode.connect(this.workletNode);
    }
    this.transmitting = true;
  }

  stopTransmitting() {
    this.transmitting = false;
    // start the next transmission clean: no leftover samples from this one
    this._resetTx();
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
