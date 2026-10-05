'use strict';

const { EventEmitter } = require('events');
const { RadePipeline } = require('../audio/rade-pipeline');
const { downsamplePcmToFloat, upsampleFloatToPcm } = require('../audio/resample');
const { tagAudio } = require('./audio-bridge');
const { EVENT, BINARY_TYPE } = require('./protocol');

// Sample rates fixed by the rade_c tools themselves (RADE_FS_SPEECH /
// RADE_FS in the upstream C sources), not something this bridge chooses —
// see docs/ui-notes.md for how these were confirmed from the project's
// own documented example pipelines (github.com/freedv/rade_c), since
// there's no way to verify them against the real binaries from this
// environment.
const RADE_SPEECH_SAMPLE_RATE = 16000; // lpcnet_demo's speech-domain rate, both directions
const RADE_MODEM_SAMPLE_RATE = 8000; // the real-valued modem-tone rate radae_tx outputs and radae_rx expects on input

// Scaling constant from rade_c's own rade_api.h — NOT the standard "int16
// full-scale" convention this file's other PCM helpers use. Confirmed by
// reading rade_api.h directly (see docs/ui-notes.md's "Real bug found" note
// on the real2iq/scaling bug this constant fixes):
//
//   TX (float IQ -> int16):  int16 = Re{radae_tx output} * RADE_INT16_SCALE
//     (nominal float amplitude 1.0 -> int16 16384, deliberately leaving 6dB
//     of headroom to the int16 ceiling of 32767 for peaks)
//   RX, real-valued input (int16 -> float, imag = 0): float = int16 * (2 / RADE_INT16_SCALE)
//     (restores unit amplitude at the OFDM correlators after Re{} halves
//     the power of the positive-frequency component radae_rx tunes to)
//
// Only the RX half of this is actually applied by this bridge (see
// RADE_REAL_INPUT_RESCALE below) — an on-air test showed the documented TX
// half made this app's real transmit chain too quiet, not correctly
// leveled; see docs/ui-notes.md's "Real bug found: reverting the
// RADE_INT16_SCALE-based TX scaling" note and _handleModulatedAudio()'s
// own doc comment. RADE_INT16_SCALE itself is kept as a named constant
// purely for that RX use and for this doc comment's own reference value.
const RADE_INT16_SCALE = 16384.0;

// downsamplePcmToFloat() (src/audio/resample.js) uses the generic
// full-scale PCM convention (divide by 32768), not RADE_INT16_SCALE's
// documented 16384 — this constant converts between the two conventions
// for RX's real-input scaling, rather than duplicating the resample/
// filter logic downsamplePcmToFloat() already provides. See
// _handleRadioAudio()'s own doc comment for the derivation. There is no
// equivalent constant on the TX side — see _handleModulatedAudio()'s own
// doc comment and docs/ui-notes.md's "Real bug found: reverting the
// RADE_INT16_SCALE-based TX scaling" note for why TX deliberately does
// NOT apply a RADE_INT16_SCALE correction, unlike RX.
const RADE_REAL_INPUT_RESCALE = 32768 / (RADE_INT16_SCALE / 2); // = 4

/**
 * Wires the compiled rade_c binaries (radae_tx, radae_rx, lpcnet_demo —
 * see docs/ui-notes.md for install instructions and where they come from;
 * rade_c also ships real2iq, but this bridge deliberately doesn't use it —
 * see below) to the radio's actual RX/TX audio, so the FreeDV mode
 * button's "RADE" variant does real encode/decode instead of just
 * toggling USB + DATA MODE (see src/client/app.js's enterFreeDvMode()
 * doc comment for the state of things before this bridge existed).
 *
 * Two independent chained subprocess pipelines (see
 * src/audio/rade-pipeline.js), spawned/torn down as PTT and the
 * armed/variant state change — never both attached at once, since this
 * app is half-duplex the same way plain PTT already is:
 *
 *   RX (armed, not transmitting):
 *     radio audio (audioBridge.sampleRate) --downsample--> 8kHz real PCM
 *       -> built directly into complex float32 IQ with the imaginary part
 *          set to zero and the real part rescaled to RADE's own
 *          documented real-input convention (RADE_INT16_SCALE, see above)
 *          — NOT a Hilbert-transform conversion (real2iq) and NOT plain
 *          16-bit PCM; see _handleRadioAudio() below and docs/ui-notes.md's
 *          "Real bug found" note for why both of those were wrong
 *       -> radae_rx --v2 -> lpcnet_demo -fargan-synthesis
 *       -> 16kHz speech PCM --upsample--> audioBridge.sampleRate
 *       -> broadcast as an ordinary tagged AUDIO frame (see tagAudio()),
 *          the exact same channel/format AudioBridge's own RX broadcast
 *          uses, so the client needs zero changes to hear it.
 *
 *   TX (armed, PTT active):
 *     operator's mic audio, arriving the normal way as a client's tagged
 *     AUDIO binary message (see ControlServer's 'binary-message' event)
 *       --downsample--> 16kHz speech PCM
 *       -> lpcnet_demo -features -> radae_tx --v2
 *       -> radae_tx's stdout is complex float32 IQ (8kHz, interleaved
 *          I,Q) — the real (I) component is extracted directly and,
 *          per the reference RADE GUI client's own approach ("take real
 *          part, scale by TX output level"), optionally gained (txGain)
 *          before being treated as the actual passband audio to transmit
 *          — deliberately at the same generic full-scale PCM level every
 *          other TX path in this app uses, not RADE_INT16_SCALE's
 *          documented (but, on-air, too-quiet) headroom-scaled level; see
 *          _handleModulatedAudio() below and docs/ui-notes.md's "Real bug
 *          found: reverting the RADE_INT16_SCALE-based TX scaling" note
 *       -> 8kHz real waveform --upsample--> audioBridge.sampleRate
 *       -> written straight to audioBridge.playback, the same call
 *          Ft8Bridge's own synthesized TX audio uses (see ft8-bridge.js).
 *
 * **There is no real2iq (or any other Hilbert-transform) stage anywhere
 * in this bridge, on either direction.** An earlier version of this file
 * ran rade_c's real2iq tool as the first RX stage, on the theory that
 * radae_rx needed a proper analytic-signal IQ conversion of the radio's
 * real audio. Two things were wrong with that, discovered only by reading
 * rade_c's own source directly (see docs/ui-notes.md's "Real bug found"
 * note for the full story):
 *   1. real2iq.c reads its *entire* stdin to EOF before writing a single
 *      byte of output — it's a batch, whole-file tool, not a streaming
 *      one. Piped into a live, never-closing radio-audio stream, it can
 *      never produce output at all, which is why RX stayed completely
 *      silent even after the separate PCM-vs-float32 format bug (see
 *      below) was fixed.
 *   2. It's also not what rade_c's own reference RX tool
 *      (rade_demod_wav.c, "RADAE WAV demodulator") does for real-valued
 *      input in the first place: it builds IQ with the imaginary part set
 *      to zero, reasoning that the OFDM carriers (1062-1875 Hz) don't
 *      overlap the negative-frequency mirror a real signal produces
 *      (-1875 to -1062 Hz), so no Hilbert transform is needed at all.
 * This bridge now does the same zero-imaginary construction in JS,
 * directly in _handleRadioAudio() below, with no extra subprocess.
 *
 * Because both directions would otherwise collide with AudioBridge's own
 * always-on raw passthrough (raw modem tones instead of/alongside decoded
 * speech on RX; the operator's raw mic audio racing this bridge's encoded
 * audio into `playback` on TX), attaching either pipeline also mutes the
 * matching direction on AudioBridge for as long as it's attached — see
 * AudioBridge#setRxMuted()/setTxMuted()'s own doc comments for why this
 * needed a small change there instead of just observing the stream the
 * way CwDecoderBridge/RttyDecoderBridge/Ft8Bridge's RX decode already do.
 *
 * FreeDV isn't a CI-V hardware mode (same as FT8 — see
 * src/audio/ft8-bridge.js's own doc comment and docs/ui-notes.md), so
 * this bridge doesn't key off civ 'mode' events at all, only the client's
 * own armed/variant toggle (REQUEST.SET_FREEDV_ACTIVE /
 * REQUEST.SET_FREEDV_VARIANT — see ws-server.js) and controlServer's
 * shared 'ptt' state, exactly mirroring how Ft8Bridge itself has no
 * mode-based gating either.
 *
 * **Only the 'RADE' variant does anything.** '700E' is Codec2-based, not
 * part of rade_c at all (rade_c is specifically the RADE neural-vocoder
 * codec's C port — see docs/ui-notes.md), so this bridge stays fully idle
 * (no subprocess spawned, no muting) while the active variant is '700E',
 * even if the client has "armed" FreeDV. There is still no 700E codec
 * anywhere in this codebase.
 *
 * **Genuinely unverified.** Every other decoder in this codebase (CW,
 * RTTY, FT8) was checked against either synthetic audio generated and
 * decoded in the same environment it was developed in, or real off-air
 * recordings. Neither is possible here: radae_tx/radae_rx/lpcnet_demo are
 * native binaries that only exist on the operator's own server (compiled
 * there, per docs/ui-notes.md's install notes) — nothing
 * about this bridge's subprocess plumbing, resampling, or format
 * assumptions has been exercised against the real tools or real radio
 * hardware from here. See docs/ui-notes.md's "Known limitations" for
 * RADE for the full list of what that means in practice, including that
 * upstream itself currently says RADE V2 on-air use isn't recommended
 * yet.
 */
class RadeBridge extends EventEmitter {
  /**
   * @fires RadeBridge#decoded-speech - `(pcm: Buffer)`, once per decoded
   *   RX chunk, right alongside the `broadcastBinary()` call that sends
   *   the same audio to connected clients for playback (see
   *   `_handleDecodedSpeech()`). `pcm` is already resampled to
   *   `audioBridge.sampleRate` — the same PCM format/rate `audioBridge.
   *   capture`'s own `'data'` event chunks are in — so any consumer built
   *   to read RX audio from `audioBridge.capture` can read this instead
   *   with no reformatting. This exists so something server-side other
   *   than "play it back to the client" can get at the actual decoded
   *   *speech*, as opposed to `audioBridge.capture`'s raw stream, which
   *   while FreeDV is active is the off-air OFDM modem waveform (digital
   *   tones), not voice — a consumer needing decoded speech can't just tap
   *   `audioBridge.capture` like every other voice mode, hence this event.
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {import('./audio-bridge').AudioBridge} opts.audioBridge
   * @param {string} [opts.txBin] - path/name of the radae_tx binary; defaults to 'radae_tx' (must be on PATH)
   * @param {string} [opts.rxBin] - path/name of the radae_rx binary; defaults to 'radae_rx'
   * @param {string} [opts.lpcnetBin] - path/name of the lpcnet_demo binary; defaults to 'lpcnet_demo'
   * @param {'v1'|'v2'} [opts.radeVersion] - which RADE protocol version to pass to radae_tx/radae_rx via
   *   --v2 (default 'v1' — the stable, undeprecated waveform per rade_c's own README; 'v2' is
   *   opt-in only, since upstream itself currently says V2 "is under active development" and
   *   "on-air use is not recommended at this stage" — see docs/ui-notes.md). Both ends of a link
   *   must agree on this, same as any modem.
   * @param {number} [opts.txGain] - linear multiplier applied to the real part extracted from
   *   radae_tx's complex IQ output before it's sent to the radio (default 4 — see below). Unlike
   *   everything else radio-facing in this bridge, this genuinely has no independently-confirmed
   *   "correct" value: nothing here has been checked against real hardware or a real over-the-air
   *   signal from this environment. The default of 4 is itself just a real-world data point, not a
   *   spec — a remote station reported only ~20% modulation with no extra gain applied (txGain 1,
   *   i.e. radae_tx's raw real-part amplitude, unmodified) — so 4 is a middle-of-the-road
   *   correction (~80% modulation at that same operating point, deliberately short of 5x/100% to
   *   leave headroom against clipping the OFDM waveform's peaks, which typically run hotter than
   *   its average/ALC-read level). Adjust by ear/power-meter (same instrument used to diagnose "no
   *   power" in the first place, and this same ~20%-modulation report) via `RADE_TX_GAIN` if TX
   *   still reads low or now clips/distorts on your own radio/audio chain — see docs/ui-notes.md.
   * @param {Function} [opts.pipelineFactory] - injectable for testing; defaults to `(opts) => new RadePipeline(opts)`
   */
  constructor({ controlServer, audioBridge, txBin, rxBin, lpcnetBin, radeVersion, txGain, pipelineFactory }) {
    super();
    if (!controlServer) throw new Error('RadeBridge requires opts.controlServer');
    if (!audioBridge) throw new Error('RadeBridge requires opts.audioBridge');
    this.controlServer = controlServer;
    this.audioBridge = audioBridge;

    this._txBin = txBin ?? 'radae_tx';
    this._rxBin = rxBin ?? 'radae_rx';
    this._lpcnetBin = lpcnetBin ?? 'lpcnet_demo';
    // Default 4, not 1 — see this constructor's own @param txGain doc
    // comment above and docs/ui-notes.md's "Real bug found: only ~20%
    // modulation with the reverted full-scale TX level" note for why a
    // flat "no extra gain" default was itself found too quiet on real
    // hardware.
    this._txGain = typeof txGain === 'number' && txGain > 0 ? txGain : 4;
    this._versionArgs = radeVersion === 'v2' ? ['--v2'] : [];
    this._makePipeline = pipelineFactory ?? ((pipelineOpts) => new RadePipeline(pipelineOpts));

    this._active = false; // client has "armed" FreeDV via SET_FREEDV_ACTIVE
    this._variant = 'RADE'; // mirrors controlServer.state.freeDvVariant's own default — see its doc comment in ws-server.js
    this._pttActive = false;

    this._rxAttached = false;
    this._rxPipeline = null;
    this._txAttached = false;
    this._txPipeline = null;

    this._onRxPcm = (chunk) => this._handleRadioAudio(chunk);
    this._onPtt = (on) => this._handlePttChange(on);
    this._onActiveRequest = (active) => this.setActive(active);
    this._onVariantRequest = (variant) => this.setVariant(variant);
    this._onBinaryMessage = (ws, data) => this._handleClientAudio(data);

    this.controlServer.on('ptt', this._onPtt);
    this.controlServer.on('freedv-active', this._onActiveRequest);
    this.controlServer.on('freedv-variant', this._onVariantRequest);
    this.controlServer.on('binary-message', this._onBinaryMessage);
  }

  /** No async setup needed (see this class's own doc comment on why there's no CI-V mode to read) — exists for symmetry with the other bridges' start()/stop() lifecycle. */
  start() {}

  /** Detaches from everything and tears down any running pipeline — call on server shutdown. */
  stop() {
    this._detachRx();
    this._detachTx();
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('freedv-active', this._onActiveRequest);
    this.controlServer.off('freedv-variant', this._onVariantRequest);
    this.controlServer.off('binary-message', this._onBinaryMessage);
  }

  /** Arms/disarms the bridge — the client calls this when opening/closing FreeDV mode (mirrors Ft8Bridge#setActive). */
  setActive(active) {
    this._active = active;
    this._syncAttachment();
  }

  /**
   * Switches between the '700E' and 'RADE' variants — the server-side
   * half of the client's FreeDV toggle button. Only 'RADE' actually
   * attaches anything (see this class's own doc comment); switching
   * *away* from 'RADE' while a pipeline is attached tears it down
   * immediately, same as leaving FreeDV mode entirely would.
   */
  setVariant(variant) {
    if (variant !== '700E' && variant !== 'RADE') {
      throw new Error(`Unknown FreeDV variant: ${variant}`);
    }
    if (variant === this._variant) return;
    this._variant = variant;
    this._syncAttachment();
  }

  _handlePttChange(on) {
    this._pttActive = on;
    this._syncAttachment();
  }

  get _radeArmed() {
    return this._active && this._variant === 'RADE';
  }

  _syncAttachment() {
    const shouldRx = this._radeArmed && !this._pttActive;
    const shouldTx = this._radeArmed && this._pttActive;
    if (shouldRx && !this._rxAttached) this._attachRx();
    else if (!shouldRx && this._rxAttached) this._detachRx();
    if (shouldTx && !this._txAttached) this._attachTx();
    else if (!shouldTx && this._txAttached) this._detachTx();
  }

  _attachRx() {
    if (this._rxAttached) return;
    this.audioBridge.setRxMuted(true);
    this._rxPipeline = this._makePipeline({
      label: 'rade-rx',
      stages: [
        // radae_rx is fed complex IQ built directly in JS (see
        // _handleRadioAudio() below) — no real2iq stage; see this class's
        // own doc comment for why.
        { bin: this._rxBin, args: [...this._versionArgs] },
        { bin: this._lpcnetBin, args: ['-fargan-synthesis', '-', '-'] },
      ],
    });
    this._rxPipeline.on('data', (chunk) => this._handleDecodedSpeech(chunk));
    this._rxPipeline.on('error', (err) => this._reportError('rx', err));
    this._rxPipeline.on('stderr', (msg) => console.error('[rade-rx]', msg));
    this._rxPipeline.start();
    this.audioBridge.capture.on('data', this._onRxPcm);
    this._rxAttached = true;
  }

  _detachRx() {
    if (!this._rxAttached) return;
    this.audioBridge.capture.off('data', this._onRxPcm);
    if (this._rxPipeline) {
      this._rxPipeline.stop();
      this._rxPipeline = null;
    }
    this.audioBridge.setRxMuted(false);
    this._rxAttached = false;
  }

  _attachTx() {
    if (this._txAttached) return;
    this.audioBridge.setTxMuted(true);
    this._txPipeline = this._makePipeline({
      label: 'rade-tx',
      stages: [
        { bin: this._lpcnetBin, args: ['-features', '-', '-'] },
        { bin: this._txBin, args: [...this._versionArgs] },
        // No real2iq (or any other) stage after radae_tx — its stdout is
        // already the final native-tool output, complex float32 IQ; the
        // conversion down to a real passband waveform for the radio
        // happens in JS, in _handleModulatedAudio() below, not another
        // subprocess stage. See this class's own doc comment for why
        // real2iq specifically does not belong here.
      ],
    });
    this._txPipeline.on('data', (chunk) => this._handleModulatedAudio(chunk));
    this._txPipeline.on('error', (err) => this._reportError('tx', err));
    this._txPipeline.on('stderr', (msg) => console.error('[rade-tx]', msg));
    this._txPipeline.start();
    this._txAttached = true;
  }

  _detachTx() {
    if (!this._txAttached) return;
    if (this._txPipeline) {
      this._txPipeline.stop();
      this._txPipeline = null;
    }
    this.audioBridge.setTxMuted(false);
    this._txAttached = false;
  }

  /**
   * RX: radio audio at audioBridge.sampleRate -> 8kHz real samples ->
   * complex float32 IQ with the imaginary part zeroed, at RADE's own
   * real-input scale (RADE_INT16_SCALE) -> radae_rx's stdin directly (no
   * real2iq stage — see this class's own doc comment for why).
   *
   * `downsamplePcmToFloat()` normalizes int16 to the generic [-1, 1]
   * range (divides by 32768), which is NOT the scale rade_api.h documents
   * for real-valued RX input (`float = int16 * (2 / RADE_INT16_SCALE)`,
   * i.e. divide by 8192, not 32768) — so its output is rescaled by
   * `RADE_REAL_INPUT_RESCALE` (32768 / 8192 = 4) below to land on RADE's
   * actual documented convention rather than the generic PCM one.
   * Skipping this rescale doesn't crash anything — it just hands radae_rx
   * a signal at 1/4 the amplitude the OFDM correlators are tuned for,
   * which is exactly the kind of "runs fine, decodes nothing" failure
   * this bridge has already gotten wrong once (see docs/ui-notes.md's
   * "Real bug found" notes).
   */
  _handleRadioAudio(chunk) {
    if (!this._rxPipeline) return;
    let iqBytes;
    try {
      const generic = downsamplePcmToFloat(readInt16Array(chunk), this.audioBridge.sampleRate, RADE_MODEM_SAMPLE_RATE);
      iqBytes = realFloatToZeroImagIq(generic, RADE_REAL_INPUT_RESCALE);
    } catch (err) {
      this._reportError('rx-resample-in', err);
      return;
    }
    this._rxPipeline.write(iqBytes);
  }

  /**
   * RX: the chain's decoded 16kHz speech -> audioBridge.sampleRate ->
   * broadcast as a normal tagged AUDIO frame for client playback, AND
   * emitted as `'decoded-speech'` with the same resampled `pcmOut` for any
   * other server-side consumer that needs the actual decoded voice (not
   * `audioBridge.capture`'s raw modem waveform) — see this class's own
   * `@fires RadeBridge#decoded-speech` doc comment above.
   */
  _handleDecodedSpeech(chunk) {
    let pcmOut;
    try {
      pcmOut = resamplePcm(chunk, RADE_SPEECH_SAMPLE_RATE, this.audioBridge.sampleRate);
    } catch (err) {
      this._reportError('rx-resample-out', err);
      return;
    }
    this.controlServer.broadcastBinary(tagAudio(pcmOut));
    this.emit('decoded-speech', pcmOut);
  }

  /** TX: an operator's raw mic audio, arriving as a client's tagged AUDIO binary message. */
  _handleClientAudio(data) {
    if (!this._txPipeline) return;
    if (data.length < 1 || data[0] !== BINARY_TYPE.AUDIO) return; // not ours (e.g. a scope/FT8-spectrum tag)
    const payload = data.subarray(1);
    let pcm16k;
    try {
      pcm16k = resamplePcm(payload, this.audioBridge.sampleRate, RADE_SPEECH_SAMPLE_RATE);
    } catch (err) {
      this._reportError('tx-resample-in', err);
      return;
    }
    this._txPipeline.write(pcm16k);
  }

  /**
   * TX: radae_tx's stdout — complex float32 IQ at 8kHz, interleaved
   * (I,Q,I,Q,...), NOT real-valued PCM — extract just the real (I)
   * component (this bridge's own previous bug fed this straight into a
   * PCM resampler as if it were already real 16-bit audio, which both
   * misreads the sample width — 4-byte floats sliced as 2-byte ints — and
   * throws away nothing of the imaginary part, since it was never
   * separated out at all; see docs/ui-notes.md's "Real bug found" note),
   * then resample/anti-alias/pack to 16-bit PCM at audioBridge.sampleRate
   * via upsampleFloatToPcm() (float32 in, same helper ft8-bridge.js's own
   * TX path uses) and write it straight to the radio (mirrors Ft8Bridge's
   * own playback.write()).
   *
   * `upsampleFloatToPcm()` clamps to [-1, 1] and scales to int16 by the
   * generic full-scale PCM convention (32767), not rade_api.h's own
   * documented `RADE_INT16_SCALE` (16384, deliberately leaving 6dB of
   * headroom against clipping the OFDM waveform's peaks — see this file's
   * own RADE_INT16_SCALE doc comment). An earlier version of this method
   * applied that RADE_INT16_SCALE correction here (effectively halving
   * the drive level) on the theory that it's the "correct" scale rade_c
   * itself documents for this exact boundary. **That correction is
   * deliberately NOT applied here** — see docs/ui-notes.md's "Real bug
   * found: reverting the RADE_INT16_SCALE-based TX scaling" note: a real
   * on-air contact confirmed TX was working well before that correction
   * and too quiet after it, so whatever gain staging this app's own audio
   * chain to the radio actually has (see e.g. `CIV_MAXIMIZE_USB_LEVELS`
   * and the ALSA-side `amixer` maximization elsewhere in this app) wants
   * the plain full-scale drive level, not rade_api.h's own IQ-domain
   * headroom margin. txGain is applied on top of that full-scale
   * baseline for further by-ear/by-meter tuning — defaulting to 4, not 1
   * (radae_tx's own real-part output level, unmodified), because even
   * full-scale-with-no-extra-gain was itself confirmed too quiet on real
   * hardware: a remote station read only ~20% modulation at txGain 1.
   * See this class's own constructor doc comment (`@param opts.txGain`)
   * and docs/ui-notes.md for the full reasoning behind 4 specifically.
   */
  _handleModulatedAudio(chunk) {
    let pcmOut;
    try {
      const real = extractRealFromComplexFloat32(chunk, this._txGain);
      pcmOut = upsampleFloatToPcm(real, RADE_MODEM_SAMPLE_RATE, this.audioBridge.sampleRate);
    } catch (err) {
      this._reportError('tx-resample-out', err);
      return;
    }
    this.audioBridge.playback.write(pcmOut);
  }

  _reportError(context, err) {
    console.error(`[rade:${context}]`, err.message);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { context: `rade-${context}`, message: err.message });
  }
}

/**
 * S16_LE PCM Buffer at `fromRate` -> S16_LE PCM Buffer at `toRate`, via
 * resample.js's downsamplePcmToFloat (which, despite its name, resamples
 * in either direction — see its own doc comment — and applies the
 * necessary anti-aliasing low-pass filter when downsampling). Used for
 * every resample this bridge does, in both directions: unlike FT8's
 * upsampleFloatToPcm (which starts from an already-synthesized Float32
 * waveform), every hop here starts and ends as PCM, so there's no need
 * for a second, separately-named helper.
 */
function resamplePcm(pcmBuffer, fromRate, toRate) {
  const int16 = readInt16Array(pcmBuffer);
  const float = downsamplePcmToFloat(int16, fromRate, toRate);

  const out = Buffer.alloc(float.length * 2);
  for (let i = 0; i < float.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float[i]));
    out.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return out;
}

/** S16_LE PCM Buffer -> Int16Array. Shared by resamplePcm() and _handleRadioAudio()'s own float32 conversion (see there for why RX needs float, not PCM, past this point). */
function readInt16Array(pcmBuffer) {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const int16 = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) int16[i] = pcmBuffer.readInt16LE(i * 2);
  return int16;
}

/**
 * Float32Array of real samples -> a Buffer of interleaved little-endian
 * complex float32 IQ (I,Q,I,Q,...) with every imaginary component set to
 * zero and each real component multiplied by `gain` — i.e. exactly the
 * "real -> IQ" construction rade_c's own rade_demod_wav.c uses for
 * real-valued RX input (see this file's own class-level doc comment for
 * why that's a plain zero-fill, not a Hilbert-transform real2iq call).
 * This is radae_rx's actual stdin format (RADE_COMP: two floats per
 * complex sample, per rade_api.h).
 */
function realFloatToZeroImagIq(floatSamples, gain = 1) {
  const out = Buffer.alloc(floatSamples.length * 8);
  for (let i = 0; i < floatSamples.length; i++) {
    out.writeFloatLE(floatSamples[i] * gain, i * 8);
    out.writeFloatLE(0, i * 8 + 4);
  }
  return out;
}

/**
 * A Buffer of raw little-endian complex float32 IQ samples (interleaved
 * I,Q,I,Q,... — radae_tx's actual stdout format, per rade_c's own
 * README's "radio interface" description) -> a Float32Array of just the
 * real (I) component, gained by `gain`. This is the "take real part,
 * scale by TX output level" step the reference RADE GUI client
 * (peterbmarks/radae_decoder) does before handing audio to an ordinary
 * (non-IQ-capable) radio — see this file's own class-level doc comment
 * for why there's no rade_c tool that does this for us.
 */
function extractRealFromComplexFloat32(buffer, gain = 1) {
  const complexSampleCount = Math.floor(buffer.length / 8); // 2 x 4-byte floats (I,Q) per complex sample
  const real = new Float32Array(complexSampleCount);
  for (let i = 0; i < complexSampleCount; i++) {
    real[i] = buffer.readFloatLE(i * 8) * gain; // every other float (the I component); Q (offset +4) is discarded
  }
  return real;
}

module.exports = { RadeBridge };
