'use strict';

/**
 * "Current conditions": a quality tag for each WSPR band, from two sources.
 *
 * - My QTH: the WSPR spots PiRO itself decoded in the last 90 minutes
 *   (attended WSPR, or the unattended band cycle). A band PiRO listened to
 *   and heard nothing on is "Dismal"; a band it hasn't listened to is "N/A".
 * - Local area: the spots of every WSPR reporter in the site's 4-character
 *   Maidenhead square and the 8 around it, in the last 60 minutes. These
 *   are wsprnet.org's spots, read from wspr.live (a public copy of the
 *   wsprnet.org database that takes SQL queries, free, at most 20 a
 *   minute); wsprnet.org itself has no open query interface. The result is
 *   kept for 10 minutes. A band with no spots there is "N/A".
 *
 * Either way the band's "range" is how far the stations heard were: the
 * distance of each station heard (its farthest spot), and of those the
 * 80th percentile, so one freak spot doesn't decide it. The range is then
 * tagged Great / Good / Average / Bad / Dismal (RANGE_TAGS).
 */

const https = require('node:https');
const { WSPR_DIAL_HZ } = require('./wspr-bridge');

const BANDS = Object.keys(WSPR_DIAL_HZ); // 160m ... 6m
const MY_WINDOW_MS = 90 * 60 * 1000;
const LOCAL_WINDOW_MIN = 60;
const LOCAL_CACHE_MS = 10 * 60 * 1000;
const WSPR_LIVE_URL = 'https://db1.wspr.live/';

/** Range (km) at or above which a band gets each tag. Below the last: Dismal. */
const RANGE_TAGS = [
  [10000, 'Great'],
  [5000, 'Good'],
  [2500, 'Average'],
  [1000, 'Bad'],
];

function tagForRange(km) {
  for (const [min, tag] of RANGE_TAGS) if (km >= min) return tag;
  return 'Dismal';
}

/** Latitude/longitude of a locator's centre (4 or 6 characters). */
function gridToLatLon(grid) {
  const g = String(grid || '').trim();
  if (!/^[A-Ra-r]{2}[0-9]{2}([A-Xa-x]{2})?$/.test(g)) return null;
  const u = g.toUpperCase();
  let lon = (u.charCodeAt(0) - 65) * 20 - 180 + Number(u[2]) * 2;
  let lat = (u.charCodeAt(1) - 65) * 10 - 90 + Number(u[3]);
  if (u.length === 6) {
    lon += ((u.charCodeAt(4) - 65) * 5) / 60 + 2.5 / 60;
    lat += ((u.charCodeAt(5) - 65) * 2.5) / 60 + 1.25 / 60;
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}

/** Great-circle distance, km. */
function distanceKm(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The 4-character square and the 8 around it (longitude wraps; no squares beyond the poles). */
function squareAndNeighbours(grid) {
  const u = String(grid || '').toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}/.test(u)) return [];
  const lonIdx = (u.charCodeAt(0) - 65) * 10 + Number(u[2]);
  const latIdx = (u.charCodeAt(1) - 65) * 10 + Number(u[3]);
  const out = [];
  for (const dy of [1, 0, -1]) {
    for (const dx of [-1, 0, 1]) {
      const lon = (lonIdx + dx + 180) % 180;
      const lat = latIdx + dy;
      if (lat < 0 || lat > 179) continue;
      out.push(`${String.fromCharCode(65 + Math.floor(lon / 10))}${String.fromCharCode(65 + Math.floor(lat / 10))}${lon % 10}${lat % 10}`);
    }
  }
  return out;
}

/** The band a frequency (Hz) is in, by its WSPR frequency (within about 8%), or null. */
function bandForHz(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  for (const b of BANDS) if (Math.abs(Math.log(hz / WSPR_DIAL_HZ[b])) < 0.08) return b;
  return null;
}

/** 80th percentile (nearest rank) of the distances. */
function rangeOf(distances) {
  if (!distances.length) return 0;
  const s = [...distances].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.8 * s.length) - 1)];
}

function summary(distances, extra = {}) {
  const rangeKm = Math.round(rangeOf(distances));
  return { tag: tagForRange(rangeKm), rangeKm, stations: distances.length, ...extra };
}

/** The wspr.live query for the local area: per 10 kHz and transmitter, its farthest spot and who heard it. */
function localQuery(squares, minutes = LOCAL_WINDOW_MIN) {
  const list = squares.map((s) => `'${s}'`).join(',');
  return (
    'SELECT intDiv(frequency, 10000) AS f, tx_sign, max(distance) AS d, groupUniqArray(rx_sign) AS rx ' +
    `FROM wspr.rx WHERE time > now() - INTERVAL ${minutes} MINUTE ` +
    `AND upper(substring(rx_loc, 1, 4)) IN (${list}) ` +
    'GROUP BY f, tx_sign FORMAT JSONCompact'
  );
}

/** Runs a query on wspr.live, returning the JSONCompact rows. */
function wsprLiveQuery(sql, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${WSPR_LIVE_URL}?query=${encodeURIComponent(sql)}`;
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'PiRO' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`wspr.live answered ${res.statusCode}: ${body.slice(0, 120).trim()}`));
        try {
          resolve(JSON.parse(body).data || []);
        } catch {
          reject(new Error('wspr.live sent something that is not JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('wspr.live did not answer')));
    req.on('error', reject);
  });
}

/** Per band, from the query's rows: {band: {distances, reporters}}. */
function localFromRows(rows) {
  const out = {};
  for (const [f10k, tx, d, rx] of rows) {
    let hz = Number(f10k) * 10000;
    const band = bandForHz(hz);
    if (!band) continue;
    const b = (out[band] = out[band] ?? { byTx: new Map(), reporters: new Set() });
    b.byTx.set(tx, Math.max(b.byTx.get(tx) ?? 0, Number(d) || 0));
    for (const r of rx || []) b.reporters.add(r);
  }
  return out;
}

class BandConditions {
  /**
   * @param {object} opts
   * @param {object} opts.controlServer - its 'wspr-slot-decoded' events feed My QTH
   * @param {string} opts.grid - the site's locator (WSPR_GRID or STATION_GRID)
   * @param {Function} [opts.query] - runs SQL on wspr.live and returns rows (test hook)
   * @param {Function} [opts.now]
   */
  constructor({ controlServer, grid, query = wsprLiveQuery, now = Date.now } = {}) {
    this.controlServer = controlServer;
    this.grid = String(grid || '').trim().toUpperCase();
    this.home = gridToLatLon(this.grid);
    this.squares = squareAndNeighbours(this.grid);
    this.query = query;
    this.now = now;
    this._slots = []; // {time, band, stations: Map(call -> km)}
    this._local = null; // {time, bands, error}
    this._localPending = null;
    this._onDecoded = (slot) => this.addSlot(slot);
  }

  start() {
    this.controlServer?.on('wspr-slot-decoded', this._onDecoded);
  }

  stop() {
    this.controlServer?.off('wspr-slot-decoded', this._onDecoded);
  }

  /** One decoded WSPR slot (including one with nothing heard). */
  addSlot({ slotStartMs, dialHz, decodes }) {
    const band = bandForHz(dialHz);
    if (!band) return;
    const stations = new Map();
    for (const d of decodes || []) {
      const where = gridToLatLon(d.grid);
      const call = d.callsign || d.message?.split(' ')[0];
      if (!where || !call || !this.home) continue;
      const km = distanceKm(this.home, where);
      stations.set(call, Math.max(stations.get(call) ?? 0, km));
    }
    this._slots.push({ time: slotStartMs ?? this.now(), band, stations });
    const cutoff = this.now() - MY_WINDOW_MS;
    this._slots = this._slots.filter((s) => s.time >= cutoff);
  }

  _myQth() {
    const cutoff = this.now() - MY_WINDOW_MS;
    const per = {};
    for (const s of this._slots) {
      if (s.time < cutoff) continue;
      const b = (per[s.band] = per[s.band] ?? { stations: new Map(), slots: 0, last: 0 });
      b.slots++;
      b.last = Math.max(b.last, s.time);
      for (const [call, km] of s.stations) b.stations.set(call, Math.max(b.stations.get(call) ?? 0, km));
    }
    return per;
  }

  /** Fetches the local area (at most every 10 minutes; requests in between share it). */
  _localArea() {
    if (this._local && this.now() - this._local.time < LOCAL_CACHE_MS) return Promise.resolve(this._local);
    if (this._localPending) return this._localPending;
    if (this.squares.length === 0) return Promise.resolve({ time: this.now(), bands: {}, error: 'No grid set (WSPR_GRID or STATION_GRID).' });
    this._localPending = this.query(localQuery(this.squares))
      .then(
        (rows) => ({ time: this.now(), bands: localFromRows(rows) }),
        // keep the last good one, if any, and say why it is old
        (err) => ({ ...(this._local ?? { bands: {} }), time: this._local?.time ?? null, error: err.message })
      )
      .then((r) => {
        this._localPending = null;
        if (!r.error) this._local = r;
        return r;
      });
    return this._localPending;
  }

  /** The table for the "Current conditions" window. */
  async report() {
    const local = await this._localArea();
    const mine = this._myQth();
    const bands = BANDS.map((band) => {
      const m = mine[band];
      const l = local.bands?.[band];
      return {
        band,
        myQth: m ? summary([...m.stations.values()], { slots: m.slots, lastMs: m.last }) : { tag: 'N/A' },
        local: l && l.byTx.size ? summary([...l.byTx.values()], { reporters: l.reporters.size }) : { tag: 'N/A' },
      };
    });
    return {
      grid: this.grid || null,
      squares: this.squares,
      myWindowMin: MY_WINDOW_MS / 60000,
      localWindowMin: LOCAL_WINDOW_MIN,
      localUpdatedMs: local.time ?? null,
      localError: local.error ?? null,
      myError: this.home ? null : 'No grid set (WSPR_GRID or STATION_GRID), so distances are unknown.',
      tags: RANGE_TAGS.map(([km, tag]) => ({ tag, km })),
      bands,
    };
  }
}

module.exports = {
  BandConditions,
  RANGE_TAGS,
  tagForRange,
  gridToLatLon,
  distanceKm,
  squareAndNeighbours,
  bandForHz,
  rangeOf,
  localQuery,
  localFromRows,
  wsprLiveQuery,
};
