'use strict';

/**
 * Runs inside a Node worker_thread (spawned by ft8-bridge.js), never
 * required directly from the main thread. Exists because FT8 decoding is
 * genuinely CPU-heavy — measured at 1-3+ seconds for a moderately busy
 * band on fast hardware, plausibly longer on a Raspberry Pi under real
 * contest-weekend band conditions with dozens of simultaneous decodes —
 * and running that synchronously on the main thread would stall CI-V
 * serial communication, audio streaming, and the WebSocket connection
 * itself for that whole span, every 15 seconds. Node has no built-in way
 * to make a single synchronous library call yield partway through, so
 * the only real option is moving it off the main thread entirely; this
 * uses the standard library's own `worker_threads` rather than pulling
 * in a job-queue dependency, keeping the "no external dependencies"
 * goal intact for this part of the app (ft8ts itself is the one
 * accepted, deliberate exception — see README/LICENSE).
 *
 * Protocol (all messages are plain objects via postMessage):
 *   -> { type: 'decode', requestId, samples: ArrayBuffer (Float32),
 *        sampleRate, knownCallsigns: string[], protocol?: 'FT8'|'FT4' }
 *   <- { type: 'decoded', requestId, messages: DecodedMessage[],
 *        discoveredCallsigns: string[] }
 *   <- { type: 'decode-error', requestId, error: string }
 *
 * `protocol` selects which of ft8ts's decoders to run (defaults to 'FT8'
 * for backward compatibility with any caller that predates FT4 support —
 * see ft8-bridge.js#setVariant()). Both decoders take the same options
 * shape and return the same DecodedMessage shape, so nothing else here
 * needs to branch on it.
 *
 * `knownCallsigns`/`discoveredCallsigns` stand in for passing a real
 * ft8ts HashCallBook across the worker boundary, which isn't practical —
 * it's a class instance, not plain data, and worker_threads can only
 * structured-clone plain data. Each decode instead builds a *fresh*
 * HashCallBook seeded from whatever plain callsign strings the main
 * thread has accumulated across previous slots (see ft8-bridge.js), and
 * reports back any additional full (non-hashed) callsigns this decode
 * itself turned up, so the main thread's running set keeps growing.
 * Honest limitation: a hashed-callsign reference can only resolve
 * against a callsign already learned in an *earlier* slot (or earlier in
 * the same decode call's candidate order), same as it would take a
 * real operator a moment to build up context on who's on frequency —
 * this just doesn't carry a mid-decode hash table across the boundary.
 */

const { parentPort } = require('node:worker_threads');
const { decodeFT8, decodeFT4, HashCallBook } = require('@e04/ft8ts');

// A generous, permissive shape check, not a strict callsign validator —
// HashCallBook.save() already tolerates and ignores blank/short/`<...>`
// input on its own (see its own doc comment), so erring toward saving a
// few non-callsign tokens is harmless; the real failure mode being
// guarded against is a real callsign getting *missed* because a
// regex here was too strict about slashes, digits, or portable/compound
// forms (e.g. "VK2IO/P", "PJ4/K1ABC").
const CALLSIGN_LIKE = /^[A-Z0-9]{1,3}\/?[A-Z0-9]{2,4}\/?[A-Z0-9]{0,4}$/;

function looksLikeCallsign(token) {
  return token.length >= 3 && token.length <= 12 && /\d/.test(token) && CALLSIGN_LIKE.test(token);
}

function extractCallsigns(messageText) {
  return messageText
    .split(/\s+/)
    .filter((tok) => tok && !tok.startsWith('<') && looksLikeCallsign(tok));
}

parentPort.on('message', (msg) => {
  if (msg.type !== 'decode') return;
  const { requestId, samples, sampleRate, knownCallsigns, protocol } = msg;
  try {
    const floatSamples = new Float32Array(samples);
    const book = new HashCallBook();
    for (const call of knownCallsigns) book.save(call);
    const decodeFn = protocol === 'FT4' ? decodeFT4 : decodeFT8;
    const messages = decodeFn(floatSamples, { sampleRate, hashCallBook: book });
    const discoveredCallsigns = [];
    for (const m of messages) {
      for (const call of extractCallsigns(m.msg)) discoveredCallsigns.push(call);
    }
    parentPort.postMessage({ type: 'decoded', requestId, messages, discoveredCallsigns });
  } catch (err) {
    parentPort.postMessage({ type: 'decode-error', requestId, error: err.message });
  }
});
