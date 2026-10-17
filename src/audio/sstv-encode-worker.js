'use strict';

/**
 * Encodes one SSTV transmission off the main thread (spawned per
 * transmission by server/sstv-tx-bridge.js): a 110 s Scottie 1 picture is
 * over five million samples at 48 kHz, a second or more of work on a
 * Raspberry Pi that would otherwise hold up CI-V, audio and the WebSocket.
 *
 *   workerData: { rgb: Uint8Array, width, height, mode, callsign, fskId, cwId, sampleRate, amplitude }
 *   -> posts { pcm: ArrayBuffer (S16LE mono), durationSec } or { error }
 */

const { parentPort, workerData } = require('worker_threads');
const { encodeSstvTransmission } = require('./sstv-tx');

try {
  const { rgb, width, height, mode, ...opts } = workerData;
  const { samples, durationSec } = encodeSstvTransmission(rgb, width, height, mode, opts);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  parentPort.postMessage({ pcm: pcm.buffer, durationSec }, [pcm.buffer]);
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
