'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { encodeFT8, encodeFT4 } = require('@e04/ft8ts');
const { SlotClock } = require('./slot-clock');
const { downsamplePcmToFloat, upsampleFloatToPcm } = require('./resample');
const { computeMagnitudeSpectrum } = require('./fft');
const { EVENT, BINARY_TYPE } = require('../server/protocol');
const { PskReporterClient, extractSpot } = require('./psk-reporter');

const FT8_SAMPLE_RATE = 12000;
const FT8_SLOT_MS = 15000;
const FT4_SLOT_MS = 7500;
// Per-variant slot length — FT4 runs the same protocol machinery as FT8
// (same sample rate, same encode/decode option shapes — see
// @e04/ft8ts/dist/ft8ts.d.ts) at a faster 7.5s cadence rather than FT8's
// 15s, per the FT4 spec. Keyed by the exact string this bridge tracks as
// `this._protocol` and the client sends as its `setFt8Variant` value —
// see setVariant() below.
const PROTOCOLS = {
  FT8: { slotMs: FT8_SLOT_MS },
  FT4: { slotMs: FT4_SLOT_MS },
};
const MAX_KNOWN_CALLSIGNS = 500; // bounds the cross-slot hash-resolution memory; see ft8-decode-worker.js
// Audio offset (Hz) within the FT8 passband used when a transmission
// requests no more specific frequency at all (see send()'s optional
// freqHz). 1500Hz — the conventional mid-passband default most FT8
// operators/software (WSJT-X et al.) actually use — rather than an
// arbitrary corner of the passband, matching src/client/app.js's own
// DEFAULT_FT8_TX_FREQ_HZ (kept in sync deliberately: the client always
// sends an explicit freqHz once FT8 mode is active, so this server-side
// fallback is mostly a safety net for any future caller that doesn't,
// and the two defaults disagreeing would be a confusing trap).
const DEFAULT_TX_BASE_FREQUENCY_HZ = 1500;

// Extra time to hold PTT *after* the last PCM byte has been handed to
// AlsaPlayback.write() before releasing it, to cover playback latency that
// isn't visible to this code at all: write() only hands the buffer to the
// OS pipe feeding a persistently-running `aplay` process (see alsa.js) —
// it returns as soon as the pipe accepts the bytes, not when they've
// actually been converted to sound. Two separate delays sit between those
// two moments: `aplay` has to read the pipe and hand the audio to ALSA,
// and ALSA itself buffers a configurable amount of audio in its hardware
// ring buffer before physically outputting it (its `buffer_time`/
// `period_time`, whatever they default to on the actual USB codec in use —
// see docs/audio-notes.md). Without this margin, `_transmitNow()` was
// waiting exactly the *nominal* PCM duration and then releasing PTT
// immediately — before every byte had necessarily reached the speaker —
// which would truncate the tail of the FT8 waveform. For a 79-symbol
// LDPC-coded FT8 transmission, losing even the last symbol or two at the
// receiving station is enough to prevent a clean decode: this isn't a
// cosmetic clipped-audio issue, it's a very plausible reason every real
// on-air QSO attempt has failed to complete even though the encoder and
// resampler have been directly verified (round-trip tested) to produce a
// correct, fully decodable waveform.
//
// 300ms is a deliberately generous default — comfortably more than
// typical ALSA buffer/period sizes (usually tens of ms), leaving margin
// for pipe scheduling jitter under Node's event loop too. Since FT8's
// 15-second slot structure has plenty of idle time before the next
// scheduled transmission, erring high here costs nothing in practice; the
// only real risk was ever erring low.
const PTT_RELEASE_MARGIN_MS = 300;

// Spectrum display tuning. 4096 divides evenly into exactly 1024 bins
// across the 0-3000Hz FT8 passband at 12kHz (binHz = 12000/4096 =
// 2.9296875Hz; 3000 / 2.9296875 = 1024 exactly) — chosen so the
// passband cutoff lands precisely on a bin boundary rather than an
// approximation. ~250ms (a few times a second, per the confirmed UX
// choice) is frequent enough to feel live without meaningfully adding
// to CPU load — this FFT is tiny compared to the FT8 decode itself.
const FT8_SPECTRUM_FFT_SIZE = 4096;
const FT8_SPECTRUM_MAX_HZ = 3000;
const FT8_SPECTRUM_INTERVAL_MS = 250;
// Rolling raw-audio window kept for the spectrum FFT, independent of
// the slot-boundary-aligned `_rxChunks` buffer used for decoding —
// just enough native-rate audio (plus headroom) to always have
// FT8_SPECTRUM_FFT_SIZE samples once downsampled to FT8_SAMPLE_RATE.

// How many dB above the per-frame noise floor maps to the very top
// (byte 255, pure red) of the color scale — see _dbToScaledBytes()'s
// doc comment for why this replaced per-frame min/max autoscaling, and
// for the reasoning behind this specific number. Not an exact
// calibration (there's no direct hardware reference for "dB" here the
// way the S-meter has one) — a considered estimate, checked against a
// user-supplied reference screenshot and a batch of real decode SNRs
// (see that doc comment), not lab-verified against real RF.
const FT8_SPECTRUM_DYNAMIC_RANGE_DB = 50;

/**
 * Wires FT8 RX decoding and TX transmission to the radio's actual audio
 * and PTT, mirroring CwDecoderBridge's overall shape (attach to the same
 * AudioBridge capture stream only when genuinely useful, pause during our
 * own TX) but with two things CW never needed: slot-boundary-aligned
 * buffering (FT8 only makes sense analyzed in whole 15-second, UTC-slot
 * -aligned chunks, not as a continuous stream) and actual transmission
 * (CW's "TX" is the operator's own paddle keying straight through PTT;
 * FT8 TX is a synthesized waveform this bridge generates and plays out
 * itself).
 *
 * RX is only attached while `setActive(true)` has been called (the
 * client's FT8 panel is open — there's no CI-V "FT8 mode" to key off of,
 * since the radio itself just sees USB/DATA; see docs/ui-notes.md) and
 * PTT isn't active. Decoding a slot's audio is CPU-heavy enough (see
 * ft8-decode-worker.js's doc comment) that it runs in a worker thread,
 * not on the main thread where it would stall CI-V/audio/WebSocket
 * handling for seconds at a time.
 *
 * Depends on an already-constructed AudioBridge for both RX PCM
 * (`audioBridge.capture`) and TX playback (`audioBridge.playback`), the
 * same hard dependency on AUDIO_RX_DEVICE (and, for TX, the existing
 * audio-out device) that CW decoding and voice PTT already have.
 */
class Ft8Bridge {
  /**
   * @param {object} opts
   * @param {import('../civ/driver').CivDriver} opts.civ
   * @param {import('../server/ws-server').ControlServer} opts.controlServer
   * @param {import('../server/audio-bridge').AudioBridge} opts.audioBridge
   * @param {SlotClock} [opts.slotClock] - injectable for testing
   * @param {{postMessage: Function, on: Function, terminate: Function}} [opts.worker] - injectable for testing; defaults to a real worker_thread running ft8-decode-worker.js
   * @param {Function} [opts.encodeFn] - injectable for testing; defaults to ft8ts's encodeFT8
   * @param {Function} [opts.encodeFnFt4] - injectable for testing; defaults to ft8ts's encodeFT4. Selected
   *   instead of opts.encodeFn whenever the active variant (see setVariant()) is 'FT4'.
   * @param {number} [opts.txBaseFrequencyHz]
   * @param {Function} [opts.computeSpectrumFn] - injectable for testing; defaults to computeMagnitudeSpectrum from ./fft
   * @param {number} [opts.spectrumIntervalMs] - injectable for testing; defaults to FT8_SPECTRUM_INTERVAL_MS
   * @param {number} [opts.pttReleaseMarginMs] - injectable for testing; defaults to PTT_RELEASE_MARGIN_MS. See that
   *   constant's doc comment for why this margin exists at all.
   * @param {PskReporterClient} [opts.pskReporter] - injectable for testing; defaults to a real
   *   PskReporterClient configured from controlServer.state.stationCallsign/stationGrid — see
   *   src/audio/psk-reporter.js and the "PSK Spot" checkbox in the FT8 UI.
   */
  constructor({
    civ,
    controlServer,
    audioBridge,
    slotClock,
    worker,
    encodeFn,
    encodeFnFt4,
    txBaseFrequencyHz,
    computeSpectrumFn,
    spectrumIntervalMs,
    pttReleaseMarginMs,
    pskReporter,
  }) {
    if (!civ) throw new Error('Ft8Bridge requires opts.civ');
    if (!controlServer) throw new Error('Ft8Bridge requires opts.controlServer');
    if (!audioBridge) throw new Error('Ft8Bridge requires opts.audioBridge');
    this.civ = civ;
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;
    // Keyed the same way as PROTOCOLS/this._protocol above, so
    // _transmitNow() can just do this._encodeFns[this._protocol]. Kept as
    // a map (rather than a single this.encodeFn reassigned by
    // setVariant()) so an injected encodeFn/encodeFnFt4 for testing stays
    // valid across as many setVariant() calls as a test wants to make.
    this._encodeFns = { FT8: encodeFn ?? encodeFT8, FT4: encodeFnFt4 ?? encodeFT4 };
    this.txBaseFrequencyHz = txBaseFrequencyHz ?? DEFAULT_TX_BASE_FREQUENCY_HZ;
    this.computeSpectrumFn = computeSpectrumFn ?? computeMagnitudeSpectrum;
    this.spectrumIntervalMs = spectrumIntervalMs ?? FT8_SPECTRUM_INTERVAL_MS;
    this.pttReleaseMarginMs = pttReleaseMarginMs ?? PTT_RELEASE_MARGIN_MS;

    // Which protocol is currently active — see setVariant(). Purely a
    // server-side mirror of the client's FT8/FT4 toggle button (there's
    // no CI-V concept of either, same as "FT8 mode" itself; see this
    // class's own doc comment above); defaults to 'FT8' to match every
    // pre-FT4 client/test expectation.
    this._protocol = 'FT8';

    this.slotClock = slotClock ?? new SlotClock({ slotMs: FT8_SLOT_MS });
    this.worker = worker ?? new Worker(path.join(__dirname, 'ft8-decode-worker.js'));

    // "PSK Spot" — reports decoded stations to pskreporter.info; see
    // src/audio/psk-reporter.js for the wire protocol and
    // docs/ui-notes.md for the UI. Built from the operator's own
    // configured station identity (STATION_CALLSIGN/STATION_GRID —
    // see src/server/index.js); PskReporterClient itself no-ops (never
    // sends anything) while rxCall is unset, so this is safe to
    // construct/start unconditionally even if that's never configured.
    this.pskReporter =
      pskReporter ??
      new PskReporterClient({
        rxCall: controlServer.state?.stationCallsign,
        rxGrid: controlServer.state?.stationGrid,
      });
    // Enabled by default per the original request — mirrors
    // controlServer's own `state.pskSpotEnabled` default (see
    // ws-server.js), kept as a separate field here (rather than reading
    // controlServer.state directly on every decode) so this stays in
    // sync via the same event-based pattern as `_pttActive`/`_active`
    // above, not a shared mutable read.
    this._pskSpotEnabled = true;

    this._active = false; // client has the FT8 panel open
    this._pttActive = false;
    this._attached = false;
    this._rxChunks = [];
    this._spectrumChunks = [];
    this._spectrumBytes = 0;
    // Keep roughly 400ms of native-rate audio — comfortably more than
    // the ~341ms (4096 samples @ 12kHz) the FFT actually needs once
    // downsampled, so a resample never comes up short.
    this._spectrumMaxBytes = Math.ceil(this.audioBridge.sampleRate * 0.4) * 2;
    this._spectrumTimer = null;
    this._knownCallsigns = [];
    this._pendingRequests = new Map(); // requestId -> {resolve, reject}
    this._nextRequestId = 1;
    this._pendingTxMessage = null; // queued text, sent at the next boundary
    this._pttReleaseTimer = null;

    this._onPcmData = (chunk) => {
      this._rxChunks.push(chunk);
      this._pushSpectrumChunk(chunk);
    };
    this._onBoundary = (info) => this._handleBoundary(info);
    this._onPtt = (on) => this._handlePttChange(on);
    this._onActiveRequest = (active) => this.setActive(active);
    this._onSendRequest = (payload) => {
      // Accepts either a plain string (message only, using this bridge's
      // own default TX frequency) or {message, freqHz} (the guided QSO
      // sequencer's shape — see ws-server.js's SEND_FT8 handler) — kept
      // deliberately tolerant of both rather than a breaking shape change,
      // since a plain string is simpler for anything that doesn't need a
      // specific frequency (a manual composer send, a fresh CQ).
      const { message, freqHz } = typeof payload === 'string' ? { message: payload, freqHz: undefined } : payload;
      this.send(message, { freqHz }).catch((err) => {
        // Errors are already broadcast as EVENT.FT8_TX_STATUS below —
        // this catch only exists so a rejected promise here (nothing is
        // awaiting it, since the request/response already returned
        // "accepted") doesn't surface as an unhandled rejection.
        console.error('[ft8] send failed:', err.message);
      });
    };
    this._onWorkerMessage = (msg) => this._handleWorkerMessage(msg);
    this._onPskSpotEnabledRequest = (enabled) => {
      this._pskSpotEnabled = enabled;
    };
    this._onVariantRequest = (variant) => this.setVariant(variant);

    this.controlServer.on('ptt', this._onPtt);
    this.controlServer.on('ft8-active', this._onActiveRequest);
    this.controlServer.on('ft8-send', this._onSendRequest);
    this.controlServer.on('psk-spot-enabled', this._onPskSpotEnabledRequest);
    this.controlServer.on('ft8-variant', this._onVariantRequest);
    this.slotClock.on('boundary', this._onBoundary);
    this.worker.on('message', this._onWorkerMessage);
    this.worker.on('error', (err) => console.error('[ft8] decode worker error:', err.message));
  }

  start() {
    this.slotClock.start();
    this.pskReporter.start();
  }

  /** Detaches from everything and terminates the decode worker — call on server shutdown. */
  stop() {
    this.slotClock.stop();
    this._detach();
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('ft8-active', this._onActiveRequest);
    this.controlServer.off('ft8-send', this._onSendRequest);
    this.controlServer.off('psk-spot-enabled', this._onPskSpotEnabledRequest);
    this.controlServer.off('ft8-variant', this._onVariantRequest);
    this.slotClock.off('boundary', this._onBoundary);
    if (this._pttReleaseTimer) clearTimeout(this._pttReleaseTimer);
    for (const { reject } of this._pendingRequests.values()) reject(new Error('Ft8Bridge stopped'));
    this._pendingRequests.clear();
    if (typeof this.worker.terminate === 'function') this.worker.terminate();
    this.pskReporter.stop();
  }

  /** Arms/disarms RX decoding — the client calls this when opening/closing the FT8 panel. */
  setActive(active) {
    this._active = active;
    this._syncAttachment();
  }

  /**
   * Switches between the FT8 and FT4 protocols — the server-side half of
   * the client's FT8/FT4 toggle button (see docs/ui-notes.md). Re-grids
   * the slot clock to the new protocol's slot length (SlotClock.setSlotMs()
   * re-arms immediately against the new UTC grid rather than waiting out
   * whatever was left of the old one), discards any RX audio already
   * buffered against the *old* grid (it can't be usefully decoded as a
   * slot of the new length), and cancels — rather than silently
   * re-sending under the new protocol — any transmission that was merely
   * scheduled for the next boundary but hasn't gone out yet, since a
   * message queued as (say) an FT8 CQ shouldn't suddenly go out as FT4.
   * A transmission already in flight (PTT active, playback started) is
   * untouched — this can't rewind audio already being written to the
   * radio, and _transmitNow() itself doesn't read this._protocol again
   * after it starts.
   */
  setVariant(variant) {
    if (variant !== 'FT8' && variant !== 'FT4') {
      throw new Error(`Unknown FT8/FT4 variant: ${variant}`);
    }
    if (variant === this._protocol) return;
    this._protocol = variant;
    this.slotClock.setSlotMs(PROTOCOLS[variant].slotMs);
    this._rxChunks = [];
    if (this._pendingTxMessage) {
      const { reject } = this._pendingTxMessage;
      this._pendingTxMessage = null;
      reject(new Error('FT8/FT4 mode changed before this transmission went out'));
    }
  }

  _syncAttachment() {
    const shouldBeAttached = this._active && !this._pttActive;
    if (shouldBeAttached && !this._attached) this._attach();
    else if (!shouldBeAttached && this._attached) this._detach();
  }

  _attach() {
    if (this._attached) return;
    this._rxChunks = [];
    this._spectrumChunks = [];
    this._spectrumBytes = 0;
    this.audioBridge.capture.on('data', this._onPcmData);
    this._attached = true;
    this._spectrumTimer = setInterval(() => this._emitSpectrum(), this.spectrumIntervalMs);
    if (typeof this._spectrumTimer.unref === 'function') this._spectrumTimer.unref();
  }

  _detach() {
    if (!this._attached) return;
    this.audioBridge.capture.off('data', this._onPcmData);
    this._attached = false;
    this._rxChunks = [];
    this._spectrumChunks = [];
    this._spectrumBytes = 0;
    if (this._spectrumTimer) {
      clearInterval(this._spectrumTimer);
      this._spectrumTimer = null;
    }
  }

  /** Appends to the rolling spectrum buffer, trimming from the front once it exceeds `_spectrumMaxBytes`. */
  _pushSpectrumChunk(chunk) {
    this._spectrumChunks.push(chunk);
    this._spectrumBytes += chunk.length;
    while (this._spectrumBytes > this._spectrumMaxBytes && this._spectrumChunks.length > 1) {
      const dropped = this._spectrumChunks.shift();
      this._spectrumBytes -= dropped.length;
    }
  }

  /**
   * Computes a magnitude spectrum of the most recent audio (via a real
   * FFT — see src/audio/fft.js) and broadcasts it as a BINARY_TYPE.FT8_SPECTRUM
   * frame, cropped to the FT8 passband (0-FT8_SPECTRUM_MAX_HZ) and scaled
   * to a 0-255 byte range for reuse with the client's existing waterfall
   * color mapping (see amplitudeToColor() in scope.js). No-ops until
   * enough audio has accumulated (e.g. immediately after FT8 mode is
   * armed). See _dbToScaledBytes() below for the scaling itself — an
   * earlier version of this method autoscaled each frame independently
   * to its own min/max, which turned out to be a real bug (see that
   * function's doc comment).
   */
  _emitSpectrum() {
    if (this._spectrumBytes === 0) return;
    const combined = Buffer.concat(this._spectrumChunks, this._spectrumBytes);
    const sampleCount = Math.floor(combined.length / 2);
    if (sampleCount === 0) return;
    const int16 = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) int16[i] = combined.readInt16LE(i * 2);

    let floatSamples;
    try {
      floatSamples = downsamplePcmToFloat(int16, this.audioBridge.sampleRate, FT8_SAMPLE_RATE);
    } catch (err) {
      console.error('[ft8] spectrum resample failed:', err.message);
      return;
    }

    const { magnitudes, binHz } = this.computeSpectrumFn(floatSamples, {
      fftSize: FT8_SPECTRUM_FFT_SIZE,
      sampleRate: FT8_SAMPLE_RATE,
    });
    const binCount = Math.min(magnitudes.length, Math.round(FT8_SPECTRUM_MAX_HZ / binHz));

    const bins = _dbToScaledBytes(magnitudes, binCount);
    this.controlServer.broadcastBinary(encodeFt8SpectrumFrame(binHz, bins));
  }

  _handlePttChange(on) {
    this._pttActive = on;
    this._syncAttachment();
  }

  /**
   * Queues an FT8 transmission for the next slot boundary and resolves
   * once it's been sent (or rejects if encoding/PTT/playback fails).
   * Only one transmission can be queued at a time — a second call before
   * the first has gone out replaces it, on the assumption an operator
   * changing their mind about what to send next is more likely than
   * wanting both queued back to back.
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.freqHz] - audio-offset frequency (Hz within the
   *   passband) to transmit this message at, overriding txBaseFrequencyHz
   *   for just this one transmission. Used by the guided QSO sequencer
   *   (src/client/ft8-qso.js) so a reply goes out at the frequency the
   *   other station is actually listening on — standard FT8 operating
   *   practice, see docs/ui-notes.md — rather than this bridge's one
   *   fixed default. Omit for a plain/manual send (e.g. a fresh CQ).
   */
  send(message, { freqHz } = {}) {
    return new Promise((resolve, reject) => {
      this._pendingTxMessage = { message, freqHz, resolve, reject };
      this.controlServer.broadcastJsonEvent(EVENT.FT8_TX_STATUS, {
        status: 'scheduled',
        message,
        freqHz: freqHz ?? this.txBaseFrequencyHz,
        sendAtMs: this.slotClock.nextSlotStart(),
      });
    });
  }

  _handleBoundary({ slotStartMs, slotMs }) {
    // The slot that just *ended* is the one immediately before this
    // boundary — decode whatever RX audio was captured during it.
    if (this._attached && this._rxChunks.length > 0) {
      this._decodeSlot(slotStartMs - slotMs, this._rxChunks);
    }
    this._rxChunks = [];

    if (this._pendingTxMessage) {
      const tx = this._pendingTxMessage;
      this._pendingTxMessage = null;
      this._transmitNow(tx);
    }
  }

  _decodeSlot(slotStartMs, chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const combined = Buffer.concat(chunks, total);
    const sampleCount = Math.floor(combined.length / 2);
    const int16 = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) int16[i] = combined.readInt16LE(i * 2);

    let floatSamples;
    try {
      floatSamples = downsamplePcmToFloat(int16, this.audioBridge.sampleRate, FT8_SAMPLE_RATE);
    } catch (err) {
      this.controlServer.broadcastJsonEvent(EVENT.RIG_ERROR, { message: `FT8 resample failed: ${err.message}` });
      return;
    }

    const requestId = this._nextRequestId++;
    this._pendingRequests.set(requestId, {
      resolve: ({ messages, discoveredCallsigns }) => {
        this._rememberCallsigns(discoveredCallsigns);
        this.controlServer.broadcastJsonEvent(EVENT.FT8_DECODES, { slotStartMs, messages });
        this._reportSpots(messages, slotStartMs);
      },
      reject: (err) => {
        this.controlServer.broadcastJsonEvent(EVENT.RIG_ERROR, { message: `FT8 decode failed: ${err.message}` });
      },
    });
    // Float32Array's buffer is transferred (zero-copy) to the worker
    // rather than cloned — safe because `floatSamples` isn't touched
    // again after this call.
    this.worker.postMessage(
      {
        type: 'decode',
        requestId,
        samples: floatSamples.buffer,
        sampleRate: FT8_SAMPLE_RATE,
        knownCallsigns: this._knownCallsigns,
        protocol: this._protocol,
      },
      [floatSamples.buffer]
    );
  }

  _handleWorkerMessage(msg) {
    const pending = this._pendingRequests.get(msg.requestId);
    if (!pending) return;
    this._pendingRequests.delete(msg.requestId);
    if (msg.type === 'decoded') {
      pending.resolve({ messages: msg.messages, discoveredCallsigns: msg.discoveredCallsigns });
    } else if (msg.type === 'decode-error') {
      pending.reject(new Error(msg.error));
    }
  }

  _rememberCallsigns(callsigns) {
    for (const call of callsigns) {
      if (!this._knownCallsigns.includes(call)) this._knownCallsigns.push(call);
    }
    // Bounded, and oldest-first-out rather than never growing further —
    // an unattended, long-running session shouldn't accumulate this
    // forever, and the most recently active callsigns on the band are
    // the most useful ones to keep resolving hashes against anyway.
    if (this._knownCallsigns.length > MAX_KNOWN_CALLSIGNS) {
      this._knownCallsigns.splice(0, this._knownCallsigns.length - MAX_KNOWN_CALLSIGNS);
    }
  }

  /**
   * Queues every plausible decoded station from one completed slot as a
   * PSK Reporter spot (see src/audio/psk-reporter.js) — a no-op unless
   * both the "PSK Spot" checkbox is enabled and STATION_CALLSIGN is
   * configured (PskReporterClient#addSpot() itself already guards the
   * latter, but checking here too avoids the pointless extractSpot()
   * work on every message for a rig that's never going to spot anyway).
   * Absolute (dial + audio-offset) frequency is used for the "Tx Freq"
   * field, matching what every other PSK Reporter client reports and
   * what pskreporter.info's own map expects — `message.freq` alone is
   * only the audio-domain offset within the passband (see
   * docs/ui-notes.md), so this adds the radio's current dial frequency
   * (controlServer.state.frequency, kept live by CI-V's own unsolicited
   * frequency updates — see ws-server.js) to get there.
   */
  _reportSpots(messages, slotStartMs) {
    if (!this._pskSpotEnabled || !this.controlServer.state?.stationCallsign) return;
    const dialHz = this.controlServer.state?.frequency || 0;
    const timeSec = Math.floor(slotStartMs / 1000);
    for (const message of messages) {
      const spot = extractSpot(message.msg);
      if (!spot) continue;
      this.pskReporter.addSpot({
        call: spot.call,
        grid: spot.grid,
        freqHz: dialHz + (message.freq || 0),
        snr: message.snr,
        mode: this._protocol,
        timeSec,
      });
    }
  }

  async _transmitNow({ message, freqHz, resolve, reject }) {
    const actualFreqHz = freqHz ?? this.txBaseFrequencyHz;
    try {
      this.controlServer.broadcastJsonEvent(EVENT.FT8_TX_STATUS, { status: 'sending', message, freqHz: actualFreqHz });
      const floatSamples = this._encodeFns[this._protocol](message, {
        sampleRate: FT8_SAMPLE_RATE,
        baseFrequency: actualFreqHz,
      });
      const pcm = upsampleFloatToPcm(floatSamples, FT8_SAMPLE_RATE, this.audioBridge.sampleRate);

      await this.controlServer.setPttFromServer(true);
      this.audioBridge.playback.write(pcm);

      const durationMs = (pcm.length / 2 / this.audioBridge.sampleRate) * 1000;
      // See PTT_RELEASE_MARGIN_MS's doc comment: hold PTT for longer than
      // the nominal PCM duration so the pipe + ALSA buffering between
      // write() returning and the audio actually reaching the speaker has
      // time to drain before the radio de-keys.
      await new Promise((r) => {
        this._pttReleaseTimer = setTimeout(r, durationMs + this.pttReleaseMarginMs);
      });
      this._pttReleaseTimer = null;
      await this.controlServer.setPttFromServer(false);

      this.controlServer.broadcastJsonEvent(EVENT.FT8_TX_STATUS, { status: 'sent', message, freqHz: actualFreqHz });
      resolve();
    } catch (err) {
      try {
        await this.controlServer.setPttFromServer(false);
      } catch {
        // best-effort — if this also fails, the PTT watchdog is still
        // armed from the setPttFromServer(true) above and will force it
        // off within its own timeout regardless.
      }
      this.controlServer.broadcastJsonEvent(EVENT.FT8_TX_STATUS, { status: 'error', message, error: err.message });
      reject(err);
    }
  }
}

/**
 * Converts one frame's raw FFT magnitudes to the 0-255 byte scale the
 * FT8_SPECTRUM wire format carries, for reuse with the client's existing
 * `amplitudeToColor()` waterfall heatmap (see scope.js).
 *
 * An earlier version of this stretched each frame independently to its
 * own min/max — i.e. whatever the single loudest bin in *that* frame
 * happened to be always became pure red, and the quietest always became
 * pure black, regardless of how strong or weak either actually was. A
 * user-supplied reference screenshot showing an almost entirely solid-red
 * waterfall — alongside a batch of real FT8 decodes from that same
 * moment with SNRs from -6 to -17dB, i.e. genuinely weak-to-moderate
 * signals, not "everything is screaming in" — made the bug obvious: a
 * frame of *pure noise* looks visually identical to one with a strong
 * signal under min/max stretching, because the noise floor's own
 * bin-to-bin variance alone spans a wide enough dB range to fill the
 * whole color scale once stretched.
 *
 * This replaces that with a fixed-dB-span mapping *relative to the
 * frame's own noise floor*, matching how conventional SDR/waterfall
 * displays (and WSJT-X's own) are calibrated: the floor still adapts
 * per frame (so changes in RX gain or band noise re-center the display
 * rather than clipping it), but the *span* of dB above it that reaches
 * full red is fixed, so a quiet frame stays mostly blue/black instead of
 * being stretched to look identical to a loud one.
 *
 * The noise floor is estimated as the per-frame *median* dB across all
 * bins, not the minimum — robust to the handful of bins an actual FT8
 * signal occupies (each tone is only ~6.25Hz wide, at most a couple of
 * these ~2.93Hz-wide bins) even with several signals decoding in the
 * same slot, since the great majority of bins are still noise either way.
 *
 * FT8_SPECTRUM_DYNAMIC_RANGE_DB (50) is a judgment call, not a hardware
 * calibration (there's no S-meter-style ground truth for "dB" in this
 * audio-FFT context the way there is for the RF scope's amplitude byte).
 * It's picked so that a per-bin SNR roughly in line with WSJT-X's own
 * reported decode SNRs lands near the middle of the scale (which is also
 * where `amplitudeToColor()` pins its S9 red reference) — per-bin SNR
 * reads meaningfully higher than WSJT-X's reported SNR because WSJT-X
 * normalizes to a 2500Hz reference bandwidth while a single FFT bin here
 * is only ~2.93Hz wide (roughly a 29dB narrower-bandwidth, thus
 * higher-SNR, view of the same signal). This is an estimate to get the
 * displayed contrast into a sensible range, not a claim that the color
 * scale reads out a specific SNR value.
 */
function _dbToScaledBytes(magnitudes, binCount) {
  const EPS = 1e-9;
  const db = new Float64Array(binCount);
  for (let i = 0; i < binCount; i++) db[i] = 20 * Math.log10(magnitudes[i] + EPS);

  const sorted = Array.from(db).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const noiseFloorDb = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  const bins = Buffer.alloc(binCount);
  for (let i = 0; i < binCount; i++) {
    const aboveFloorDb = db[i] - noiseFloorDb;
    bins[i] = Math.max(0, Math.min(255, Math.round((aboveFloorDb / FT8_SPECTRUM_DYNAMIC_RANGE_DB) * 255)));
  }
  return bins;
}

/**
 * Wire format for a BINARY_TYPE.FT8_SPECTRUM frame — mirrors
 * scope-bridge.js's encodeScopeLine() pattern (fixed header + payload):
 *   [0]      BINARY_TYPE.FT8_SPECTRUM
 *   [1..4]   binHz, Float32LE (the width of one bin, in Hz)
 *   [5..]    one unsigned byte per bin (0-255 — see _dbToScaledBytes()
 *            for how a magnitude becomes this byte)
 * The client-side decoder mirrors this format in src/client/rpc.js —
 * keep both in sync if this changes.
 */
function encodeFt8SpectrumFrame(binHz, bins) {
  const header = Buffer.alloc(5);
  header[0] = BINARY_TYPE.FT8_SPECTRUM;
  header.writeFloatLE(binHz, 1);
  return Buffer.concat([header, bins]);
}

module.exports = {
  Ft8Bridge,
  FT8_SAMPLE_RATE,
  FT8_SLOT_MS,
  FT4_SLOT_MS,
  DEFAULT_TX_BASE_FREQUENCY_HZ,
  PTT_RELEASE_MARGIN_MS,
  FT8_SPECTRUM_FFT_SIZE,
  FT8_SPECTRUM_MAX_HZ,
  FT8_SPECTRUM_INTERVAL_MS,
  FT8_SPECTRUM_DYNAMIC_RANGE_DB,
  encodeFt8SpectrumFrame,
  _dbToScaledBytes,
};
