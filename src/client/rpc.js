'use strict';

// Thin client for the server's WebSocket control protocol (see
// src/server/protocol.js on the server side). Handles request/response
// correlation by id, dispatches unsolicited JSON events to subscribers,
// and decodes/routes binary frames (audio, scope data) by their leading
// type-tag byte — see BINARY_TYPE below, which must stay in sync with
// src/server/protocol.js. Also owns reconnection, since the rest of the
// app just wants "connected or not" plus a stream of events — it
// shouldn't have to know about retry logic.

// Mirrors src/server/protocol.js's BINARY_TYPE.
const BINARY_TYPE = {
  AUDIO: 0x01,
  SCOPE_LINE: 0x02,
  FT8_SPECTRUM: 0x03,
};

// Mirrors src/civ/commands.js SCOPE_MODE.
const CENTER_LIKE_MODES = new Set([0x00, 0x02]); // Center, Scroll-C

/**
 * Decodes a scope-line binary frame. Mirrors the encoder in
 * src/server/scope-bridge.js exactly — see that file's doc comment for
 * the full wire format. Keep both in sync if this format ever changes.
 */
function decodeScopeLine(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const mode = view.getUint8(1);
  const mainSub = view.getUint8(2);
  const freqA = view.getUint32(3, true);
  const freqB = view.getUint32(7, true);
  const extra = view.getUint8(11);
  const points = new Uint8Array(arrayBuffer, 12);

  const line = { mode, mainSub, points };
  if (CENTER_LIKE_MODES.has(mode)) {
    line.centerFreq = freqA;
    line.span = freqB;
  } else {
    line.startFreq = freqA;
    line.endFreq = freqB;
    line.inRange = extra === 0x01;
  }
  return line;
}

/**
 * Decodes an FT8 audio-spectrum binary frame. Mirrors the encoder in
 * src/audio/ft8-bridge.js's encodeFt8SpectrumFrame() exactly — see that
 * function's doc comment for the full wire format. Keep both in sync
 * if this format ever changes.
 */
function decodeFt8Spectrum(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const binHz = view.getFloat32(1, true);
  const bins = new Uint8Array(arrayBuffer, 5);
  return { binHz, bins };
}

export class RigLink extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this._nextId = 1;
    this._pending = new Map();
    this._reconnectDelayMs = 2000;
    this._closedByUser = false;
  }

  connect() {
    this._closedByUser = false;
    this._open();
  }

  disconnect() {
    this._closedByUser = true;
    if (this.ws) this.ws.close();
  }

  _open() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    this._dispatch('connecting');

    ws.addEventListener('open', () => {
      this.connected = true;
      this._dispatch('open');
    });

    ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        this._handleBinaryMessage(event.data);
        return;
      }
      this._handleJsonMessage(event.data);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this._rejectAllPending(new Error('Connection closed'));
      this._dispatch('close');
      if (!this._closedByUser) {
        setTimeout(() => this._open(), this._reconnectDelayMs);
      }
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  _handleJsonMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id != null && (msg.type === 'result' || msg.type === 'error')) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.data);
      else pending.reject(new Error(msg.error || 'Request failed'));
      return;
    }

    // Unsolicited event (connected/frequency/mode/ptt/rig-error/audio-error/...)
    this._dispatch(msg.type, msg.data);
  }

  _handleBinaryMessage(arrayBuffer) {
    if (arrayBuffer.byteLength < 1) return;
    const tag = new Uint8Array(arrayBuffer, 0, 1)[0];

    if (tag === BINARY_TYPE.AUDIO) {
      this._dispatch('audio-frame', arrayBuffer.slice(1));
      return;
    }
    if (tag === BINARY_TYPE.SCOPE_LINE) {
      try {
        this._dispatch('scope-line', decodeScopeLine(arrayBuffer));
      } catch {
        // malformed frame — drop it, nothing useful to recover
      }
      return;
    }
    if (tag === BINARY_TYPE.FT8_SPECTRUM) {
      try {
        this._dispatch('ft8-spectrum', decodeFt8Spectrum(arrayBuffer));
      } catch {
        // malformed frame — drop it, nothing useful to recover
      }
      return;
    }
    // Unknown tag: ignore rather than guess.
  }

  _dispatch(type, data) {
    this.dispatchEvent(new CustomEvent(type, { detail: data }));
  }

  _rejectAllPending(err) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
  }

  /** Send a control request and resolve with its result data. */
  request(type, extra = {}) {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error('Not connected'));
    }
    const id = String(this._nextId++);
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, ...extra }));
    });
  }

  /** Send one captured mic-audio frame (ArrayBuffer of raw PCM) if connected; silently drops otherwise. */
  sendAudioFrame(buffer) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const tagged = new Uint8Array(buffer.byteLength + 1);
    tagged[0] = BINARY_TYPE.AUDIO;
    tagged.set(new Uint8Array(buffer), 1);
    this.ws.send(tagged);
  }
}
