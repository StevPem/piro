'use strict';

/**
 * Runs inside a Node worker_thread (spawned by server/olivia-decoder-bridge.js),
 * never required directly from the main thread. The Olivia receiver is light
 * (about 1% of real time on a fast PC), but it works in 1-second batches,
 * and on a Raspberry Pi each batch would otherwise hold up CI-V, audio and
 * the WebSocket for tens of milliseconds.
 *
 * Protocol (plain objects via postMessage):
 *   -> { type: 'config', centreHz, squelch }   (re)creates the receiver; squelch false = fldigi's behaviour
 *   -> { type: 'samples', samples: ArrayBuffer (Float32, 8 kHz mono) }
 *   -> { type: 'flush' }                         push the decoder pipeline out (end of a stream)
 *   <- { type: 'text', text, snr, freqOffsetHz, centreHz }
 *   <- { type: 'ack', samples }                  samples consumed (for backlog accounting)
 *   <- { type: 'error', error }
 */

const { parentPort } = require('worker_threads');
const { OliviaReceiver, OliviaTextDecoder } = require('./olivia-rx');

let receiver = null;
let textDecoder = new OliviaTextDecoder();
let centreHz = 1500;

function configure(msg) {
  centreHz = msg.centreHz ?? centreHz;
  const opts = { centreHz };
  if (msg.squelch === false) Object.assign(opts, { syncThreshold: 3, blockSnrMin: 0, dropControlBlocks: false });
  receiver = new OliviaReceiver(opts);
  textDecoder = new OliviaTextDecoder();
}

function emit(bytes) {
  if (bytes.length === 0) return;
  const text = textDecoder.push(bytes);
  if (text === '') return;
  parentPort.postMessage({
    type: 'text',
    text,
    snr: Math.round(receiver.lastOutput.snr * 10) / 10,
    freqOffsetHz: receiver.lastOutput.freqOffsetHz,
    centreHz,
  });
}

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'config':
        configure(msg);
        break;
      case 'samples': {
        const samples = new Float32Array(msg.samples);
        if (!receiver) configure({});
        emit(receiver.process(samples));
        parentPort.postMessage({ type: 'ack', samples: samples.length });
        break;
      }
      case 'flush':
        if (receiver) emit(receiver.flush());
        break;
      default:
        break;
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message });
  }
});
