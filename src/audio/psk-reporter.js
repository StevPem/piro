'use strict';

/**
 * Real UDP client for reporting decoded FT8 stations to the PSK Reporter
 * propagation-reporting service (pskreporter.info) — the "PSK Spot"
 * checkbox in the FT8 UI (see docs/ui-notes.md) turns this on/off.
 *
 * Wire format: PSK Reporter's protocol is IPFIX (RFC 5101/7011)-based.
 * The official developer page (pskreporter.info/pskdev.html) only
 * describes it in prose and doesn't give a byte-level spec, so this was
 * reverse-engineered instead from a real, actively-used, open-source
 * reference client — WSJT-X/JTDX's own `PSK_Reporter` class
 * (psk_reporter.cpp, GPL) — read in full and transcribed field-by-field.
 * Every template ID, field ID, and enterprise number below comes
 * directly from that source, not from guessing:
 *
 *   - Enterprise number 0x0000768F (30351) is PSK Reporter's own IANA
 *     Private Enterprise Number, used on every non-standard field.
 *   - The "Rx Info" Options Template (Set ID 0x0003, Template ID
 *     0x50E2) describes the *receiving* station: call, grid, decoding
 *     software ("Rx Soft"), and antenna, each a variable-length
 *     enterprise field.
 *   - The "Tx Info" Template (Set ID 0x0002, Template ID 0x50E3)
 *     describes each *heard* station: call, frequency (Hz, fixed 4
 *     bytes), SNR (signed, fixed 1 byte), mode, grid, a constant
 *     "info source" byte (1 = REPORTER_SOURCE_AUTOMATIC), and a
 *     standard (non-enterprise) IPFIX field 150 ("flowStartSeconds")
 *     reused as the report's Unix-seconds timestamp.
 *   - Both templates are followed by matching Data Sets carrying the
 *     actual values: enterprise string fields are a 1-byte length
 *     prefix + raw UTF-8 bytes; the whole packet is IPFIX Message
 *     Header (16 bytes: version, total length, export time, sequence
 *     number, a random "observation domain" ID chosen once at startup)
 *     + both template sets + both data sets.
 *
 * Rate limits, per pskreporter.info: send at most once every 5 minutes,
 * reuse the same UDP source port across sends, and resend the template
 * descriptors with at least the first few packets (or at least once an
 * hour). This client follows the reference implementation's
 * simplest-safe choice — sending both template sets with *every* report
 * packet — and batches whatever spots were queued into one packet every
 * REPORT_INTERVAL_MS (5 minutes, matching the reference and the stated
 * limit), rather than sending one packet per decode.
 *
 * NOTE on verification: the packet-building logic here has been checked
 * byte-for-byte against the reference implementation's own hex-building
 * code (see test/psk-reporter.test.js), but has NOT yet been separately
 * confirmed against the real pskreporter.info service — that service
 * gives no error feedback at all for a malformed packet, it simply never
 * shows the spot. The only real way to confirm this end-to-end is to
 * check the configured STATION_CALLSIGN actually appears on
 * pskreporter.info's live map after a real FT8 decode with PSK Spot
 * enabled.
 */

const dgram = require('dgram');

const PSK_REPORTER_HOST = 'report.pskreporter.info';
const PSK_REPORTER_PORT = 4739;
const REPORT_INTERVAL_MS = 5 * 60 * 1000; // pskreporter.info's stated "no more than once every 5 minutes" limit
const IPFIX_VERSION = 0x000a;
const RX_TEMPLATE_ID = 0x50e2;
const TX_TEMPLATE_ID = 0x50e3;
const REPORTER_SOURCE_AUTOMATIC = 1;
const DEFAULT_PROG_ID = 'SPARC-PiRO';

// Fixed-format Options/regular Template Sets — see the module doc
// comment above for what each field is. These never change (no operator
// data in them), so they're built once as constant Buffers rather than
// re-assembled per packet.
const RX_TEMPLATE_SET = Buffer.from(
  '0003002C50E200040000' +
    '8002FFFF0000768F' + // 2. Rx Call
    '8004FFFF0000768F' + // 4. Rx Grid
    '8008FFFF0000768F' + // 8. Rx Soft
    '8009FFFF0000768F' + // 9. Rx Antenna
    '0000',
  'hex'
);

const TX_TEMPLATE_SET = Buffer.from(
  '0002003C50E30007' +
    '8001FFFF0000768F' + // 1. Tx Call
    '800500040000768F' + // 5. Tx Freq
    '800600010000768F' + // 6. Tx SNR
    '800AFFFF0000768F' + // 10. Tx Mode
    '8003FFFF0000768F' + // 3. Tx Grid
    '800B00010000768F' + // 11. Tx info src
    '00960004', // standard IE 150 "flowStartSeconds", reused as report time
  'hex'
);

// Heuristic amateur-radio callsign matcher, used to decide whether a
// decoded message's apparent "from" token is really a callsign worth
// spotting, versus one of FT8's many non-callsign tokens (RR73, a bare
// signal report, "..." for an unresolved compound/hashed call, etc.).
// Real callsigns are prefix letters/digits + a digit + suffix letters,
// optionally with a "/PORTABLE"-style suffix — this isn't a strict
// ITU-format validator (see extractSpot()'s doc comment), just good
// enough to reject the common non-callsign tokens confidently.
const CALLSIGN_RE = /^[A-Z0-9]{1,3}\d[A-Z]{1,4}(\/[A-Z0-9]{1,4})?$/;
const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/;

function lengthPrefixedString(str) {
  const utf8 = Buffer.from(str || '', 'utf8');
  const buf = Buffer.alloc(1 + utf8.length);
  buf.writeUInt8(utf8.length, 0);
  utf8.copy(buf, 1);
  return buf;
}

function clampSnrToInt8(snr) {
  const n = Number.isFinite(snr) ? Math.round(snr) : 0;
  return Math.max(-128, Math.min(127, n));
}

/**
 * Extracts "who transmitted this decode, and their grid if they sent
 * one" from a raw decoded FT8 message's text, for PSK Reporter spot
 * purposes. A deliberately simpler, server-side, CommonJS sibling of
 * src/client/ft8-qso.js's parseFt8Message() — that one drives the much
 * richer guided-QSO state machine (report/RRR/RR73/73 tracking), none of
 * which spotting needs; this one only cares about "callsign + optional
 * grid" and returns null for anything else (a bare "CQ" with no call, an
 * RRR/73-only continuation, unrecognized text, etc.).
 * @returns {{call: string, grid: string|null}|null}
 */
function extractSpot(text) {
  const tokens = (text || '')
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;

  let call = null;
  let grid = null;
  if (tokens[0] === 'CQ') {
    if (tokens.length === 2) {
      call = tokens[1];
    } else if (tokens.length >= 3) {
      const last = tokens[tokens.length - 1];
      const hasGrid = GRID_RE.test(last);
      call = hasGrid ? tokens[tokens.length - 2] : tokens[tokens.length - 1];
      grid = hasGrid ? last : null;
    }
  } else if (tokens.length >= 2) {
    call = tokens[1]; // "<toCall> <fromCall> ..."
    const extra = tokens.length >= 3 ? tokens[2] : null;
    // RR73 in particular is a real trap here: its own letters ("RR") fall
    // entirely inside the valid Maidenhead A-R range, so GRID_RE alone
    // would happily (and wrongly) treat it as a locator. Exclude the
    // fixed non-grid tokens explicitly first — same ordering
    // src/client/ft8-qso.js's parseFt8Message() already uses for exactly
    // this reason.
    if (extra && extra !== 'RR73' && extra !== 'RRR' && extra !== '73' && GRID_RE.test(extra)) grid = extra;
  }

  if (!call || !CALLSIGN_RE.test(call)) return null;
  return { call, grid };
}

/** Builds the Rx Info Data Set (this station's own identity) matching RX_TEMPLATE_SET's field order. */
function buildRxInfoDataSet({ rxCall, rxGrid, progId, rxAntenna }) {
  const body = Buffer.concat([
    lengthPrefixedString(rxCall),
    lengthPrefixedString(rxGrid),
    lengthPrefixedString(progId),
    lengthPrefixedString(rxAntenna),
    Buffer.from([0x00, 0x00]),
  ]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(RX_TEMPLATE_ID, 0);
  header.writeUInt16BE(4 + body.length, 2);
  return Buffer.concat([header, body]);
}

/** Builds the Tx Info Data Set (one entry per heard station) matching TX_TEMPLATE_SET's field order. */
function buildTxInfoDataSet(spots) {
  const parts = [];
  for (const spot of spots) {
    const freqBuf = Buffer.alloc(4);
    freqBuf.writeUInt32BE(Math.max(0, Math.round(spot.freqHz || 0)), 0);
    const snrBuf = Buffer.alloc(1);
    snrBuf.writeInt8(clampSnrToInt8(spot.snr), 0);
    const timeBuf = Buffer.alloc(4);
    timeBuf.writeUInt32BE(Math.max(0, Math.round(spot.timeSec || 0)), 0);
    parts.push(
      lengthPrefixedString(spot.call),
      freqBuf,
      snrBuf,
      lengthPrefixedString(spot.mode),
      lengthPrefixedString(spot.grid || ''),
      Buffer.from([REPORTER_SOURCE_AUTOMATIC]),
      timeBuf
    );
  }
  const body = Buffer.concat([...parts, Buffer.from([0x00, 0x00])]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(TX_TEMPLATE_ID, 0);
  header.writeUInt16BE(4 + body.length, 2);
  return Buffer.concat([header, body]);
}

/**
 * Encodes one complete IPFIX report packet: header + both template sets
 * + both data sets. Pure/deterministic given its inputs (no I/O, no
 * clock/random access of its own) so it's directly unit-testable — see
 * test/psk-reporter.test.js.
 * @param {object} opts
 * @param {number} opts.sequenceNumber
 * @param {number} opts.randomId - the "observation domain ID", chosen once at client startup
 * @param {number} opts.exportTimeSec - Unix seconds
 * @param {string} opts.rxCall
 * @param {string} opts.rxGrid
 * @param {string} [opts.progId]
 * @param {string} [opts.rxAntenna]
 * @param {Array<{call: string, grid?: string, freqHz: number, snr: number, mode: string, timeSec: number}>} opts.spots
 * @returns {Buffer}
 */
function encodeReportPacket({ sequenceNumber, randomId, exportTimeSec, rxCall, rxGrid, progId, rxAntenna, spots }) {
  const rxInfoData = buildRxInfoDataSet({ rxCall, rxGrid, progId: progId || DEFAULT_PROG_ID, rxAntenna: rxAntenna || '' });
  const txInfoData = buildTxInfoDataSet(spots);
  const body = Buffer.concat([RX_TEMPLATE_SET, TX_TEMPLATE_SET, rxInfoData, txInfoData]);

  const header = Buffer.alloc(16);
  header.writeUInt16BE(IPFIX_VERSION, 0);
  header.writeUInt16BE(16 + body.length, 2); // total packet length, filled in last
  header.writeUInt32BE(Math.max(0, Math.round(exportTimeSec || 0)), 4);
  header.writeUInt32BE(sequenceNumber >>> 0, 8);
  header.writeUInt32BE(randomId >>> 0, 12);

  return Buffer.concat([header, body]);
}

/**
 * Queues decoded stations and sends them to pskreporter.info in a
 * batched UDP report every REPORT_INTERVAL_MS, same cadence as the
 * WSJT-X/JTDX reference this was modeled on. Every external dependency
 * (the UDP socket, the clock, the random observation-domain ID) is
 * injectable so the batching/encoding logic can be fully unit-tested
 * without a real network — see test/psk-reporter.test.js and this
 * project's other Stub- and Fake-style tests.
 */
class PskReporterClient {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.rxCall] - this station's own callsign (STATION_CALLSIGN); spotting is a no-op while unset, see addSpot()
   * @param {string|null} [opts.rxGrid] - this station's own grid locator (STATION_GRID)
   * @param {string} [opts.progId] - decoding-software identifier sent as "Rx Soft"
   * @param {string} [opts.rxAntenna]
   * @param {{send: Function, close?: Function}} [opts.socket] - injectable for testing; defaults to a real dgram udp4 socket
   * @param {string} [opts.host]
   * @param {number} [opts.port]
   * @param {number} [opts.reportIntervalMs] - injectable for testing
   * @param {Function} [opts.now] - injectable for testing; defaults to Date.now
   * @param {number} [opts.randomId] - injectable for testing; defaults to a random 32-bit value
   */
  constructor({ rxCall, rxGrid, progId, rxAntenna, socket, host, port, reportIntervalMs, now, randomId } = {}) {
    this.rxCall = rxCall || null;
    this.rxGrid = rxGrid || null;
    this.progId = progId || DEFAULT_PROG_ID;
    this.rxAntenna = rxAntenna || '';
    this.host = host || PSK_REPORTER_HOST;
    this.port = port || PSK_REPORTER_PORT;
    this.reportIntervalMs = reportIntervalMs ?? REPORT_INTERVAL_MS;
    this.now = now ?? (() => Date.now());
    this.randomId = randomId ?? Math.floor(Math.random() * 0xffffffff);
    this.socket = socket ?? dgram.createSocket('udp4');
    this._ownsSocket = !socket;
    this._sequenceNumber = 0;
    this._queue = [];
    this._timer = null;
  }

  /**
   * Queues one heard station for the next batched report. A no-op
   * (nothing queued, nothing ever sent) while this station's own
   * callsign isn't configured (STATION_CALLSIGN unset) — PSK Reporter
   * has no meaning without knowing who's doing the receiving, and this
   * app has no other source for that identity (see src/server/index.js).
   * @param {{call: string, grid?: string|null, freqHz: number, snr: number, mode: string, timeSec?: number}} spot
   */
  addSpot({ call, grid, freqHz, snr, mode, timeSec }) {
    if (!this.rxCall) return;
    this._queue.push({
      call,
      grid: grid || null,
      freqHz,
      snr,
      mode,
      timeSec: timeSec ?? Math.floor(this.now() / 1000),
    });
  }

  /** Starts the periodic batched-send timer. Safe to call more than once. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._sendReport(), this.reportIntervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** Stops the timer and closes the socket (if this client created it itself). */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._ownsSocket) {
      try {
        this.socket.close();
      } catch {
        // already closed — nothing to do
      }
    }
  }

  /**
   * Builds and sends one batched report packet for everything queued
   * since the last send; no-ops if nothing is queued, exactly matching
   * the reference implementation (see module doc comment). Exposed
   * (not private) so tests can trigger a send deterministically instead
   * of waiting on the real timer.
   */
  _sendReport() {
    if (this._queue.length === 0) return;
    const spots = this._queue;
    this._queue = [];
    const packet = encodeReportPacket({
      sequenceNumber: ++this._sequenceNumber,
      randomId: this.randomId,
      exportTimeSec: Math.floor(this.now() / 1000),
      rxCall: this.rxCall,
      rxGrid: this.rxGrid,
      progId: this.progId,
      rxAntenna: this.rxAntenna,
      spots,
    });
    this.socket.send(packet, this.port, this.host, (err) => {
      if (err) console.error('[psk-reporter] send failed:', err.message);
    });
  }
}

module.exports = { PskReporterClient, encodeReportPacket, extractSpot, CALLSIGN_RE, GRID_RE };
