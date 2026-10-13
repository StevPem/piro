'use strict';

/**
 * Runs inside a Node worker_thread (spawned by server/jtty-decoder-bridge.js),
 * never required directly from the main thread. JTTY receive is CPU-heavy
 * (about 130 ms of FFT work for every 472 ms of audio at full effort on a fast
 * machine, 55 ms in the default economy mode; a Raspberry Pi is slower still), so it must not share the event loop with CI-V, audio
 * streaming and the WebSocket connection.
 *
 * Protocol (plain objects via postMessage):
 *   -> { type: 'config', lowHz, highHz, quality }  search band and effort: economy (default) | light | full | auto
 *   -> { type: 'reset' }                       start a new stream (clears partial messages)
 *   -> { type: 'samples', samples: ArrayBuffer (Float32, 12 kHz mono) }
 *   -> { type: 'flush' }                       expire partial messages
 *   <- { type: 'update', update }              a JttyReceiver message update
 *   <- { type: 'ack', samples }                samples consumed (for backlog accounting)
 *   <- { type: 'load', light, avgWindowMs }    the receiver switched search mode to keep up
 */

const { parentPort } = require('worker_threads');
const { JttyReceiver, LoadGovernor } = require('./jtty-rx');

let receiver = new JttyReceiver({ onMessage: (update) => parentPort.postMessage({ type: 'update', update }) });
let governor = new LoadGovernor();
// 'economy' (default), 'light', 'full', or 'auto' (full, dropping to economy under load)
let quality = 'economy';
const LEVELS = { full: 0, light: 1, economy: 2, auto: 0 };

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'config':
        receiver.setBand(msg.lowHz, msg.highHz);
        if (msg.quality in LEVELS) {
          quality = msg.quality;
          receiver.setLight(LEVELS[quality]);
        }
        break;
      case 'reset': {
        const band = { lowHz: receiver.lowHz, highHz: receiver.highHz };
        receiver = new JttyReceiver({ ...band, light: receiver.level, onMessage: (update) => parentPort.postMessage({ type: 'update', update }) });
        break;
      }
      case 'flush':
        receiver.flush();
        break;
      case 'samples': {
        const samples = new Float32Array(msg.samples);
        const t0 = process.hrtime.bigint();
        const windows = receiver.push(samples);
        parentPort.postMessage({ type: 'ack', samples: samples.length });
        if (windows > 0 && quality === 'auto') {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6 / windows;
          const change = governor.update(ms);
          if (change !== null) {
            receiver.setLight(change ? 2 : 0);
            parentPort.postMessage({ type: 'load', light: change, avgWindowMs: Math.round(ms) });
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message });
  }
});
