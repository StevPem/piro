'use strict';

const { EVENT } = require('../server/protocol');
const { encodeRtty } = require('./rtty-encoder');
const { encodeJtty, sampleRateSupported, JTTY_BASE_RATE, JTTY_BAUD } = require('./jtty-tx');
const { upsampleFloatToPcm } = require('./resample');
const { encodeOlivia, textToOliviaBytes } = require('./olivia-tx');
const { OLIVIA_SAMPLE_RATE, clampOliviaCentre } = require('./olivia-dsp');

// Olivia 8/250 sends ~1.46 characters a second, so this is about 3.5
// minutes on air: well inside the 10-minute PTT watchdog.
const OLIVIA_MAX_CHARS = 300;

// Audio frequency (Hz) of JTTY's lowest tone. The signal occupies this
// frequency plus ~94 Hz (four tones 31.25 Hz apart), so 1450 centres it on
// ~1500 Hz — the same mid-passband default FT8 uses.
const DEFAULT_JTTY_TX_FREQ_HZ = 1450;
const MIN_JTTY_TX_FREQ_HZ = 200;
const MAX_JTTY_TX_FREQ_HZ = 2800;

// Same reasoning as ft8-bridge.js's PTT_RELEASE_MARGIN_MS: write() only
// hands the PCM to the OS pipe feeding `aplay`, so PTT is held for the
// nominal audio length *plus* this margin, or the tail of the transmission
// (for JTTY, the last symbols, which carry the end of the CRC-protected
// frame) would be cut off.
const PTT_RELEASE_MARGIN_MS = 300;

// Matches the full-scale level ft8-bridge.js sends, so the operator's
// existing audio drive/ALC setting works unchanged across modes.
const DEFAULT_TX_AMPLITUDE = 1.0;

/**
 * RTTY, JTTY and Olivia transmit. Receives `tty-send` / `tty-abort` events from the
 * ControlServer (the client's "Send" button), synthesizes the audio, keys
 * PTT, plays the audio out through the same ALSA path FT8 and voice use,
 * and releases PTT afterwards. Unlike FT8, neither mode is slotted, so a
 * transmission starts the moment it is requested.
 *
 * Receive for these modes is separate (RTTY: rtty-decoder-bridge.js;
 * JTTY: server/jtty-decoder-bridge.js; Olivia: server/olivia-decoder-bridge.js).
 *
 * Status is reported through EVENT.TTY_TX_STATUS broadcasts:
 *   {status: 'sending', mode, text, message, nframes?, durationSec}
 *   {status: 'sent' | 'aborted', mode, text, message}
 *   {status: 'error', mode, error}
 */
class TtyBridge {
  /**
   * @param {object} opts
   * @param {import('../server/ws-server').ControlServer} opts.controlServer
   * @param {import('../server/audio-bridge').AudioBridge} opts.audioBridge
   * @param {number} [opts.jttyFreqHz] - default JTTY lowest-tone audio frequency
   * @param {number} [opts.oliviaFreqHz] - default Olivia centre audio frequency (used if a request gives none)
   * @param {number} [opts.pttReleaseMarginMs] - injectable for testing
   * @param {number} [opts.amplitude]
   */
  constructor({ controlServer, audioBridge, jttyFreqHz, oliviaFreqHz, pttReleaseMarginMs, amplitude } = {}) {
    if (!controlServer) throw new Error('TtyBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('TtyBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    this.jttyFreqHz = jttyFreqHz ?? DEFAULT_JTTY_TX_FREQ_HZ;
    this.oliviaFreqHz = clampOliviaCentre(oliviaFreqHz);
    this.pttReleaseMarginMs = pttReleaseMarginMs ?? PTT_RELEASE_MARGIN_MS;
    this.amplitude = amplitude ?? DEFAULT_TX_AMPLITUDE;
    this._tx = null; // the in-flight transmission, if any
    this._onSend = (req) => {
      // Errors are reported as EVENT.TTY_TX_STATUS inside send(); nothing to add here.
      this.send(req).catch(() => {});
    };
    this._onAbort = () => this.abort();
  }

  start() {
    this.controlServer.on('tty-send', this._onSend);
    this.controlServer.on('tty-abort', this._onAbort);
  }

  stop() {
    this.controlServer.off('tty-send', this._onSend);
    this.controlServer.off('tty-abort', this._onAbort);
    if (this._tx) this.abort();
  }

  get transmitting() {
    return this._tx !== null;
  }

  _status(data) {
    this.controlServer.broadcastJsonEvent(EVENT.TTY_TX_STATUS, data);
  }

  /** Builds the PCM (S16LE mono at the audio bridge's rate) for a request, or returns {error}. */
  _synthesize({ mode, text, freqHz }) {
    const rate = this.audioBridge.sampleRate;
    if (mode === 'RTTY') {
      const enc = encodeRtty(text, {
        sampleRate: rate,
        reversed: !!this.controlServer.state?.rttyReversed,
        amplitude: this.amplitude,
      });
      if (enc.samples.length === 0) return { error: 'Nothing to send: none of that text can be sent as RTTY.' };
      return {
        pcm: floatToPcm(enc.samples),
        durationSec: enc.durationSec,
        message: enc.sent,
        note: enc.dropped ? `Skipped characters RTTY cannot send: ${enc.dropped}` : undefined,
      };
    }
    if (mode === 'OLIVIA') {
      const bytes = textToOliviaBytes(text);
      if (bytes.length > OLIVIA_MAX_CHARS) {
        return { error: `That text is too long for one Olivia transmission (the limit is ${OLIVIA_MAX_CHARS} characters, about 3.5 minutes).` };
      }
      const centreHz = clampOliviaCentre(freqHz ?? this.oliviaFreqHz);
      const enc = encodeOlivia(bytes, { centreHz, amplitude: this.amplitude });
      const replaced = [...String(text)].filter((ch) => ch.codePointAt(0) > 255);
      return {
        pcm: rate === OLIVIA_SAMPLE_RATE ? floatToPcm(enc.samples) : upsampleFloatToPcm(enc.samples, OLIVIA_SAMPLE_RATE, rate),
        durationSec: enc.durationSec,
        message: text,
        freqHz: centreHz,
        note: replaced.length ? `Sent "." for characters Olivia cannot carry: ${[...new Set(replaced)].join('')}` : undefined,
      };
    }
    // JTTY
    const f0 = clampFreq(freqHz ?? this.jttyFreqHz);
    const direct = sampleRateSupported(rate);
    const enc = encodeJtty(text, {
      f0,
      sampleRate: direct ? rate : JTTY_BASE_RATE,
      amplitude: this.amplitude,
    });
    if (enc.nframes < 0) {
      return { error: 'That text is too long for JTTY (the limit is 16 frames, about 80 characters).' };
    }
    if (enc.nframes === 0) return { error: 'Nothing to send.' };
    return {
      pcm: direct ? floatToPcm(enc.samples) : upsampleFloatToPcm(enc.samples, JTTY_BASE_RATE, rate),
      durationSec: enc.durationSec,
      message: enc.message,
      nframes: enc.nframes,
      freqHz: f0,
    };
  }

  /**
   * Encodes and transmits. Resolves when the transmission is over (sent or
   * aborted) and rejects on failure; the same outcome is also broadcast.
   */
  async send({ mode, text, freqHz } = {}) {
    const fail = (error) => {
      this._status({ status: 'error', mode, error });
      return Promise.reject(new Error(error));
    };
    if (mode !== 'RTTY' && mode !== 'JTTY' && mode !== 'OLIVIA') return fail('Unknown mode.');
    if (typeof text !== 'string' || text.trim() === '') return fail('Nothing to send.');
    if (this._tx) return fail('Already transmitting.');
    if (this.controlServer.state?.ptt) return fail('The radio is already transmitting.');

    let built;
    try {
      built = this._synthesize({ mode, text, freqHz });
    } catch (err) {
      return fail(`Couldn't encode that: ${err.message}`);
    }
    if (built.error) return fail(built.error);

    const tx = { aborted: false, timer: null, wake: null };
    this._tx = tx;
    const info = { mode, text, message: built.message, durationSec: built.durationSec };
    if (built.nframes !== undefined) info.nframes = built.nframes;
    if (built.freqHz !== undefined) info.freqHz = built.freqHz;
    if (built.note) info.note = built.note;
    try {
      this._status({ status: 'sending', ...info });
      await this.controlServer.setPttFromServer(true);
      if (!tx.aborted) {
        this.audioBridge.playback.write(built.pcm);
        const durationMs = (built.pcm.length / 2 / this.audioBridge.sampleRate) * 1000;
        await new Promise((resolve) => {
          tx.wake = resolve;
          tx.timer = setTimeout(resolve, durationMs + this.pttReleaseMarginMs);
        });
      }
      tx.timer = null;
      await this.controlServer.setPttFromServer(false);
      this._status({ status: tx.aborted ? 'aborted' : 'sent', ...info });
    } catch (err) {
      try {
        await this.controlServer.setPttFromServer(false);
      } catch {
        // best effort — the PTT watchdog is still armed from setPttFromServer(true)
      }
      this._tx = null;
      this._status({ status: 'error', mode, error: err.message });
      throw err;
    }
    this._tx = null;
  }

  /** Cuts the current transmission short: drops the queued audio and lets send() release PTT. */
  abort() {
    const tx = this._tx;
    if (!tx || tx.aborted) return;
    tx.aborted = true;
    if (tx.timer) clearTimeout(tx.timer);
    // Replacing aplay discards what is still in the pipe and in ALSA's buffer.
    if (typeof this.audioBridge.playback.restart === 'function') this.audioBridge.playback.restart();
    if (tx.wake) tx.wake();
  }
}

function clampFreq(hz) {
  const n = Number(hz);
  if (!Number.isFinite(n)) return DEFAULT_JTTY_TX_FREQ_HZ;
  return Math.max(MIN_JTTY_TX_FREQ_HZ, Math.min(MAX_JTTY_TX_FREQ_HZ, Math.round(n)));
}

function floatToPcm(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

module.exports = {
  TtyBridge,
  DEFAULT_JTTY_TX_FREQ_HZ,
  MIN_JTTY_TX_FREQ_HZ,
  MAX_JTTY_TX_FREQ_HZ,
  PTT_RELEASE_MARGIN_MS,
  DEFAULT_TX_AMPLITUDE,
  JTTY_BAUD,
  OLIVIA_MAX_CHARS,
};
