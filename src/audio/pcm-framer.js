'use strict';

const { EventEmitter } = require('events');

/**
 * `arecord` (and any other PCM source) delivers data in arbitrary-sized
 * chunks with no relationship to Opus frame boundaries. PcmFramer buffers
 * incoming chunks and emits exactly `frameBytes`-sized frames as soon as
 * enough data has accumulated, carrying any leftover bytes over to the
 * next push().
 *
 * Event: 'frame' (Buffer, exactly frameBytes long)
 */
class PcmFramer extends EventEmitter {
  /** @param {number} frameBytes - exact byte length of each emitted frame */
  constructor(frameBytes) {
    super();
    if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
      throw new Error('PcmFramer requires a positive integer frameBytes');
    }
    this.frameBytes = frameBytes;
    this._buf = Buffer.alloc(0);
  }

  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (this._buf.length >= this.frameBytes) {
      const frame = this._buf.subarray(0, this.frameBytes);
      this._buf = this._buf.subarray(this.frameBytes);
      this.emit('frame', Buffer.from(frame));
    }
  }

  /** Discard any partial frame currently buffered (e.g. on stop/restart). */
  reset() {
    this._buf = Buffer.alloc(0);
  }
}

module.exports = { PcmFramer };
