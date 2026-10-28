'use strict';

/**
 * VarAC's application layer over a VARA link: how VarAC frames its chat
 * messages, the tags inside them, and how its CQs name a slot.
 *
 * VarAC is closed source; these formats come from hfmodem by Saul St John,
 * W9SSJ (https://github.com/sstjohn/hfmodem, AGPL-3.0-only, as PiRO is),
 * whose packages/hfmodem/hfmodem/contact/varac.py works them out from
 * on-air recordings of stock VarAC. This is a JavaScript port of the parts
 * PiRO uses: SlotCodec, frame_message(), MessageParser, the tag syntax and
 * the opening signal report. Not yet tested against VarAC on air from PiRO.
 *
 * - Every message is its length in bytes (decimal ASCII), a space, then
 *   the text in UTF-8: "11 hello there". A message may hold several lines
 *   (CR LF between them) and tags such as <R-05>, <NAME:Alex>, <DISC>.
 * - After connecting, each side sends an opening report: "de CALL <R+05>",
 *   the S/N it receives the other station at.
 * - A CQ's callsign carries the slot the caller waits on as its suffix:
 *   -1 to -5 are 750 to 3750 Hz below the calling frequency, -11 to -15
 *   750 to 3750 Hz above. -9 is a beacon, sent on the calling frequency.
 */

const SLOT_STEP_HZ = 750;
/** VarAC's calling frequencies (USB dial), as the client's VARA_FREQUENCIES. */
const CALLING_HZ = [1995000, 3595000, 7105000, 10133000, 14105000, 18107000, 21105000, 24927000, 28105000, 50330000];
const SERVICE_BITS = [
  [1, 'VMail'],
  [2, 'email'],
  [4, 'AI'],
  [8, 'BBS'],
];
const BEACON_SUFFIX = 9;
const MAX_MESSAGE = 1_000_000;

/** A heard CQ frame's callsign: {call (without the suffix), slot, offsetHz, beacon}. slot is null for none. */
function decodeCqCall(raw) {
  const m = /^(.+?)-(\d{1,2})$/.exec(String(raw || '').toUpperCase());
  if (!m) return { call: String(raw || '').toUpperCase(), slot: null, offsetHz: 0, beacon: false };
  const n = Number(m[2]);
  if (n === BEACON_SUFFIX) return { call: m[1], slot: null, offsetHz: 0, beacon: true };
  if (n >= 1 && n <= 5) return { call: m[1], slot: n, offsetHz: -n * SLOT_STEP_HZ, beacon: false };
  if (n >= 11 && n <= 15) return { call: m[1], slot: n, offsetHz: (n - 10) * SLOT_STEP_HZ, beacon: false };
  // Some other SSID: a station that really uses one.
  return { call: m[0], slot: null, offsetHz: 0, beacon: false };
}

/** One VarAC message on the wire: length in bytes, a space, the UTF-8 text. */
function frameMessage(text) {
  const content = Buffer.from(String(text), 'utf8');
  return Buffer.concat([Buffer.from(`${content.length} `, 'ascii'), content]);
}

/**
 * Splits the received byte stream into VarAC messages, however the modem's
 * frames cut it. If the stream doesn't start with a length (another
 * program, such as VARA Chat, sending plain text), it gives up on framing
 * for the rest of the link and passes the bytes through as plain text.
 */
class MessageParser {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.plain = false;
  }

  /** @returns {{messages: string[], plain: string}} whole messages so far (UTF-8), and any unframed text (Latin-1) */
  feed(chunk) {
    if (this.plain) return { messages: [], plain: Buffer.from(chunk).toString('latin1') };
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const messages = [];
    for (;;) {
      if (!this.pending.length) break;
      const space = this.pending.indexOf(0x20);
      const headerEnd = space < 0 ? this.pending.length : space;
      const header = this.pending.subarray(0, headerEnd).toString('latin1');
      if (!/^\d{1,9}$/.test(header) || Number(header) > MAX_MESSAGE) {
        if (space < 0 && /^\d{0,8}$/.test(header)) break; // the length may still be arriving
        // Not VarAC framing: everything from here is plain text.
        this.plain = true;
        const plain = this.pending.toString('latin1');
        this.pending = Buffer.alloc(0);
        return { messages, plain };
      }
      if (space < 0) break;
      const size = Number(header);
      const start = space + 1;
      if (this.pending.length < start + size) break;
      let end = start + size;
      const content = this.pending.subarray(start, end);
      // A VMail's length leaves out its closing '>', which follows as one more byte (hfmodem, P1 session 021).
      if (content.subarray(0, 4).toString('latin1') === '<SM>' && content[size - 1] !== 0x3e && this.pending[end] === 0x3e) end += 1;
      messages.push(this.pending.subarray(start, end).toString('utf8'));
      this.pending = this.pending.subarray(end);
    }
    return { messages, plain: '' };
  }
}

const SERVICES = { V: 'VMail', E: 'email', A: 'AI', B: 'BBS', N: 'none' };
const TAG_TEXT = {
  DISC: 'is closing the QSO',
  AWQ: 'is away (leave a VMail)',
  AWAY: 'is away',
  Q: 'is at the station',
  TL: 'has arrived on the new frequency',
  QSYR: 'is ready on the new frequency',
  QSYU: 'asks to QSY up 750 Hz',
  QSYD: 'asks to QSY down 750 Hz',
};

function mhz(hz) {
  return (hz / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** What one tag says, in words, or null to show it as it is. */
function describeTag(name, value) {
  if (name === 'R' && /^[+-]\d{2}$/.test(value)) return `reports your signal at ${Number(value)} dB`;
  if (name === 'NAME') return `name ${value}`;
  if (name === 'QTH') return `QTH ${value}`;
  if (name === 'LOC') return `locator ${value}`;
  if (name === 'EM') return `email ${value}`;
  if (name === 'S') return `offers ${[...value].map((c) => SERVICES[c] || c).join(', ')}`;
  if (name === 'Q' && value != null && /^-?\d+$/.test(value)) return `asks to QSY ${Number(value) * 10 >= 0 ? '+' : ''}${Number(value) * 10} Hz`;
  if (name === 'QF' && /^\d+$/.test(value || '')) return `is on ${mhz(Number(value))} MHz`;
  if (value == null && TAG_TEXT[name]) return TAG_TEXT[name];
  return null;
}

/**
 * A received message for the conversation. Tags are put into words
 * (unknown ones are left as they are). A message of nothing but tags is a
 * note about the link rather than conversation.
 * @returns {{text: string, note: boolean, disc: boolean, qsyHz: number|null}}
 */
function renderMessage(message, from) {
  let disc = false;
  let qsyHz = null;
  let words = [];
  let plain = '';
  // <QSYF>012-digit frequency</QSYF>: a request to move to that frequency.
  const body = message.replace(/<QSYF>(\d{1,12})<\/QSYF>/g, (_, hz) => {
    qsyHz = Number(hz);
    return `<QSYFREQ:${hz}>`;
  });
  const re = /<([A-Z/&]{1,8})(?::([^<>]*))?>|<R([+-]\d{2})>|&IT&/g;
  let last = 0;
  let m;
  const pieces = [];
  while ((m = re.exec(body))) {
    pieces.push({ text: body.slice(last, m.index) });
    last = re.lastIndex;
    if (m[0] === '&IT&') {
      pieces.push({ raw: m[0] });
      continue;
    }
    if (m[3]) {
      pieces.push({ said: describeTag('R', m[3]), raw: m[0] });
      continue;
    }
    const [, name, value] = m;
    if (name === 'DISC') disc = true;
    if (name === 'QSYFREQ') {
      pieces.push({ said: `asks to QSY to ${mhz(Number(value))} MHz`, raw: m[0] });
      continue;
    }
    pieces.push({ said: describeTag(name, value), raw: m[0] });
  }
  pieces.push({ text: body.slice(last) });
  for (const p of pieces) {
    if (p.text != null) plain += p.text;
    else if (p.said) words.push(p.said);
    else plain += p.raw;
  }
  // "de CALL" before an opening report is just the sender's name.
  const opening = /^\s*de\s+[A-Z0-9/-]+\s*$/i.test(plain) && words.length;
  plain = cleanLines(opening ? '' : plain);
  words = words.filter(Boolean);
  const who = from || 'They';
  if (!plain.trim()) return { text: words.length ? `${who} ${words.join('; ')}\n` : '', note: true, disc, qsyHz };
  return { text: `${plain}${plain.endsWith('\n') ? '' : '\n'}${words.length ? `(${words.join('; ')})\n` : ''}`, note: false, disc, qsyHz };
}

function cleanLines(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x07\x0b-\x1f\x7f]/g, '').replace(/[ \t]+\n/g, '\n');
}

/**
 * VarAC's "advanced beacon", sent as a KISS broadcast (command 2): 20
 * characters, "2", a character not yet understood, a status letter ('@'
 * plus service bits: 1 VMail, 2 email, 4 AI, 8 BBS), the 6-character
 * locator and the callsign, space padded (hfmodem, BEACON_TEXT). The
 * second character is a digit in hfmodem's recordings; one heard on
 * 2026-10-28 (DH7LK) had a letter, so any is taken.
 * @returns {{call, grid, services: string[]}|null}
 */
function decodeBeacon(text) {
  const m = /^2[0-9A-Z]([@-O])([A-R]{2}[0-9]{2}[A-X]{2})([A-Z0-9/]{3,9}) *$/.exec(String(text));
  if (!m) return null;
  const bits = m[1].charCodeAt(0) - 64;
  return { call: m[3], grid: m[2], services: SERVICE_BITS.filter(([b]) => bits & b).map(([, n]) => n) };
}

/** One AX.25 address, shifted: `len` callsign bytes then an SSID byte. "OH8XAT", or "OH8XAT-3". */
function ax25Address(b, len) {
  let call = '';
  for (let i = 0; i < len; i++) call += String.fromCharCode(b[i] >> 1);
  call = call.trim();
  const ssid = (b[len] >> 1) & 0x0f;
  return ssid ? `${call}-${ssid}` : call;
}

/**
 * An AX.25 UI frame from a KISS broadcast, as VarAC sends its addressed
 * notices: {to, from, info} or null. VARA's KISS command 1 ("long" AX.25,
 * as on air on 2026-10-28) has 7-character callsigns (8-byte addresses);
 * command 0 is ordinary AX.25 (6 characters, 7 bytes). "<SMP>" means the
 * sender has VMail waiting for the station it is addressed to (hfmodem,
 * docs/CONSOLE.md).
 */
function decodeUi(bytes, command = 1) {
  const b = Buffer.from(bytes);
  const len = command === 1 ? 7 : 6;
  const step = len + 1;
  if (b.length < 2 * step + 2) return null;
  let end = step;
  while (end + step <= b.length && !(b[end + len] & 1)) end += step; // digipeaters, if any
  end += step;
  if (end + 2 > b.length || b[end] !== 0x03) return null; // UI frames only
  return { to: ax25Address(b.subarray(0, step), len), from: ax25Address(b.subarray(step, 2 * step), len), info: b.subarray(end + 2).toString('latin1') };
}

/**
 * A QSY request in a message, as the frequency to move to: <QSYF> with a
 * 12-digit frequency, <QF:Hz>, or <Q:n> (n tens of Hz from the dial now).
 * Bare <Q> (and <AWQ>) only say the station is ready to QSY. Null if none.
 */
function qsyTarget(message, dialHz) {
  const f = /<QSYF>(\d{1,12})<\/QSYF>/.exec(message);
  if (f) return Number(f[1]);
  const qf = /<QF:(\d+)>/.exec(message);
  if (qf) return Number(qf[1]);
  const q = /<Q:(-?\d+)>/.exec(message);
  if (q && Number.isFinite(dialHz)) return dialHz + Number(q[1]) * 10;
  return null;
}

/** The QSY request this station sends: VarAC's <QSYF>, a 12-digit frequency. */
function qsyRequest(hz) {
  return `<QSYF>${String(Math.round(hz)).padStart(12, '0')}</QSYF>`;
}

/** Whether a message is the other station's opening report ("de CALL <R+05>"). */
function isOpening(message) {
  return /^\s*de\s+[A-Z0-9/-]+\s+<R[+-]\d{2}>/i.test(message);
}

/** The opening report this station sends after connecting: "de CALL <R+05>". */
function openingMessage(mycall, sn) {
  const r = Math.max(-99, Math.min(99, Math.round(sn)));
  return `de ${mycall} <R${r < 0 ? '-' : '+'}${String(Math.abs(r)).padStart(2, '0')}>`;
}

module.exports = {
  decodeCqCall,
  decodeBeacon,
  decodeUi,
  frameMessage,
  MessageParser,
  renderMessage,
  openingMessage,
  qsyTarget,
  qsyRequest,
  isOpening,
  SLOT_STEP_HZ,
  CALLING_HZ,
};
