'use strict';

const DEFAULT_HOST = 'https://qso.freedv.org';

/**
 * Reports this station's FreeDV activity to the FreeDV Reporter service
 * (https://qso.freedv.org) — the live map/station-list other FreeDV
 * operators use to see who's active and on what frequency, the FreeDV
 * equivalent of what PSK Reporter is for FT8 (see src/audio/psk-reporter.js).
 *
 * **Protocol.** FreeDV Reporter's server is a Socket.IO v4 service; there's
 * no official written API spec, so this was built against a third-party
 * client's own reverse-engineered documentation of it (`Reporter_api.md`
 * from github.com/peterbmarks/radae_decoder, itself sourced from the
 * server's own `https://bitbucket.org/tmiw/freedv-reporter` repo) rather
 * than guessing. Connects with role `'report_wo'` — "reports but cannot
 * view others" (the same role ezDV uses) — since this app has no
 * station-list UI of its own and has no use for the (fairly chatty)
 * stream of every other station's own connects/disconnects/frequency
 * changes/chat that the `'report'` role would also receive.
 *
 * **When it connects/disconnects.** Only while a client has the FreeDV
 * chip armed (`SET_FREEDV_ACTIVE`, i.e. `controlServer`'s 'freedv-active'
 * event) *and* the "FreeDV spot" checkbox is checked
 * (`SET_FREEDV_SPOT_ENABLED`, i.e. 'freedv-spot-enabled' — off by default,
 * see this class's own `_spotEnabled` doc comment for why, unlike PSK
 * Reporter's own always-on-by-default "PSK Spot" checkbox). This
 * intentionally covers *both* variants ('700E' and 'RADE'), not just
 * 'RADE': from another operator's point of view "this station is on
 * FreeDV" is true either way (the radio's own USB + DATA MODE state is
 * identical for both — see src/client/app.js's enterFreeDvMode()), even
 * though only 'RADE' actually has a codec wired up server-side (see
 * rade-bridge.js). Disarming FreeDV, leaving it for CW/RTTY/FT8/a plain
 * hardware mode, or unchecking "FreeDV spot" mid-session all disconnect
 * cleanly rather than leaving a stale/ghost entry on the live map.
 *
 * **What gets reported, and when:**
 *   - `freq_change` — on connect (if a frequency is already known) and on
 *     every subsequent `controlServer` 'frequency' event while connected.
 *   - `tx_report` — on connect, and again on every 'ptt' or 'freedv-variant'
 *     change while connected, carrying the current variant as `mode` and
 *     PTT state as `transmitting`.
 *   - `message_update` — on connect (whatever the last-set message was,
 *     including '' if none) and again on every `REQUEST.SET_FREEDV_MESSAGE`
 *     (the internal 'freedv-message' event) while connected — standing
 *     state (`ControlServer.state.freeDvMessage`), not a one-off spot.
 *
 * **No callsign/grid, or "FreeDV spot" unchecked: no connection at all.**
 * Missing callsign/grid is the same precondition PSK Reporter has (see
 * psk-reporter.js) — FreeDV Reporter's own auth rejects a
 * `'report'`/`'report_wo'` connection missing either field, and reporting
 * "an anonymous station" has no meaning to other operators anyway. The
 * checkbox is this project's own choice, per the original request
 * ("[the checkbox] should be unselected by default") — unlike PSK
 * Reporter, which reports automatically whenever a callsign/grid are
 * configured, FreeDV Reporter registration requires the operator to
 * explicitly opt in each time, since it's arguably more identifying
 * (frequency + live TX/RX state, not just occasional decoded spots).
 *
 * **Genuinely unverified.** No access to the real qso.freedv.org service
 * from wherever this was written/reviewed — this has been checked against
 * the third-party protocol doc above, and exercised in tests against an
 * injected fake Socket.IO client (see test/freedv-reporter.test.js), but
 * never against the real service. If this station doesn't show up on
 * https://qso.freedv.org after arming FreeDV with STATION_CALLSIGN/
 * STATION_GRID configured, check the server console for
 * `[freedv-reporter]` connect-error logging first.
 */
class FreeDvReporterBridge {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {string|null} [opts.callsign] - this station's callsign (STATION_CALLSIGN); reporting is
   *   entirely disabled (never connects) while this or gridSquare is unset, same as PSK Reporter.
   * @param {string|null} [opts.gridSquare] - Maidenhead grid locator (STATION_GRID); only the first
   *   6 characters are sent, matching freedv-gui's own behavior.
   * @param {string} [opts.version] - free-text version string sent in the auth payload
   * @param {string} [opts.radeVersion] - 'v1'/'v2', matching this server's own RADE_VERSION —
   *   used to report the RADE variant as 'RADEV1'/'RADEV2' (see _reportedMode()'s doc comment
   *   for why the plain variant name alone isn't enough)
   * @param {boolean} [opts.rxOnly] - whether this station can only receive, never transmit
   * @param {string} [opts.os] - 'windows'/'linux'/'macos'/''; defaults to detecting from process.platform
   * @param {string} [opts.host] - FreeDV Reporter server URL; defaults to the real public service
   * @param {Function} [opts.socketFactory] - injectable for testing; defaults to `socket.io-client`'s
   *   `io(url, opts)`. Must return an object with `.on(event, cb)`, `.emit(event, data)`, and
   *   `.disconnect()`, matching a real Socket.IO client Socket.
   */
  constructor({
    controlServer,
    callsign,
    gridSquare,
    version,
    radeVersion,
    rxOnly,
    os,
    host,
    socketFactory,
  }) {
    if (!controlServer) throw new Error('FreeDvReporterBridge requires opts.controlServer');
    this.controlServer = controlServer;
    this.callsign = callsign || null;
    this.gridSquare = gridSquare ? gridSquare.slice(0, 6) : null;
    this.version = version || 'unknown';
    this.radeVersion = radeVersion === 'v2' ? 'v2' : 'v1'; // mirrors index.js's own RADE_VERSION default
    this.rxOnly = !!rxOnly;
    this.os = os ?? detectOs();
    this.host = host || DEFAULT_HOST;
    this._socketFactory = socketFactory ?? defaultSocketFactory;

    this._socket = null;
    this._connected = false;
    this._active = false;
    this._variant = 'RADE'; // mirrors controlServer.state.freeDvVariant's own default — see its doc comment in ws-server.js
    this._pttActive = false;
    // Seeded from the already-known frequency (if any) rather than left
    // null and waiting for the next 'frequency' event: `controlServer`
    // primes `state.frequency` from the radio during its own listen()
    // (see ws-server.js), and this bridge is constructed only after that
    // resolves — but it doesn't itself emit a 'frequency' event for that
    // priming, so without this, the very first freq_change this bridge
    // ever sends would otherwise have to wait for the operator to change
    // frequency, and FreeDV Reporter shows "0.0000 MHz" in the meantime.
    this._freqHz = this.controlServer.state?.frequency ?? null;
    // The "FreeDV spot" checkbox — off by default per the original
    // request (reporting your callsign/grid/frequency to a third-party
    // service should be opt-in, unlike PSK Reporter's own "PSK Spot"
    // checkbox, which defaults on — see ws-server.js's own
    // state.freeDvSpotEnabled doc comment). Kept as a separate field
    // here, updated via the 'freedv-spot-enabled' event, the same
    // event-based pattern Ft8Bridge's own `_pskSpotEnabled` uses rather
    // than reading controlServer.state directly.
    this._spotEnabled = false;
    // Freeform FreeDV Reporter status message — see this class's own
    // 'message_update' doc comment above and ControlServer.state.freeDvMessage's
    // doc comment in ws-server.js. Seeded from whatever's already cached
    // there for the same "don't wait for the next change event" reason
    // _freqHz is seeded above.
    this._message = this.controlServer.state?.freeDvMessage || '';

    this._onActive = (active) => this.setActive(active);
    this._onVariant = (variant) => this.setVariant(variant);
    this._onPtt = (on) => this._handlePtt(on);
    this._onFrequency = (hz) => this._handleFrequency(hz);
    this._onSpotEnabled = (enabled) => this.setSpotEnabled(enabled);
    this._onMessage = (message) => this.setMessage(message);

    this.controlServer.on('freedv-active', this._onActive);
    this.controlServer.on('freedv-variant', this._onVariant);
    this.controlServer.on('ptt', this._onPtt);
    this.controlServer.on('frequency', this._onFrequency);
    this.controlServer.on('freedv-spot-enabled', this._onSpotEnabled);
    this.controlServer.on('freedv-message', this._onMessage);
  }

  /** No async setup needed — exists for symmetry with the other bridges' start()/stop() lifecycle. */
  start() {}

  /** Disconnects (if connected) and stops listening — call on server shutdown. */
  stop() {
    this._disconnect();
    this.controlServer.off('freedv-active', this._onActive);
    this.controlServer.off('freedv-variant', this._onVariant);
    this.controlServer.off('ptt', this._onPtt);
    this.controlServer.off('frequency', this._onFrequency);
    this.controlServer.off('freedv-spot-enabled', this._onSpotEnabled);
    this.controlServer.off('freedv-message', this._onMessage);
  }

  /**
   * True only once a callsign and grid square are configured AND the
   * "FreeDV spot" checkbox is checked — see this class's own doc comment
   * on why the latter defaults to false (opt-in, not opt-out).
   */
  get _enabled() {
    return !!(this.callsign && this.gridSquare && this._spotEnabled);
  }

  /** Arms/disarms reporting — the server-side effect of the client's FreeDV chip (mirrors RadeBridge#setActive). */
  setActive(active) {
    this._active = active;
    if (active && this._enabled) this._connect();
    else this._disconnect();
  }

  /**
   * The "FreeDV spot" checkbox. Connects immediately if FreeDV is already
   * armed and this just turned reporting on; disconnects immediately if
   * it just turned off, even mid-session, rather than waiting for the
   * next arm/disarm — a station unchecking this box while already
   * reporting almost certainly wants that to take effect right away.
   */
  setSpotEnabled(enabled) {
    this._spotEnabled = enabled;
    if (this._active && this._enabled) this._connect();
    else this._disconnect();
  }

  /** Switches which variant ('700E'/'RADE') is reported as this station's current mode. */
  setVariant(variant) {
    this._variant = variant;
    if (this._connected) this._sendTxReport();
  }

  /**
   * Updates the freeform FreeDV Reporter status message (the UI's
   * message field). Sent immediately if already connected; otherwise
   * just cached and sent on the next connect, same as `_freqHz`/
   * `_variant` above. Empty string clears it — matches
   * `message_update`'s own documented behavior, see this class's doc
   * comment.
   */
  setMessage(message) {
    this._message = message || '';
    if (this._connected) this._sendMessageUpdate();
  }

  _handlePtt(on) {
    this._pttActive = on;
    if (this._connected) this._sendTxReport();
  }

  _handleFrequency(hz) {
    this._freqHz = hz;
    if (this._connected) this._sendFreqChange();
  }

  _connect() {
    if (this._socket) return;
    this._socket = this._socketFactory(this.host, {
      path: '/socket.io/',
      transports: ['websocket'],
      auth: {
        role: 'report_wo',
        callsign: this.callsign,
        grid_square: this.gridSquare,
        version: this.version,
        rx_only: this.rxOnly,
        os: this.os,
      },
    });

    this._socket.on('connect', () => {
      this._connected = true;
      this._sendFreqChange();
      this._sendTxReport();
      // Always sent, even when `_message` is '' — an operator who set a
      // message, disarmed FreeDV, then re-armed should see it restored,
      // and an explicitly-cleared message should actually clear rather
      // than leaving a stale one on the FreeDV Reporter side from a
      // previous connection.
      this._sendMessageUpdate();
    });
    this._socket.on('disconnect', () => {
      this._connected = false;
    });
    this._socket.on('connect_error', (err) => {
      console.error('[freedv-reporter] connect error:', err.message);
    });
  }

  _disconnect() {
    this._connected = false;
    if (!this._socket) return;
    try {
      this._socket.disconnect();
    } catch {
      // already disconnected — nothing to do
    }
    this._socket = null;
  }

  _sendFreqChange() {
    if (this._freqHz == null) return;
    this._emit('freq_change', { freq: this._freqHz });
  }

  _sendTxReport() {
    this._emit('tx_report', { mode: this._reportedMode(), transmitting: this._pttActive });
  }

  _sendMessageUpdate() {
    this._emit('message_update', { message: this._message });
  }

  /**
   * The mode string sent as `tx_report`'s `mode` field. For 'RADE', this
   * needs to disambiguate *which* RADE waveform is in use — 'RADEV1' or
   * 'RADEV2' — rather than the bare 'RADE' this._variant holds, since a
   * receiving FreeDV Reporter user (or a station scanning the map to see
   * who to call) can't otherwise tell whether this station is on the
   * stable V1 waveform or the still-experimental V2 one (see RADE_VERSION
   * in index.js and rade-bridge.js's own doc comment on why the two
   * aren't interoperable). '700E' has no version split, so it's reported
   * as-is.
   */
  _reportedMode() {
    if (this._variant === 'RADE') return `RADE${this.radeVersion.toUpperCase()}`;
    return this._variant;
  }

  _emit(event, payload) {
    if (!this._socket) return;
    try {
      this._socket.emit(event, payload);
    } catch (err) {
      console.error(`[freedv-reporter] failed to send ${event}:`, err.message);
    }
  }
}

/** 'windows'/'linux'/'macos'/'' from Node's own process.platform, matching the auth payload's `os` field options. */
function detectOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return '';
}

function defaultSocketFactory(url, opts) {
  // Required lazily (not at module load) so this module has no effect on
  // any test that never actually connects, and so a missing/broken
  // socket.io-client install can't break unrelated server startup paths.
  const { io } = require('socket.io-client');
  return io(url, opts);
}

module.exports = { FreeDvReporterBridge };
