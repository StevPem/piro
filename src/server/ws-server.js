'use strict';

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { REQUEST, EVENT, makeResult, makeError, makeEvent } = require('./protocol');
const { createStaticHandler } = require('./static-server');

/**
 * Bridges the (single, shared) CI-V driver to any number of WebSocket
 * clients on the LAN. Each client request is served directly and
 * correlated by `id`; state changes (whether client-initiated or from the
 * radio's own unsolicited "transceive" updates) are broadcast to every
 * other connected client so all views stay in sync.
 *
 * Binary WebSocket frames are routed separately from the JSON control
 * protocol (see protocol.js) — emitted as a 'binary-message' event for
 * the audio bridge to consume, rather than handled here directly, to keep
 * control and audio concerns decoupled.
 *
 * Note: this layer does not arbitrate simultaneous control from multiple
 * clients (e.g. two people both keying PTT, or both sending TX audio at
 * once) — every connected client has equal, unrestricted control. Access
 * control/locking, if wanted, would be a later addition on top of this.
 *
 * Events emitted: 'client-connected' (ws), 'client-disconnected' (ws),
 * 'binary-message' (ws, Buffer), 'frequency' (hz — internal-only, for
 * bridges that need to track the operating frequency without polling;
 * see src/server/freedv-reporter.js)
 */
class ControlServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../civ/driver').CivDriver} opts.civ - an already-open CivDriver
   * @param {number} [opts.port=8080]
   * @param {string} [opts.staticDir] - if set, serves the PWA app shell from this
   *   directory over the same HTTP server; if omitted, HTTP GETs just get a
   *   plain-text liveness check (useful in tests that don't need the static site)
   * @param {{cert: string|Buffer, key: string|Buffer}} [opts.tls] - if set, serves
   *   over HTTPS/WSS instead of plain HTTP/WS using this cert/key pair. Needed for
   *   getUserMedia (microphone access) to work from any origin other than
   *   localhost — see docs/pwa-notes.md.
   */
  constructor({
    civ,
    port = 8080,
    staticDir,
    tls,
    screenTitle,
    appVersion,
    stationCallsign,
    stationGrid,
    rnnoiseLevelCount = 5,
    sourceCodeUrl,
    pttWatchdogMs = 10 * 60 * 1000,
  }) {
    super();
    this.civ = civ;
    this.port = port;
    this.tls = tls ?? null;
    // Fail-safe transmission cutoff: default 10 minutes, per the
    // Australian amateur class licence's condition on remote/computer
    // controlled operation (Radiocommunications (Amateur Stations) Class
    // Licence 2023, s.13(4)(b)) — a station operated without anyone
    // physically present must be "fitted with a timer that causes
    // automatic shutdown of the station if a malfunction causes an
    // unintended transmission that lasts longer than 10 minutes." This
    // is enforced server-side rather than in the browser client
    // specifically because the server is the persistent process: if the
    // browser tab crashes or the network drops while transmitting, a
    // client-side timer would never fire — exactly the "control link
    // malfunction" scenario the rule exists to guard against. Overridable
    // via the constructor for testing, so tests aren't stuck waiting 10
    // real minutes for the timeout to fire — see docs/civ-notes.md.
    this.pttWatchdogMs = pttWatchdogMs;
    this._pttWatchdogTimer = null;

    const staticHandler = staticDir ? createStaticHandler(staticDir) : null;
    const requestHandler = (req, res) => {
      if (staticHandler) {
        staticHandler(req, res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('icom-rig-pwa control server\n');
    };
    this.httpServer = this.tls
      ? https.createServer({ cert: this.tls.cert, key: this.tls.key }, requestHandler)
      : http.createServer(requestHandler);
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.clients = new Set();

    // Cached last-known state so a newly-connected client gets an
    // immediate snapshot instead of waiting for the next change.
    this.state = {
      frequency: null,
      mode: null,
      dataMode: null, // IC-7300 "DATA MODE" — distinct from `mode`; see REQUEST.SET_DATA_MODE
      ptt: false,
      smeter: null,
      radioAddr: this.civ.radioAddr ?? null,
      audio: null, // set via setAudioInfo() once/if an AudioBridge is attached
      scope: null, // set via setScopeInfo() once/if a ScopeBridge is attached
      screenTitle: screenTitle || 'SPARC PiRO', // static for the process lifetime, see docs/ui-notes.md
      // The app's own version (from package.json), shown client-side in
      // small text next to screenTitle. Static for the process lifetime,
      // same as screenTitle — see docs/ui-notes.md. null (rather than a
      // hardcoded fallback) if the caller didn't supply one, e.g. in tests
      // that construct a ControlServer directly.
      appVersion: appVersion || null,
      // The operator's own callsign/grid (STATION_CALLSIGN/STATION_GRID
      // env vars — see src/server/index.js), null if unset. Static for the
      // process lifetime, same as screenTitle. Used client-side to build
      // the default FT8 CQ message and drive the guided QSO sequencer —
      // see src/client/ft8-qso.js and docs/ui-notes.md.
      stationCallsign: stationCallsign || null,
      stationGrid: stationGrid || null,
      // The "PSK Spot" checkbox in the FT8 UI — whether decoded FT8
      // stations get reported to pskreporter.info. Enabled by default
      // per the original request; see REQUEST.SET_PSK_SPOT_ENABLED and
      // src/audio/psk-reporter.js (which itself still no-ops unless
      // stationCallsign above is also configured).
      pskSpotEnabled: true,
      // Which protocol the FT8 mode button is currently in — 'FT8' or
      // 'FT4' (see REQUEST.SET_FT8_VARIANT / src/audio/ft8-bridge.js).
      // Defaults to 'FT8', matching Ft8Bridge's own default and every
      // pre-FT4 client's assumption.
      ft8Variant: 'FT8',
      // Whether the FT8/FT4 mode is currently armed (see
      // REQUEST.SET_FT8_ACTIVE / src/audio/ft8-bridge.js). This is a
      // server-side setting, not anything the radio itself reports over
      // CI-V — Ft8Bridge keeps its own internal `_active` flag and this is
      // a copy kept here only so a newly-connecting client's initial
      // EVENT.CONNECTED snapshot can reflect it (see _wireWsConnections()
      // below), the same reason ft8Variant/freeDvVariant are cached here.
      // Not broadcast to already-connected clients on change (unlike
      // ft8Variant) — this mirrors an earlier, deliberate choice to keep
      // "armed" state purely per-request-confirmation rather than
      // multi-client-synced; only the new-connection snapshot gap this was
      // originally missing has been filled in.
      ft8Active: false,
      // Which variant the FreeDV mode button is currently in — '700E' or
      // 'RADE' (see REQUEST.SET_FREEDV_VARIANT / src/server/rade-bridge.js).
      // Defaults to 'RADE' — the only variant the client's FreeDV chip
      // can select any more. '700E' (Codec2-based, never had a codec
      // wired up in this codebase) was removed from the UI per explicit
      // request; SET_FREEDV_VARIANT/this field still technically accept
      // it (nothing currently enforces otherwise), but nothing in this
      // app sends it, and defaulting here to anything other than 'RADE'
      // would leave RadeBridge idle by default with no client-side way
      // left to switch it on — see rade-bridge.js's own doc comment.
      freeDvVariant: 'RADE',
      // Whether FreeDV mode is currently armed (see
      // REQUEST.SET_FREEDV_ACTIVE / src/server/rade-bridge.js) — same
      // reasoning as ft8Active above: a server-side setting cached here
      // purely so a newly-connecting client's initial snapshot can reflect
      // it, not broadcast on change.
      freeDvActive: false,
      // The "FreeDV spot" checkbox — whether this station gets reported
      // to qso.freedv.org (see REQUEST.SET_FREEDV_SPOT_ENABLED and
      // src/server/freedv-reporter.js) while FreeDV is armed. Unlike
      // pskSpotEnabled above, defaults to false: reporting your
      // callsign/grid/frequency to a third-party service should be
      // something the operator explicitly opts into, per the original
      // request, not an on-by-default checkbox they have to notice and
      // uncheck.
      freeDvSpotEnabled: false,
      // Freeform FreeDV Reporter status message (see REQUEST.SET_FREEDV_MESSAGE
      // and src/server/freedv-reporter.js's message_update), e.g. "Looking
      // for contacts". Standing state — cached here so a newly-connecting
      // client's initial snapshot shows whatever's currently set, and
      // broadcast on change so a second connected client (or a page
      // reload) stays in sync, the same pattern as freeDvSpotEnabled
      // above. Defaults to '' (no status message set).
      freeDvMessage: '',
      // The RTTY "Reverse" checkbox (see REQUEST.SET_RTTY_REVERSED and
      // src/server/rtty-decoder-bridge.js) — swaps which tone the decoder
      // treats as mark vs space. RTTY polarity genuinely isn't predictable
      // from the radio's mode alone (it depends on both stations'
      // equipment), so this defaults to false and is a manual per-operator
      // toggle, same as every real RTTY terminal program provides. Cached
      // here so a newly-connecting client's snapshot reflects it, and
      // broadcast on change so other connected clients stay in sync.
      rttyReversed: false,
      // The "RNN" cycling button (see REQUEST.SET_RNNOISE_LEVEL and
      // src/server/audio-bridge.js#setRnnoiseLevel) — arms/disarms an
      // RNNoise speech-denoiser on the RX audio broadcast to clients (but
      // never the raw capture stream CW/RTTY/FT8/RADE decode from — see
      // audio-bridge.js for the full reasoning). Replaces the old Noise Blanker (NB)
      // button, which is removed from the client UI (server-side CI-V
      // NB support in civ/driver.js is untouched). Same "cache here so a
      // newly-connecting client's snapshot reflects it, broadcast on
      // change" pattern as rttyReversed above. Defaults to 0 ("RNN Off")
      // — like every other AudioBridge-dependent toggle in this app, it's
      // a no-op until AUDIO_RX_DEVICE is configured, and additionally
      // requires the separately-installed rnnoise_demo binary
      // (RNNOISE_BIN) to actually filter anything. Levels above 0 select
      // a configured original/denoised blend ratio — see rnnoiseLevelCount
      // below and RNNOISE_WET_LEVELS in server/index.js for where the
      // actual ratios live (ControlServer itself only knows the COUNT of
      // levels, for validation/display purposes — the ratios themselves
      // are AudioBridge's concern, since it's the one that spawns the
      // filter process).
      rnnoiseLevel: 0,
      // How many states the "RNN" button has in total, INCLUDING level 0
      // ("RNN Off") — e.g. 5 for the original 4-ratio (25/50/75/100%)
      // default. Driven by how many comma-separated values are in the
      // RNNOISE_WET env var (see server/index.js's RNNOISE_LEVEL_COUNT),
      // so the number of levels is itself configurable, not fixed. Sent
      // in the 'connected' snapshot so the client can build its button
      // with the right number of "RNN N" labels (see RNN_LEVELS/
      // buildRnnLevels() in app.js) instead of a hardcoded 5, and also
      // used below to validate an incoming SET_RNNOISE_LEVEL request's
      // range instead of a hardcoded 0-4.
      rnnoiseLevelCount,
      // Whether the "HamNoise" button (beneath "RNN") is currently armed —
      // see REQUEST.SET_HAMNOISE_ENABLED / audio-bridge.js#setHamNoiseEnabled.
      // A plain boolean, not a level like RNN's — HamNoise has no wet-ratio
      // knob. Mutually exclusive with rnnoiseLevel above (AudioBridge
      // enforces this and broadcasts whichever side it forces off — see
      // that class's own doc comment), but independent of and compatible
      // with the radio's own internal noise reduction (the NR button).
      hamNoiseEnabled: false,
      // Which CW decoding algorithm the CW mode chip's ticker currently
      // uses — 'CW1' (audio/cw-decoder.js, this app's original decoder),
      // 'CW2' (audio/hamfist-cw-decoder.js), or 'CW3'
      // (audio/deepcw-decoder.js, a neural-network/CTC decoder) — see
      // REQUEST.SET_CW_DECODER_VARIANT / server/cw-decoder-bridge.js.
      // Cached here so a newly-connecting client's snapshot reflects it
      // and the chip shows the right label immediately, and broadcast on
      // change so other connected clients stay in sync — same pattern as
      // ft8Variant/rttyReversed above.
      cwDecoderVariant: 'CW1',
      // Where this running instance's corresponding source is published
      // — see server/index.js's SOURCE_CODE_URL doc comment for why this
      // is operator-configured rather than a hardcoded repo URL, and
      // README.md's "Licence" section for why it's needed at all (AGPL-
      // 3.0-only §13, triggered by bundling the "CW 3" deepcw-engine
      // model). null (the default) shows no link client-side — static
      // for the process lifetime, same as screenTitle/appVersion above.
      sourceCodeUrl: sourceCodeUrl || null,
    };

    this._wireCivEvents();
    this._wireWsConnections();
  }

  _wireCivEvents() {
    this.civ.on('frequency', (hz) => {
      this.state.frequency = hz;
      this._broadcast(makeEvent(EVENT.FREQUENCY, { value: hz }));
      this.emit('frequency', hz);
    });
    this.civ.on('mode', (value) => {
      this.state.mode = value;
      this._broadcast(makeEvent(EVENT.MODE, { value }));
    });
    this.civ.on('error', (err) => {
      this._broadcast(makeEvent(EVENT.RIG_ERROR, { message: err.message }));
    });
  }

  _wireWsConnections() {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(makeEvent(EVENT.CONNECTED, { ...this.state }));
      this.emit('client-connected', ws);

      ws.on('message', (raw, isBinary) => {
        if (isBinary) {
          this.emit('binary-message', ws, raw);
          return;
        }
        this._handleMessage(ws, raw);
      });
      ws.on('close', () => {
        this.clients.delete(ws);
        this.emit('client-disconnected', ws);
      });
      ws.on('error', () => {
        this.clients.delete(ws);
        this.emit('client-disconnected', ws);
      });
    });
  }

  async _handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(makeError(null, 'Malformed JSON'));
      return;
    }

    const { id, type } = msg;
    if (!type) {
      ws.send(makeError(id ?? null, 'Missing "type"'));
      return;
    }

    try {
      switch (type) {
        case REQUEST.GET_FREQUENCY: {
          const value = await this.civ.getFrequency();
          this.state.frequency = value;
          ws.send(makeResult(id, { value }));
          break;
        }
        case REQUEST.SET_FREQUENCY: {
          if (typeof msg.value !== 'number') {
            throw new Error('"value" must be a number (Hz)');
          }
          await this.civ.setFrequency(msg.value);
          this.state.frequency = msg.value;
          ws.send(makeResult(id, { value: msg.value }));
          this._broadcast(makeEvent(EVENT.FREQUENCY, { value: msg.value }), ws);
          // Client-requested frequency changes (e.g. FT8's auto-tune)
          // don't necessarily round-trip back through civ's own
          // 'frequency' event in time for internal listeners (that
          // depends on the radio auto-transceiving) — emit directly here
          // too so bridges that track frequency (see 'frequency' in this
          // class's own doc comment) see it immediately either way.
          this.emit('frequency', msg.value);
          break;
        }
        case REQUEST.GET_MODE: {
          const value = await this.civ.getMode();
          this.state.mode = value;
          ws.send(makeResult(id, { value }));
          break;
        }
        case REQUEST.SET_MODE: {
          if (!msg.mode) throw new Error('"mode" is required');
          await this.civ.setMode(msg.mode, msg.filter);
          const value = { mode: msg.mode, filter: msg.filter ?? 1 };
          this.state.mode = value;
          ws.send(makeResult(id, { value }));
          this._broadcast(makeEvent(EVENT.MODE, { value }), ws);
          break;
        }
        case REQUEST.SET_DATA_MODE: {
          if (typeof msg.on !== 'boolean') {
            throw new Error('"on" must be a boolean');
          }
          await this.civ.setDataMode(msg.on);
          this.state.dataMode = msg.on;
          ws.send(makeResult(id, { on: msg.on }));
          this._broadcast(makeEvent(EVENT.DATA_MODE, { on: msg.on }), ws);
          break;
        }
        case REQUEST.GET_DATA_MODE: {
          const on = await this.civ.getDataMode();
          this.state.dataMode = on;
          ws.send(makeResult(id, { on }));
          break;
        }
        case REQUEST.SET_PTT: {
          if (typeof msg.value !== 'boolean') {
            throw new Error('"value" must be a boolean');
          }
          // Excludes the requesting client from the broadcast, same as
          // setFrequency/setMode above — that client already gets its own
          // confirmation via the result reply below.
          await this.setPttFromServer(msg.value, { except: ws });
          ws.send(makeResult(id, { value: msg.value }));
          break;
        }
        case REQUEST.SET_FT8_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          // Cached here purely so a newly-connecting client's initial
          // EVENT.CONNECTED snapshot reflects it — see this.state.ft8Active's
          // own doc comment above. Ft8Bridge keeps the actual authoritative
          // `_active` flag it acts on; this is just a mirror of it.
          this.state.ft8Active = msg.active;
          // Handled by Ft8Bridge (internal-only event, same pattern as
          // 'ptt' above) rather than called directly, since ControlServer
          // has no reference to it — see src/audio/ft8-bridge.js.
          this.emit('ft8-active', msg.active);
          ws.send(makeResult(id, { active: msg.active }));
          break;
        }
        case REQUEST.SEND_FT8: {
          if (typeof msg.message !== 'string' || msg.message.trim() === '') {
            throw new Error('"message" must be a non-empty string');
          }
          // freqHz is optional: the audio-offset frequency (Hz within the
          // passband) to transmit this specific message at, overriding
          // Ft8Bridge's own default. The guided QSO sequencer
          // (src/client/ft8-qso.js) sends this so a QSO's replies go out
          // at the frequency the other station is actually listening on
          // (standard FT8 practice — see docs/ui-notes.md) rather than
          // always at this app's one fixed default; a plain manual send
          // (e.g. a fresh CQ) omits it and gets that default as before.
          if (msg.freqHz !== undefined && typeof msg.freqHz !== 'number') {
            throw new Error('"freqHz" must be a number (Hz) if provided');
          }
          // This only *schedules* the transmission (it happens at the next
          // FT8 slot boundary, up to 15s away) — the actual outcome
          // arrives later as an EVENT.FT8_TX_STATUS broadcast, not as this
          // request's result, since it can't be known yet.
          this.emit('ft8-send', { message: msg.message, freqHz: msg.freqHz });
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.SET_PSK_SPOT_ENABLED: {
          if (typeof msg.enabled !== 'boolean') {
            throw new Error('"enabled" must be a boolean');
          }
          this.state.pskSpotEnabled = msg.enabled;
          // Handled by Ft8Bridge (internal-only event, same pattern as
          // 'ft8-active' above) rather than called directly, since
          // ControlServer has no reference to it — see
          // src/audio/psk-reporter.js.
          this.emit('psk-spot-enabled', msg.enabled);
          ws.send(makeResult(id, { enabled: msg.enabled }));
          this._broadcast(makeEvent(EVENT.PSK_SPOT_ENABLED, { enabled: msg.enabled }), ws);
          break;
        }
        case REQUEST.SET_FT8_VARIANT: {
          if (msg.variant !== 'FT8' && msg.variant !== 'FT4') {
            throw new Error('"variant" must be "FT8" or "FT4"');
          }
          this.state.ft8Variant = msg.variant;
          // Handled by Ft8Bridge (internal-only event, same pattern as
          // 'ft8-active'/'psk-spot-enabled' above) rather than called
          // directly, since ControlServer has no reference to it — see
          // src/audio/ft8-bridge.js#setVariant.
          this.emit('ft8-variant', msg.variant);
          ws.send(makeResult(id, { variant: msg.variant }));
          this._broadcast(makeEvent(EVENT.FT8_VARIANT, { variant: msg.variant }), ws);
          break;
        }
        case REQUEST.SET_FREEDV_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          // Cached here purely so a newly-connecting client's initial
          // EVENT.CONNECTED snapshot reflects it — see
          // this.state.freeDvActive's own doc comment above. RadeBridge
          // keeps the actual authoritative `_active` flag it acts on; this
          // is just a mirror of it, same pattern as ft8Active above (not
          // broadcast to other already-connected clients on change).
          this.state.freeDvActive = msg.active;
          // Handled by RadeBridge (internal-only event, same pattern as
          // 'ft8-active' above) rather than called directly, since
          // ControlServer has no reference to it — see
          // src/server/rade-bridge.js.
          this.emit('freedv-active', msg.active);
          ws.send(makeResult(id, { active: msg.active }));
          break;
        }
        case REQUEST.SET_FREEDV_VARIANT: {
          if (msg.variant !== '700E' && msg.variant !== 'RADE') {
            throw new Error('"variant" must be "700E" or "RADE"');
          }
          this.state.freeDvVariant = msg.variant;
          // Handled by RadeBridge (internal-only event, same pattern as
          // 'freedv-active'/'ft8-variant' above) rather than called
          // directly, since ControlServer has no reference to it — see
          // src/server/rade-bridge.js#setVariant.
          this.emit('freedv-variant', msg.variant);
          ws.send(makeResult(id, { variant: msg.variant }));
          this._broadcast(makeEvent(EVENT.FREEDV_VARIANT, { variant: msg.variant }), ws);
          break;
        }
        case REQUEST.SET_FREEDV_SPOT_ENABLED: {
          if (typeof msg.enabled !== 'boolean') {
            throw new Error('"enabled" must be a boolean');
          }
          this.state.freeDvSpotEnabled = msg.enabled;
          // Handled by FreeDvReporterBridge (internal-only event, same
          // pattern as 'psk-spot-enabled' above) rather than called
          // directly, since ControlServer has no reference to it — see
          // src/server/freedv-reporter.js.
          this.emit('freedv-spot-enabled', msg.enabled);
          ws.send(makeResult(id, { enabled: msg.enabled }));
          this._broadcast(makeEvent(EVENT.FREEDV_SPOT_ENABLED, { enabled: msg.enabled }), ws);
          break;
        }
        case REQUEST.SET_FREEDV_MESSAGE: {
          if (typeof msg.message !== 'string') {
            throw new Error('"message" must be a string');
          }
          this.state.freeDvMessage = msg.message;
          // Handled by FreeDvReporterBridge (internal-only event, same
          // pattern as 'freedv-spot-enabled' above) rather than called
          // directly, since ControlServer has no reference to it — see
          // src/server/freedv-reporter.js.
          this.emit('freedv-message', msg.message);
          ws.send(makeResult(id, { message: msg.message }));
          this._broadcast(makeEvent(EVENT.FREEDV_MESSAGE, { message: msg.message }), ws);
          break;
        }
        case REQUEST.SET_CW_DECODER_VARIANT: {
          if (msg.variant !== 'CW1' && msg.variant !== 'CW2' && msg.variant !== 'CW3') {
            throw new Error('"variant" must be "CW1", "CW2", or "CW3"');
          }
          this.state.cwDecoderVariant = msg.variant;
          // Handled by CwDecoderBridge (internal-only event, same pattern
          // as 'rtty-reversed' below) rather than called directly, since
          // ControlServer has no reference to it — see
          // src/server/cw-decoder-bridge.js.
          this.emit('cw-decoder-variant', msg.variant);
          ws.send(makeResult(id, { variant: msg.variant }));
          this._broadcast(makeEvent(EVENT.CW_DECODER_VARIANT, { variant: msg.variant }), ws);
          break;
        }
        case REQUEST.SET_RTTY_REVERSED: {
          if (typeof msg.reversed !== 'boolean') {
            throw new Error('"reversed" must be a boolean');
          }
          this.state.rttyReversed = msg.reversed;
          // Handled by RttyDecoderBridge (internal-only event, same pattern
          // as 'freedv-spot-enabled' above) rather than called directly,
          // since ControlServer has no reference to it — see
          // src/server/rtty-decoder-bridge.js.
          this.emit('rtty-reversed', msg.reversed);
          ws.send(makeResult(id, { reversed: msg.reversed }));
          this._broadcast(makeEvent(EVENT.RTTY_REVERSED, { reversed: msg.reversed }), ws);
          break;
        }
        case REQUEST.SET_RNNOISE_LEVEL: {
          const maxLevel = this.state.rnnoiseLevelCount - 1;
          if (!Number.isInteger(msg.level) || msg.level < 0 || msg.level > maxLevel) {
            throw new Error(`"level" must be an integer 0-${maxLevel}`);
          }
          this.state.rnnoiseLevel = msg.level;
          // Handled by AudioBridge (internal-only event, same pattern as
          // 'freedv-spot-enabled' above) rather than called directly,
          // since ControlServer has no reference to it — see
          // src/server/audio-bridge.js#setRnnoiseLevel.
          this.emit('rnnoise-level', msg.level);
          ws.send(makeResult(id, { level: msg.level }));
          this._broadcast(makeEvent(EVENT.RNNOISE_LEVEL, { level: msg.level }), ws);
          break;
        }
        case REQUEST.SET_HAMNOISE_ENABLED: {
          if (typeof msg.enabled !== 'boolean') {
            throw new Error('"enabled" must be a boolean');
          }
          this.state.hamNoiseEnabled = msg.enabled;
          // Handled by AudioBridge (internal-only event), same pattern as
          // 'rnnoise-level' above — see
          // src/server/audio-bridge.js#setHamNoiseEnabled, which also
          // enforces mutual exclusion with RNN and broadcasts EVENT.
          // RNNOISE_LEVEL itself if enabling this forces RNN off (this
          // handler doesn't need to know about that — AudioBridge does
          // it directly).
          this.emit('hamnoise-enabled', msg.enabled);
          ws.send(makeResult(id, { enabled: msg.enabled }));
          this._broadcast(makeEvent(EVENT.HAMNOISE_ENABLED, { enabled: msg.enabled }), ws);
          break;
        }
        case REQUEST.GET_SMETER: {
          const value = await this.civ.getSMeter();
          this.state.smeter = value;
          ws.send(makeResult(id, { value }));
          break;
        }
        case REQUEST.SET_SCOPE_BAND: {
          if (typeof msg.lowHz !== 'number' || typeof msg.highHz !== 'number') {
            throw new Error('"lowHz" and "highHz" must both be numbers (Hz)');
          }
          const span = await this.civ.tuneScopeToRange(msg.lowHz, msg.highHz);
          ws.send(makeResult(id, { span }));
          break;
        }
        case REQUEST.SET_SCOPE_SPAN: {
          if (typeof msg.spanHz !== 'number') {
            throw new Error('"spanHz" must be a number (Hz)');
          }
          const span = await this.civ.centerScope(msg.spanHz);
          ws.send(makeResult(id, { span }));
          break;
        }
        case REQUEST.SET_PREAMP: {
          if (![0, 1, 2].includes(msg.value)) {
            throw new Error('"value" must be 0 (OFF), 1 (Amp 1), or 2 (Amp 2)');
          }
          await this.civ.setPreamp(msg.value);
          ws.send(makeResult(id, { value: msg.value }));
          break;
        }
        case REQUEST.SET_NOISE_REDUCTION: {
          if (typeof msg.on !== 'boolean') {
            throw new Error('"on" must be a boolean');
          }
          await this.civ.setNoiseReduction(msg.on);
          ws.send(makeResult(id, { on: msg.on }));
          break;
        }
        case REQUEST.SET_NOISE_BLANKER: {
          if (typeof msg.on !== 'boolean') {
            throw new Error('"on" must be a boolean');
          }
          await this.civ.setNoiseBlanker(msg.on);
          ws.send(makeResult(id, { on: msg.on }));
          break;
        }
        case REQUEST.SET_NOTCH: {
          if (typeof msg.on !== 'boolean') {
            throw new Error('"on" must be a boolean');
          }
          await this.civ.setNotch(msg.on);
          ws.send(makeResult(id, { on: msg.on }));
          break;
        }
        case REQUEST.SET_TUNER: {
          if (![0, 1, 2].includes(msg.value)) {
            throw new Error('"value" must be 0 (OFF), 1 (ON), or 2 (start tuning)');
          }
          await this.civ.setTuner(msg.value);
          ws.send(makeResult(id, { value: msg.value }));
          break;
        }
        case REQUEST.GET_PREAMP: {
          const value = await this.civ.getPreamp();
          ws.send(makeResult(id, { value }));
          break;
        }
        case REQUEST.GET_NOISE_REDUCTION: {
          const on = await this.civ.getNoiseReduction();
          ws.send(makeResult(id, { on }));
          break;
        }
        case REQUEST.GET_NOISE_BLANKER: {
          const on = await this.civ.getNoiseBlanker();
          ws.send(makeResult(id, { on }));
          break;
        }
        case REQUEST.GET_NOTCH: {
          const on = await this.civ.getNotch();
          ws.send(makeResult(id, { on }));
          break;
        }
        case REQUEST.GET_TUNER: {
          const value = await this.civ.getTuner();
          ws.send(makeResult(id, { value }));
          break;
        }
        case REQUEST.GET_SWR: {
          const value = await this.civ.getSWR();
          ws.send(makeResult(id, { value }));
          break;
        }
        case REQUEST.SET_FILTER: {
          if (![1, 2, 3].includes(msg.value)) {
            throw new Error('"value" must be 1, 2, or 3');
          }
          await this.civ.setFilter(msg.value);
          ws.send(makeResult(id, { value: msg.value }));
          break;
        }
        case REQUEST.GET_FILTER: {
          const value = await this.civ.getFilter();
          ws.send(makeResult(id, { value }));
          break;
        }
        case REQUEST.SET_TX_POWER: {
          if (typeof msg.watts !== 'number') {
            throw new Error('"watts" must be a number');
          }
          const watts = await this.civ.setTxPower(msg.watts);
          ws.send(makeResult(id, { watts }));
          break;
        }
        case REQUEST.GET_TX_POWER: {
          const watts = await this.civ.getTxPower();
          ws.send(makeResult(id, { watts }));
          break;
        }
        case REQUEST.SET_RX_GAIN: {
          if (typeof msg.value !== 'number' || msg.value < 0 || msg.value > 255) {
            throw new Error('"value" must be a number between 0 and 255');
          }
          const value = await this.civ.setRxGain(msg.value);
          ws.send(makeResult(id, { value }));
          break;
        }
        case REQUEST.GET_RX_GAIN: {
          const value = await this.civ.getRxGain();
          ws.send(makeResult(id, { value }));
          break;
        }
        default:
          throw new Error(`Unknown request type "${type}"`);
      }
    } catch (err) {
      // Also logged server-side, not just sent back to the requesting
      // client — the client-side error banner (see app.js's showError())
      // auto-hides after 5s, easy to miss for a request the operator
      // didn't watch closely (e.g. setDataMode, fired without an await
      // alongside setMode when entering FT8 mode). A line in the server's
      // own console/journal is the only trace left once that banner is
      // gone, which matters for exactly the kind of "did this CI-V
      // command actually take?" debugging documented in docs/civ-notes.md.
      console.error(`[ws] request "${type}" failed:`, err.message);
      ws.send(makeError(id ?? null, err.message));
    }
  }

  /**
   * Record audio pipeline info so it's included in the "connected"
   * snapshot every client gets — lets the client know the sample
   * rate/channel count/codec to use for its own capture/playback graph
   * without hardcoding assumptions that could drift from the server config.
   */
  setAudioInfo(info) {
    this.state.audio = info;
  }

  /** Same idea as setAudioInfo(), for the scope pipeline's config/availability. */
  setScopeInfo(info) {
    this.state.scope = info;
  }

  /** Send an already-stringified message to all clients except `except`. */
  _broadcast(payload, except) {
    for (const client of this.clients) {
      if (client === except) continue;
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  /** Broadcast a JSON event (see protocol.js `EVENT` types) to all clients. */
  broadcastJsonEvent(type, data) {
    this._broadcast(makeEvent(type, data));
  }

  /**
   * Send a JSON event (see protocol.js `EVENT` types) to one specific
   * client rather than broadcasting to all of them — e.g. pushing a
   * server-side bridge's current state to a client that just connected,
   * so a page reload isn't left with stale/blank UI until the next change.
   */
  sendJsonEvent(ws, type, data) {
    if (ws.readyState === ws.OPEN) ws.send(makeEvent(type, data));
  }

  /** Send a raw binary payload (e.g. an Opus packet) to one client. */
  sendBinary(ws, buffer) {
    if (ws.readyState === ws.OPEN) ws.send(buffer);
  }

  /** Send a raw binary payload to all clients except `except`. */
  broadcastBinary(buffer, except) {
    for (const client of this.clients) {
      if (client === except) continue;
      if (client.readyState === client.OPEN) client.send(buffer);
    }
  }

  /**
   * Start listening. Resolves with the actual port bound (useful with port
   * 0). First primes `this.state.frequency`/`this.state.mode` with an
   * explicit read from the radio, so the very first client to connect gets
   * a real snapshot in its 'connected' event instead of the constructor's
   * `null` placeholders — without this, the frequency/mode display stays
   * blank until something happens to populate `this.state` (a client's own
   * GET_FREQUENCY/SET_FREQUENCY request, or an unsolicited CI-V
   * "transceive" update from the radio). Best-effort: if the radio doesn't
   * answer (not powered on yet, cable unplugged, etc.), listening still
   * proceeds with `null` rather than blocking the server from starting.
   *
   * Note this only primes `this.state` — it does not itself emit an
   * internal 'frequency'/'mode' event, since nothing has necessarily
   * subscribed yet at this point (bridges are typically constructed
   * *after* `listen()` resolves — see src/server/index.js). Anything
   * that needs the radio's starting frequency (e.g. `FreeDvReporterBridge`
   * — see freedv-reporter.js) reads `controlServer.state.frequency`
   * directly at construction time instead of waiting for that event, the
   * same way a freshly-connected client's own 'connected' snapshot does.
   */
  async listen() {
    // Guarded with typeof checks (rather than just try/catch) since some
    // test stub drivers only implement the subset of CivDriver's API their
    // test actually exercises, and calling a method that isn't there at
    // all throws synchronously rather than rejecting.
    await Promise.all([
      typeof this.civ.getFrequency === 'function'
        ? this.civ
            .getFrequency()
            .then((value) => {
              this.state.frequency = value;
            })
            .catch(() => {})
        : Promise.resolve(),
      typeof this.civ.getMode === 'function'
        ? this.civ
            .getMode()
            .then((value) => {
              this.state.mode = value;
            })
            .catch(() => {})
        : Promise.resolve(),
    ]);

    return new Promise((resolve) => {
      this.httpServer.listen(this.port, () => {
        const addr = this.httpServer.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve(this.port);
      });
    });
  }

  /**
   * Starts (on PTT engage) or clears (on PTT release) the fail-safe
   * transmission watchdog — see the constructor's doc comment for why
   * this lives server-side. Any transition to PTT-off — a normal
   * release, this same watchdog firing, or anything else — clears any
   * pending timer, so the 10-minute window always measures one
   * continuous, unbroken transmission (this is deliberately what makes
   * normal CW keying, which naturally toggles PTT off between elements,
   * immune to ever tripping this: only a truly stuck/continuous
   * transmission accumulates toward the limit).
   */
  /**
   * Sets PTT from server-side logic rather than a client request — e.g.
   * Ft8Bridge keying up automatically at a slot boundary — doing exactly
   * the same state update, watchdog arm/clear, broadcast, and internal
   * 'ptt' emission the SET_PTT request handler does, just without a
   * request/response envelope around it (there's no `ws`/`id` to reply
   * to). The 10-minute fail-safe watchdog still arms normally here: an
   * FT8 transmission is ~12.64s, far under that timeout, so this doesn't
   * weaken the fail-safe — it's just reusing the one safety mechanism
   * rather than needing a separate exemption path for automated TX.
   */
  async setPttFromServer(on, { except } = {}) {
    await this.civ.setPtt(on);
    this.state.ptt = on;
    this._armOrClearPttWatchdog(on);
    this._broadcast(makeEvent(EVENT.PTT, { value: on }), except);
    this.emit('ptt', on);
  }

  _armOrClearPttWatchdog(pttOn) {
    if (this._pttWatchdogTimer) {
      clearTimeout(this._pttWatchdogTimer);
      this._pttWatchdogTimer = null;
    }
    if (pttOn) {
      this._pttWatchdogTimer = setTimeout(() => this._onPttWatchdogTimeout(), this.pttWatchdogMs);
    }
  }

  async _onPttWatchdogTimeout() {
    this._pttWatchdogTimer = null;
    try {
      await this.civ.setPtt(false);
    } catch (err) {
      // Still tell clients what happened even if the force-off itself
      // failed to confirm — better to surface it than fail silently on
      // exactly the kind of malfunction this watchdog exists to catch.
      this._broadcast(makeEvent(EVENT.RIG_ERROR, { message: `PTT watchdog fired but the force-off failed: ${err.message}` }));
    }
    this.state.ptt = false;
    this._broadcast(makeEvent(EVENT.PTT_TIMEOUT, { pttWatchdogMs: this.pttWatchdogMs }));
    this._broadcast(makeEvent(EVENT.PTT, { value: false }));
    this.emit('ptt', false); // internal, server-side-only — see the SET_PTT handler's matching emission
  }

  close() {
    if (this._pttWatchdogTimer) {
      clearTimeout(this._pttWatchdogTimer);
      this._pttWatchdogTimer = null;
    }
    return new Promise((resolve) => {
      for (const client of this.clients) client.terminate();
      this.wss.close(() => this.httpServer.close(() => resolve()));
    });
  }
}

module.exports = { ControlServer };
