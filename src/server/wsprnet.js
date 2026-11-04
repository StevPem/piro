'use strict';

/**
 * Uploads WSPR spots to wsprnet.org, the way WSJT-X does
 * (Network/wsprnet.cpp): one form-encoded POST to /post/ per spot
 * ("function=wspr"), or one "function=wsprstat" report when a slot
 * decoded nothing, so the map still shows the station as listening.
 *
 * WSJT-X posts over plain HTTP (http://wsprnet.org/post/, still so in its
 * current source). PiRO tries HTTPS first and falls back to HTTP only if
 * wsprnet.org clearly didn't take the HTTPS request: the connection or TLS
 * failed, or it answered with a redirect or a 4xx error. A timeout or 5xx
 * is not a reason to fall back, since the spot may already have been
 * taken and would be posted twice. The choice is kept until PiRO
 * restarts and logged once. Spots are public, so HTTP is a small risk;
 * HTTPS keeps them from being altered on the way.
 */

const http = require('node:http');
const https = require('node:https');
const { CONNECT_OPTIONS } = require('./net-options');

const WSPRNET_URL = 'https://wsprnet.org/post/';
const WSPRNET_HTTP_URL = 'http://wsprnet.org/post/';

// Connection and TLS failures: the request never reached wsprnet.org's form handler.
const NOT_TAKEN_CODES = new Set(['ECONNREFUSED', 'EPROTO', 'EHOSTUNREACH', 'ENETUNREACH']);
const NOT_TAKEN_PREFIXES = ['ERR_TLS_', 'ERR_SSL_', 'CERT_', 'UNABLE_TO_', 'DEPTH_ZERO_', 'SELF_SIGNED_'];

/** Whether a failed HTTPS post certainly wasn't taken, so HTTP may be tried without posting twice. */
function httpsNotTaken(err) {
  if (err && Number.isInteger(err.statusCode)) return err.statusCode >= 300 && err.statusCode < 500;
  const code = String(err?.code || '');
  return NOT_TAKEN_CODES.has(code) || NOT_TAKEN_PREFIXES.some((p) => code.startsWith(p));
}

/** yymmdd and hhmm (UTC) for a slot start. */
function slotDateTime(slotStartMs) {
  const d = new Date(slotStartMs);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`,
  };
}

const mhz = (hz) => (hz / 1e6).toFixed(6);

/**
 * The form bodies for one slot.
 * @param {object} r
 * @param {string} r.rcall - our callsign
 * @param {string} r.rgrid - our grid
 * @param {number} r.dialHz - the radio's dial frequency
 * @param {number} r.slotStartMs
 * @param {Array} r.decodes - from wspr-rx.js (snr, dt, drift, audioHz, callsign, grid, dbm, type)
 * @param {number} [r.tpct=0] - our transmit percentage
 * @param {number} [r.txHz=1500] - our transmit audio frequency
 * @param {number} [r.dbm=0] - our transmit power
 * @param {string} [r.version]
 */
function spotBodies({ rcall, rgrid, dialHz, slotStartMs, decodes, tpct = 0, txHz = 1500, dbm = 0, version = 'PiRO' }) {
  const common = { rcall, rgrid, rqrg: mhz(dialHz), version, mode: '2' };
  const enc = (obj) => new URLSearchParams(obj).toString();
  const spots = decodes.filter((d) => d.callsign);
  if (spots.length === 0) {
    return [enc({ function: 'wsprstat', rcall, rgrid, rqrg: mhz(dialHz), tpct: String(tpct), tqrg: mhz(dialHz + txHz), dbm: String(dbm), version, mode: '2' })];
  }
  const { date, time } = slotDateTime(slotStartMs);
  return spots.map((d) =>
    enc({
      function: 'wspr',
      date,
      time,
      sig: String(d.snr),
      dt: d.dt.toFixed(1),
      drift: String(d.drift),
      tqrg: mhz(dialHz + d.audioHz),
      tcall: d.callsign,
      tgrid: d.grid || '',
      dbm: String(d.dbm),
      ...common,
    })
  );
}

function httpPost(body, { url = WSPRNET_URL, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(
      url,
      { method: 'POST', ...CONNECT_OPTIONS, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on('end', () =>
          res.statusCode >= 200 && res.statusCode < 300
            ? resolve()
            : reject(Object.assign(new Error(`wsprnet.org answered ${res.statusCode}`), { statusCode: res.statusCode }))
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('wsprnet.org did not answer')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Posts slots one at a time, in order. A slot that fails is dropped (the next slot is more useful than a retry). */
class WsprNetClient {
  constructor({ post = httpPost, log = console } = {}) {
    this.post = post;
    this.log = log;
    this._chain = Promise.resolve();
    this.scheme = null; // 'https' or 'http' once one has worked; null: try HTTPS first
  }

  /** Posts one body over HTTPS, or HTTP if wsprnet.org didn't take HTTPS (see the top of this file). */
  async _post(body) {
    if (this.scheme === 'http') return this.post(body, { url: WSPRNET_HTTP_URL });
    try {
      await this.post(body, { url: WSPRNET_URL });
      if (this.scheme !== 'https') {
        this.scheme = 'https';
        this.log.log('wsprnet.org: uploading spots over HTTPS.');
      }
    } catch (err) {
      if (this.scheme === 'https' || !httpsNotTaken(err)) throw err;
      await this.post(body, { url: WSPRNET_HTTP_URL });
      this.scheme = 'http';
      this.log.warn(`wsprnet.org didn't take HTTPS (${err.code || err.message}); uploading spots over HTTP, as WSJT-X does.`);
    }
  }

  /** @returns {Promise<{sent:number, error?:string}>} */
  upload(slot) {
    const bodies = spotBodies(slot);
    const run = async () => {
      let sent = 0;
      try {
        for (const body of bodies) {
          await this._post(body);
          sent++;
        }
        return { sent, spots: bodies.length };
      } catch (err) {
        return { sent, spots: bodies.length, error: err.message };
      }
    };
    const p = this._chain.then(run);
    this._chain = p.catch(() => {});
    return p;
  }
}

module.exports = { WsprNetClient, spotBodies, slotDateTime, httpsNotTaken, WSPRNET_URL, WSPRNET_HTTP_URL };
