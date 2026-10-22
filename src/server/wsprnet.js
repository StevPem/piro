'use strict';

/**
 * Uploads WSPR spots to wsprnet.org, the way WSJT-X does
 * (Network/wsprnet.cpp): one form-encoded POST to
 * http://wsprnet.org/post/ per spot ("function=wspr"), or one
 * "function=wsprstat" report when a slot decoded nothing, so the map
 * still shows the station as listening.
 */

const http = require('node:http');
const { CONNECT_OPTIONS } = require('./net-options');

const WSPRNET_URL = 'http://wsprnet.org/post/';

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
    const req = http.request(
      url,
      { method: 'POST', ...CONNECT_OPTIONS, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`wsprnet.org answered ${res.statusCode}`))));
      }
    );
    req.on('timeout', () => req.destroy(new Error('wsprnet.org did not answer')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Posts slots one at a time, in order. A slot that fails is dropped (the next slot is more useful than a retry). */
class WsprNetClient {
  constructor({ post = httpPost } = {}) {
    this.post = post;
    this._chain = Promise.resolve();
  }

  /** @returns {Promise<{sent:number, error?:string}>} */
  upload(slot) {
    const bodies = spotBodies(slot);
    const run = async () => {
      let sent = 0;
      try {
        for (const body of bodies) {
          await this.post(body);
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

module.exports = { WsprNetClient, spotBodies, slotDateTime, WSPRNET_URL };
