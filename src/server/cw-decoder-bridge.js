'use strict';

const { CwDecoder } = require('../audio/cw-decoder');
const { HamfistCwDecoder } = require('../audio/hamfist-cw-decoder');
const { DeepCwDecoder } = require('../audio/deepcw-decoder');
const { EVENT } = require('./protocol');

const VARIANTS = ['CW1', 'CW2', 'CW3'];

/**
 * Wires a CwDecoder to the radio's actual RX audio and mode/PTT state,
 * so it only ever runs while genuinely useful: mode is CW, and the
 * operator isn't currently transmitting (there's nothing meaningful to
 * decode in our own TX audio/silence, and running it anyway would just
 * feed the decoder garbage between elements of our own keying).
 *
 * Depends on an already-constructed AudioBridge for the actual PCM data
 * (`audioBridge.capture`, the same `AlsaCapture` instance AudioBridge
 * itself listens to for RX playback/broadcast) — this bridge just
 * attaches as an *additional* listener on that same stream rather than
 * needing its own separate ALSA capture process, and only when CW mode
 * is active and PTT isn't. This is a hard dependency: CW decoding is
 * only possible when RX audio is already configured and running (see
 * README's AUDIO_RX_DEVICE), the same way normal RX audio playback is.
 *
 * Decoded output is broadcast to every connected client as
 * EVENT.CW_TEXT ({ text: '<one character or a single space>' }) — one
 * event per resolved character/word-gap, not an accumulated string, so
 * clients render their own scrolling display however they choose (see
 * docs/ui-notes.md for this app's own ticker).
 *
 * Owns THREE decoder implementations side by side — 'CW1' (cw-decoder.js,
 * this app's original single-frequency Goertzel decoder), 'CW2'
 * (hamfist-cw-decoder.js, a port of the FFT/multi-channel/beam-search
 * "Hamfist" decoder), and 'CW3' (deepcw-decoder.js, a neural-network
 * decoder ported from e04/deepcw-engine) — and feeds PCM to whichever
 * one is currently selected (see REQUEST.SET_CW_DECODER_VARIANT / the CW
 * mode chip's click handler in app.js, which cycles CW1 -> CW2 -> CW3 ->
 * CW1). Only the active decoder actually receives audio; the others sit
 * idle rather than burning CPU (or, for CW3, GPU/NPU-adjacent inference
 * time) on output nobody sees, so switching variants resets whichever
 * one becomes newly active rather than resuming from stale/empty state.
 */
class CwDecoderBridge {
  /**
   * @param {object} opts
   * @param {import('../civ/driver').CivDriver} opts.civ
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {CwDecoder} [opts.decoder] - injectable for testing; the 'CW1' decoder
   * @param {HamfistCwDecoder} [opts.decoder2] - injectable for testing; the 'CW2' decoder
   * @param {DeepCwDecoder} [opts.decoder3] - injectable for testing; the 'CW3' decoder
   */
  constructor({ civ, controlServer, audioBridge, decoder, decoder2, decoder3 }) {
    if (!civ) throw new Error('CwDecoderBridge requires opts.civ');
    if (!controlServer) throw new Error('CwDecoderBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('CwDecoderBridge requires opts.audioBridge');
    this.civ = civ;
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;

    this.decoders = {
      CW1: decoder ?? new CwDecoder({ sampleRate: audioBridge.sampleRate }),
      CW2: decoder2 ?? new HamfistCwDecoder({ sampleRate: audioBridge.sampleRate }),
      CW3: decoder3 ?? new DeepCwDecoder({ sampleRate: audioBridge.sampleRate }),
    };
    // Mirrors controlServer.state.cwDecoderVariant (see ws-server.js) so
    // a server that's already been running with a non-default variant
    // selected (e.g. this bridge recreated without the control server
    // itself restarting) stays in sync; falls back to 'CW1' the same way
    // state's own default does.
    this.variant = VARIANTS.includes(controlServer.state && controlServer.state.cwDecoderVariant)
      ? controlServer.state.cwDecoderVariant
      : 'CW1';
    this._attached = false; // currently listening to the PCM stream
    this._inCwMode = false;
    this._pttActive = false;

    // One set of handlers per decoder (rather than per-variant dispatch
    // inside a single shared handler) so stop() can cleanly remove
    // exactly this bridge's own listeners from each decoder instance,
    // same as when there was only ever one decoder.
    this._charHandlers = {};
    this._spaceHandlers = {};
    this._pitchHandlers = {};
    this._errorHandlers = {};
    for (const variant of VARIANTS) {
      const dec = this.decoders[variant];
      this._charHandlers[variant] = (text) => {
        if (this.variant === variant) this.controlServer.broadcastJsonEvent(EVENT.CW_TEXT, { text });
      };
      this._spaceHandlers[variant] = () => {
        if (this.variant === variant) this.controlServer.broadcastJsonEvent(EVENT.CW_TEXT, { text: ' ' });
      };
      // Purely informational — logged, not broadcast to clients (no UI
      // currently shows it) — so that when CW1's own autoCalibratePitch
      // (see cw-decoder.js) corrects a wrong or stale pitch, that
      // correction is visible somewhere instead of only ever being
      // inferable from "the ticker suddenly started working". CW2/CW3
      // never emit this (see their own setPitch() doc comments).
      this._pitchHandlers[variant] = (hz) => {
        if (this.variant === variant) console.log(`[cw] ${variant} decoder auto-calibrated its tone frequency to ${hz}Hz`);
      };
      // CW3 is the only decoder that can fail here — loading its ONNX
      // model depends on a native onnxruntime-node binary existing for
      // this platform/architecture (see deepcw-decoder.js's top-of-file
      // doc comment), which CW1/CW2 have no equivalent dependency on.
      // Surfaced the same way a failed CI-V pitch read is below, rather
      // than only ever showing up as "CW3 decodes nothing, no visible
      // reason why".
      this._errorHandlers[variant] = (err) => {
        if (this.variant === variant) {
          this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { message: `${variant} decoder: ${err.message}` });
        }
      };
      dec.on('char', this._charHandlers[variant]);
      dec.on('space', this._spaceHandlers[variant]);
      dec.on('pitch', this._pitchHandlers[variant]);
      dec.on('error', this._errorHandlers[variant]);
    }

    this._onPcmData = (chunk) => this._handlePcm(chunk);
    this._onMode = (info) => this._handleModeChange(info.mode);
    this._onPtt = (on) => this._handlePttChange(on);
    this._onVariantChange = (variant) => this._setVariant(variant);

    this.civ.on('mode', this._onMode);
    this.controlServer.on('ptt', this._onPtt);
    this.controlServer.on('cw-decoder-variant', this._onVariantChange);
  }

  /** The currently-active decoder instance (whichever one PCM is actually being fed to). */
  get decoder() {
    return this.decoders[this.variant];
  }

  /**
   * Switches which decoder algorithm is fed PCM and has its output
   * broadcast — see REQUEST.SET_CW_DECODER_VARIANT in ws-server.js,
   * which is what actually emits 'cw-decoder-variant' on controlServer.
   * Resets the newly-active decoder so it never resumes with whatever
   * stale (or simply empty, since it wasn't being fed audio) state it
   * was left in from before — the same "never start CW decoding with
   * leftover state" rule _handleModeChange() already applies on
   * entering CW mode fresh.
   */
  _setVariant(variant) {
    if (!VARIANTS.includes(variant)) return;
    if (variant === this.variant) return;
    this.variant = variant;
    this.decoders[variant].reset();
    if (variant === 'CW1' && this._inCwMode) this._refreshPitch();
  }

  /**
   * Picks up the radio's current mode and CW pitch (rather than waiting
   * for the next unsolicited change event, which might not come for a
   * while if the radio's already sitting in CW mode when this starts).
   * Both are best-effort — a failure here just means the next real mode
   * change or a later manual pitch refresh picks up correctly instead
   * of the whole server failing to start over a non-essential feature.
   */
  async start() {
    try {
      const current = await this.civ.getMode();
      this._handleModeChange(current.mode); // already refreshes pitch itself if this lands in CW mode
    } catch {
      // the next unsolicited 'mode' event will still pick this up
    }
  }

  /** Detaches from everything — call on server shutdown. */
  stop() {
    this._detach();
    this.civ.off('mode', this._onMode);
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('cw-decoder-variant', this._onVariantChange);
    for (const variant of Object.keys(this.decoders)) {
      const dec = this.decoders[variant];
      dec.off('char', this._charHandlers[variant]);
      dec.off('space', this._spaceHandlers[variant]);
      dec.off('pitch', this._pitchHandlers[variant]);
      dec.off('error', this._errorHandlers[variant]);
    }
  }

  /**
   * A CI-V read failure here used to be swallowed completely silently,
   * leaving the decoder stuck at whatever pitch it already had (its own
   * 600Hz default, if this is the very first attempt) with literally no
   * visible symptom other than "decodes nothing" — indistinguishable
   * from a genuinely broken decoder. A real user recording surfaced
   * exactly this: the recording's actual tone was ~787Hz, nowhere near
   * the 600Hz default, and nothing about the failure was ever reported
   * anywhere. The decoder itself is more robust to this now
   * (`autoCalibratePitch` in cw-decoder.js re-derives the real tone
   * frequency from received audio on its own), but a CI-V command
   * failing here is still worth surfacing — e.g. if it happens on every
   * single attempt, that's a real problem on this radio/firmware worth
   * investigating (see the same concern already raised for this exact
   * command group in driver.js#_decodeMeterReply's doc comment) even
   * though it's no longer fatal to decoding.
   */
  async _refreshPitch() {
    try {
      const hz = await this.civ.getCwPitch();
      this.decoder.setPitch(hz);
    } catch (err) {
      this.controlServer.broadcastJsonEvent(EVENT.RIG_ERROR, {
        message: `Couldn't read CW pitch from radio (${err.message}) — the CW decoder will auto-detect the tone from received audio instead`,
      });
    }
  }

  _handleModeChange(mode) {
    const wasInCwMode = this._inCwMode;
    this._inCwMode = mode === 'CW';
    this._syncAttachment();
    if (this._inCwMode && !wasInCwMode) {
      // Freshly entering CW mode: the pitch may have been changed on
      // the radio's own menu since the last time we checked, and stale
      // decode state from whatever was happening before shouldn't carry
      // over into this session.
      this.decoder.reset();
      this._refreshPitch();
    }
  }

  _handlePttChange(on) {
    this._pttActive = on;
    this._syncAttachment();
  }

  _syncAttachment() {
    const shouldBeAttached = this._inCwMode && !this._pttActive;
    if (shouldBeAttached && !this._attached) this._attach();
    else if (!shouldBeAttached && this._attached) this._detach();
  }

  _attach() {
    if (this._attached) return;
    this.audioBridge.capture.on('data', this._onPcmData);
    this._attached = true;
  }

  _detach() {
    if (!this._attached) return;
    this.audioBridge.capture.off('data', this._onPcmData);
    this._attached = false;
  }

  _handlePcm(chunk) {
    // chunk is a raw Buffer of S16_LE samples (mono) from arecord —
    // read via readInt16LE rather than a typed-array view over the same
    // memory, since a Buffer from a stream isn't guaranteed to start at
    // a 2-byte-aligned offset within its underlying allocation.
    const sampleCount = Math.floor(chunk.length / 2);
    const samples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) samples[i] = chunk.readInt16LE(i * 2);
    this.decoder.pushSamples(samples);
  }
}

module.exports = { CwDecoderBridge };
