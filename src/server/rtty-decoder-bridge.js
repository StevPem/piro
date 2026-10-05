'use strict';

const { RttyDecoder } = require('../audio/rtty-decoder');
const { EVENT } = require('./protocol');

/**
 * Wires an RttyDecoder to the radio's actual RX audio and mode/PTT state,
 * exactly mirroring CwDecoderBridge (see that file's own doc comment for
 * the full rationale, which applies here unchanged): it only ever runs
 * while mode is RTTY and the operator isn't currently transmitting, it
 * attaches as an *additional* listener on AudioBridge's own capture
 * stream rather than needing separate ALSA capture, and it's a hard
 * dependency on RX audio already being configured (AUDIO_RX_DEVICE).
 *
 * Unlike CW, there's no CI-V readback for RTTY's mark/space tone
 * frequencies to refresh on entering the mode (the IC-7300 exposes a CW
 * pitch setting over CI-V — see civ/driver.js#getCwPitch — but nothing
 * equivalent for RTTY's AFSK tones or shift), so this bridge is simpler
 * than CwDecoderBridge in exactly that one respect: RttyDecoder's
 * mark/space frequencies are fixed at construction (defaulting to the
 * standard 2125/2295Hz amateur convention — see rtty-decoder.js) rather
 * than periodically re-read from the radio.
 *
 * Decoded output is broadcast to every connected client as
 * EVENT.RTTY_TEXT ({ text: '<one decoded character>' }) — one event per
 * resolved character, not an accumulated string, the same convention as
 * EVENT.CW_TEXT (see docs/ui-notes.md for this app's own ticker).
 */
class RttyDecoderBridge {
  /**
   * @param {object} opts
   * @param {import('../civ/driver').CivDriver} opts.civ
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {RttyDecoder} [opts.decoder] - injectable for testing
   */
  constructor({ civ, controlServer, audioBridge, decoder }) {
    if (!civ) throw new Error('RttyDecoderBridge requires opts.civ');
    if (!controlServer) throw new Error('RttyDecoderBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('RttyDecoderBridge requires opts.audioBridge');
    this.civ = civ;
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;

    this.decoder =
      decoder ??
      new RttyDecoder({ sampleRate: audioBridge.sampleRate, reversed: !!controlServer.state?.rttyReversed });
    this._attached = false; // currently listening to the PCM stream
    this._inRttyMode = false;
    this._pttActive = false;

    this._onChar = (text) => this.controlServer.broadcastJsonEvent(EVENT.RTTY_TEXT, { text });
    this.decoder.on('char', this._onChar);

    this._onPcmData = (chunk) => this._handlePcm(chunk);
    this._onMode = (info) => this._handleModeChange(info.mode);
    this._onPtt = (on) => this._handlePttChange(on);
    // See REQUEST.SET_RTTY_REVERSED (ws-server.js) — an internal-only event
    // emitted by ControlServer, same pattern as 'ptt'/'freedv-spot-enabled'
    // above, since this bridge has no other way to hear about the
    // "Reverse" checkbox changing. Resetting afterward clears any
    // in-progress frame/bit-sync state that was built up under the old
    // (now-wrong) polarity assumption — same reasoning as the reset() in
    // _handleModeChange() above.
    this._onRttyReversed = (reversed) => {
      this.decoder.setReversed(reversed);
      this.decoder.reset();
    };

    this.civ.on('mode', this._onMode);
    this.controlServer.on('ptt', this._onPtt);
    this.controlServer.on('rtty-reversed', this._onRttyReversed);
  }

  /**
   * Picks up the radio's current mode (rather than waiting for the next
   * unsolicited change event, which might not come for a while if the
   * radio's already sitting in RTTY mode when this starts). Best-effort —
   * a failure here just means the next real mode change picks up
   * correctly instead of the whole server failing to start over a
   * non-essential feature.
   */
  async start() {
    try {
      const current = await this.civ.getMode();
      this._handleModeChange(current.mode);
    } catch {
      // the next unsolicited 'mode' event will still pick this up
    }
  }

  /** Detaches from everything — call on server shutdown. */
  stop() {
    this._detach();
    this.civ.off('mode', this._onMode);
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('rtty-reversed', this._onRttyReversed);
    this.decoder.off('char', this._onChar);
  }

  _handleModeChange(mode) {
    const wasInRttyMode = this._inRttyMode;
    this._inRttyMode = mode === 'RTTY';
    this._syncAttachment();
    if (this._inRttyMode && !wasInRttyMode) {
      // Freshly entering RTTY mode: stale decode state (mid-character
      // bit-sync, a stuck FIGS shift) from whatever was happening before
      // shouldn't carry over into this session.
      this.decoder.reset();
    }
  }

  _handlePttChange(on) {
    this._pttActive = on;
    this._syncAttachment();
  }

  _syncAttachment() {
    const shouldBeAttached = this._inRttyMode && !this._pttActive;
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
    // chunk is a raw Buffer of S16_LE samples (mono) from arecord — read
    // via readInt16LE rather than a typed-array view over the same
    // memory, since a Buffer from a stream isn't guaranteed to start at
    // a 2-byte-aligned offset within its underlying allocation. Same
    // approach as CwDecoderBridge's own _handlePcm().
    const sampleCount = Math.floor(chunk.length / 2);
    const samples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) samples[i] = chunk.readInt16LE(i * 2);
    this.decoder.pushSamples(samples);
  }
}

module.exports = { RttyDecoderBridge };
