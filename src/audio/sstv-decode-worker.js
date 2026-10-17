'use strict';

/**
 * Runs inside a Node worker_thread (spawned by server/sstv-decoder-bridge.js).
 * The SSTV receiver costs a few percent of a Raspberry Pi core while a
 * picture comes in, and its slant correction at the end of each picture is
 * a burst of work that would otherwise hold up CI-V, audio and the
 * WebSocket.
 *
 * Protocol (plain objects via postMessage):
 *   -> { type: 'samples', samples: ArrayBuffer (Float32, 12 kHz mono) }
 *   -> { type: 'flush' }      end a picture in progress now (e.g. PTT, Stop)
 *   -> { type: 'reset' }      drop everything and listen afresh
 *   <- { type: 'start', mode, name, width, lines, lineHeight, shiftHz }
 *   <- { type: 'line', y, rgb: ArrayBuffer }
 *   <- { type: 'end', mode, name, width, lines, lineHeight, rgb: ArrayBuffer, rate, skip, slantDeg, complete, linesReceived, shiftHz }
 *   <- { type: 'fskid', text }  the FSK ID (callsign) sent after a whole picture
 *   <- { type: 'ack', samples }
 *   <- { type: 'error', error }
 */

const { parentPort } = require('worker_threads');
const { SstvReceiver } = require('./sstv-rx');

let rx = new SstvReceiver();

function post(events) {
  for (const e of events) {
    if (e.rgb) {
      const buf = e.rgb.buffer.slice(e.rgb.byteOffset, e.rgb.byteOffset + e.rgb.byteLength);
      parentPort.postMessage({ ...e, rgb: buf }, [buf]);
    } else parentPort.postMessage(e);
  }
}

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'samples': {
        const samples = new Float32Array(msg.samples);
        post(rx.process(samples));
        parentPort.postMessage({ type: 'ack', samples: samples.length });
        break;
      }
      case 'flush':
        post(rx.flush());
        break;
      case 'reset':
        rx = new SstvReceiver();
        break;
      default:
        break;
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message });
  }
});
