'use strict';

const { EventEmitter } = require('events');
const { PcmFramer } = require('../audio/pcm-framer');
const { AlsaCapture, AlsaPlayback } = require('../audio/alsa');
const { OpusCodec } = require('../audio/opus-codec');
const { maximizeVolume, alsaDeviceToCardId } = require('../audio/mixer');
const { RnnoiseFilter } = require('../audio/rnnoise-filter');
const { HamnoiseFilter } = require('../audio/hamnoise-filter');
const { EVENT, BINARY_TYPE } = require('./protocol');

// Fallback wet-ratio list if the caller (src/server/index.js, from the
// RNNOISE_WET env var) doesn't supply one — e.g. a test harness that
// constructs an AudioBridge directly. Kept as the original 25/50/75/100%
// 4-level default this feature shipped with.
const DEFAULT_RNNOISE_WET_LEVELS = [0.25, 0.5, 0.75, 1.0];

/**
 * Wires the radio's audio (via ALSA) to every connected WebSocket client's
 * binary channel, in both directions:
 *
 *   radio RX audio -> arecord -> [encode] -> broadcast to clients
 *   client mic audio -> [decode] -> aplay -> radio TX (mic) input
 *
 * Two wire codecs are supported, via opts.codec:
 *
 * - 'pcm' (default): raw 16-bit PCM straight over the WebSocket binary
 *   channel, no framing or encoding at all. This is the simplest option
 *   and works via the standard Web Audio API in every browser (including
 *   Safari/iOS) with no WASM/WebCodecs dependency client-side. Chosen as
 *   the default because this app is LAN-only (see project README) where
 *   the extra bandwidth of uncompressed audio is a non-issue.
 * - 'opus': the phase-3 pipeline (PcmFramer -> Opus encode/decode via
 *   opusscript). Kept available for a future bandwidth-constrained
 *   scenario (e.g. if remote-over-internet access is layered on via VPN
 *   later, per the project's original scope) where compression would
 *   actually matter. Not used by the current PWA client.
 *
 * `capture`/`playback`/`codec` can be injected (e.g. for testing without
 * real ALSA hardware or to swap devices); otherwise real AlsaCapture /
 * AlsaPlayback / OpusCodec instances are created from rxDevice/txDevice.
 *
 * Every binary WebSocket frame this class sends/reads is prefixed with a
 * 1-byte type tag (BINARY_TYPE.AUDIO, see protocol.js) so audio and scope
 * data (src/server/scope-bridge.js) can share the same binary channel;
 * frames tagged for something else are ignored here.
 *
 * Known limitation: like ControlServer, there's no arbitration between
 * multiple clients sending TX audio simultaneously — packets are
 * decoded/written in whatever order they arrive, which will produce
 * garbled audio if more than one person transmits mic audio at once.
 *
 * `setRxMuted()`/`setTxMuted()` let another bridge that needs to
 * *replace* (not just observe) one direction of this pipeline — currently
 * only RadeBridge, see src/server/rade-bridge.js — temporarily suppress
 * this class's own default passthrough. This is a genuinely different
 * need than CW/RTTY/FT8's RX decoders, which only ever *observe* the same
 * capture stream (attaching an additional 'data' listener, see
 * cw-decoder-bridge.js) without needing the raw audio's normal broadcast
 * suppressed — CW/RTTY decode to text (no audio-channel conflict) and
 * FT8 leaves raw audio playing throughout (its tones are quiet/musical
 * enough that this was never judged a problem). RADE is a digital voice
 * codec: raw modem tones and the decoded speech would otherwise both hit
 * the same output/channel at once, so its bridge needs this stream's
 * *default* behavior turned off while it substitutes its own — see
 * rade-bridge.js's own doc comment.
 *
 * On start(), also best-effort maximizes every ALSA mixer control on the
 * USB codec's card (see src/audio/mixer.js) unless
 * opts.maximizeVolumeOnStart is set to false.
 *
 * Emits (as an EventEmitter, in addition to the WebSocket-facing behavior
 * above): 'tx-pcm' (Buffer of raw S16LE mono PCM at `sampleRate`) — the
 * operator's own mic/TX audio, decoded to raw PCM if needed (see
 * _handleBinaryMessage() below) and emitted right alongside (not instead
 * of) the normal write to `playback`, so another bridge that needs to
 * *observe* TX audio without disturbing normal playback can tap it the
 * same way CW/RTTY/FT8 already tap `capture`'s own 'data' event for RX
 * audio; and 'rx-pcm'
 * (Buffer of raw S16LE mono PCM at `sampleRate`) — the RX audio actually
 * broadcast to clients on the wire, i.e. RNNoise-filtered if the toggle
 * below is on, or the untouched raw chunk if it's off/unavailable. Unlike
 * 'tx-pcm' (always the raw decoded mic audio), 'rx-pcm' deliberately
 * reflects whatever the operator is actually *hearing* — see the RNNoise
 * paragraph immediately below for why.
 *
 * **RNNoise speech denoising — client audio + STT only, deliberately NOT
 * CW/RTTY/FT8/RADE.** `setRnnoiseLevel()` (armed via REQUEST.
 * SET_RNNOISE_LEVEL / the "RNN" button's click-to-cycle levels, mirroring
 * FUNCTION_CONTROLS' own click-to-cycle pattern client-side, though this
 * is server-pushed state rather than a CI-V-backed one — see
 * REQUEST.SET_RNNOISE_LEVEL's own doc comment) lazily spawns/kills an
 * ../audio/rnnoise-filter.js `RnnoiseFilter` child process and, while it's
 * running, routes RX audio through it — but *only* at the one specific
 * point in `_wire()`'s pcm-mode `capture.on('data', ...)` listener that
 * already decides what gets broadcast to clients (`tagAudio(chunk)` via
 * `controlServer.broadcastBinary()`). Filtering happens on a *separate*
 * code path from `capture`'s raw 'data' event itself: `CwDecoderBridge`,
 * `RttyDecoderBridge`, `Ft8Bridge`, and `RadeBridge` (for FreeDV's raw
 * modem-tone decode) all attach their own independent listeners straight
 * to `capture`'s 'data' event and NEVER see filtered audio, regardless of
 * whether RNNoise is enabled — this is deliberate and load-bearing.
 * RNNoise is a *speech* denoiser; running it over CW tones, RTTY AFSK
 * tones, FT8 tones, or FreeDV's raw OFDM modem waveform would corrupt
 * exactly the signal those decoders need to see, since none of that is
 * actually speech. So RNNoise only ever touches the one RX path that
 * genuinely carries speech to a human listener — the client
 * broadcast — never the shared raw capture stream every decoder taps.
 * See docs/ui-notes.md for the
 * full reasoning and docs/audio-notes.md for where this sits in the
 * signal path. `rnnoise-filter.js` also documents that the real
 * `rnnoise_demo` binary's stdin/stdout behavior is genuinely unverified
 * from this environment.
 *
 * **HamNoise — a second, mutually-exclusive RX denoiser, same scope as
 * RNNoise.** `setHamNoiseEnabled()` (armed via REQUEST.
 * SET_HAMNOISE_ENABLED / the "HamNoise" button beneath "RNN") runs
 * HamNoise's own neural denoiser (see ../audio/hamnoise-filter.js and
 * models/hamnoise/NOTICE.md) over exactly the same RX broadcast path
 * RNNoise occupies — never the raw `capture` 'data' stream CW/RTTY/FT8/
 * RADE decoders tap, for the identical reason RNNoise doesn't touch it
 * either (see the big paragraph above). Unlike RNNoise, HamNoise ships two
 * separately-trained models (CW vs. voice/SSB) as two separate WASM
 * binaries, so this class tracks the radio's current operating mode
 * (via the optional `civ` constructor option's own 'mode' events — the
 * same event CwDecoderBridge/RttyDecoderBridge already
 * rely on, now that CivDriver#setMode() reliably emits it, see that
 * method's own doc comment) purely to pick which HamNoise model is
 * actually loaded; `civ` is optional here specifically so existing tests/
 * callers that construct an AudioBridge without one keep working — HamNoise
 * just always uses the voice model in that case (see
 * `_currentHamNoiseTarget()`). Each target also comes in two model
 * generations (`hamnoiseQuality` constructor option, 'classic' default)
 * — see hamnoise-filter.js's own doc comment on its `quality` option for
 * why 'classic' is the default despite HamNoise's own web app defaulting
 * to the newer 'v2' models: 'v2' measured roughly 100x too expensive to
 * run in real time on this app's actual deployment target (a Raspberry
 * Pi), to the point of pinning the whole server at 100% CPU with nothing
 * actually throwing an error to report.
 *
 * **Mutual exclusion, not independent toggles.** The operator asked for
 * RNNoise and HamNoise to never run at the same time — enabling one forces
 * the other off (see `setRnnoiseLevel()` and `setHamNoiseEnabled()`,
 * which each call the other's disable path and broadcast the resulting
 * state change directly, the same "force a known-good state and tell
 * everyone" pattern `_handleRnnoiseError()` already established below).
 * Both are explicitly fine to run *alongside* the radio's own internal
 * noise reduction (the NR button, a CI-V/hardware feature this class has
 * no visibility into or control over) — that's a completely independent
 * stage upstream in the actual RF/analog signal chain, not something
 * either of these two RX-audio-stream denoisers could conflict with even
 * if they wanted to.
 */
class AudioBridge extends EventEmitter {
  constructor(opts) {
    super();
    const {
      controlServer,
      civ,
      rxDevice,
      txDevice,
      sampleRate = 48000,
      channels = 1,
      frameMs = 20,
      codecType = 'pcm',
      capture,
      playback,
      codec,
      mixer,
      maximizeVolumeOnStart = true,
      rnnoiseBin,
      rnnoiseWetLevels,
      rnnoiseFilterFactory,
      hamnoiseFilterFactory,
      hamnoiseQuality,
    } = opts;

    if (!controlServer) throw new Error('AudioBridge requires opts.controlServer');
    if (!capture && !rxDevice) throw new Error('AudioBridge requires opts.rxDevice (or an injected capture)');
    if (!playback && !txDevice) throw new Error('AudioBridge requires opts.txDevice (or an injected playback)');
    if (codecType !== 'pcm' && codecType !== 'opus') {
      throw new Error(`AudioBridge codecType must be "pcm" or "opus", got "${codecType}"`);
    }

    this.controlServer = controlServer;
    this.civ = civ ?? null;
    this.codecType = codecType;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.rxDevice = rxDevice;
    this.txDevice = txDevice;
    this._mixer = mixer ?? maximizeVolume;
    this.maximizeVolumeOnStart = maximizeVolumeOnStart;

    if (codecType === 'opus') {
      this.codec = codec ?? new OpusCodec({ sampleRate, channels, frameMs });
      this.framer = new PcmFramer(this.codec.frameBytes);
    }

    this.capture = capture ?? new AlsaCapture({ device: rxDevice, sampleRate, channels });
    this.playback = playback ?? new AlsaPlayback({ device: txDevice, sampleRate, channels });

    this._stopping = false;
    this._rxMuted = false;
    this._txMuted = false;
    this._rnnoiseBin = rnnoiseBin || 'rnnoise_demo';
    // The "RNN" button's level->wet mapping. index.js parses the
    // RNNOISE_WET env var (a comma-separated list, e.g.
    // "0.25, 0.5, 0.75, 1.0") into `rnnoiseWetLevels` and passes it
    // through here; an empty/unset list falls back to the original
    // 25/50/75/100% 4-level default. `undefined` is prepended for level 0
    // ("RNN Off") since that level never spawns a filter at all (see
    // setRnnoiseLevel() below) and has no wet ratio of its own. The
    // NUMBER of levels is therefore itself configurable, not fixed at 5
    // — src/server/index.js derives the client-facing
    // `rnnoiseLevelCount` (ControlServer.state.rnnoiseLevelCount, sent in
    // the 'connected' snapshot) from this same parsed list so the
    // button's state count and ws-server's SET_RNNOISE_LEVEL validation
    // range both stay in lockstep with whatever was actually configured.
    this._rnnoiseWetLevels = [
      undefined,
      ...((rnnoiseWetLevels && rnnoiseWetLevels.length ? rnnoiseWetLevels : DEFAULT_RNNOISE_WET_LEVELS)),
    ];
    this._makeRnnoiseFilter = rnnoiseFilterFactory ?? ((filterOpts) => new RnnoiseFilter(filterOpts));
    this._rnnoiseLevel = 0;
    this._rnnoiseEnabled = false;
    this._rnnoiseFilter = null; // lazily created by setRnnoiseLevel(level > 0) — see this class's own doc comment

    this._makeHamNoiseFilter = hamnoiseFilterFactory ?? ((filterOpts) => new HamnoiseFilter(filterOpts));
    // 'classic' (default) vs 'v2' — see HamnoiseFilter's own doc comment
    // on its `quality` option for the real-time-performance reasoning
    // (the v2 models are roughly 100x too expensive for a Raspberry Pi).
    // Threaded through from src/server/index.js's HAMNOISE_QUALITY env var.
    this._hamNoiseQuality = hamnoiseQuality === 'v2' ? 'v2' : 'classic';
    this._hamNoiseEnabled = false;
    this._hamNoiseFilter = null; // lazily created by setHamNoiseEnabled(true) — see this class's own doc comment
    // Tracks the radio's current mode purely to pick which HamNoise model
    // (cw vs. voice) is loaded — see this class's own doc comment for why
    // this is the one place AudioBridge cares about operating mode at
    // all. Defaults to 'voice' (HamNoise's own more broadly-applicable
    // model) until a real mode is known, same "best available guess, not
    // a hard requirement" posture as _refreshPitch()'s callers elsewhere.
    this._currentMode = null;
    this._onCivMode = (info) => this._handleCivModeChange(info.mode);
    if (this.civ) this.civ.on('mode', this._onCivMode);

    this._onBinaryMessage = (ws, data) => this._handleBinaryMessage(data);
    this._onRnnoiseLevel = (level) => this.setRnnoiseLevel(level);
    this._onHamNoiseEnabled = (enabled) => this.setHamNoiseEnabled(enabled);

    this._wire();
  }

  /**
   * Suppresses (true) or restores (false) this class's own RX broadcast —
   * the radio's raw captured audio no longer reaches connected clients as
   * EVENT-tagged AUDIO frames while muted, e.g. so RadeBridge can
   * broadcast decoded speech on the same channel instead without both
   * playing at once. See this class's own doc comment above.
   */
  setRxMuted(muted) {
    this._rxMuted = muted;
  }

  /**
   * Suppresses (true) or restores (false) this class's own TX
   * passthrough — an operator's raw mic audio arriving from a client no
   * longer reaches the radio directly while muted, e.g. so RadeBridge can
   * write its own encoded/modulated audio to `playback` instead without
   * both being written at once. See this class's own doc comment above.
   */
  setTxMuted(muted) {
    this._txMuted = muted;
  }

  /**
   * Sets the "RNN" button's level (0..this._rnnoiseWetLevels.length-1; see
   * this._rnnoiseWetLevels, built in the constructor from the RNNOISE_WET
   * env var) on the RX broadcast path — see this class's own doc comment
   * above for the full scope (client audio + STT only, never the raw
   * `capture` 'data' event CW/RTTY/FT8/RADE tap; this is the single most
   * important thing to get right about this feature). Level 0 kills the
   * underlying `RnnoiseFilter` child process entirely (never held open
   * when the operator has it switched off, since it's a real native
   * subprocess nobody needs most of the time); every level above that
   * (re)spawns it with the matching configured blend ratio. Since that
   * ratio is fixed at spawn time via argv (see rnnoise-filter.js's
   * `wet`), moving between two non-zero levels stops and restarts the
   * filter process rather than adjusting it in place — cheap, and no
   * different in effect from the operator toggling it off and back on. A
   * no-op if already at the requested level. A failed spawn or an
   * unexpected mid-stream exit is reported as EVENT.AUDIO_ERROR and the
   * level reset to 0 (see `_handleRnnoiseError()`), falling back to
   * unfiltered passthrough — this call itself never throws, and RX audio
   * never stops flowing just because the RNNoise binary is missing or
   * broken.
   */
  setRnnoiseLevel(level) {
    if (level === this._rnnoiseLevel) return;
    this._rnnoiseLevel = level;
    this._rnnoiseEnabled = level > 0;
    if (this._rnnoiseFilter) {
      this._rnnoiseFilter.stop();
      this._rnnoiseFilter = null;
    }
    if (this._rnnoiseEnabled) {
      // Mutual exclusion with HamNoise — see this class's own doc
      // comment. Checked after this level is already applied above so a
      // client asking for RNN level 0 (off) while HamNoise is active
      // never disturbs HamNoise at all.
      this._disableHamNoise();
      const filter = this._makeRnnoiseFilter({ bin: this._rnnoiseBin, wet: this._rnnoiseWetLevels[level] });
      this._rnnoiseFilter = filter;
      filter.on('data', (chunk) => {
        if (this.codecType === 'opus') this._encodeAndPublishRx(chunk);
        else this._publishRx(chunk);
      });
      filter.on('error', (err) => this._handleRnnoiseError(err));
      filter.on('stderr', (msg) => console.error('[rnnoise]', msg));
      filter.start();
    }
  }

  /**
   * Arms/disarms HamNoise (see this class's own doc comment) on the same
   * RX broadcast path RNNoise occupies. Unlike RNNoise's multi-level "RNN"
   * cycling button, this is a plain on/off toggle — HamNoise has no wet-
   * ratio concept to expose a level for. A no-op if already in the
   * requested state.
   */
  setHamNoiseEnabled(enabled) {
    if (enabled === this._hamNoiseEnabled) return;
    this._hamNoiseEnabled = enabled;
    this._stopHamNoiseFilterSafely();
    if (this._hamNoiseEnabled) {
      // Mutual exclusion with RNNoise — see setRnnoiseLevel()'s mirror of
      // this call, and this class's own doc comment.
      this._disableRnnoise();
      const filter = this._makeHamNoiseFilter({
        sampleRate: this.sampleRate,
        target: this._currentHamNoiseTarget(),
        quality: this._hamNoiseQuality,
      });
      this._hamNoiseFilter = filter;
      filter.on('data', (chunk) => {
        if (this.codecType === 'opus') this._encodeAndPublishRx(chunk);
        else this._publishRx(chunk);
      });
      filter.on('error', (err) => this._handleHamNoiseError(err));
      filter.start();
    }
  }

  /** Which HamNoise model (see hamnoise-filter.js) matches the radio's current mode — 'cw' while in CW mode, 'voice' otherwise (including while mode is still unknown, e.g. no `civ` was given, or the first mode read/event hasn't landed yet). */
  _currentHamNoiseTarget() {
    return this._currentMode === 'CW' ? 'cw' : 'voice';
  }

  /**
   * Stops and clears this._hamNoiseFilter if one exists — the one place
   * that actually calls HamnoiseFilter#stop(), used by setHamNoiseEnabled()
   * and _disableHamNoise() alike. Wrapped in try/catch deliberately:
   * unlike RnnoiseFilter (a subprocess accessed only through Node streams,
   * nothing that can throw synchronously), HamnoiseFilter calls into
   * HamNoise's real WASM engines (see hamnoise-filter.js) synchronously,
   * in-process, directly on this call stack, and that native boundary's
   * behavior under every real-world condition hasn't been exercised
   * against actual hardware (see models/hamnoise/NOTICE.md's own
   * disclosed upstream caveat). A synchronous throw from inside the one
   * WebSocket request that triggered it would actually be caught by
   * ws-server.js's own _handleMessage() try/catch — but this same call
   * also runs from _disableHamNoise()'s mutual-exclusion path (triggered
   * by a DIFFERENT request, setRnnoiseLevel()'s) and from stop() below
   * (server shutdown, no request in flight at all), neither of which that
   * safety net covers. So this gets the same explicit defense every other
   * external-process/native-boundary call in this class already has
   * (_handleRnnoiseError(), _handleHamNoiseError()): never let a failure
   * here take the whole server down — report it and move on.
   */
  _stopHamNoiseFilterSafely() {
    if (!this._hamNoiseFilter) return;
    const filter = this._hamNoiseFilter;
    this._hamNoiseFilter = null;
    try {
      filter.stop();
    } catch (err) {
      this._reportError('hamnoise', new Error(`stop() failed: ${err.message}`));
    }
  }

  /** Internal-only: used by setRnnoiseLevel() to enforce mutual exclusion without going through the public SET_HAMNOISE_ENABLED request path. Broadcasts the forced-off state so every connected client's HamNoise button reflects it, same as _handleRnnoiseError()'s own forced-reset broadcast below. */
  _disableHamNoise() {
    if (!this._hamNoiseEnabled) return;
    this._hamNoiseEnabled = false;
    this._stopHamNoiseFilterSafely();
    this.controlServer.state.hamNoiseEnabled = false;
    this.controlServer.broadcastJsonEvent(EVENT.HAMNOISE_ENABLED, { enabled: false });
  }

  /** Internal-only mirror of _disableHamNoise(), used by setHamNoiseEnabled() to enforce mutual exclusion. */
  _disableRnnoise() {
    if (!this._rnnoiseEnabled) return;
    this._rnnoiseLevel = 0;
    this._rnnoiseEnabled = false;
    if (this._rnnoiseFilter) {
      this._rnnoiseFilter.stop();
      this._rnnoiseFilter = null;
    }
    this.controlServer.state.rnnoiseLevel = 0;
    this.controlServer.broadcastJsonEvent(EVENT.RNNOISE_LEVEL, { level: 0 });
  }

  /** HamnoiseFilter reported a load/init/model-select/process failure — same posture as _handleRnnoiseError(): log/broadcast it, force the "HamNoise" toggle back off for every connected client, and fall back to unfiltered RX passthrough. */
  _handleHamNoiseError(err) {
    this._reportError('hamnoise', err);
    this._hamNoiseEnabled = false;
    this._hamNoiseFilter = null; // HamnoiseFilter already stopped itself before emitting 'error' — see its own doc comment
    this.controlServer.state.hamNoiseEnabled = false;
    this.controlServer.broadcastJsonEvent(EVENT.HAMNOISE_ENABLED, { enabled: false });
  }

  /**
   * Picks up the radio's current mode purely to keep HamNoise's model
   * selection in sync — see this class's own doc comment. Switches the
   * live filter's model immediately if HamNoise is already running;
   * otherwise just remembers the mode for whenever it's next enabled.
   * Wrapped in try/catch for the same reason _stopHamNoiseFilterSafely()
   * is: setModel() re-enters the native WASM boundary (loading/resetting
   * the other engine) synchronously, triggered here by a CI-V mode change
   * that has nothing to do with the WebSocket request (if any) that's
   * currently in flight, so ws-server.js's own request-level try/catch
   * can't be relied on to catch it.
   */
  _handleCivModeChange(mode) {
    this._currentMode = mode;
    if (this._hamNoiseEnabled && this._hamNoiseFilter) {
      try {
        this._hamNoiseFilter.setModel(this._currentHamNoiseTarget());
      } catch (err) {
        this._handleHamNoiseError(new Error(`setModel() failed: ${err.message}`));
      }
    }
  }

  /**
   * Writes one chunk into the active HamNoise filter, guarding the same
   * native-WASM-boundary call with try/catch as _stopHamNoiseFilterSafely()
   * above (see that method's own doc comment for why) — this one matters
   * even more, since it runs on literally every captured audio chunk
   * rather than only on enable/disable/mode-change, so it's the single
   * highest-frequency call into that boundary in the whole pipeline. A
   * caught failure here falls back to broadcasting this one chunk raw
   * (via `publish`, the same function the caller would have used had
   * HamNoise been off) rather than dropping it silently, on top of
   * reporting the error and resetting the toggle via _handleHamNoiseError()
   * — RX audio should keep flowing through a HamNoise failure exactly like
   * it does through an RNNoise one. Also makes a best-effort attempt to
   * stop() the filter that just threw — unlike every other path that
   * reaches _handleHamNoiseError() (HamnoiseFilter's own 'error' event,
   * documented as always stopping itself first), a throw caught HERE means
   * the filter's internal state is in an unknown condition, so this is the
   * one caller that can't assume that's already happened.
   */
  _writeHamNoiseFilterSafely(chunk, publish) {
    try {
      this._hamNoiseFilter.write(chunk);
    } catch (err) {
      const filter = this._hamNoiseFilter;
      this._handleHamNoiseError(new Error(`write() failed: ${err.message}`));
      try {
        filter.stop();
      } catch {
        // Best-effort only — already reported above; a second failure here
        // changes nothing about the outcome.
      }
      publish(chunk);
    }
  }

  /** RnnoiseFilter reported a spawn failure or an unexpected exit — log/broadcast it, reset the "RNN" level to 0 (off) for every connected client (not just log it server-side — an operator watching the button would otherwise see it claim a level that silently stopped applying), and fall back to unfiltered RX passthrough rather than leaving audio silently broken. See setRnnoiseLevel()'s own doc comment. */
  _handleRnnoiseError(err) {
    this._reportError('rnnoise', err);
    this._rnnoiseLevel = 0;
    this._rnnoiseEnabled = false;
    this._rnnoiseFilter = null; // RnnoiseFilter already stopped itself before emitting 'error' — see its own doc comment
    this.controlServer.state.rnnoiseLevel = 0;
    this.controlServer.broadcastJsonEvent(EVENT.RNNOISE_LEVEL, { level: 0 });
  }

  /** pcm mode: broadcasts one RX chunk (raw or RNNoise-filtered, whichever this call actually received) to clients, and emits it as 'rx-pcm' for other server-side listeners — see this class's own doc comment. */
  _publishRx(chunk) {
    if (!this._rxMuted) this.controlServer.broadcastBinary(tagAudio(chunk));
    this.emit('rx-pcm', chunk);
  }

  /** opus mode: same idea as _publishRx(), but Opus-encodes the (raw or filtered) PCM before broadcasting — 'rx-pcm' still carries the raw PCM, never the encoded packet, since a server-side listener needs samples it can actually read. */
  _encodeAndPublishRx(pcm) {
    this.emit('rx-pcm', pcm);
    try {
      const packet = this.codec.encode(pcm);
      if (!this._rxMuted) this.controlServer.broadcastBinary(tagAudio(packet));
    } catch (err) {
      this._reportError('encode', err);
    }
  }

  _wire() {
    if (this.codecType === 'opus') {
      this.framer.on('frame', (pcm) => {
        if (this._rnnoiseEnabled && this._rnnoiseFilter) {
          // Filtered result arrives asynchronously via the filter's own
          // 'data' event (wired in setRnnoiseLevel()) — a child-process
          // round trip, not a synchronous call — so this branch does
          // nothing further with `pcm` itself here.
          this._rnnoiseFilter.write(pcm);
          return;
        }
        if (this._hamNoiseEnabled && this._hamNoiseFilter) {
          // filtered result arrives via the 'data' handler in
          // setHamNoiseEnabled(); see _writeHamNoiseFilterSafely()'s own
          // doc comment for why this call is guarded.
          this._writeHamNoiseFilterSafely(pcm, (raw) => this._encodeAndPublishRx(raw));
          return;
        }
        this._encodeAndPublishRx(pcm);
      });
      this.capture.on('data', (chunk) => this.framer.push(chunk));
    } else {
      // pcm mode: no framing needed at all — raw PCM playback doesn't
      // care about chunk boundaries, so pass arecord's output straight
      // through as-is (just tagged), unless muted (see setRxMuted()) or
      // routed through RNNoise first (see setRnnoiseLevel()). This is
      // the ONE listener on `capture`'s 'data' event that decides what
      // gets broadcast to clients — CW/RTTY/FT8/RADE each register their
      // own SEPARATE 'data' listener directly on `capture` (see
      // cw-decoder-bridge.js etc.) and are completely unaffected by
      // anything this listener does; they always see the original,
      // unfiltered chunk.
      this.capture.on('data', (chunk) => {
        if (this._rnnoiseEnabled && this._rnnoiseFilter) {
          this._rnnoiseFilter.write(chunk); // filtered result arrives asynchronously — see the 'data' handler in setRnnoiseLevel()
          return;
        }
        if (this._hamNoiseEnabled && this._hamNoiseFilter) {
          // filtered result arrives via the 'data' handler in
          // setHamNoiseEnabled() — may be a different-length chunk than
          // written, see hamnoise-filter.js's resampling; see
          // _writeHamNoiseFilterSafely()'s own doc comment for why this
          // call is guarded.
          this._writeHamNoiseFilterSafely(chunk, (raw) => this._publishRx(raw));
          return;
        }
        this._publishRx(chunk);
      });
    }

    this.capture.on('error', (err) => this._reportError('capture', err));
    this.capture.on('stderr', (msg) => console.error('[arecord]', msg.trim()));
    this.capture.on('exit', ({ code, signal }) => {
      if (this._stopping) return;
      this._reportError('capture', new Error(`arecord exited unexpectedly (code=${code}, signal=${signal})`));
    });

    this.playback.on('error', (err) => this._reportError('playback', err));
    this.playback.on('stderr', (msg) => console.error('[aplay]', msg.trim()));
    this.playback.on('exit', ({ code, signal }) => {
      if (this._stopping) return;
      this._reportError('playback', new Error(`aplay exited unexpectedly (code=${code}, signal=${signal})`));
    });

    this.controlServer.on('binary-message', this._onBinaryMessage);
    // Self-contained wiring, no index.js glue needed beyond normal
    // construction — same pattern RttyDecoderBridge already uses for its
    // own 'rtty-reversed' subscription (see rtty-decoder-bridge.js).
    this.controlServer.on('rnnoise-level', this._onRnnoiseLevel);
    this.controlServer.on('hamnoise-enabled', this._onHamNoiseEnabled);
  }

  _handleBinaryMessage(data) {
    if (data.length < 1 || data[0] !== BINARY_TYPE.AUDIO) {
      // Not tagged as audio (e.g. a scope-related or future tag) — not ours.
      return;
    }
    const payload = data.subarray(1);
    if (this.codecType === 'pcm') {
      // pcm mode: `payload` is already raw S16LE PCM, the same shape
      // `capture`'s own 'data' event carries for RX — emit it as-is.
      this.emit('tx-pcm', payload);
      if (!this._txMuted) this.playback.write(payload);
      return;
    }
    try {
      const pcm = this.codec.decode(payload);
      // opus mode: emit the *decoded* PCM, not the still-encoded Opus
      // packet — a server-side listener needs raw audio samples,
      // not a codec it doesn't know how to decode itself.
      this.emit('tx-pcm', pcm);
      if (!this._txMuted) this.playback.write(pcm);
    } catch (err) {
      this._reportError('decode', err);
    }
  }

  _reportError(context, err) {
    console.error(`[audio:${context}]`, err.message);
    this.controlServer.broadcastJsonEvent(EVENT.AUDIO_ERROR, { context, message: err.message });
  }

  /**
   * Starts the audio pipeline. If maximizeVolumeOnStart is true
   * (default), first best-effort sets every ALSA mixer control on the
   * USB codec's card(s) to 100% — see src/audio/mixer.js — so input/output
   * gain doesn't get left wherever a previous session or the device's
   * power-on default happened to leave it. This never blocks/fails
   * startup even if amixer isn't available or the device has no
   * adjustable controls; it's a convenience default, not a requirement.
   */
  async start() {
    this._stopping = false;

    if (this.maximizeVolumeOnStart) {
      const cardIds = new Set(
        [alsaDeviceToCardId(this.rxDevice), alsaDeviceToCardId(this.txDevice)].filter(Boolean)
      );
      for (const cardId of cardIds) {
        try {
          const results = await this._mixer(cardId);
          const applied = results.filter((r) => r.ok).map((r) => r.name);
          const failed = results.filter((r) => !r.ok).map((r) => r.name);
          if (applied.length) console.log(`[audio] Set to 100% on card ${cardId}: ${applied.join(', ')}`);
          if (failed.length) console.log(`[audio] Could not adjust on card ${cardId} (ignored): ${failed.join(', ')}`);
        } catch (err) {
          // Best-effort only — never let a mixer problem block audio startup.
          console.log(`[audio] Skipping volume setup on card ${cardId}: ${err.message}`);
        }
      }
    }

    if (this.civ) {
      try {
        const current = await this.civ.getMode();
        this._handleCivModeChange(current.mode);
      } catch {
        // Best-effort, same reasoning as CwDecoderBridge's own startup
        // poll — the next real mode change (now reliably emitted, see
        // CivDriver#setMode()'s doc comment) still picks this up, and
        // HamNoise defaults to its 'voice' model in the meantime.
      }
    }

    this.capture.start();
    this.playback.start();
  }

  stop() {
    this._stopping = true;
    this.controlServer.off('binary-message', this._onBinaryMessage);
    this.controlServer.off('rnnoise-level', this._onRnnoiseLevel);
    this.controlServer.off('hamnoise-enabled', this._onHamNoiseEnabled);
    if (this.civ) this.civ.off('mode', this._onCivMode);
    if (this._rnnoiseFilter) {
      this._rnnoiseFilter.stop();
      this._rnnoiseFilter = null;
    }
    this._stopHamNoiseFilterSafely();
    if (this.framer) this.framer.reset();
    this.capture.stop();
    this.playback.stop();
  }
}

module.exports = { AudioBridge, tagAudio };

/**
 * Prefix a payload with the AUDIO binary-frame type tag (see
 * protocol.js). Exported (not just used internally) so RadeBridge can tag
 * its own decoded-speech broadcasts identically — from the client's
 * perspective a RADE decode is just another AUDIO frame on the same
 * channel, requiring no client-side changes at all (see
 * src/server/rade-bridge.js).
 */
function tagAudio(payload) {
  return Buffer.concat([Buffer.from([BINARY_TYPE.AUDIO]), payload]);
}
