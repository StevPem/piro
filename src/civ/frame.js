'use strict';

/**
 * CI-V frame handling: encoding outbound frames, and parsing a raw byte
 * stream (which may contain partial frames, multiple frames, and echoed
 * frames) into discrete parsed frames.
 *
 * Frame format:
 *   FE FE <to> <from> <cmd> [<subCmd>] [<data...>] FD
 *
 * CI-V data bytes are BCD-encoded (each byte holds two decimal digits,
 * 0x00-0x99), so they never collide with the 0xFE preamble or 0xFD
 * terminator bytes used for framing. No byte-stuffing/escaping is needed.
 */

const PREAMBLE = 0xfe;
const TERMINATOR = 0xfd;

/**
 * Build a CI-V frame as a Buffer.
 * @param {object} opts
 * @param {number} opts.to - destination CI-V address
 * @param {number} opts.from - source (controller) CI-V address
 * @param {number} opts.cmd - command byte
 * @param {number} [opts.subCmd] - optional sub-command byte
 * @param {Buffer|number[]} [opts.data] - optional data bytes
 */
function encodeFrame({ to, from, cmd, subCmd, data }) {
  const parts = [PREAMBLE, PREAMBLE, to, from, cmd];
  if (subCmd !== undefined && subCmd !== null) parts.push(subCmd);
  if (data && data.length) parts.push(...data);
  parts.push(TERMINATOR);
  return Buffer.from(parts);
}

/**
 * Incremental parser: feed it chunks of bytes as they arrive from the
 * serial port, and it emits complete, well-formed frames as they're found.
 * Any bytes before the first valid preamble, or a frame missing its
 * terminator, are held in the internal buffer until more data arrives.
 */
class FrameParser {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {Array<{to:number, from:number, cmd:number, subCmd:number|null, data:Buffer, raw:Buffer}>}
   */
  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    const frames = [];

    for (;;) {
      // Find a candidate preamble byte. Note: a single trailing 0xFE at
      // the end of the buffer might be the first half of a preamble that
      // hasn't fully arrived yet (frames can be split across multiple
      // serial reads), so it must be kept, not discarded.
      const first = this._buf.indexOf(PREAMBLE);
      if (first === -1) {
        // No 0xFE anywhere; nothing useful in the buffer.
        this._buf = Buffer.alloc(0);
        break;
      }
      if (first + 1 >= this._buf.length) {
        // Only the lone possible-preamble byte is available so far.
        this._buf = this._buf.subarray(first);
        break;
      }
      if (this._buf[first + 1] !== PREAMBLE) {
        // Not actually a preamble (single 0xFE not followed by 0xFE);
        // drop it and keep scanning from the next byte.
        this._buf = this._buf.subarray(first + 1);
        continue;
      }

      // Confirmed preamble at `first`; drop any leading noise before it.
      this._buf = this._buf.subarray(first);

      const end = this._buf.indexOf(TERMINATOR);
      if (end === -1) {
        // Frame not complete yet; wait for more data.
        break;
      }

      const raw = this._buf.subarray(0, end + 1);
      this._buf = this._buf.subarray(end + 1);

      const parsed = parseSingleFrame(raw);
      if (parsed) frames.push(parsed);
      // If a malformed frame slipped through, just skip it and keep scanning.
    }

    return frames;
  }

  reset() {
    this._buf = Buffer.alloc(0);
  }
}

/**
 * Parse a single, already-delimited frame (starting with FE FE, ending
 * with FD). Returns null if the frame is too short to be valid.
 */
function parseSingleFrame(raw) {
  // Minimum: FE FE to from cmd FD = 6 bytes
  if (raw.length < 6) return null;
  if (raw[0] !== PREAMBLE || raw[1] !== PREAMBLE) return null;
  if (raw[raw.length - 1] !== TERMINATOR) return null;

  const to = raw[2];
  const from = raw[3];
  const cmd = raw[4];

  const payload = raw.subarray(5, raw.length - 1); // everything after cmd, before FD

  // Whether the first payload byte is a sub-command is command-dependent
  // (defined by higher-level command tables), so we surface the full
  // payload and let the caller decide. For convenience we also expose the
  // first payload byte as `subCmd` when present, since most multi-byte
  // commands (04, 1A, 1C, etc.) use it that way.
  const subCmd = payload.length > 0 ? payload[0] : null;
  const data = payload.length > 1 ? payload.subarray(1) : Buffer.alloc(0);

  return { to, from, cmd, subCmd, data, payload, raw: Buffer.from(raw) };
}

/**
 * Encode a frequency in whole Hz as little-endian BCD bytes, as used by
 * Icom's set/read-frequency commands.
 * @param {number} freqHz
 * @param {number} [byteLen=5] number of BCD bytes (5 = up to 10 digits / 9.999999999 GHz)
 */
function freqToBCD(freqHz, byteLen = 5) {
  const digits = Math.round(freqHz).toString().padStart(byteLen * 2, '0');
  if (digits.length > byteLen * 2) {
    throw new Error(`Frequency ${freqHz} does not fit in ${byteLen} BCD bytes`);
  }
  const bytes = [];
  for (let i = digits.length; i > 0; i -= 2) {
    const pair = digits.slice(Math.max(0, i - 2), i).padStart(2, '0');
    bytes.push(parseInt(pair, 16));
  }
  return Buffer.from(bytes);
}

/**
 * Decode little-endian BCD bytes (as used by Icom frequency fields) into
 * a whole-Hz number.
 * @param {Buffer} buf
 */
function bcdToFreq(buf) {
  let digits = '';
  for (let i = buf.length - 1; i >= 0; i--) {
    digits += buf[i].toString(16).padStart(2, '0');
  }
  return parseInt(digits, 10);
}

module.exports = {
  PREAMBLE,
  TERMINATOR,
  encodeFrame,
  parseSingleFrame,
  FrameParser,
  freqToBCD,
  bcdToFreq,
};
