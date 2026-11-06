'use strict';

/**
 * Runs the JS8 decoder (audio/js8/js8-decoder.js) and the JS8 message
 * builder for server/js8-bridge.js, off the main thread: a slot's decode
 * takes a second or more on a Pi, and the word list behind the message
 * layer (about 2 MB of text) is only loaded here.
 *
 * Messages in:
 *   {type: 'decode', id, samples, nfa, nfb, nfqso}  samples: Float32Array buffer, 12 kHz, the slot from its boundary
 *   {type: 'encode', id, mycall, mygrid, text}
 * Messages out:
 *   {type: 'decoded', id, decodes: [{freq, dt, snr, frame, bits, hardErrors, text, info}], ms}
 *   {type: 'encoded', id, frames: [{frame, bits, text}]}
 *   {type: 'error', id, error}
 */

const { parentPort } = require('worker_threads');
const { Js8Decoder } = require('./js8/js8-decoder');
const varicode = require('./js8/js8-varicode');

let decoder = null;

function decode({ samples, nfa, nfb, nfqso }) {
  if (!decoder) decoder = new Js8Decoder();
  const x = new Float32Array(samples);
  // JS8Call decodes 16-bit sample values; its thresholds assume that scale.
  const scaled = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) scaled[i] = x[i] * 32768;
  const started = Date.now();
  const found = decoder.decodeSlot(scaled, { nfa, nfb, nfqso });
  const decodes = [];
  for (const d of found) {
    const info = varicode.decodeFrame(d.frame, d.type);
    if (!info) continue;
    decodes.push({ freq: d.freq, dt: d.dt, snr: d.snr, frame: d.frame, bits: d.type, hardErrors: d.hardErrors, text: info.message, info });
  }
  return { decodes, ms: Date.now() - started };
}

function encode({ mycall, mygrid, text }) {
  const frames = varicode.buildMessageFrames(mycall, mygrid, '', text);
  return frames.map(({ frame, type }) => ({ frame, bits: type, text: varicode.decodeFrame(frame, type)?.message ?? '' }));
}

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'decode') parentPort.postMessage({ type: 'decoded', id: msg.id, ...decode(msg) });
    else if (msg.type === 'encode') parentPort.postMessage({ type: 'encoded', id: msg.id, frames: encode(msg) });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, error: err.message });
  }
});
