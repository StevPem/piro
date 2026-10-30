'use strict';

/**
 * JS8's message layer: how text becomes 12-character frames, and frames
 * become text again.
 *
 * Ported from JS8Call-improved (JS8_Main/Varicode.cpp: the pack/unpack
 * functions and buildMessageFrames(); JS8_Mode/DecodedText.cpp), GPL-3.0.
 * See third_party/js8call/README.md.
 *
 * A frame is 72 bits (twelve 6-bit characters of ALPHABET72) plus the 3
 * transmission-type bits the modem carries beside it (first/last frame of
 * a message; "data" for the faster speeds only). The first bits of the 72
 * say what kind of frame it is:
 *   000 heartbeat or CQ: callsign (50 bits), grid
 *   001 compound: a callsign that doesn't fit 28 bits, grid
 *   010 compound directed: a compound callsign, command
 *   011 directed: from (28 bits), to (28 bits), command, number
 *   1x  data (Normal speed): Huffman-coded (10) or JSC-compressed (11) text
 */

const jsc = require('./js8-jsc');

// Transmission types (the 3 bits beside each frame).
const TX = { NORMAL: 0, FIRST: 1, LAST: 2, DATA: 4 };
// Frame types (the first 3 bits).
const FRAME = { HEARTBEAT: 0, COMPOUND: 1, COMPOUND_DIRECTED: 2, DIRECTED: 3, DATA: 4, DATA_COMPRESSED: 6, UNKNOWN: 255 };

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?'; // base 41, for checksums
const ALPHABET72 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+/?.';
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@'; // callsigns and grids

// Directed commands: text -> number. Several texts share a number; sending
// uses the text, receiving shows the first text (in Qt's string order) for
// the number, as JS8Call does.
const DIRECTED_CMDS = new Map([
  [' HEARTBEAT', -1],
  [' HB', -1],
  [' CQ', -1],
  [' SNR?', 0],
  ['?', 0],
  [' DIT DIT', 1],
  [' HEARING?', 3],
  [' GRID?', 4],
  ['>', 5],
  [' STATUS?', 6],
  [' STATUS', 7],
  [' HEARING', 8],
  [' MSG', 9],
  [' MSG TO:', 10],
  [' QUERY', 11],
  [' QUERY MSGS', 12],
  [' QUERY MSGS?', 12],
  [' QUERY CALL', 13],
  [' GRID', 15],
  [' INFO?', 16],
  [' INFO', 17],
  [' FB', 18],
  [' HW CPY?', 19],
  [' SK', 20],
  [' RR', 21],
  [' QSL?', 22],
  [' QSL', 23],
  [' CMD', 24],
  [' SNR', 25],
  [' NO', 26],
  [' YES', 27],
  [' 73', 28],
  [' NACK', 2],
  [' ACK', 14],
  [' HEARTBEAT SNR', 29],
  [' AGN?', 30],
  ['  ', 31],
  [' ', 31],
]);
const SORTED_CMD_KEYS = [...DIRECTED_CMDS.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const AUTOREPLY_CMDS = new Set([0, 2, 3, 4, 6, 9, 10, 11, 12, 13, 14, 16, 30]);
const BUFFERED_CMDS = new Set([5, 9, 10, 11, 12, 13, 15, 24]);
const SNR_CMDS = new Set([25, 29]);
const CHECKSUM_CMDS = new Map([
  [5, 16],
  [9, 16],
  [10, 16],
  [11, 16],
  [12, 16],
  [13, 16],
  [15, 0],
  [24, 16],
]);

/** The command text JS8Call shows for a command number. */
function cmdKey(value) {
  for (const k of SORTED_CMD_KEYS) if (DIRECTED_CMDS.get(k) === value) return k;
  return '';
}

const NBASECALL = 37 * 36 * 10 * 27 * 27 * 27;
const NBASEGRID = 180 * 180;
const NUSERGRID = NBASEGRID + 10;
const NMAXGRID = (1 << 15) - 1;

const BASECALLS = new Map(
  [
    '<....>',
    '@ALLCALL',
    '@JS8NET',
    '@DX/NA',
    '@DX/SA',
    '@DX/EU',
    '@DX/AS',
    '@DX/AF',
    '@DX/OC',
    '@DX/AN',
    '@REGION/1',
    '@REGION/2',
    '@REGION/3',
    '@GROUP/0',
    '@GROUP/1',
    '@GROUP/2',
    '@GROUP/3',
    '@GROUP/4',
    '@GROUP/5',
    '@GROUP/6',
    '@GROUP/7',
    '@GROUP/8',
    '@GROUP/9',
    '@COMMAND',
    '@CONTROL',
    '@NET',
    '@NTS',
    '@RESERVE/0',
    '@RESERVE/1',
    '@RESERVE/2',
    '@RESERVE/3',
    '@RESERVE/4',
    '@APRSIS',
    '@RAGCHEW',
    '@JS8',
    '@EMCOMM',
    '@ARES',
    '@MARS',
    '@AMRRON',
    '@RACES',
    '@RAYNET',
    '@RADAR',
    '@SKYWARN',
    '@CQ',
    '@HB',
    '@QSO',
    '@QSOPARTY',
    '@CONTEST',
    '@FIELDDAY',
    '@SOTA',
    '@IOTA',
    '@POTA',
    '@QRP',
    '@QRO',
  ].map((name, i) => [name, NBASECALL + 1 + i])
);
const BASECALL_NAMES = new Map([...BASECALLS].map(([k, v]) => [v, k]));

const CQS = ['CQ CQ CQ', 'CQ DX', 'CQ QRP', 'CQ CONTEST', 'CQ FIELD', 'CQ FD', 'CQ CQ', 'CQ'];
const HBS = ['HB', 'HB', 'HB', 'HB', 'HB', 'HB', 'HB', 'HB'];

// Huffman code for data frames (JS8Call's "hufftable").
const HUFF = new Map([
  [' ', '01'],
  ['E', '100'],
  ['T', '1101'],
  ['A', '0011'],
  ['O', '11111'],
  ['I', '11100'],
  ['N', '10111'],
  ['S', '10100'],
  ['H', '00011'],
  ['R', '00000'],
  ['D', '111011'],
  ['L', '110011'],
  ['C', '110001'],
  ['U', '101101'],
  ['M', '101011'],
  ['W', '001011'],
  ['F', '001001'],
  ['G', '000101'],
  ['Y', '000011'],
  ['P', '1111011'],
  ['B', '1111001'],
  ['.', '1110100'],
  ['V', '1100101'],
  ['K', '1100100'],
  ['-', '1100001'],
  ['+', '1100000'],
  ['?', '1011001'],
  ['!', '1011000'],
  ['"', '1010101'],
  ['X', '1010100'],
  ['0', '0010101'],
  ['J', '0010100'],
  ['1', '0010001'],
  ['Q', '0010000'],
  ['2', '0001001'],
  ['Z', '0001000'],
  ['3', '0000101'],
  ['5', '0000100'],
  ['4', '11110101'],
  ['9', '11110100'],
  ['8', '11110001'],
  ['6', '11110000'],
  ['7', '11101011'],
  ['/', '11101010'],
]);
const HUFF_DECODE = new Map([...HUFF].map(([ch, code]) => [code, ch]));

// Patterns (Qt's PCRE patterns; these all mean the same in JavaScript).
const GRID_PATTERN = '(?<grid>[A-X]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)*)+';
const COMPOUND_CALLSIGN_PATTERN =
  '(?<callsign>(?:[@]?|\\b)(?<extended>[A-Z0-9\\/@][A-Z0-9\\/]{0,2}[\\/]?[A-Z0-9\\/]{0,3}[\\/]?[A-Z0-9\\/]{0,3})\\b)';
const BASE_CALLSIGN_PATTERN =
  '(?<callsign>\\b(?<base>([0-9A-Z])?([0-9A-Z])([0-9])([A-Z])?([A-Z])?([A-Z])?)(?<portable>[/][P])?\\b)';
const PACK_CALLSIGN_RE = /([0-9A-Z ])([0-9A-Z])([0-9])([A-Z ])([A-Z ])([A-Z ])/;
const CALLSIGN_PATTERN = '(?<callsign>[@]?[A-Z0-9/]+)';
const OPTIONAL_CMD_PATTERN =
  '(?<cmd>\\s?(?:AGN[?]|QSL[?]|HW CPY[?]|MSG TO[:]|SNR[?]|INFO[?]|GRID[?]|STATUS[?]|QUERY MSGS[?]|HEARING[?]|' +
  '(?:(?:STATUS|HEARING|QUERY CALL|QUERY MSGS|QUERY|CMD|MSG|NACK|ACK|73|YES|NO|HEARTBEAT SNR|SNR|QSL|RR|SK|FB|INFO|GRID|DIT DIT)(?=[ ]|$))|[?> ]))?';
const OPTIONAL_GRID_PATTERN = '(?<grid>\\s?[A-R]{2}[0-9]{2})?';
const OPTIONAL_NUM_PATTERN = '(?<num>(?<=SNR)\\s?[-+]?(?:3[01]|[0-2]?[0-9]))?';

const GRID_RE = new RegExp(GRID_PATTERN);
const DIRECTED_RE = new RegExp(`^${CALLSIGN_PATTERN}${OPTIONAL_CMD_PATTERN}${OPTIONAL_NUM_PATTERN}`);
const HEARTBEAT_RE = new RegExp(
  '^\\s*(?<callsign>[@](?:ALLCALL|HB)\\s+)?(?<type>CQ CQ CQ|CQ DX|CQ QRP|CQ CONTEST|CQ FIELD|CQ FD|CQ CQ|CQ|HB|HEARTBEAT(?!\\s+SNR))(?:\\s(?<grid>[A-R]{2}[0-9]{2}))?\\b'
);
const COMPOUND_RE = new RegExp(
  `^\\s*[\`]${CALLSIGN_PATTERN}(?<extra>${OPTIONAL_GRID_PATTERN}${OPTIONAL_CMD_PATTERN}${OPTIONAL_NUM_PATTERN})`
);
const BASE_CALLSIGN_RE = new RegExp(BASE_CALLSIGN_PATTERN);
const COMPOUND_CALLSIGN_FULL_RE = new RegExp(`^${COMPOUND_CALLSIGN_PATTERN}`);
const LETTER_DIGIT_RE = /[0-9][A-Z]|[A-Z][0-9]/;

const g = (m, name) => (m && m.groups && m.groups[name]) || '';

// --- bits ---

function intToBits(value, n) {
  const bits = new Array(n).fill(0);
  for (let i = n - 1; i >= 0 && value > 0; i--) {
    bits[i] = value % 2;
    value = Math.floor(value / 2);
  }
  return bits;
}

function bitsToInt(bits, start = 0, n = bits.length - start) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 2 + bits[start + i];
  return v;
}

/** 72 bits -> 12 frame characters. */
function bitsToFrame(bits) {
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET72[bitsToInt(bits, i * 6, 6)];
  return s;
}

/** 12 frame characters -> 72 bits (null if a character isn't a frame character). */
function frameToBits(frame) {
  const bits = [];
  for (let i = 0; i < 12; i++) {
    const v = ALPHABET72.indexOf(frame[i]);
    if (v < 0 || v > 63) return null;
    bits.push(...intToBits(v, 6));
  }
  return bits;
}

// --- checksums (for buffered commands) ---

function crc16Kermit(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc & 0xffff;
}

function crc32Bzip2(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pack16bits(packed) {
  const n = ALPHABET.length;
  const a = Math.floor(packed / (n * n));
  const b = Math.floor((packed - a * n * n) / n);
  return ALPHABET[a] + ALPHABET[b] + ALPHABET[packed % n];
}

function checksum16(input) {
  return pack16bits(crc16Kermit(Buffer.from(input, 'utf8'))).padEnd(3, ' ');
}

function checksum32(input) {
  const crc = crc32Bzip2(Buffer.from(input, 'utf8'));
  return (pack16bits(crc >>> 16) + pack16bits(crc & 0xffff)).padEnd(6, ' ');
}

// --- callsigns, grids, numbers ---

function packAlphaNumeric50(value) {
  let word = value.replace(/[^A-Z0-9 /@]/g, '');
  if (word.length > 3 && word[3] !== '/') word = `${word.slice(0, 3)} ${word.slice(3)}`;
  if (word.length > 7 && word[7] !== '/') word = `${word.slice(0, 7)} ${word.slice(7)}`;
  if (word.length < 11) word = word.padEnd(11, ' ');
  const idx = (i) => ALPHANUMERIC.indexOf(word[i]);
  let v = idx(0);
  v = v * 38 + idx(1);
  v = v * 38 + idx(2);
  v = v * 2 + (word[3] === '/' ? 1 : 0);
  v = v * 38 + idx(4);
  v = v * 38 + idx(5);
  v = v * 38 + idx(6);
  v = v * 2 + (word[7] === '/' ? 1 : 0);
  v = v * 38 + idx(8);
  v = v * 38 + idx(9);
  v = v * 38 + idx(10);
  return v;
}

function unpackAlphaNumeric50(packed) {
  const w = new Array(11);
  const take = (mod) => {
    const r = packed % mod;
    packed = Math.floor(packed / mod);
    return r;
  };
  w[10] = ALPHANUMERIC[take(38)];
  w[9] = ALPHANUMERIC[take(38)];
  w[8] = ALPHANUMERIC[take(38)];
  w[7] = take(2) ? '/' : ' ';
  w[6] = ALPHANUMERIC[take(38)];
  w[5] = ALPHANUMERIC[take(38)];
  w[4] = ALPHANUMERIC[take(38)];
  w[3] = take(2) ? '/' : ' ';
  w[2] = ALPHANUMERIC[take(38)];
  w[1] = ALPHANUMERIC[take(38)];
  w[0] = ALPHANUMERIC[take(39)];
  return w.join('').replace(/ /g, '');
}

/** A standard callsign in 28 bits; {packed, portable}. packed 0 means it doesn't fit. */
function packCallsign(value) {
  let callsign = value.toUpperCase().trim();
  if (BASECALLS.has(callsign)) return { packed: BASECALLS.get(callsign), portable: false };
  let portable = false;
  if (callsign.endsWith('/P')) {
    callsign = callsign.slice(0, -2);
    portable = true;
  }
  if (callsign.startsWith('3DA0')) callsign = `3D0${callsign.slice(4)}`;
  if (callsign.startsWith('3X') && callsign[2] >= 'A' && callsign[2] <= 'Z') callsign = `Q${callsign.slice(2)}`;
  const len = callsign.length;
  if (len < 2 || len > 6) return { packed: 0, portable };
  const perms = [callsign];
  if (len === 2) perms.push(` ${callsign}   `);
  if (len === 3) perms.push(` ${callsign}  `, `${callsign}   `);
  if (len === 4) perms.push(` ${callsign} `, `${callsign}  `);
  if (len === 5) perms.push(` ${callsign}`, `${callsign} `);
  let matched = '';
  for (const p of perms) {
    const m = PACK_CALLSIGN_RE.exec(p);
    if (m) matched = m[0]; // the last that matches, as in JS8Call
  }
  if (matched.length < 6) return { packed: 0, portable };
  const a = (i) => ALPHANUMERIC.indexOf(matched[i]);
  let packed = a(0);
  packed = 36 * packed + a(1);
  packed = 10 * packed + a(2);
  packed = 27 * packed + a(3) - 10;
  packed = 27 * packed + a(4) - 10;
  packed = 27 * packed + a(5) - 10;
  return { packed, portable };
}

function unpackCallsign(value, portable) {
  if (BASECALL_NAMES.has(value)) return BASECALL_NAMES.get(value);
  const w = new Array(6);
  w[5] = ALPHANUMERIC[(value % 27) + 10];
  value = Math.floor(value / 27);
  w[4] = ALPHANUMERIC[(value % 27) + 10];
  value = Math.floor(value / 27);
  w[3] = ALPHANUMERIC[(value % 27) + 10];
  value = Math.floor(value / 27);
  w[2] = ALPHANUMERIC[value % 10];
  value = Math.floor(value / 10);
  w[1] = ALPHANUMERIC[value % 36];
  value = Math.floor(value / 36);
  w[0] = ALPHANUMERIC[value] ?? ' ';
  let callsign = w.join('');
  if (callsign.startsWith('3D0')) callsign = `3DA0${callsign.slice(3)}`;
  if (callsign[0] === 'Q' && callsign[1] >= 'A' && callsign[1] <= 'Z') callsign = `3X${callsign.slice(1)}`;
  if (portable) callsign = `${callsign.trim()}/P`;
  return callsign.trim();
}

function deg2grid(dlong, dlat) {
  if (dlong < -180) dlong += 360;
  if (dlong > 180) dlong -= 360;
  const nlong = Math.trunc((60 * (180 - dlong)) / 5);
  let n1 = Math.trunc(nlong / 240);
  let n2 = Math.trunc((nlong - 240 * n1) / 24);
  const g0 = String.fromCharCode(65 + n1);
  const g2 = String.fromCharCode(48 + n2);
  const nlat = Math.trunc((60 * (dlat + 90)) / 2.5);
  n1 = Math.trunc(nlat / 240);
  n2 = Math.trunc((nlat - 240 * n1) / 24);
  return g0 + String.fromCharCode(65 + n1) + g2 + String.fromCharCode(48 + n2);
}

function grid2deg(grid) {
  const g4 = grid.slice(0, 4).toUpperCase();
  const c = (i) => g4.charCodeAt(i);
  const nlong = 180 - 20 * (c(0) - 65);
  const n20d = 2 * (c(2) - 48);
  const xminlong = 5 * (109 - 97 + 0.5); // subsquare "mm"
  const dlong = nlong - n20d - xminlong / 60;
  const nlat = -90 + 10 * (c(1) - 65) + c(3) - 48;
  const xminlat = 2.5 * (109 - 97 + 0.5);
  const dlat = nlat + xminlat / 60;
  return [dlong, dlat];
}

function packGrid(value) {
  const grid = value.trim();
  if (grid.length < 4) return NMAXGRID;
  const [dlong, dlat] = grid2deg(grid.slice(0, 4));
  const ilong = Math.trunc(dlong);
  const ilat = Math.trunc(dlat + 90);
  return Math.trunc((ilong + 180) / 2) * 180 + ilat;
}

function unpackGrid(value) {
  if (value > NBASEGRID) return '';
  const dlat = (value % 180) - 90;
  const dlong = Math.trunc(value / 180) * 2 - 180 + 2;
  return deg2grid(dlong, dlat);
}

/** A number or S/N (-30..31) as 1..62; {value, ok}. */
function packNum(num) {
  if (num === '' || num == null) return { value: 0, ok: false };
  const t = String(num).trim();
  if (!/^[-+]?\d+$/.test(t)) return { value: 31, ok: false }; // Qt's toInt gives 0 on failure
  const n = Math.max(-30, Math.min(Number(t), 31));
  return { value: n + 31, ok: true };
}

function isSnrCommand(cmd) {
  return DIRECTED_CMDS.has(cmd) && SNR_CMDS.has(DIRECTED_CMDS.get(cmd));
}

function isCommandAllowed(cmd) {
  return DIRECTED_CMDS.has(cmd);
}

function isCommandBuffered(cmd) {
  return DIRECTED_CMDS.has(cmd) && (cmd.includes(' ') || BUFFERED_CMDS.has(DIRECTED_CMDS.get(cmd)));
}

function isCommandChecksummed(cmd) {
  if (!DIRECTED_CMDS.has(cmd)) return 0;
  return CHECKSUM_CMDS.get(DIRECTED_CMDS.get(cmd)) ?? 0;
}

function isCommandAutoreply(cmd) {
  return DIRECTED_CMDS.has(cmd) && AUTOREPLY_CMDS.has(DIRECTED_CMDS.get(cmd));
}

function packCmd(cmd, num) {
  const cmdStr = cmdKey(cmd);
  if (isSnrCommand(cmdStr)) {
    let value = ((1 << 1) | (cmdStr === ' HEARTBEAT SNR' ? 1 : 0)) << 6;
    value += num & 0x3f;
    return value & 0xff;
  }
  return cmd & 0x7f;
}

function unpackCmd(value) {
  if (value & 0x80) {
    const num = value & 0x3f;
    const cmd = value & 0x40 ? DIRECTED_CMDS.get(' HEARTBEAT SNR') : DIRECTED_CMDS.get(' SNR');
    return { cmd, num };
  }
  return { cmd: value & 0x7f, num: 0 };
}

function formatSnr(snr) {
  if (snr < -60 || snr > 60) return '';
  if (snr >= 0) return `+${String(snr).padStart(2, '0')}`;
  return `-${String(-snr).padStart(2, '0')}`;
}

function isValidCompoundCallsign(callsign) {
  if (callsign.length - (callsign.match(/\//g) || []).length > 9) return false;
  const slash = callsign.indexOf('/');
  if (slash !== -1) return !BASECALLS.has(callsign.slice(0, slash));
  if (callsign.startsWith('@')) return true;
  return callsign.length > 2 && LETTER_DIGIT_RE.test(callsign);
}

/** {valid, compound} for a callsign as JS8Call sees it. */
function checkCallsign(callsign) {
  if (BASECALLS.has(callsign)) return { valid: true, compound: false };
  let m = BASE_CALLSIGN_RE.exec(callsign);
  if (m && m[0].length === callsign.length) {
    return { valid: callsign.length > 2 && LETTER_DIGIT_RE.test(callsign), compound: false };
  }
  m = COMPOUND_CALLSIGN_FULL_RE.exec(callsign);
  if (m && m[0].length === callsign.length) {
    const valid = isValidCompoundCallsign(m[0]);
    return { valid, compound: valid };
  }
  return { valid: false, compound: false };
}

function isValidCallsign(callsign) {
  return checkCallsign(callsign).valid;
}

function isCompoundCallsign(callsign) {
  if (BASECALLS.has(callsign) && !callsign.startsWith('@')) return false;
  let m = BASE_CALLSIGN_RE.exec(callsign);
  if (m && m[0].length === callsign.length) return false;
  m = COMPOUND_CALLSIGN_FULL_RE.exec(callsign);
  if (!m || m[0].length !== callsign.length) return false;
  return isValidCompoundCallsign(m[0]);
}

/** Callsigns in some text (JS8Call's parseCallsigns()). */
function parseCallsigns(input) {
  const out = [];
  const re = new RegExp(COMPOUND_CALLSIGN_PATTERN, 'g');
  let m;
  while ((m = re.exec(input)) !== null) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    const callsign = g(m, 'callsign').trim();
    if (!isValidCallsign(callsign)) continue;
    if (GRID_RE.test(callsign)) continue;
    out.push(callsign);
  }
  return out;
}

// --- frames ---

function packCompoundFrame(callsign, type, num, bits3) {
  if (type === FRAME.DATA || type === FRAME.DIRECTED) return '';
  const packedCallsign = packAlphaNumeric50(callsign);
  if (packedCallsign === 0) return '';
  const packed11 = (num & 0xffe0) >> 5;
  const packed5 = num & 0x1f;
  const bits = [
    ...intToBits(type, 3),
    ...intToBits(packedCallsign, 50),
    ...intToBits(packed11, 11),
    ...intToBits(packed5, 5),
    ...intToBits(bits3, 3),
  ];
  return bitsToFrame(bits);
}

function unpackCompoundFrame(text) {
  if (text.length < 12 || text.includes(' ')) return null;
  const bits = frameToBits(text);
  if (!bits) return null;
  const type = bitsToInt(bits, 0, 3);
  if (type === FRAME.DATA || type === FRAME.DIRECTED) return null;
  const callsign = unpackAlphaNumeric50(bitsToInt(bits, 3, 50));
  const packed11 = bitsToInt(bits, 53, 11);
  const packed5 = bitsToInt(bits, 64, 5);
  const bits3 = bitsToInt(bits, 69, 3);
  return { parts: [callsign, ''], type, num: (packed11 << 5) | packed5, bits3 };
}

/** Heartbeat or CQ ("CQ CQ CQ QF22", "HB QF22"); {frame, n} where n is the text used. */
function packHeartbeatMessage(text, callsign) {
  const m = HEARTBEAT_RE.exec(text);
  if (!m || !callsign) return { frame: '', n: 0 };
  const extra = g(m, 'grid');
  const type = g(m, 'type');
  const isAlt = type.startsWith('CQ');
  let packedExtra = NMAXGRID;
  if (extra.length === 4 && GRID_RE.test(extra)) packedExtra = packGrid(extra);
  let number = Math.max(0, HBS.indexOf(type));
  if (isAlt) {
    packedExtra |= 1 << 15;
    number = Math.max(0, CQS.indexOf(type));
  }
  const frame = packCompoundFrame(callsign, FRAME.HEARTBEAT, packedExtra, number);
  if (!frame) return { frame: '', n: 0 };
  return { frame, n: m[0].length };
}

function unpackHeartbeatMessage(text) {
  const u = unpackCompoundFrame(text);
  if (!u || u.type !== FRAME.HEARTBEAT) return null;
  return {
    parts: [...u.parts, unpackGrid(u.num & 0x7fff)],
    type: u.type,
    isAlt: (u.num & 0x8000) !== 0,
    bits3: u.bits3,
  };
}

/** "`CALL/P GRID" or "`CALL/P CMD"; {frame, n}. */
function packCompoundMessage(text) {
  const m = COMPOUND_RE.exec(text);
  if (!m) return { frame: '', n: 0 };
  const callsign = g(m, 'callsign');
  const grid = g(m, 'grid');
  const cmd = g(m, 'cmd');
  const num = g(m, 'num').trim();
  if (!callsign) return { frame: '', n: 0 };
  let type = FRAME.COMPOUND;
  let extra = NMAXGRID;
  if (cmd && DIRECTED_CMDS.has(cmd) && isCommandAllowed(cmd)) {
    extra = NUSERGRID + packCmd(DIRECTED_CMDS.get(cmd), packNum(num).value);
    type = FRAME.COMPOUND_DIRECTED;
  } else if (grid) {
    extra = packGrid(grid);
  }
  return { frame: packCompoundFrame(callsign, type, extra, 0), n: m[0].length };
}

function unpackCompoundMessage(text) {
  const u = unpackCompoundFrame(text);
  if (!u || (u.type !== FRAME.COMPOUND && u.type !== FRAME.COMPOUND_DIRECTED)) return null;
  const parts = [...u.parts];
  const extra = u.num;
  if (extra <= NBASEGRID) {
    parts.push(` ${unpackGrid(extra)}`);
  } else if (NUSERGRID <= extra && extra < NMAXGRID) {
    const { cmd, num } = unpackCmd(extra - NUSERGRID);
    const cmdStr = cmdKey(cmd);
    parts.push(cmdStr);
    if (isSnrCommand(cmdStr)) parts.push(formatSnr(num - 31));
  }
  return { parts, type: u.type, bits3: u.bits3 };
}

/** "VK2ABC SNR?" from mycall; {frame, n, to, toCompound, cmd, num}. */
function packDirectedMessage(text, mycall) {
  const fail = { frame: '', n: 0, to: '', toCompound: false, cmd: '', num: '' };
  const m = DIRECTED_RE.exec(text);
  if (!m) return fail;
  let from = mycall;
  if (isCompoundCallsign(from)) from = '<....>';
  let to = g(m, 'callsign');
  const cmd = g(m, 'cmd');
  const num = g(m, 'num');
  if (!cmd) return fail;
  const check = to !== mycall ? checkCallsign(to) : { valid: false, compound: false };
  if (!check.valid) return fail;
  // As in JS8Call, the "to" call is reported even if packing fails later.
  const out = { ...fail, to, toCompound: check.compound };
  if (check.compound) to = '<....>';
  if (!isCommandAllowed(cmd) && !isCommandAllowed(cmd.trim())) return out;
  const pn = packNum(num.trim());
  if (pn.ok) out.num = num;
  const f = packCallsign(from);
  const t = packCallsign(to);
  if (f.packed === 0 || t.packed === 0) return out;
  let cmdOut = '';
  let packedCmd = 0;
  if (DIRECTED_CMDS.has(cmd)) {
    cmdOut = cmd;
    packedCmd = DIRECTED_CMDS.get(cmd);
  }
  if (DIRECTED_CMDS.has(cmd.trim())) {
    cmdOut = cmd.trim();
    packedCmd = DIRECTED_CMDS.get(cmdOut);
  }
  const extra = ((f.portable ? 1 : 0) << 7) + ((t.portable ? 1 : 0) << 6) + pn.value;
  const bits = [
    ...intToBits(FRAME.DIRECTED, 3),
    ...intToBits(f.packed, 28),
    ...intToBits(t.packed, 28),
    ...intToBits(((packedCmd % 32) + 32) % 32, 5),
    ...intToBits(extra, 8),
  ];
  return { ...out, frame: bitsToFrame(bits), n: m[0].length, cmd: cmdOut };
}

function unpackDirectedMessage(text) {
  if (text.length < 12 || text.includes(' ')) return null;
  const bits = frameToBits(text);
  if (!bits) return null;
  if (bitsToInt(bits, 0, 3) !== FRAME.DIRECTED) return null;
  const packedFrom = bitsToInt(bits, 3, 28);
  const packedTo = bitsToInt(bits, 31, 28);
  const packedCmd = bitsToInt(bits, 59, 5);
  let extra = bitsToInt(bits, 64, 8);
  const portableFrom = ((extra >> 7) & 1) === 1;
  const portableTo = ((extra >> 6) & 1) === 1;
  extra %= 64;
  const cmd = cmdKey(packedCmd % 32);
  const parts = [unpackCallsign(packedFrom, portableFrom), unpackCallsign(packedTo, portableTo), cmd];
  if (extra !== 0) parts.push(isSnrCommand(cmd) ? formatSnr(extra - 31) : String(extra - 31));
  return { parts, type: FRAME.DIRECTED };
}

/** Pads frame bits to 72: a 0, then 1s. */
function padFrame(bits) {
  const out = [...bits];
  for (let i = 0; out.length < 72; i++) out.push(i === 0 ? 0 : 1);
  return out;
}

function huffEncode(text) {
  const keys = [...HUFF.keys()]; // all one character long
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (keys.includes(ch)) out.push({ chars: 1, bits: [...HUFF.get(ch)].map(Number) });
    i++;
  }
  return out;
}

function huffDecode(bits) {
  let text = '';
  let code = '';
  for (const b of bits) {
    code += b;
    if (HUFF_DECODE.has(code)) {
      text += HUFF_DECODE.get(code);
      code = '';
    } else if (code.length > 8) break;
  }
  return text;
}

function packHuffMessage(input, prefix) {
  for (const ch of input) if (!HUFF.has(ch.toUpperCase())) return { frame: '', n: 0 };
  const bits = [...prefix];
  let n = 0;
  for (const { chars, bits: cb } of huffEncode(input)) {
    if (bits.length + cb.length < 72) {
      bits.push(...cb);
      n += chars;
      continue;
    }
    break;
  }
  return { frame: bitsToFrame(padFrame(bits)), n };
}

function packCompressedMessage(input, prefix) {
  const bits = [...prefix];
  let n = 0;
  for (const { bits: cb, chars } of jsc.compress(input)) {
    if (bits.length + cb.length < 72) {
      bits.push(...cb);
      n += chars;
      continue;
    }
    break;
  }
  return { frame: bitsToFrame(padFrame(bits)), n };
}

/** A Normal-speed data frame: Huffman (10) or JSC (11), whichever carries more. */
function packDataMessage(input) {
  const huff = packHuffMessage(input, [1, 0]);
  const comp = packCompressedMessage(input, [1, 1]);
  return huff.n > comp.n ? huff : comp;
}

function unpackDataMessage(text) {
  if (text.length < 12 || text.includes(' ')) return '';
  let bits = frameToBits(text);
  if (!bits || !bits[0]) return '';
  bits = bits.slice(1);
  const compressed = bits[0] === 1;
  const n = bits.lastIndexOf(0);
  bits = bits.slice(1, n < 1 ? bits.length : n);
  return compressed ? jsc.decompress(bits) : huffDecode(bits);
}

/** A faster-speed data frame (all 72 bits JSC; flagged by the DATA transmission bit). */
function unpackFastDataMessage(text) {
  if (text.length < 12 || text.includes(' ')) return '';
  let bits = frameToBits(text);
  if (!bits) return '';
  const n = bits.lastIndexOf(0);
  bits = bits.slice(0, n < 0 ? bits.length : n);
  return jsc.decompress(bits);
}

function startsWithCq(text) {
  return CQS.some((cq) => text.startsWith(cq));
}

function startsWithHb(text) {
  return HBS.some((hb) => text.startsWith(hb));
}

const lstrip = (s) => s.replace(/^\s+/, '');

/**
 * Text -> frames, as JS8Call's buildMessageFrames() (one line, Normal
 * speed). Returns [{frame, type}] where type is the transmission bits
 * (first/last). `forceIdentify` puts "MYCALL: " before plain text that
 * names nobody, as JS8Call does by default. Throws if some text can't be
 * sent (a character JS8 has no code for).
 */
function buildMessageFrames(mycall, mygrid, selectedCall, text, { forceIdentify = true, forceData = false } = {}) {
  const mycallCompound = isCompoundCallsign(mycall);
  const frames = [];
  let line = text;
  let hasDirected = false;
  let hasData = false;
  if (forceData) {
    forceIdentify = false;
    hasData = true;
  }
  if (line.startsWith(`${mycall}:`) || line.startsWith(`${mycall} `)) line = lstrip(line.slice(mycall.length + 1));
  if (selectedCall && !line.startsWith(selectedCall) && !line.startsWith('`') && !forceData) {
    const startsWithBase = line.startsWith('@ALLCALL') || startsWithCq(line) || startsWithHb(line);
    const calls = parseCallsigns(line);
    const startsWithStandard = calls.length > 0 && line.startsWith(calls[0]) && calls[0].length > 3;
    if (!startsWithBase && !startsWithStandard) line = `${selectedCall}${line.startsWith(' ') ? '' : ' '}${line}`;
  }
  let info = { to: '', cmd: '', num: '' };
  let guard = 0;
  while (line.length > 0) {
    if (++guard > 500) throw new Error('JS8 message too long');
    const bcn = packHeartbeatMessage(line, mycall);
    const cmp = packCompoundMessage(line);
    const dir = packDirectedMessage(line, mycall);
    const likelyData = frames.length === 0 && !selectedCall && !dir.to && bcn.n === 0 && cmp.n === 0;
    if (forceIdentify && likelyData && !line.includes(mycall)) line = `${mycall}: ${line}`;
    const dat = packDataMessage(line);

    if (!hasDirected && !hasData && bcn.n > 0) {
      frames.push({ frame: bcn.frame, type: TX.NORMAL });
      line = line.slice(bcn.n);
    } else if (!hasDirected && !hasData && cmp.n > 0) {
      frames.push({ frame: cmp.frame, type: TX.NORMAL });
      line = line.slice(cmp.n);
    } else if (!hasDirected && !hasData && dir.n > 0) {
      hasDirected = true;
      if (mycallCompound || dir.toCompound) {
        const de = packCompoundMessage(`\`${mycall} ${mygrid}`);
        if (de.frame) frames.push({ frame: de.frame, type: TX.NORMAL });
        const to = packCompoundMessage(`\`${dir.to}${dir.cmd}${dir.num}`);
        if (to.frame) frames.push({ frame: to.frame, type: TX.NORMAL });
      } else {
        frames.push({ frame: dir.frame, type: TX.NORMAL });
      }
      line = line.slice(dir.n);
      if (isCommandBuffered(dir.cmd) && line.length > 0) {
        line = lstrip(line);
        const skip = dir.to.toUpperCase() === '@APRSIS' && (dir.cmd === ' MSG' || dir.cmd === ' MSG TO:');
        const size = skip ? 0 : isCommandChecksummed(dir.cmd);
        if (size === 32) line = `${line} ${checksum32(line)}`;
        else if (size === 16) line = `${line} ${checksum16(line)}`;
      }
      info = { to: dir.to, cmd: dir.cmd, num: dir.num };
    } else if (dat.n > 0) {
      hasData = true;
      frames.push({ frame: dat.frame, type: TX.NORMAL });
      line = line.slice(dat.n);
    } else {
      throw new Error(`JS8 can't send "${line[0]}"`);
    }
  }
  if (frames.length) {
    frames[0].type |= TX.FIRST;
    frames[frames.length - 1].type |= TX.LAST;
  }
  frames.info = info;
  return frames;
}

function buildCompound(parts) {
  return parts
    .slice(0, 2)
    .filter((p) => p !== '')
    .join('/');
}

/**
 * Frame -> text, as JS8Call's DecodedText. Returns {message, frameType,
 * heartbeat, cq, from, to, cmd, num, grid}, or null if the frame doesn't
 * make sense. `message` is what JS8Call shows; data frames carry only text.
 */
function decodeFrame(frame, bits) {
  const m = frame.trim();
  if (m.length < 12 || m.includes(' ')) return null;
  const isDataTx = (bits & TX.DATA) === TX.DATA;
  if (isDataTx) {
    const data = unpackFastDataMessage(m);
    return data ? { message: data, frameType: FRAME.DATA } : null;
  }
  const data = unpackDataMessage(m);
  if (data) return { message: data, frameType: FRAME.DATA };

  const hb = unpackHeartbeatMessage(m);
  if (hb && hb.parts.length >= 2) {
    const compound = buildCompound(hb.parts);
    const grid = hb.parts[2] || '';
    let message = `${compound}: `;
    if (hb.isAlt) message += `@ALLCALL ${CQS[hb.bits3] ?? ''}`;
    else message += `@HB ${HBS[hb.bits3] === 'HB' ? 'HEARTBEAT' : HBS[hb.bits3] ?? ''}`;
    message += ` ${grid} `;
    return {
      message,
      frameType: hb.type,
      heartbeat: true,
      cq: hb.isAlt,
      from: compound,
      to: hb.isAlt ? '@ALLCALL' : '@HB',
      cmd: hb.isAlt ? ` ${CQS[hb.bits3] ?? 'CQ'}` : ' HEARTBEAT',
      grid,
    };
  }

  const cmp = unpackCompoundMessage(m);
  if (cmp && cmp.parts.length >= 2) {
    const compound = buildCompound(cmp.parts);
    const extraParts = cmp.parts.slice(2);
    if (cmp.type === FRAME.COMPOUND) {
      const grid = (extraParts[0] || '').trim();
      return { message: `${compound}: `, frameType: cmp.type, from: compound, grid, compound: true };
    }
    return {
      message: `${compound}${extraParts.join(' ')} `,
      frameType: cmp.type,
      from: '<....>',
      to: compound,
      cmd: extraParts[0] || '',
      num: extraParts[1] || '',
      compound: true,
    };
  }

  const dir = unpackDirectedMessage(m);
  if (dir) {
    const p = dir.parts;
    return {
      message: `${p[0]}: ${p[1]}${p.slice(2).join(' ')} `,
      frameType: dir.type,
      from: p[0],
      to: p[1],
      cmd: p[2],
      num: p[3] || '',
    };
  }
  return null;
}

module.exports = {
  TX,
  FRAME,
  DIRECTED_CMDS,
  cmdKey,
  isCommandAutoreply,
  isCommandBuffered,
  isCommandChecksummed,
  isValidCallsign,
  isCompoundCallsign,
  parseCallsigns,
  packCallsign,
  unpackCallsign,
  packGrid,
  unpackGrid,
  packAlphaNumeric50,
  unpackAlphaNumeric50,
  packHeartbeatMessage,
  packCompoundMessage,
  packDirectedMessage,
  packDataMessage,
  unpackDataMessage,
  huffDecode,
  checksum16,
  checksum32,
  formatSnr,
  buildMessageFrames,
  decodeFrame,
  bitsToFrame,
  frameToBits,
};
