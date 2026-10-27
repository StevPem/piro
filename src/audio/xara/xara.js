'use strict';

/**
 * Xara's VARA HF modem (https://github.com/x0rro/xara, MIT), compiled to
 * WebAssembly (xara.wasm, built by third_party/xara/build-wasm.sh). One
 * XaraModem is one modem, with its own copy of the module.
 *
 * It works like VARA HF without the TCP ports: audio in and out at 48 kHz in
 * 10 ms blocks, VARA's commands in (`command('CONNECT VK3TR VK3ABC')`), its
 * replies out (`takeLines()`: 'CONNECTED VK3TR VK3ABC 500', 'PTT ON', 'SN 21.3',
 * ...), and the data stream both ways (`send()`, `takeData()`). See
 * docs: third_party/xara/README.md.
 */

const fs = require('fs');
const path = require('path');

const RATE = 48000;
const BLOCK = 480; // 10 ms, as xara's own audio loop
let wasmModule = null;

function compiled() {
  if (!wasmModule) wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 'xara.wasm')));
  return wasmModule;
}

class XaraModem {
  /**
   * @param {object} opts
   * @param {string} opts.call - callsign
   * @param {number} [opts.bw=500] - 500, 2300 or 2750 Hz
   * @param {number} [opts.leadMs=0] - PTT lead: transmit audio starts this long after PTT is asked for
   * @param {number} [opts.latencyMs=0] - more transmit delay the audio path adds on its own (the
   *   sound card's buffer); the modem holds PTT that much longer and times its replies to suit
   * @param {number} [opts.driveDb=-5] - transmit level, -30..0 dB (xara's default -5)
   */
  constructor({ call, bw = 500, leadMs = 0, latencyMs = 0, driveDb = -5 }) {
    this.instance = new WebAssembly.Instance(compiled(), {});
    this.x = this.instance.exports;
    this.audioPtr = this.x.xr_audio_buffer(BLOCK);
    const c = this._write(String(call).toUpperCase());
    const ms = (v) => Math.max(0, Math.round((v * RATE) / 1000));
    const r = this.x.xr_init(bw, c.ptr, c.len, ms(leadMs), ms(latencyMs), driveDb);
    this.x.xr_free(c.ptr, c.len);
    if (r !== 0) throw new Error(`xara: bandwidth must be 500, 2300 or 2750 Hz (got ${bw})`);
    this.ptt = false;
  }

  _write(text) {
    const b = Buffer.isBuffer(text) ? text : Buffer.from(text, 'latin1');
    const ptr = this.x.xr_alloc(b.length);
    new Uint8Array(this.x.memory.buffer, ptr, b.length).set(b);
    return { ptr, len: b.length };
  }

  /**
   * Runs the modem over one block of received audio (BLOCK samples, -1..1) and
   * returns the block to transmit (a new Float32Array). `ptt` says whether the
   * modem wants the transmitter keyed for this block.
   */
  process(samples) {
    const buf = new Float32Array(this.x.memory.buffer, this.audioPtr, BLOCK);
    buf.set(samples);
    this.ptt = (this.x.xr_process(this.audioPtr, BLOCK) & 1) === 1;
    return new Float32Array(this.x.memory.buffer, this.audioPtr, BLOCK).slice();
  }

  /** One VARA command, e.g. 'LISTEN ON' (no CR). */
  command(line) {
    const c = this._write(line);
    this.x.xr_command(c.ptr, c.len);
    this.x.xr_free(c.ptr, c.len);
  }

  /** Data to send over the link (a string is sent as Latin-1, as VARA's data port carries bytes). */
  send(data) {
    const c = this._write(data);
    this.x.xr_send(c.ptr, c.len);
    this.x.xr_free(c.ptr, c.len);
  }

  _take(which) {
    const n = this.x.xr_take(which);
    if (!n) return Buffer.alloc(0);
    return Buffer.from(new Uint8Array(this.x.memory.buffer, this.x.xr_take_ptr(), n));
  }

  /** The command-port replies since the last call, one string each. */
  takeLines() {
    return this._take(0)
      .toString('latin1')
      .split('\r')
      .filter(Boolean);
  }

  /** Data received over the link since the last call (a Buffer). */
  takeData() {
    return this._take(1);
  }

  /** Bytes still to send (VARA's BUFFER). */
  get buffered() {
    return this.x.xr_buffered();
  }
}

module.exports = { XaraModem, RATE, BLOCK };
