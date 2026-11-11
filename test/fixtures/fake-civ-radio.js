'use strict';

// A stand-in IC-7300 on a serial port, for CivDriver's `transport` option:
// it answers CI-V commands as the radio does (frequency, mode, DATA mode,
// PTT, CW text, scope, model ID, 1A 05 settings) and can echo every frame
// back first, as a USB CI-V port with "CI-V USB Echo Back" on does. Not a
// hardware capture.

const { EventEmitter } = require('node:events');

const PRE = [0xfe, 0xfe];
const FD = 0xfd;

function bcd(hz) {
  const s = String(Math.round(hz)).padStart(10, '0');
  const out = [];
  for (let i = 8; i >= 0; i -= 2) out.push((Number(s[i]) << 4) | Number(s[i + 1]));
  return out;
}
function fromBcd(bytes) {
  let hz = 0;
  for (let i = bytes.length - 1; i >= 0; i--) hz = hz * 100 + (bytes[i] >> 4) * 10 + (bytes[i] & 0x0f);
  return hz;
}

class FakeCivRadio extends EventEmitter {
  constructor({ addr = 0x94, model = 0x94, echo = false } = {}) {
    super();
    Object.assign(this, { addr, model, echo });
    this.isOpen = true;
    this.freq = 14074000;
    this.mode = 0x01; // USB
    this.filter = 1;
    this.dataMode = false;
    this.ptt = false;
    this.cwText = [];
    this.params = new Map([['0032', [0x01]], ['0079', [0x00]], ['0080', [0x00]]]);
    this.written = []; // every frame PiRO or a client sent, as hex
    this.scopeTimer = null;
    this._buf = Buffer.alloc(0);
  }

  /** CivDriver's port interface. */
  write(bytes, cb) {
    this._buf = Buffer.concat([this._buf, Buffer.from(bytes)]);
    let end;
    while ((end = this._buf.indexOf(FD)) !== -1) {
      const frame = this._buf.subarray(0, end + 1);
      this._buf = this._buf.subarray(end + 1);
      const start = frame.indexOf(0xfe);
      if (start === -1 || frame[start + 1] !== 0xfe) continue;
      this._frame(Buffer.from(frame.subarray(start)));
    }
    cb?.();
    return true;
  }

  close(cb) {
    this.isOpen = false;
    this.stopScope();
    cb?.();
  }

  set() {}

  stopScope() {
    clearInterval(this.scopeTimer);
    this.scopeTimer = null;
  }

  /** Sends bytes as if from the radio. */
  push(bytes) {
    setImmediate(() => this.emit('data', Buffer.from(bytes)));
  }

  _reply(to, body) {
    this.push([...PRE, to, this.addr, ...body, FD]);
  }

  _frame(f) {
    this.written.push(f.toString('hex'));
    if (this.echo) this.push(f);
    const to = f[2];
    const from = f[3];
    const cmd = f[4];
    const p = [...f.subarray(5, f.length - 1)];
    if (to !== this.addr && to !== 0) return;
    const ok = () => this._reply(from, [0xfb]);
    switch (cmd) {
      case 0x03:
        return this._reply(from, [0x03, ...bcd(this.freq)]);
      case 0x04:
        return this._reply(from, [0x04, this.mode, this.filter]);
      case 0x05:
        this.freq = fromBcd(p);
        return ok();
      case 0x06:
        this.mode = p[0];
        this.filter = p[1] ?? 1;
        this.dataMode = false;
        return ok();
      case 0x19:
        return this._reply(from, [0x19, 0x00, this.model]);
      case 0x17:
        if (p[0] !== 0xff) this.cwText.push(Buffer.from(p).toString('latin1'));
        return ok();
      case 0x1a:
        if (p[0] === 0x06) {
          if (p.length > 1) {
            this.dataMode = p[1] === 1;
            return ok();
          }
          return this._reply(from, [0x1a, 0x06, this.dataMode ? 1 : 0, this.dataMode ? this.filter : 0]);
        }
        if (p[0] === 0x05) {
          const key = Buffer.from(p.slice(1, 3)).toString('hex');
          if (p.length > 3) {
            this.params.set(key, p.slice(3));
            return ok();
          }
          return this._reply(from, [0x1a, 0x05, ...p.slice(1, 3), ...(this.params.get(key) || [0])]);
        }
        return ok();
      case 0x1c:
        if (p[0] === 0x00) {
          if (p.length > 1) {
            this.ptt = p[1] === 1;
            this.emit('ptt', this.ptt);
            return ok();
          }
          return this._reply(from, [0x1c, 0x00, this.ptt ? 1 : 0]);
        }
        return ok();
      case 0x27:
        if (p[0] === 0x11 && p.length > 1) {
          // scope data output on/off
          this.stopScope();
          if (p[1] === 1) {
            this.scopeTimer = setInterval(() => {
              // a one-division scope line: 27 00 00 seq=01 of 01, centre mode, then points
              this._reply(0x00, [0x27, 0x00, 0x00, 0x01, 0x01, 0x00, ...bcd(this.freq), ...bcd(25000), 0x00, ...Array(20).fill(0x20)]);
            }, 50);
            this.scopeTimer.unref?.();
          }
        }
        return ok();
      default:
        return ok();
    }
  }
}

module.exports = { FakeCivRadio, bcd, fromBcd };
