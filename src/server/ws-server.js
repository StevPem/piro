'use strict';

const { clampOliviaCentre } = require('../audio/olivia-dsp');
const { clampJs8TxHz } = require('./js8-bridge');
const { clampHellTone } = require('../audio/hell-rx');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { REQUEST, EVENT, BINARY_TYPE, makeResult, makeError, makeEvent } = require('./protocol');
const { createStaticHandler } = require('./static-server');

// Operator notes (REQUEST.POST_NOTE)
const NOTES_KEEP = 3;
const NOTE_MAX_CHARS = 200;
const NOTES_IDLE_MS = 60 * 60 * 1000; // cleared after an hour with no new note
const NOTES_EMPTY_GRACE_MS = 2 * 60 * 1000; // ...or two minutes after the last browser leaves

// How often each browser is pinged. A browser that hasn't answered the
// previous ping by the next one is dropped, so a phone that lost its
// network is noticed in 15-30 s, not when TCP gives up many minutes later.
const HEARTBEAT_MS = 15 * 1000;

// Transmit safety (see releasePtt() and restoreWhenReceiving()).
const PTT_RELEASE_ATTEMPTS = 3; // a rejected PTT-off is tried this many times in all
const PTT_RELEASE_RETRY_MS = 200; // ...this far apart
const WATCHDOG_RETRY_MS = 5000; // the watchdog's force-off is retried this often until it is confirmed
const TRANSMITTING_REFUSAL = "Can't change that while transmitting.";

// Requests that change a setting on the radio, or the app mode (which
// changes radio settings). While the radio is transmitting they are refused
// with TRANSMITTING_REFUSAL: a change mid-transmission could put the
// microphone or higher power on the air, or move the signal. Transmit
// controls (PTT, Stop/abort, sending) and reads are not in this list.
// PTT-on refused while a feature that keys without PTT (CW) hasn't confirmed
// the radio is receiving again (see holdReceiveConfirmation).
const RECEIVE_NOT_CONFIRMED = 'The radio may still be sending CW; receive has not been confirmed.';
const RADIO_SETTING_REQUESTS = new Set([
  REQUEST.SET_FREQUENCY,
  REQUEST.SET_MODE,
  REQUEST.SET_DATA_MODE,
  REQUEST.SET_FILTER,
  REQUEST.SET_TX_POWER,
  REQUEST.SET_RX_GAIN,
  REQUEST.SET_PREAMP,
  REQUEST.SET_NOISE_REDUCTION,
  REQUEST.SET_NOISE_BLANKER,
  REQUEST.SET_NOTCH,
  REQUEST.SET_TUNER,
  REQUEST.SET_SCOPE_SPAN,
]);
// App-mode switches: refused only when they would change the mode (a
// reconnecting browser re-stating the current mode is not a change).
const APP_MODE_REQUESTS = new Map([
  [REQUEST.SET_FT8_ACTIVE, 'ft8Active'],
  [REQUEST.SET_FREEDV_ACTIVE, 'freeDvActive'],
  [REQUEST.SET_JTTY_ACTIVE, 'jttyActive'],
  [REQUEST.SET_OLIVIA_ACTIVE, 'oliviaActive'],
  [REQUEST.SET_JS8_ACTIVE, 'js8Active'],
  [REQUEST.SET_HELL_ACTIVE, 'hellActive'],
  [REQUEST.SET_VARA_ACTIVE, 'varaActive'],
  [REQUEST.SET_SSTV_ACTIVE, 'sstvActive'],
  [REQUEST.SET_WSPR_ACTIVE, 'wsprActive'],
  [REQUEST.SET_FAX_ACTIVE, 'faxActive'],
  [REQUEST.SET_EASYPAL_ACTIVE, 'easypalActive'],
]);

// The largest WebSocket message accepted from a browser. The biggest the
// protocol allows is REQUEST.SEND_EASYPAL: a JPEG of up to 4 MB, about
// 5.6 MB as base64 (SEND_SSTV's RGB is at most 3 MB, 4 MB as base64).
// Bigger messages are refused and the socket closed (code 1009), so one
// browser can't make the Pi hold ws's default of 100 MiB.
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

// Backpressure. A browser that can't keep up (a phone on weak mobile data)
// would otherwise have audio, scope and spectrum frames pile up in the
// Pi's memory, and hear the band later and later. When more than this is
// waiting to go to one browser, its live frames are skipped until the
// backlog is under a quarter of it: a short gap instead of growing delay.
// Raw PCM is about 96 kB/s, so 128 kB is a little over a second of it;
// compressed audio is 3 to 6 kB/s, so 32 kB is several seconds. (Data
// already handed to the network stack isn't counted; this is on top.)
const LIVE_BACKLOG_BYTES = { pcm: 128 * 1024, compressed: 32 * 1024 };

// Binary frames that are only worth showing now, so may be skipped for a
// browser that is behind. Picture data (SSTV and fax lines, Feld-Hell
// columns) is never skipped: a lost line would leave a hole in the picture.
// JSON (state, decoded text) is never skipped either.
const LIVE_FRAME_TYPES = new Set([
  BINARY_TYPE.AUDIO,
  BINARY_TYPE.AUDIO_OPUS,
  BINARY_TYPE.AUDIO_ADPCM,
  BINARY_TYPE.SCOPE_LINE,
  BINARY_TYPE.FT8_SPECTRUM,
]);

// CI-V carries a frequency as 10 BCD digits.
const MAX_FREQUENCY_HZ = 9999999999;

/**
 * Whether a WebSocket upgrade may go ahead, judged by its Origin header.
 * A browser always sends Origin; another web page open in the operator's
 * browser would send its own, so only the page this server serves (same
 * host and port as the request's Host header) or an origin in
 * `allowedOrigins` gets through. No Origin means no browser (a script or
 * a test), which a web page can't fake.
 */
function originAllowed(origin, host, allowedOrigins = []) {
  if (!origin) return true;
  const o = String(origin).trim().toLowerCase().replace(/\/+$/, '');
  if (allowedOrigins.some((a) => a === '*' || a === o)) return true;
  let url;
  try {
    url = new URL(o);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !!host && url.host === String(host).trim().toLowerCase();
}

/** "a, b" (ALLOWED_ORIGINS) or an array -> lower-case origins without a trailing slash. */
function parseAllowedOrigins(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list.map((o) => String(o).trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean);
}

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
    heartbeatMs = HEARTBEAT_MS,
    maxMessageBytes = MAX_MESSAGE_BYTES,
    liveBacklogBytes = LIVE_BACKLOG_BYTES,
    allowedOrigins = [],
    notesIdleMs = NOTES_IDLE_MS,
    notesEmptyGraceMs = NOTES_EMPTY_GRACE_MS,
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
    // The browser that keyed PTT with REQUEST.SET_PTT, while it's keyed.
    // If that browser goes (closed, network lost, heartbeat missed), PTT
    // is released at once rather than when the watchdog fires.
    this._pttOwner = null;
    // Transmit safety. _rxConfirmed: the radio's last answer was that it is
    // unkeyed (a PTT-off it acknowledged). False from the moment a key-up
    // is attempted (it may reach the radio even if the answer doesn't) until
    // a PTT-off is acknowledged. Settings a feature changed for a
    // transmission are put back only while it is true (restoreWhenReceiving).
    this._rxConfirmed = true;
    this._receiveHolds = new Set(); // autonomous transmitters awaiting actual RX
    this._heldRestores = []; // restores waiting for a confirmed unkey
    this._restoreChain = Promise.resolve(); // restores run one at a time; a key-up waits for them
    this._lastTransmitting = false;
    // Ping every heartbeatMs (0 turns it off); see HEARTBEAT_MS.
    this.heartbeatMs = heartbeatMs;
    this._heartbeatTimer = null;
    // Backpressure limits (see LIVE_BACKLOG_BYTES), and each browser's
    // limit (by its audio format) and whether it's skipping frames now.
    this.liveBacklogBytes = { ...LIVE_BACKLOG_BYTES, ...liveBacklogBytes };
    this._liveLimit = new WeakMap();
    this._lagging = new WeakMap(); // ws -> {since, dropped}
    // Origins allowed besides this server's own page; see originAllowed().
    this.allowedOrigins = parseAllowedOrigins(allowedOrigins);
    // Operator notes (REQUEST.POST_NOTE): cleared after notesIdleMs with no
    // new note, or once nobody has been connected for notesEmptyGraceMs (a
    // grace period, so one person reloading the page doesn't wipe them).
    this.notesIdleMs = notesIdleMs;
    this.notesEmptyGraceMs = notesEmptyGraceMs;
    this._notesIdleTimer = null;
    this._notesEmptyTimer = null;
    this._noteId = 0;

    const staticHandler = staticDir ? createStaticHandler(staticDir) : null;
    const requestHandler = (req, res) => {
      if (staticHandler) {
        // Belt and braces: nothing a browser sends should be able to throw
        // out of here and take the server (and the radio's PTT) down.
        try {
          staticHandler(req, res);
        } catch (err) {
          console.error(`[http] ${req.method} ${req.url} failed:`, err.message);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Server error');
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('PiRO control server\n');
    };
    this.httpServer = this.tls
      ? https.createServer({ cert: this.tls.cert, key: this.tls.key }, requestHandler)
      : http.createServer(requestHandler);
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: maxMessageBytes,
      verifyClient: ({ origin, req }) => {
        if (originAllowed(origin, req.headers.host, this.allowedOrigins)) return true;
        console.warn(`[ws] refused a connection from origin ${origin} (Host: ${req.headers.host}); see ALLOWED_ORIGINS`);
        return false;
      },
    });
    this.clients = new Set();
    // Programs that aren't browsers, such as a logger on the Hamlib-style
    // port (rigctl-server.js). They send requests through the same checks
    // as a browser, and can hold PTT, but get no broadcasts and don't count
    // as browsers (see addExternalClient).
    this.externalClients = new Set();

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
      screenTitle: screenTitle || 'PiRO', // static for the process lifetime, see docs/ui-notes.md
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
      // Every change is also broadcast to the other connected clients as
      // part of EVENT.APP_MODES (see appModes()), as are all the app-level
      // modes below, so every browser shows the same mode.
      ft8Active: false,
      // Whether the client has JTTY selected (see REQUEST.SET_JTTY_ACTIVE /
      // server/jtty-decoder-bridge.js). Cached here for the same reason as
      // ft8Active: JttyDecoderBridge acts on the 'jtty-active' event, and a
      // newly-connecting client's EVENT.CONNECTED snapshot needs the value.
      jttyActive: false,
      // The JTTY transmit audio frequency (lowest tone), shared so every
      // browser shows the same one (REQUEST.SET_JTTY_ACTIVE's txHz).
      jttyTxHz: 1450,
      // Whether the client has Olivia selected, and the audio centre
      // frequency it listens on (see REQUEST.SET_OLIVIA_ACTIVE /
      // server/olivia-decoder-bridge.js). Same reasons as jttyActive.
      oliviaActive: false,
      oliviaCentreHz: 1500,
      // Whether the client has Feld-Hell selected, and the audio tone it
      // paints (see REQUEST.SET_HELL_ACTIVE / server/hell-decoder-bridge.js).
      // Same reasons as jttyActive.
      hellActive: false,
      hellToneHz: 1000,
      // Whether the client has JS8 selected, and its transmit offset (see
      // REQUEST.SET_JS8_ACTIVE / server/js8-bridge.js), and JS8's state
      // (state.js8, kept by Js8Bridge; null when it isn't set up).
      js8Active: false,
      js8TxHz: 1500,
      js8: null,
      // Speech-to-text copy aid (REQUEST.SET_STT_ENABLED / server/stt-bridge.js):
      // the "STT" checkbox, and its state (state.stt, kept by SttBridge; null
      // when it isn't set up).
      sttEnabled: false,
      stt: null,
      // Whether the client has VARA chat selected (REQUEST.SET_VARA_ACTIVE /
      // server/vara-bridge.js), and the modem's state (state.vara, kept by
      // VaraBridge; null when it isn't set up).
      varaActive: false,
      vara: null,
      // Whether the client has SSTV selected (see REQUEST.SET_SSTV_ACTIVE /
      // server/sstv-decoder-bridge.js). Same reasons as jttyActive.
      sstvActive: false,
      // Whether WSPR is on (REQUEST.SET_WSPR_ACTIVE / server/wspr-bridge.js).
      // Its own state (TX on/off, slot, last upload) is state.wspr, kept by
      // WsprBridge.
      wsprActive: false,
      wspr: null,
      // Whether radiofax receive is on (REQUEST.SET_FAX_ACTIVE /
      // server/fax-decoder-bridge.js), and the receiver's state (state.fax).
      faxActive: false,
      fax: null,
      // Whether EasyPal (HamDRM) receive is on (REQUEST.SET_EASYPAL_ACTIVE /
      // server/easypal-decoder-bridge.js), and the receiver's state (state.easypal).
      easypalActive: false,
      easypal: null,
      // The EasyPal transmit settings (EASYPAL_TX_*), set by
      // server/easypal-tx-bridge.js; null when it isn't set up.
      easypalTx: null,
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
      // reasoning as ft8Active above: a server-side setting cached here so
      // a newly-connecting client's initial snapshot can reflect it, and
      // broadcast in EVENT.APP_MODES on change.
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
      // CW3 (DeepCW) by default: the only one the client offers for now
      // (CW_DECODERS_IN_UI in app.js); CW1 and CW2 are kept.
      cwDecoderVariant: 'CW3',
      // Where this running instance's corresponding source is published
      // — see server/index.js's SOURCE_CODE_URL doc comment for why this
      // is operator-configured rather than a hardcoded repo URL, and
      // README.md's "Licence" section for why it's needed at all (AGPL-
      // 3.0-only §13, triggered by bundling the "CW 3" deepcw-engine
      // model). null (the default) shows no link client-side — static
      // for the process lifetime, same as screenTitle/appVersion above.
      sourceCodeUrl: sourceCodeUrl || null,
      // Short text notes operators leave each other (the bar under the PTT
      // button): the NOTES_KEEP most recent, newest last, each {id, text,
      // time} with time in epoch ms. See REQUEST.POST_NOTE.
      notes: [],
      cwKeying: false, // the CW paddle is keying (EVENT.CW_KEYING); see cw-paddle-bridge.js
      transmitting: false, // the radio is, or may be, transmitting (EVENT.TRANSMITTING); see ControlServer#transmitting
    };
    this.cwPaddle = null; // set by CwPaddleBridge#start()

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
      // Internal: the radio's mode, DATA mode or an app mode changed (STT follows it).
      this.emit('mode-changed');
    });
    this.civ.on('error', (err) => {
      this._broadcast(makeEvent(EVENT.RIG_ERROR, { message: err.message }));
    });
  }

  _wireWsConnections() {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      if (this._notesEmptyTimer) {
        clearTimeout(this._notesEmptyTimer);
        this._notesEmptyTimer = null;
      }
      ws.send(makeEvent(EVENT.CONNECTED, { ...this.state, clients: this.clients.size }));
      this._broadcastClientCount(ws); // the new browser has the count in its snapshot
      this.emit('client-connected', ws);

      ws.on('message', (raw, isBinary) => {
        if (isBinary) {
          this.emit('binary-message', ws, raw);
          return;
        }
        this._handleMessage(ws, raw);
      });
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('close', () => this._onClientGone(ws));
      ws.on('error', () => this._onClientGone(ws));
    });
    if (this.heartbeatMs > 0) {
      this._heartbeatTimer = setInterval(() => this._heartbeat(), this.heartbeatMs);
      this._heartbeatTimer.unref?.();
    }
  }

  /**
   * Registers a program that isn't a browser, such as a logger on the
   * Hamlib-style port (rigctl-server.js). Returns a handle:
   * - request(msg): runs a request (REQUEST.*) through the same path as a
   *   browser's, so the same checks apply, including "Can't change that
   *   while transmitting." Resolves with the reply: {ok: true, data} or
   *   {ok: false, error}. Never rejects.
   * - close(): call when the program disconnects. If it holds PTT, PTT is
   *   released, as for a browser.
   * It gets no broadcasts and doesn't count as a browser, so it doesn't
   * keep receivers running when the last browser leaves.
   */
  addExternalClient(name) {
    const pending = new Map();
    let nextId = 0;
    const client = {
      name,
      readyState: 1,
      OPEN: 1,
      // _handleMessage() replies here; hand each reply to its request.
      send: (payload) => {
        let reply;
        try {
          reply = JSON.parse(payload);
        } catch {
          return;
        }
        const resolve = pending.get(reply.id);
        if (!resolve) return;
        pending.delete(reply.id);
        resolve(reply.ok ? { ok: true, data: reply.data } : { ok: false, error: reply.error });
      },
      request: (msg) =>
        new Promise((resolve) => {
          const id = `${name}#${++nextId}`;
          pending.set(id, resolve);
          this._handleMessage(client, JSON.stringify({ ...msg, id }));
        }),
      close: () => {
        if (!this.externalClients.delete(client)) return;
        this._releasePttIfOwnerGone(client);
      },
    };
    this.externalClients.add(client);
    return client;
  }

  /** A browser closed, errored or was dropped by the heartbeat ('close' and 'error' may both call this). */
  _onClientGone(ws) {
    this.clients.delete(ws);
    this._broadcastClientCount();
    this.emit('client-disconnected', ws);
    this._releaseJttyIfAlone();
    this._releasePttIfOwnerGone(ws);
  }

  /**
   * Unkeys the radio if `ws` keyed it with REQUEST.SET_PTT and is still
   * holding it. Without this a phone that loses its network mid-over
   * would leave the transmitter on until the 10-minute watchdog.
   * Transmissions a bridge keyed itself (FT8, WSPR, ...) have no owner;
   * the bridges stop those when the last browser leaves.
   */
  _releasePttIfOwnerGone(ws) {
    if (!this._pttOwner || this._pttOwner !== ws) return;
    this._pttOwner = null; // first, so 'close' after 'error' doesn't send it twice
    if (!this.state.ptt) return;
    console.warn(`[ws] ${ws.name || 'the browser'} holding PTT disconnected; releasing PTT`);
    this.setPttFromServer(false).catch((err) => {
      console.error('[ws] releasing PTT after a disconnect failed:', err.message);
      this._broadcast(makeEvent(EVENT.RIG_ERROR, { message: `Releasing PTT after a browser disconnected failed: ${err.message}` }));
    });
  }

  /** Pings every browser; drops any that didn't answer the last ping. */
  _heartbeat() {
    for (const ws of this.clients) {
      if (ws.isAlive === false) {
        console.warn('[ws] a browser stopped answering pings; dropping it');
        ws.terminate(); // 'close' follows, which calls _onClientGone()
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // not open any more; 'close' deals with it
      }
    }
  }

  /**
   * Tells every browser how many are connected (EVENT.CLIENTS), when the
   * number changes; `except` (a browser that has just connected) already
   * has it in its snapshot. A socket's 'error' and 'close' both remove it,
   * so the second of them sends nothing.
   */
  _broadcastClientCount(except) {
    const count = this.clients.size;
    if (count === this._lastClientCount) return;
    this._lastClientCount = count;
    this._broadcast(makeEvent(EVENT.CLIENTS, { count }), except);
  }

  /**
   * The app-level modes (layered on the radio's own LSB/USB, so CI-V can't
   * report them) and their settings. Broadcast as EVENT.APP_MODES whenever
   * one changes, so every connected browser shows the same mode.
   */
  appModes() {
    const s = this.state;
    return {
      ft8Active: s.ft8Active,
      freeDvActive: s.freeDvActive,
      jttyActive: s.jttyActive,
      jttyTxHz: s.jttyTxHz,
      oliviaActive: s.oliviaActive,
      oliviaCentreHz: s.oliviaCentreHz,
      js8Active: s.js8Active,
      js8TxHz: s.js8TxHz,
      hellActive: s.hellActive,
      hellToneHz: s.hellToneHz,
      varaActive: s.varaActive,
      sstvActive: s.sstvActive,
      wsprActive: s.wsprActive,
      faxActive: s.faxActive,
      easypalActive: s.easypalActive,
    };
  }

  /** Tells every browser except `except` (which has its own reply) about the app modes now. */
  _broadcastAppModes(except) {
    this._broadcast(makeEvent(EVENT.APP_MODES, this.appModes()), except);
    this.emit('mode-changed');
  }

  _setJttyActive(active) {
    this.state.jttyActive = active;
    // Handled by JttyDecoderBridge (internal-only event, same pattern as 'ft8-active').
    this.emit('jtty-active', active);
  }

  _setOliviaActive(active, centreHz) {
    this.state.oliviaActive = active;
    if (centreHz !== undefined) this.state.oliviaCentreHz = centreHz;
    // Handled by OliviaDecoderBridge (internal-only event, same pattern as 'jtty-active').
    this.emit('olivia-active', { active, centreHz: this.state.oliviaCentreHz });
  }

  _setSttEnabled(enabled) {
    this.state.sttEnabled = enabled;
    // Handled by SttBridge (internal-only event).
    this.emit('stt-enabled', enabled);
  }

  _setJs8Active(active, txHz) {
    this.state.js8Active = active;
    if (txHz !== undefined) this.state.js8TxHz = txHz;
    // Handled by Js8Bridge (internal-only event).
    this.emit('js8-active', { active, txHz: this.state.js8TxHz });
  }

  _setHellActive(active, toneHz) {
    this.state.hellActive = active;
    if (toneHz !== undefined) this.state.hellToneHz = toneHz;
    // Handled by HellDecoderBridge (internal-only event, same pattern as 'olivia-active').
    this.emit('hell-active', { active, toneHz: this.state.hellToneHz });
  }

  _setVaraActive(active) {
    this.state.varaActive = active;
    // Handled by VaraBridge (internal-only event).
    this.emit('vara-active', active);
  }

  _setWsprActive(active) {
    this.state.wsprActive = active;
    // Handled by WsprBridge (internal-only event).
    this.emit('wspr-active', active);
  }

  _setFaxActive(active) {
    this.state.faxActive = active;
    // Handled by FaxDecoderBridge (internal-only event).
    this.emit('fax-active', active);
  }

  _setEasypalActive(active) {
    this.state.easypalActive = active;
    // Handled by EasypalDecoderBridge (internal-only event).
    this.emit('easypal-active', active);
  }

  _setSstvActive(active) {
    this.state.sstvActive = active;
    // Handled by SstvDecoderBridge (internal-only event).
    this.emit('sstv-active', active);
  }

  /** JTTY, Olivia, Feld-Hell and SSTV receiving cost CPU: don't leave them running for a browser that has gone away. */
  _releaseJttyIfAlone() {
    if (this.clients.size !== 0) return;
    // Notes are for the people using the radio now: once nobody has been
    // here for a little while, they go.
    if (this.state.notes.length && !this._notesEmptyTimer) {
      this._notesEmptyTimer = setTimeout(() => {
        this._notesEmptyTimer = null;
        if (this.clients.size === 0) this._clearNotes('empty');
      }, this.notesEmptyGraceMs);
      this._notesEmptyTimer.unref?.();
    }
    if (this.state.jttyActive) this._setJttyActive(false);
    if (this.state.oliviaActive) this._setOliviaActive(false);
    // JS8 too: a message may be being sent.
    if (this.state.js8Active) this._setJs8Active(false);
    // Speech-to-text: off until someone ticks it again (it starts a speech engine).
    if (this.state.sttEnabled) this._setSttEnabled(false);
    if (this.state.hellActive) this._setHellActive(false);
    // VARA too: it transmits on its own (answering calls, acknowledging).
    if (this.state.varaActive) this._setVaraActive(false);
    if (this.state.sstvActive) this._setSstvActive(false);
    if (this.state.faxActive) this._setFaxActive(false);
    if (this.state.easypalActive) this._setEasypalActive(false);
    // WSPR too (it may transmit). WSPR_UNATTENDED can start a receive-only run later; see wspr-bridge.js.
    if (this.state.wsprActive) {
      this._setWsprActive(false);
      this._broadcastAppModes();
    }
  }

  /** Adds an operator note, broadcasts it (the other browsers chime), and restarts the idle clock. */
  _postNote(text, except) {
    const note = { id: ++this._noteId, text, time: Date.now() };
    const notes = [...this.state.notes, note].slice(-NOTES_KEEP);
    this.state.notes = notes;
    if (this._notesIdleTimer) clearTimeout(this._notesIdleTimer);
    this._notesIdleTimer = setTimeout(() => {
      this._notesIdleTimer = null;
      this._clearNotes('idle');
    }, this.notesIdleMs);
    this._notesIdleTimer.unref?.();
    this._broadcast(makeEvent(EVENT.NOTES, { notes, posted: note }), except);
    return notes;
  }

  _clearNotes(reason) {
    if (this._notesIdleTimer) clearTimeout(this._notesIdleTimer);
    this._notesIdleTimer = null;
    if (!this.state.notes.length) return;
    this.state.notes = [];
    this._broadcast(makeEvent(EVENT.NOTES, { notes: [], cleared: reason }));
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

    // No setting changes while the radio is transmitting (see RADIO_SETTING_REQUESTS).
    if (this.transmitting && this._changesSetting(type, msg)) {
      ws.send(makeError(id ?? null, TRANSMITTING_REFUSAL));
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
          // Above zero and within CI-V's 10 digits, rounded to whole Hz as
          // the radio is set. Whether the radio covers it is up to the
          // radio: it answers NG if not.
          const hz = Math.round(msg.value);
          if (!Number.isFinite(msg.value) || hz < 1 || hz > MAX_FREQUENCY_HZ) {
            throw new Error(`"value" must be a frequency in Hz from 1 to ${MAX_FREQUENCY_HZ}`);
          }
          await this.civ.setFrequency(hz);
          this.state.frequency = hz;
          ws.send(makeResult(id, { value: hz }));
          this._broadcast(makeEvent(EVENT.FREQUENCY, { value: hz }), ws);
          // Client-requested frequency changes (e.g. FT8's auto-tune)
          // don't necessarily round-trip back through civ's own
          // 'frequency' event in time for internal listeners (that
          // depends on the radio auto-transceiving) — emit directly here
          // too so bridges that track frequency (see 'frequency' in this
          // class's own doc comment) see it immediately either way.
          this.emit('frequency', hz);
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
          this.emit('mode-changed');
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
          this.emit('mode-changed');
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
          await this.setPttFromServer(msg.value, { except: ws, owner: ws });
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
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.SET_JTTY_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          if (msg.txHz !== undefined && (typeof msg.txHz !== 'number' || !Number.isFinite(msg.txHz))) {
            throw new Error('"txHz" must be a number (Hz) if provided');
          }
          if (msg.txHz !== undefined) this.state.jttyTxHz = Math.round(Math.max(200, Math.min(2800, msg.txHz)));
          this._setJttyActive(msg.active);
          ws.send(makeResult(id, { active: msg.active, txHz: this.state.jttyTxHz }));
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.SET_OLIVIA_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          if (msg.centreHz !== undefined && (typeof msg.centreHz !== 'number' || !Number.isFinite(msg.centreHz))) {
            throw new Error('"centreHz" must be a number (Hz) if provided');
          }
          const centreHz = msg.centreHz === undefined ? undefined : clampOliviaCentre(msg.centreHz);
          this._setOliviaActive(msg.active, centreHz);
          ws.send(makeResult(id, { active: msg.active, centreHz: this.state.oliviaCentreHz }));
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.SET_STT_ENABLED: {
          if (typeof msg.enabled !== 'boolean') throw new Error('"enabled" must be a boolean');
          if (msg.enabled && !this.listenerCount('stt-enabled')) throw new Error('Speech-to-text is not set up on this server (it needs audio).');
          this._setSttEnabled(msg.enabled);
          ws.send(makeResult(id, { enabled: msg.enabled }));
          break;
        }
        case REQUEST.SET_JS8_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          if (msg.txHz !== undefined && (typeof msg.txHz !== 'number' || !Number.isFinite(msg.txHz))) {
            throw new Error('"txHz" must be a number (Hz) if provided');
          }
          if (msg.active && !this.listenerCount('js8-active')) throw new Error('JS8 is not set up on this server (it needs audio).');
          const txHz = msg.txHz === undefined ? undefined : clampJs8TxHz(msg.txHz);
          this._setJs8Active(msg.active, txHz);
          ws.send(makeResult(id, { active: msg.active, txHz: this.state.js8TxHz }));
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.JS8: {
          if (!['send', 'cq', 'stop'].includes(msg.action)) {
            throw new Error('"action" must be "send", "cq" or "stop"');
          }
          if (msg.text !== undefined && typeof msg.text !== 'string') throw new Error('"text" must be a string');
          if (typeof msg.text === 'string' && msg.text.length > 1000) throw new Error('"text" is too long');
          if (!this.listenerCount('js8')) throw new Error('JS8 is not set up on this server (it needs audio).');
          // Handled by Js8Bridge#request (its listener); it resolves with the result or rejects with why not.
          const handler = this.listeners('js8')[0];
          const result = await handler({ action: msg.action, text: msg.text });
          ws.send(makeResult(id, result || {}));
          break;
        }
        case REQUEST.SET_HELL_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          if (msg.toneHz !== undefined && (typeof msg.toneHz !== 'number' || !Number.isFinite(msg.toneHz))) {
            throw new Error('"toneHz" must be a number (Hz) if provided');
          }
          const toneHz = msg.toneHz === undefined ? undefined : clampHellTone(msg.toneHz);
          this._setHellActive(msg.active, toneHz);
          ws.send(makeResult(id, { active: msg.active, toneHz: this.state.hellToneHz }));
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.SET_VARA_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          if (msg.active && !this.listenerCount('vara-active')) throw new Error('VARA is not set up on this server (it needs audio).');
          this._setVaraActive(msg.active);
          ws.send(makeResult(id, { active: msg.active }));
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.VARA: {
          if (!['cq', 'connect', 'disconnect', 'send', 'qsy'].includes(msg.action)) {
            throw new Error('"action" must be "cq", "connect", "disconnect", "send" or "qsy"');
          }
          if (msg.offsetHz !== undefined && (typeof msg.offsetHz !== 'number' || !Number.isFinite(msg.offsetHz))) throw new Error('"offsetHz" must be a number (Hz)');
          if (msg.call !== undefined && typeof msg.call !== 'string') throw new Error('"call" must be a string');
          if (msg.text !== undefined && typeof msg.text !== 'string') throw new Error('"text" must be a string');
          if (typeof msg.text === 'string' && msg.text.length > 1000) throw new Error('"text" is too long (1000 characters at most)');
          if (!this.listenerCount('vara')) throw new Error('VARA is not set up on this server (it needs audio).');
          // Handled by VaraBridge#request, which throws if it can't be done.
          this.emit('vara', { action: msg.action, call: msg.call, text: msg.text, offsetHz: msg.offsetHz });
          ws.send(makeResult(id, {}));
          break;
        }
        case REQUEST.SET_SSTV_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          this._setSstvActive(msg.active);
          ws.send(makeResult(id, { active: msg.active }));
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.SET_WSPR_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          this._setWsprActive(msg.active);
          ws.send(makeResult(id, { active: msg.active }));
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.SET_WSPR_TX: {
          if (msg.enabled !== undefined && typeof msg.enabled !== 'boolean') throw new Error('"enabled" must be a boolean if provided');
          if (msg.txHz !== undefined && (typeof msg.txHz !== 'number' || !Number.isFinite(msg.txHz))) {
            throw new Error('"txHz" must be a number (Hz) if provided');
          }
          // Handled by WsprBridge, which owns state.wspr and broadcasts EVENT.WSPR_STATUS.
          this.emit('wspr-tx', { enabled: msg.enabled, txHz: msg.txHz });
          ws.send(makeResult(id, { wspr: this.state.wspr ?? null }));
          break;
        }
        case REQUEST.END_SSTV_PICTURE: {
          this.emit('sstv-end-picture');
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.SEND_SSTV: {
          if (typeof msg.rgb !== 'string' || !Number.isInteger(msg.width) || !Number.isInteger(msg.height)) {
            throw new Error('"rgb" (base64) and integer "width" and "height" are required');
          }
          if (msg.width * msg.height > 1024 * 1024) throw new Error('That picture is too large');
          const rgb = Buffer.from(msg.rgb, 'base64');
          if (rgb.length !== msg.width * msg.height * 3) throw new Error('"rgb" must be width * height * 3 bytes');
          // Like SEND_TTY, this only starts it; the outcome arrives as EVENT.SSTV_TX_STATUS.
          this.emit('sstv-send', { rgb, width: msg.width, height: msg.height });
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.ABORT_SSTV: {
          this.emit('sstv-abort');
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.SEND_EASYPAL: {
          if (typeof msg.jpeg !== 'string' || !msg.jpeg) throw new Error('"jpeg" (base64) is required');
          if (msg.jpeg.length > Math.ceil((4 * 1024 * 1024 * 4) / 3) + 4) throw new Error('That picture is too large (4 MB at most)');
          const jpeg = Buffer.from(msg.jpeg, 'base64');
          if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('"jpeg" must be a JPEG');
          if (!this.state.easypalTx) throw new Error('EasyPal transmit is not available');
          // Like SEND_SSTV, this only starts it; the outcome arrives as EVENT.EASYPAL_TX_STATUS.
          this.emit('easypal-send', { jpeg });
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.ABORT_EASYPAL: {
          this.emit('easypal-abort');
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.POST_NOTE: {
          if (typeof msg.text !== 'string') throw new Error('"text" must be a string');
          const text = msg.text.replace(/\s+/g, ' ').trim();
          if (!text) throw new Error('"text" must not be empty');
          if (text.length > NOTE_MAX_CHARS) throw new Error(`A note can be at most ${NOTE_MAX_CHARS} characters`);
          const notes = this._postNote(text, ws);
          ws.send(makeResult(id, { notes }));
          break;
        }
        case REQUEST.SET_FAX_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          this._setFaxActive(msg.active);
          ws.send(makeResult(id, { active: msg.active }));
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.SET_EASYPAL_ACTIVE: {
          if (typeof msg.active !== 'boolean') {
            throw new Error('"active" must be a boolean');
          }
          this._setEasypalActive(msg.active);
          ws.send(makeResult(id, { active: msg.active }));
          this._broadcastAppModes(ws);
          break;
        }
        case REQUEST.GET_EASYPAL_PICTURES: {
          // Kept here by EasypalDecoderBridge (newest last).
          ws.send(makeResult(id, { pictures: this.easypalPictures ?? [], preview: this.easypalPreview ?? null }));
          break;
        }
        case REQUEST.SET_VOICE_SQUELCH: {
          // AudioBridge keeps the state and broadcasts it (EVENT.VOICE_SQUELCH)
          if (!this.setVoiceSquelch) throw new Error('Audio is not enabled on this server');
          if (typeof msg.enabled !== 'boolean') throw new Error('setVoiceSquelch needs {enabled: true|false}');
          ws.send(makeResult(id, this.setVoiceSquelch(msg.enabled)));
          break;
        }
        case REQUEST.SET_AUDIO_CODEC: {
          // per browser, not shared: AudioBridge keeps it (setClientAudioCodec)
          if (!this.setClientAudioCodec) throw new Error('Audio is not enabled on this server');
          const codec = this.setClientAudioCodec(ws, msg.codec);
          this._liveLimit.set(ws, codec === 'pcm' ? this.liveBacklogBytes.pcm : this.liveBacklogBytes.compressed);
          ws.send(makeResult(id, { codec }));
          break;
        }
        case REQUEST.FAX_START_NOW: {
          this.emit('fax-start-now');
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.FAX_STOP: {
          this.emit('fax-stop');
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.GET_FAX_PICTURES: {
          // Kept here by FaxDecoderBridge (newest last).
          const current = this.faxCurrent ? await this.faxCurrent() : null;
          ws.send(makeResult(id, { pictures: this.faxPictures ?? [], current }));
          break;
        }
        case REQUEST.GET_BAND_CONDITIONS: {
          if (!this.bandConditions) throw new Error('Band conditions are not available');
          ws.send(makeResult(id, await this.bandConditions.report()));
          break;
        }
        case REQUEST.GET_SSTV_PICTURES: {
          // Kept here by SstvDecoderBridge (newest last).
          ws.send(makeResult(id, { pictures: this.sstvPictures ?? [] }));
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
        case REQUEST.SEND_TTY: {
          if (!['RTTY', 'JTTY', 'OLIVIA', 'HELL'].includes(msg.mode)) {
            throw new Error('"mode" must be "RTTY", "JTTY", "OLIVIA" or "HELL"');
          }
          if (typeof msg.text !== 'string' || msg.text.trim() === '') {
            throw new Error('"text" must be a non-empty string');
          }
          if (msg.text.length > 1000) {
            throw new Error('"text" is too long');
          }
          if (msg.freqHz !== undefined && (typeof msg.freqHz !== 'number' || !Number.isFinite(msg.freqHz))) {
            throw new Error('"freqHz" must be a number (Hz) if provided');
          }
          // Like SEND_FT8, this only *starts* the transmission — it runs for
          // seconds to tens of seconds, and the real outcome (including
          // encoder rejections) arrives as EVENT.TTY_TX_STATUS broadcasts,
          // handled by TtyBridge (internal-only event, same pattern as
          // 'ft8-send').
          this.emit('tty-send', { mode: msg.mode, text: msg.text, freqHz: msg.freqHz });
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.CW_KEY: {
          // One paddle element; see cw-paddle-bridge.js. Replies at once: the
          // element is keyed later, on the server's clock.
          if (!this.cwPaddle) throw new Error('The CW paddle is not available on this server');
          ws.send(makeResult(id, this.cwPaddle.key(ws, msg)));
          break;
        }
        case REQUEST.SEND_CW: {
          if (typeof msg.text !== 'string' || msg.text.trim() === '') throw new Error('"text" must be a non-empty string');
          if (msg.text.length > 1000) throw new Error('"text" is too long');
          if (msg.wpm !== undefined && (typeof msg.wpm !== 'number' || !Number.isFinite(msg.wpm))) throw new Error('"wpm" must be a number if provided');
          // Like SEND_TTY, this only starts it; progress arrives as EVENT.CW_TX_STATUS (see cw-tx-bridge.js).
          this.emit('cw-send', { text: msg.text, wpm: msg.wpm });
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.ABORT_CW: {
          this.emit('cw-abort');
          ws.send(makeResult(id, { accepted: true }));
          break;
        }
        case REQUEST.ABORT_TTY: {
          this.emit('tty-abort');
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
          // is just a mirror of it, same pattern as ft8Active above.
          this.state.freeDvActive = msg.active;
          // Handled by RadeBridge (internal-only event, same pattern as
          // 'ft8-active' above) rather than called directly, since
          // ControlServer has no reference to it — see
          // src/server/rade-bridge.js.
          this.emit('freedv-active', msg.active);
          ws.send(makeResult(id, { active: msg.active }));
          this._broadcastAppModes(ws);
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
        case REQUEST.GET_ALC: {
          const value = await this.civ.getAlc();
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
    if (LIVE_FRAME_TYPES.has(buffer[0])) this.sendLive(ws, buffer);
    else if (ws.readyState === ws.OPEN) ws.send(buffer);
  }

  /** Send a raw binary payload to all clients except `except`. */
  broadcastBinary(buffer, except) {
    const live = LIVE_FRAME_TYPES.has(buffer[0]);
    for (const client of this.clients) {
      if (client === except) continue;
      if (live) this.sendLive(client, buffer);
      else if (client.readyState === client.OPEN) client.send(buffer);
    }
  }

  /**
   * Sends a live frame (audio, scope, spectrum) to one browser unless it
   * is too far behind (see LIVE_BACKLOG_BYTES). Once over its limit it
   * skips live frames until its backlog is under a quarter of the limit,
   * so it doesn't flip on and off each frame. One log line when it starts
   * skipping and one when it catches up. Returns whether it was sent.
   */
  sendLive(ws, buffer) {
    if (ws.readyState !== ws.OPEN) return false;
    const limit = this._liveLimit.get(ws) ?? this.liveBacklogBytes.pcm;
    const backlog = ws.bufferedAmount;
    const lag = this._lagging.get(ws);
    if (lag) {
      if (backlog > limit / 4) {
        lag.dropped++;
        return false;
      }
      this._lagging.delete(ws);
      console.log(`[ws] a browser caught up after ${((Date.now() - lag.since) / 1000).toFixed(1)} s; ${lag.dropped} audio/scope frames were skipped`);
    } else if (backlog > limit) {
      this._lagging.set(ws, { since: Date.now(), dropped: 1 });
      console.warn(`[ws] a browser is falling behind (${Math.round(backlog / 1024)} kB waiting); skipping its audio and scope frames until it catches up`);
      return false;
    }
    ws.send(buffer);
    return true;
  }

  /** Whether `ws` is skipping live frames because it is behind. */
  isLagging(ws) {
    return this._lagging.has(ws);
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
  async setPttFromServer(on, { except, owner, urgent = false } = {}) {
    if (on) {
      // Never key up in the middle of putting settings back.
      await this._restoreChain;
      if (this._receiveHolds.size) throw new Error(RECEIVE_NOT_CONFIRMED);
      // From here the radio may be transmitting, even if the answer is lost.
      this._rxConfirmed = false;
      this.refreshTransmitting();
    }
    try {
      await this.civ.setPtt(on, { urgent });
    } catch (err) {
      this.refreshTransmitting();
      throw err;
    }
    this.state.ptt = on;
    if (!on) this._confirmedReceive();
    // `owner`: the browser that keyed it (REQUEST.SET_PTT); none when a bridge keyed it.
    this._pttOwner = on ? owner ?? null : null;
    this._armOrClearPttWatchdog(on);
    this._broadcast(makeEvent(EVENT.PTT, { value: on }), except);
    this.emit('ptt', on);
    // The browser went while the radio was being keyed: unkey now.
    if (on && owner && !this.clients.has(owner) && !this.externalClients.has(owner)) this._releasePttIfOwnerGone(owner);
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
    this._pttOwner = null;
    try {
      await this.civ.setPtt(false, { urgent: true });
    } catch (err) {
      // Tell every browser, keep PTT shown as on (the radio may still be
      // transmitting) and try again shortly: claiming the radio released
      // when it didn't say so would let features put settings back, or
      // start again, on a live transmitter.
      this._broadcast(makeEvent(EVENT.RIG_ERROR, { message: `PTT watchdog fired but the force-off failed: ${err.message}. Trying again; check the radio.` }));
      this._pttWatchdogTimer = setTimeout(() => this._onPttWatchdogTimeout(), WATCHDOG_RETRY_MS);
      return;
    }
    this.state.ptt = false;
    this._confirmedReceive();
    this._broadcast(makeEvent(EVENT.PTT_TIMEOUT, { pttWatchdogMs: this.pttWatchdogMs }));
    this._broadcast(makeEvent(EVENT.PTT, { value: false }));
    this.emit('ptt', false); // internal, server-side-only — see the SET_PTT handler's matching emission
  }

  /**
   * Unkeys the radio and reports whether the radio confirmed it: true once
   * a PTT-off is acknowledged, false if PTT_RELEASE_ATTEMPTS tries were all
   * rejected or unanswered. Then PTT stays shown as on (the radio may still
   * be transmitting), every browser is told, and the watchdog stays armed.
   * Features use this to end a transmission: they must not report it
   * released, or put settings back directly, unless it returns true (see
   * restoreWhenReceiving()).
   */
  async releasePtt({ attempts = PTT_RELEASE_ATTEMPTS, retryMs = PTT_RELEASE_RETRY_MS } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.setPttFromServer(false, { urgent: true });
        return true;
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    const message = `PTT release not confirmed: the radio may still be transmitting (${lastErr?.message || 'no answer'}). Check the radio.`;
    console.error(`[ptt] ${message}`);
    this._broadcast(makeEvent(EVENT.RIG_ERROR, { message }));
    this.refreshTransmitting();
    return false;
  }

  /** Whether the radio's last answer was that it is unkeyed (see _rxConfirmed). */
  get receiveConfirmed() {
    return this._rxConfirmed && !this.state.ptt && this._receiveHolds.size === 0;
  }

  /** Autonomous keyers must confirm actual RX, independently of a PTT-off ACK. */
  holdReceiveConfirmation(owner) {
    this._receiveHolds.add(owner);
    this.refreshTransmitting();
  }

  /** The autonomous transmitter has read back a stable receive state. */
  confirmReceive(owner) {
    if (this._receiveHolds.delete(owner)) this._confirmedReceive();
    return this._restoreChain;
  }

  /**
   * Puts settings back after a transmission, but only on a radio confirmed
   * unkeyed. `restore({held})` runs now if it is (resolving true once it
   * has run), or is held until the next confirmed PTT-off (resolving false
   * at once, so the caller isn't stuck). Restores run one at a time, in the
   * order given, and a key-up waits for any running one. A held restore is
   * passed {held: true}: a setting may have been changed by hand while it
   * waited, so it should check the radio still has the value the feature
   * set before putting the old one back (see tx-safety.js's settingStillIs()).
   */
  async restoreWhenReceiving(restore) {
    if (this.receiveConfirmed) {
      await this._runRestore(restore, false);
      return true;
    }
    this._heldRestores.push(restore);
    console.warn('[ptt] holding a settings restore until the radio confirms it has stopped transmitting');
    return false;
  }

  _runRestore(restore, held) {
    const run = this._restoreChain.then(() => restore({ held }));
    this._restoreChain = run.catch((err) => {
      console.error('[ptt] restoring settings after a transmission failed:', err.message);
      this._broadcast(makeEvent(EVENT.RIG_ERROR, { message: `Couldn't put a setting back after transmitting: ${err.message}` }));
    });
    return run;
  }

  /** PTT-off or autonomous RX was confirmed. Runs restores once all holds clear. */
  _confirmedReceive() {
    this._rxConfirmed = true;
    if (this.receiveConfirmed) {
      const held = this._heldRestores.splice(0);
      for (const restore of held) this._runRestore(restore, true).catch(() => {});
    }
    this.refreshTransmitting();
  }

  /**
   * Whether the radio is, or may be, transmitting: PTT on, an unconfirmed
   * release, the CW paddle keying, or CW text being sent by the radio's
   * keyer. Radio settings can't be changed meanwhile (RADIO_SETTING_REQUESTS).
   */
  get transmitting() {
    return !!(this.state.ptt || !this._rxConfirmed || this._receiveHolds.size || this.state.cwKeying || this.cwTxBusy?.());
  }

  /** Re-checks `transmitting` and tells every browser if it changed (EVENT.TRANSMITTING). Features that key without PTT call this. */
  refreshTransmitting() {
    const now = this.transmitting;
    this.state.transmitting = now;
    if (now === this._lastTransmitting) return;
    this._lastTransmitting = now;
    this._broadcast(makeEvent(EVENT.TRANSMITTING, { active: now }));
  }

  /** Whether request `type` would change a radio setting or the app mode (refused while transmitting). */
  _changesSetting(type, msg) {
    if (RADIO_SETTING_REQUESTS.has(type)) return true;
    const key = APP_MODE_REQUESTS.get(type);
    return key !== undefined && !!msg.active !== !!this.state[key];
  }

  close() {
    clearTimeout(this._notesIdleTimer);
    clearTimeout(this._notesEmptyTimer);
    if (this._pttWatchdogTimer) {
      clearTimeout(this._pttWatchdogTimer);
      this._pttWatchdogTimer = null;
    }
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
    return new Promise((resolve) => {
      for (const client of this.clients) client.terminate();
      this.wss.close(() => this.httpServer.close(() => resolve()));
    });
  }
}

module.exports = { ControlServer, TRANSMITTING_REFUSAL, RECEIVE_NOT_CONFIRMED, RADIO_SETTING_REQUESTS, originAllowed, parseAllowedOrigins, HEARTBEAT_MS, MAX_MESSAGE_BYTES, MAX_FREQUENCY_HZ, LIVE_BACKLOG_BYTES, LIVE_FRAME_TYPES };
