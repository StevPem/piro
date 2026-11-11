'use strict';

/**
 * A Hamlib-style control port: answers the text commands of Hamlib's
 * rigctld (TCP, port 4532 by default), so programs that can use "Hamlib NET
 * rigctl" (radio model 2) can read and set the radio through PiRO: loggers
 * such as Log4OM, N1MM and CQRLOG, and WSJT-X, fldigi or JS8Call running on
 * the Pi. Control only: no audio.
 *
 * Every command that changes something goes through ControlServer as a
 * request (see ControlServer#addExternalClient), so it gets the same checks
 * as a browser's: refused while transmitting, broadcast to the browsers,
 * PTT under the 10-minute watchdog and released when the program
 * disconnects. A refusal answers RPRT -9.
 *
 * Supported (short and \long names): f/F frequency, m/M mode and passband,
 * t/T PTT, v/V VFO (VFOA only), s/S split (off only), l/L levels (RFPOWER,
 * STRENGTH, RAWSTR, SWR, ALC; set RFPOWER), \get_powerstat, \chk_vfo,
 * \dump_state, _ (info), q (quit). Extended replies with a "+" prefix.
 * Anything else answers RPRT -11 (not available).
 *
 * The answers follow rigctld from Hamlib 4.5.5, recorded against its dummy
 * radio. Hamlib's numbers (modes, levels, error codes) were read from its
 * own library.
 */

const net = require('net');
const { REQUEST } = require('./protocol');
const { TRANSMITTING_REFUSAL, RECEIVE_NOT_CONFIRMED } = require('./ws-server');

const DEFAULT_PORT = 4532;
const MAX_CLIENTS = 4;
const MAX_LINE = 1024;

// Hamlib error codes (rig_errcode_e), sent as "RPRT -n".
const RIG_OK = 0;
const RIG_EINVAL = 1; // bad argument
const RIG_EIO = 6; // the radio didn't do it
const RIG_ERJCTED = 9; // refused (while transmitting, or PTT_DATA without DATA mode)
const RIG_ENAVAIL = 11; // not available

// Hamlib mode bits (rmode_t), from rig_parse_mode() in libhamlib 4.5.5.
const MODE_BIT = {
  AM: 0x1,
  CW: 0x2,
  USB: 0x4,
  LSB: 0x8,
  RTTY: 0x10,
  FM: 0x20,
  CWR: 0x80,
  RTTYR: 0x100,
  PKTLSB: 0x400,
  PKTUSB: 0x800,
  PKTFM: 0x1000,
  PKTAM: 0x400000,
};

// Hamlib mode name -> the radio's mode and DATA mode. FM-D and AM-D are
// Hamlib's other names for PKTFM and PKTAM.
const FROM_HAMLIB = {
  USB: { mode: 'USB', data: false },
  LSB: { mode: 'LSB', data: false },
  AM: { mode: 'AM', data: false },
  FM: { mode: 'FM', data: false },
  CW: { mode: 'CW', data: false },
  CWR: { mode: 'CW_R', data: false },
  RTTY: { mode: 'RTTY', data: false },
  RTTYR: { mode: 'RTTY_R', data: false },
  PKTUSB: { mode: 'USB', data: true },
  PKTLSB: { mode: 'LSB', data: true },
  PKTFM: { mode: 'FM', data: true },
  'FM-D': { mode: 'FM', data: true },
  PKTAM: { mode: 'AM', data: true },
  'AM-D': { mode: 'AM', data: true },
};

/** The radio's mode and DATA mode -> Hamlib's mode name. */
function toHamlibMode(mode, data) {
  const plain = { USB: 'USB', LSB: 'LSB', AM: 'AM', FM: 'FM', CW: 'CW', CW_R: 'CWR', RTTY: 'RTTY', RTTY_R: 'RTTYR' }[mode];
  if (!plain) return null;
  if (data && ['USB', 'LSB', 'FM', 'AM'].includes(mode)) return `PKT${mode}`;
  return plain;
}

// The IC-7300's factory widths for FIL1, FIL2 and FIL3, in Hz. The radio
// lets these be changed, so the passband reported is the factory width of
// the filter in use, not a reading. DATA mode SSB has its own defaults.
const FILTER_WIDTHS = {
  USB: [3000, 2400, 1800],
  LSB: [3000, 2400, 1800],
  'USB-D': [1200, 500, 250],
  'LSB-D': [1200, 500, 250],
  CW: [1200, 500, 250],
  CW_R: [1200, 500, 250],
  RTTY: [2400, 500, 250],
  RTTY_R: [2400, 500, 250],
  AM: [9000, 6000, 3000],
  'AM-D': [9000, 6000, 3000],
  FM: [15000, 10000, 7000],
  'FM-D': [15000, 10000, 7000],
};
function filterWidths(mode, data) {
  return FILTER_WIDTHS[data ? `${mode}-D` : mode] || FILTER_WIDTHS[mode] || null;
}

// Hamlib level bits (setting_t), from rig_parse_level() in libhamlib 4.5.5.
const LEVEL_BIT = { RFPOWER: 0x1000, RAWSTR: 0x4000000, SWR: 0x10000000, ALC: 0x20000000, STRENGTH: 0x40000000 };
const GET_LEVELS = LEVEL_BIT.RFPOWER | LEVEL_BIT.RAWSTR | LEVEL_BIT.SWR | LEVEL_BIT.ALC | LEVEL_BIT.STRENGTH;
const SET_LEVELS = LEVEL_BIT.RFPOWER;

const MAX_WATTS = 100; // what ControlServer's power requests scale against

// S-meter raw value -> dB relative to S9 (Hamlib's STRENGTH), from the
// same calibration as the browser's S-meter (src/client/smeter.js): S0 at
// 0, S9 at 126, 6 dB an S-unit, then +10 dB steps to S9+60.
const STRENGTH_POINTS = [
  [0, -54], [10, -48], [20, -42], [30, -36], [44, -30], [57, -24], [75, -18], [90, -12], [111, -6],
  [126, 0], [141, 10], [166, 20], [191, 30], [211, 40], [231, 50], [246, 60],
];
// SWR meter raw value -> SWR, as the browser shows it (src/client/vswr.js).
const SWR_POINTS = [[0, 1.0], [48, 1.5], [80, 2.0], [120, 3.0], [255, 5.0]];
const ALC_MAX_RAW = 120; // full scale, as src/client/meter-modes.js

function interpolate(points, raw) {
  const x = Math.max(points[0][0], Math.min(points[points.length - 1][0], raw));
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (x >= x0 && x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points[points.length - 1][1];
}
const rawToStrength = (raw) => Math.round(interpolate(STRENGTH_POINTS, raw));
const rawToSwr = (raw) => interpolate(SWR_POINTS, raw);

// Bands the IC-7300 can transmit on in Australia, for \dump_state. The
// radio itself decides what it will transmit on.
const TX_BANDS = [
  [1800000, 1875000], [3500000, 3800000], [7000000, 7300000], [10100000, 10150000], [14000000, 14350000],
  [18068000, 18168000], [21000000, 21450000], [24890000, 24990000], [28000000, 29700000], [50000000, 54000000],
];
const ALL_MODES = Object.values(MODE_BIT).reduce((a, b) => a | b, 0);
const hex = (n) => `0x${n.toString(16)}`;
const fmtFloat = (x) => x.toFixed(6);

function dumpState({ rigModel, version }) {
  const lines = ['1', String(rigModel), '0'];
  // RX ranges: start end modes low_power high_power vfo antenna
  lines.push(`30000.000000 74800000.000000 ${hex(ALL_MODES)} -1 -1 0x1 0x1`, '0 0 0 0 0 0 0');
  for (const [lo, hi] of TX_BANDS) lines.push(`${lo}.000000 ${hi}.000000 ${hex(ALL_MODES)} 2000 100000 0x1 0x1`);
  lines.push('0 0 0 0 0 0 0');
  lines.push(`${hex(ALL_MODES)} 1`, '0 0'); // tuning steps
  // Filters, the first per mode being its normal width.
  const groups = [
    [MODE_BIT.USB | MODE_BIT.LSB, FILTER_WIDTHS.USB],
    [MODE_BIT.PKTUSB | MODE_BIT.PKTLSB, FILTER_WIDTHS['USB-D']],
    [MODE_BIT.CW | MODE_BIT.CWR, FILTER_WIDTHS.CW],
    [MODE_BIT.RTTY | MODE_BIT.RTTYR, FILTER_WIDTHS.RTTY],
    [MODE_BIT.AM | MODE_BIT.PKTAM, FILTER_WIDTHS.AM],
    [MODE_BIT.FM | MODE_BIT.PKTFM, FILTER_WIDTHS.FM],
  ];
  for (const [modes, widths] of groups) for (const w of widths) lines.push(`${hex(modes)} ${w}`);
  lines.push('0 0');
  lines.push('0', '0', '0', '0'); // max RIT, max XIT, max IF shift, announces
  lines.push('', ''); // preamps, attenuators: none offered here
  lines.push('0x0', '0x0', hex(GET_LEVELS), hex(SET_LEVELS), '0x0', '0x0'); // func get/set, level get/set, parm get/set
  lines.push(
    'vfo_ops=0x0',
    'ptt_type=0x1', // PTT by command
    'targetable_vfo=0x0',
    'has_set_vfo=0', // VFOA only: stops Hamlib's client switching to VFOB to read it
    'has_get_vfo=1',
    'has_set_freq=1',
    'has_get_freq=1',
    'has_set_conf=0',
    'has_get_conf=0',
    'has_power2mW=0',
    'has_mW2power=0',
    'timeout=0',
    `rig_model=${rigModel}`,
    `rigctld_version=${version}`,
    'done'
  );
  return lines;
}

// Command table: short name -> long name. Long names arrive as "\name".
const COMMANDS = {
  f: 'get_freq',
  F: 'set_freq',
  m: 'get_mode',
  M: 'set_mode',
  v: 'get_vfo',
  V: 'set_vfo',
  t: 'get_ptt',
  T: 'set_ptt',
  s: 'get_split_vfo',
  S: 'set_split_vfo',
  l: 'get_level',
  L: 'set_level',
  _: 'get_info',
  q: 'quit',
  Q: 'quit',
};
const LONG_NAMES = new Set([...Object.values(COMMANDS), 'get_powerstat', 'chk_vfo', 'dump_state']);

/** An answer: value lines (with labels for "+" replies), then the status. */
class Reply {
  constructor(code = RIG_OK, values = []) {
    this.code = code; // 0 or a positive Hamlib error number
    this.values = values; // [[label, value], ...]
  }
}
const fail = (code) => new Reply(code);

class RigctlServer {
  /**
   * @param {object} opts
   * @param {import('./ws-server').ControlServer} opts.controlServer
   * @param {number} [opts.port=4532] - 0 for any free port (tests)
   * @param {string} [opts.host='127.0.0.1'] - '0.0.0.0' to accept other computers
   * @param {boolean} [opts.allowPtt=false] - whether "T 1" may key the radio ("T 0" always works)
   * @param {number} [opts.rigModel=3073] - the Hamlib model reported (3073 is the IC-7300)
   * @param {string} [opts.version] - shown as rigctld_version
   */
  constructor({ controlServer, port = DEFAULT_PORT, host = '127.0.0.1', allowPtt = false, rigModel = 3073, version = 'PiRO' }) {
    if (!controlServer) throw new Error('RigctlServer requires opts.controlServer');
    this.controlServer = controlServer;
    this.port = port;
    this.host = host;
    this.allowPtt = allowPtt;
    this.rigModel = rigModel;
    this.version = version;
    this.connections = new Set();
    this._server = null;
  }

  /** Starts listening. Resolves with the port. */
  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._accept(socket));
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.off('error', reject);
        server.on('error', (err) => console.error(`[rigctl] ${err.message}`));
        this._server = server;
        this.port = server.address().port;
        resolve(this.port);
      });
    });
  }

  /** Stops listening and closes every connection (releasing any PTT one holds). */
  stop() {
    for (const conn of this.connections) conn.destroy();
    if (!this._server) return Promise.resolve();
    const server = this._server;
    this._server = null;
    return new Promise((resolve) => server.close(() => resolve()));
  }

  _accept(socket) {
    const who = `${socket.remoteAddress}:${socket.remotePort}`;
    if (this.connections.size >= MAX_CLIENTS) {
      console.warn(`[rigctl] refused ${who}: already ${MAX_CLIENTS} programs connected`);
      socket.destroy();
      return;
    }
    const conn = new Connection(this, socket, who);
    this.connections.add(conn);
    socket.on('close', () => this.connections.delete(conn));
    console.log(`[rigctl] ${who} connected`);
  }
}

/** One TCP connection: reads a command a line, answers in order. */
class Connection {
  constructor(server, socket, who) {
    this.server = server;
    this.socket = socket;
    this.who = who;
    this.client = server.controlServer.addExternalClient(`rigctl ${who}`);
    this.buffer = '';
    this.chain = Promise.resolve();
    this.closed = false;
    socket.setEncoding('latin1');
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => this._closed());
  }

  destroy() {
    this.socket.destroy();
    this._closed();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.client.close(); // releases PTT if this program holds it
    console.log(`[rigctl] ${this.who} disconnected`);
  }

  _onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.search(/[\r\n]/)) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.chain = this.chain.then(() => this._run(line));
    }
    if (this.buffer.length > MAX_LINE) {
      console.warn(`[rigctl] ${this.who}: line too long; closing`);
      this.destroy();
    }
  }

  async _run(line) {
    if (this.closed) return;
    let extended = false;
    let text = line;
    if (text[0] === '+') {
      extended = true;
      text = text.slice(1).trimStart();
    }
    // "\long_name args" or a one-letter command followed by its arguments.
    let name;
    let args;
    if (text[0] === '\\') {
      const [word, ...rest] = text.slice(1).split(/\s+/);
      name = LONG_NAMES.has(word) ? word : null;
      args = rest;
      if (!name) name = { unknown: word };
    } else {
      name = COMMANDS[text[0]] || { unknown: text[0] };
      args = text.slice(1).trim().split(/\s+/).filter(Boolean);
    }
    if (typeof name === 'object') {
      this._write(extended ? `${name.unknown}:\nRPRT -${RIG_ENAVAIL}\n` : `RPRT -${RIG_ENAVAIL}\n`);
      return;
    }
    if (name === 'quit') {
      this.destroy();
      return;
    }
    let reply;
    try {
      reply = await this._command(name, args);
    } catch (err) {
      console.error(`[rigctl] ${this.who} ${name}: ${err.message}`);
      reply = fail(RIG_EIO);
    }
    if (this.closed) return;
    this._write(format(name, args, reply, extended));
  }

  _write(text) {
    if (!this.closed) this.socket.write(text, 'latin1');
  }

  /** Runs a ControlServer request; maps a refusal or failure to a Hamlib error. */
  async _request(msg) {
    const r = await this.client.request(msg);
    if (r.ok) return { data: r.data };
    // Refusals, not radio failures: a change while transmitting, or PTT
    // while CW may still be sending.
    if (r.error === TRANSMITTING_REFUSAL || r.error === RECEIVE_NOT_CONFIRMED) return { code: RIG_ERJCTED, error: r.error };
    return { code: RIG_EIO, error: r.error };
  }

  async _currentMode() {
    const m = await this._request({ type: REQUEST.GET_MODE });
    if (m.code) return m;
    const d = await this._request({ type: REQUEST.GET_DATA_MODE });
    if (d.code) return d;
    return { mode: m.data.value.mode, filter: m.data.value.filter || 1, data: !!d.data.on };
  }

  async _command(name, args) {
    const cs = this.server.controlServer;
    switch (name) {
      case 'get_freq': {
        const r = await this._request({ type: REQUEST.GET_FREQUENCY });
        return r.code ? fail(r.code) : new Reply(RIG_OK, [['Frequency', String(r.data.value)]]);
      }
      case 'set_freq': {
        const hz = Number(args[0]);
        if (!args[0] || !Number.isFinite(hz) || hz < 1) return fail(RIG_EINVAL);
        const r = await this._request({ type: REQUEST.SET_FREQUENCY, value: Math.round(hz) });
        return fail(r.code || RIG_OK);
      }
      case 'get_mode': {
        const cur = await this._currentMode();
        if (cur.code) return fail(cur.code);
        const mode = toHamlibMode(cur.mode, cur.data);
        if (!mode) return fail(RIG_ENAVAIL);
        const widths = filterWidths(cur.mode, cur.data);
        const width = widths ? widths[Math.min(2, Math.max(0, cur.filter - 1))] : 0;
        return new Reply(RIG_OK, [['Mode', mode], ['Passband', String(width)]]);
      }
      case 'set_mode':
        return this._setMode(args);
      case 'get_vfo':
        return new Reply(RIG_OK, [['VFO', 'VFOA']]);
      case 'set_vfo':
        return fail(['VFOA', 'currVFO', 'VFO', 'Main'].includes(args[0]) ? RIG_OK : RIG_ENAVAIL);
      case 'get_split_vfo':
        return new Reply(RIG_OK, [['Split', '0'], ['TX VFO', 'VFOA']]);
      case 'set_split_vfo':
        if (args[0] === undefined) return fail(RIG_EINVAL);
        return fail(Number(args[0]) === 0 ? RIG_OK : RIG_ENAVAIL);
      case 'get_ptt':
        // Whether the radio is, or may be, transmitting: PiRO's PTT, an
        // unconfirmed release, or CW being keyed.
        return new Reply(RIG_OK, [['PTT', cs.transmitting ? '1' : '0']]);
      case 'set_ptt':
        return this._setPtt(args);
      case 'get_level':
        return this._getLevel(args[0]);
      case 'set_level':
        return this._setLevel(args[0], args[1]);
      case 'get_powerstat':
        return new Reply(RIG_OK, [['Power Status', '1']]);
      case 'chk_vfo':
        return new Reply(RIG_OK, [['CHKVFO', '0']]); // no VFO argument on commands
      case 'dump_state':
        return new Reply(RIG_OK, dumpState({ rigModel: this.server.rigModel, version: this.server.version }).map((l) => [null, l]));
      case 'get_info':
        return new Reply(RIG_OK, [['Info', 'PiRO']]);
      default:
        return fail(RIG_ENAVAIL);
    }
  }

  async _setMode([name, passband]) {
    const want = FROM_HAMLIB[name];
    if (!want) return fail(RIG_EINVAL);
    const width = passband === undefined ? 0 : Number(passband);
    if (!Number.isFinite(width)) return fail(RIG_EINVAL);
    const cur = await this._currentMode();
    if (cur.code) return fail(cur.code);
    // The filter: the nearest factory width when one is asked for (above
    // 0), else the filter number in use. -1 (no change) and 0 (normal)
    // keep it, so a program re-stating the mode changes nothing.
    let filter = cur.filter;
    if (width > 0) {
      const widths = filterWidths(want.mode, want.data);
      if (widths) {
        let best = 0;
        widths.forEach((w, i) => {
          if (Math.abs(w - width) < Math.abs(widths[best] - width)) best = i;
        });
        filter = best + 1;
      }
    }
    let dataNow = cur.data;
    if (want.mode !== cur.mode || filter !== cur.filter) {
      const r = await this._request({ type: REQUEST.SET_MODE, mode: want.mode, filter });
      if (r.code) return fail(r.code);
      dataNow = false; // the mode command turns DATA mode off (docs/civ-notes.md)
    }
    if (want.data !== dataNow) {
      const r = await this._request({ type: REQUEST.SET_DATA_MODE, on: want.data });
      if (r.code) return fail(r.code);
    }
    return fail(RIG_OK);
  }

  async _setPtt([value]) {
    const n = Number(value);
    if (value === undefined || ![0, 1, 2, 3].includes(n)) return fail(RIG_EINVAL);
    if (n === 0) {
      // Unkeying is always allowed.
      const r = await this._request({ type: REQUEST.SET_PTT, value: false });
      return fail(r.code || RIG_OK);
    }
    if (!this.server.allowPtt) {
      console.warn(`[rigctl] ${this.who}: PTT refused (RIGCTL_PTT is not on)`);
      return fail(RIG_ENAVAIL);
    }
    if (n === 3) {
      // PTT with data audio: only in DATA mode, so it can't key the microphone.
      const d = await this._request({ type: REQUEST.GET_DATA_MODE });
      if (d.code) return fail(d.code);
      if (!d.data.on) {
        console.warn(`[rigctl] ${this.who}: data PTT refused: the radio is not in DATA mode`);
        return fail(RIG_ERJCTED);
      }
    }
    const r = await this._request({ type: REQUEST.SET_PTT, value: true });
    return fail(r.code || RIG_OK);
  }

  async _getLevel(level) {
    const read = async (type) => {
      const r = await this._request({ type });
      return r.code ? r : { value: r.data.value ?? r.data.watts };
    };
    let r;
    let text;
    switch (level) {
      case 'RFPOWER':
        r = await read(REQUEST.GET_TX_POWER);
        text = r.code ? null : fmtFloat(Math.max(0, Math.min(1, r.value / MAX_WATTS)));
        break;
      case 'STRENGTH':
        r = await read(REQUEST.GET_SMETER);
        text = r.code ? null : String(rawToStrength(r.value));
        break;
      case 'RAWSTR':
        r = await read(REQUEST.GET_SMETER);
        text = r.code ? null : String(Math.round(r.value));
        break;
      case 'SWR':
        r = await read(REQUEST.GET_SWR);
        text = r.code ? null : fmtFloat(rawToSwr(r.value));
        break;
      case 'ALC':
        r = await read(REQUEST.GET_ALC);
        text = r.code ? null : fmtFloat(Math.max(0, Math.min(1, r.value / ALC_MAX_RAW)));
        break;
      default:
        return fail(level ? RIG_ENAVAIL : RIG_EINVAL);
    }
    return r.code ? fail(r.code) : new Reply(RIG_OK, [[null, text]]);
  }

  async _setLevel(level, value) {
    if (level !== 'RFPOWER') return fail(level ? RIG_ENAVAIL : RIG_EINVAL);
    const x = Number(value);
    if (value === undefined || !Number.isFinite(x) || x < 0 || x > 1) return fail(RIG_EINVAL);
    const r = await this._request({ type: REQUEST.SET_TX_POWER, watts: Math.round(x * MAX_WATTS) });
    return fail(r.code || RIG_OK);
  }
}

/**
 * Formats a reply as rigctld does. Plain: a get answers its values a line
 * each (or "RPRT -n" on failure); a set answers "RPRT n". Extended ("+"):
 * "name: args", then "Label: value" lines, then "RPRT n".
 */
function format(name, args, reply, extended) {
  const isGet = !name.startsWith('set_');
  if (!extended) {
    if (reply.code) return `RPRT -${reply.code}\n`;
    if (!isGet) return `RPRT 0\n`;
    return reply.values.map(([, v]) => `${v}\n`).join('');
  }
  let out = `${name}:${args.length ? ` ${args.join(' ')}` : ''}\n`;
  if (!reply.code) for (const [label, v] of reply.values) out += label ? `${label}: ${v}\n` : `${v}\n`;
  return `${out}RPRT ${reply.code ? -reply.code : 0}\n`;
}

module.exports = {
  RigctlServer,
  DEFAULT_PORT,
  MAX_CLIENTS,
  toHamlibMode,
  FROM_HAMLIB,
  FILTER_WIDTHS,
  rawToStrength,
  rawToSwr,
  dumpState,
  STRENGTH_POINTS,
  SWR_POINTS,
};
