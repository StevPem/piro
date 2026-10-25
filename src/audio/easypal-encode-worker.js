'use strict';

/**
 * Prepares one EasyPal transmission off the main thread (spawned per
 * transmission by server/easypal-tx-bridge.js): fits the picture to the
 * transmission time (several JPEG encodes), adds Reed-Solomon protection
 * and makes the HamDRM audio: about 1.5 s on a desktop for a 90 s
 * transmission, several seconds on a Raspberry Pi.
 *
 *   workerData: { jpeg: Uint8Array, settings, seconds, rsType, name, sampleRate, amplitude }
 *   -> posts { pcm: ArrayBuffer (S16LE mono), durationSec, frames, jpeg: ArrayBuffer, width, height, quality, fileName, bytes } or { error }
 */

const { parentPort, workerData } = require('worker_threads');
const { HamDrmTransmitter, RATE } = require('./drm/transmitter');
const { fitPicture } = require('./drm/tx-picture');
const { resampleLinear } = require('./resample');

try {
  const { jpeg, settings, seconds, rsType, name, sampleRate, amplitude } = workerData;
  const tx = new HamDrmTransmitter(settings);
  const pic = fitPicture(Buffer.from(jpeg), { tx, seconds, rsType, name });
  let { audio, frames, seconds: durationSec } = tx.encode(pic.data, name, pic.ext, { amplitude });
  if (sampleRate !== RATE) audio = resampleLinear(audio, RATE, sampleRate);
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, audio[i])) * 32767);
  const jpg = pic.jpeg.buffer.slice(pic.jpeg.byteOffset, pic.jpeg.byteOffset + pic.jpeg.byteLength);
  parentPort.postMessage(
    { pcm: pcm.buffer, durationSec, frames, jpeg: jpg, width: pic.width, height: pic.height, quality: pic.quality, fileName: `${name}.${pic.ext}`, bytes: pic.data.length },
    [pcm.buffer, jpg]
  );
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
