'use strict';

const { EVENT, BINARY_TYPE } = require('./protocol');
const { SCOPE_MODE } = require('../civ/commands');

// Must match the SCOPE_MODE values in src/civ/commands.js.
const CENTER_LIKE_MODES = new Set([0x00, 0x02]); // Center, Scroll-C

/**
 * Listens for 'scope-line' events from a CivDriver and broadcasts each
 * one to every connected WebSocket client as a tagged binary frame (see
 * BINARY_TYPE.SCOPE_LINE in protocol.js). Server->client only — clients
 * never send scope data upstream.
 *
 * Wire format (all multi-byte fields little-endian):
 *   byte[0]     BINARY_TYPE.SCOPE_LINE
 *   byte[1]     mode (see src/civ/commands.js SCOPE_MODE)
 *   byte[2]     mainSub (0=main, 1=sub)
 *   byte[3:7]   freqA as UInt32LE — centerFreq (center/scroll-c modes) or
 *               startFreq (fixed/scroll-f modes)
 *   byte[7:11]  freqB as UInt32LE — span (center/scroll-c) or endFreq (fixed/scroll-f)
 *   byte[11]    extra — inRange (0/1) for fixed/scroll-f modes, 0xFF (n/a) otherwise
 *   byte[12:]   points — raw amplitude sample bytes, one per pixel
 *
 * A fixed 12-byte header (rather than a variable-length one) keeps
 * client-side parsing simple — no conditional offset math needed. The
 * client-side decoder mirrors this exactly in src/client/rpc.js; keep
 * both in sync if this format changes.
 */
class ScopeBridge {
  /**
   * @param {object} opts
   * @param {import('../civ/driver').CivDriver} opts.civ
   * @param {import('./ws-server').ControlServer} opts.controlServer
   */
  constructor({ civ, controlServer }) {
    if (!civ) throw new Error('ScopeBridge requires opts.civ');
    if (!controlServer) throw new Error('ScopeBridge requires opts.controlServer');
    this.civ = civ;
    this.controlServer = controlServer;

    this._onLine = (line) => this._broadcastLine(line);
    this.civ.on('scope-line', this._onLine);
  }

  _broadcastLine(line) {
    try {
      this.controlServer.broadcastBinary(encodeScopeLine(line));
    } catch (err) {
      console.error('[scope]', err.message);
      this.controlServer.broadcastJsonEvent(EVENT.SCOPE_ERROR, { message: err.message });
    }
  }

  /**
   * Enables scope output on the radio, switches it to Center mode, and
   * starts broadcasting lines. Deliberately does NOT set a span here.
   *
   * This has now failed at startup twice, for two different reasons: an
   * earlier wrong wire format made span-setting slow/unreliable enough to
   * delay everything after it (audio included), and even after the wire
   * format was corrected and verified against a real worked example, the
   * radio still rejected (NG) a span-set attempted immediately after
   * enabling scope output — root cause unconfirmed (could be a genuine
   * settling-time requirement in the radio's scope subsystem, could be
   * something else). Rather than keep guessing at server-startup
   * sequencing on hardware this project has no direct access to, span is
   * simply not set here at all anymore. The client requests a default
   * span itself once it's already connected (see app.js) — happening
   * naturally later, well after enable, with the WS round-trip and page
   * load already providing whatever settling time might be needed — and
   * any failure there only affects that one request (surfaced as an
   * error toast), never server health or anything else. Setting mode
   * alone is simple, low-risk, and was never implicated in the failures
   * above — kept here since Center mode's displayed center then
   * automatically tracks the VFO with no further commands needed.
   */
  async start() {
    await this.civ.enableScopeOutput();
    await this.civ.setScopeMode(SCOPE_MODE.CENTER);
  }

  /** Disables scope output on the radio and stops listening for lines. */
  async stop() {
    this.civ.off('scope-line', this._onLine);
    try {
      await this.civ.disableScopeOutput();
    } catch {
      // best-effort on shutdown
    }
  }
}

function encodeScopeLine(line) {
  const header = Buffer.alloc(12);
  header[0] = BINARY_TYPE.SCOPE_LINE;
  header[1] = line.mode;
  header[2] = line.mainSub;

  if (CENTER_LIKE_MODES.has(line.mode)) {
    header.writeUInt32LE(line.centerFreq >>> 0, 3);
    header.writeUInt32LE(line.span >>> 0, 7);
    header[11] = 0xff;
  } else {
    header.writeUInt32LE(line.startFreq >>> 0, 3);
    header.writeUInt32LE(line.endFreq >>> 0, 7);
    header[11] = line.inRange ? 0x01 : 0x00;
  }

  return Buffer.concat([header, line.points]);
}

module.exports = { ScopeBridge, encodeScopeLine };
