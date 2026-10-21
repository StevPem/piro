'use strict';

/**
 * Decodes one WSPR slot off the main thread (a busy slot takes tens of
 * seconds on a Pi; see wspr-rx.js). Messages in:
 *   {type: 'decode', requestId, samples (ArrayBuffer of Float32 at 12 kHz),
 *    hashtab: [[hash, call], ...], deadline (epoch ms)}
 * Messages out:
 *   {type: 'decoded', requestId, decodes, hashtab}
 *   {type: 'decode-error', requestId, error}
 */

const { parentPort } = require('node:worker_threads');
const { decodeWspr } = require('./wspr-rx');

parentPort.on('message', (msg) => {
  if (msg.type !== 'decode') return;
  const { requestId, samples, hashtab, deadline } = msg;
  try {
    const table = new Map(hashtab || []);
    const decodes = decodeWspr(new Float32Array(samples), { hashtab: table, deadline: deadline ?? Infinity });
    parentPort.postMessage({ type: 'decoded', requestId, decodes, hashtab: [...table] });
  } catch (err) {
    parentPort.postMessage({ type: 'decode-error', requestId, error: err.message });
  }
});
