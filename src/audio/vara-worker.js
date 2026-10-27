'use strict';

/**
 * Runs one Xara VARA HF modem (audio/xara/xara.js) for server/vara-bridge.js,
 * off the main thread: the modem's DSP is light (a few percent of a core)
 * but steady, every 10 ms, and the main thread also serves CI-V, audio and
 * the WebSocket.
 *
 * Messages in:
 *   {type: 'init', call, bw, leadMs, latencyMs, driveDb}
 *   {type: 'audio', samples}  - received audio, Float32Array buffer at 48 kHz (any length)
 *   {type: 'command', line}   - a VARA command, e.g. 'LISTEN ON'
 *   {type: 'send', data}      - bytes to send over the link (Uint8Array buffer)
 * Messages out:
 *   {type: 'ready'} or {type: 'error', error}
 *   {type: 'audio', samples}  - the audio to transmit, as much as came in (10 ms behind)
 *   {type: 'lines', lines}    - the modem's replies ('PTT ON', 'CONNECTED A B 500', ...)
 *   {type: 'data', data}      - bytes received over the link
 *   {type: 'buffer', bytes}   - bytes still to send, when it changes
 */

const { parentPort } = require('worker_threads');
const { XaraModem, BLOCK } = require('./xara/xara');

let modem = null;
const pending = new Float32Array(BLOCK);
let filled = 0;
let lastBuffered = 0;

function collect() {
  const lines = modem.takeLines();
  if (lines.length) parentPort.postMessage({ type: 'lines', lines });
  const data = modem.takeData();
  if (data.length) {
    const copy = Uint8Array.from(data);
    parentPort.postMessage({ type: 'data', data: copy.buffer }, [copy.buffer]);
  }
  const buffered = modem.buffered;
  if (buffered !== lastBuffered) {
    lastBuffered = buffered;
    parentPort.postMessage({ type: 'buffer', bytes: buffered });
  }
}

// Transmit audio waiting to go back: it starts with one block of silence,
// so each 'audio' reply can be exactly as long as its input even when the
// input doesn't end on a block boundary.
let txQueue = new Float32Array(BLOCK);
let txLen = BLOCK;

function queueTx(block) {
  if (txLen + block.length > txQueue.length) {
    const bigger = new Float32Array(Math.max(txQueue.length * 2, txLen + block.length));
    bigger.set(txQueue.subarray(0, txLen));
    txQueue = bigger;
  }
  txQueue.set(block, txLen);
  txLen += block.length;
}

function audio(samples) {
  let i = 0;
  while (i < samples.length) {
    const n = Math.min(BLOCK - filled, samples.length - i);
    pending.set(samples.subarray(i, i + n), filled);
    filled += n;
    i += n;
    if (filled === BLOCK) {
      queueTx(modem.process(pending));
      filled = 0;
    }
  }
  const out = txQueue.slice(0, samples.length);
  txQueue.copyWithin(0, samples.length, txLen);
  txLen -= samples.length;
  collect();
  parentPort.postMessage({ type: 'audio', samples: out.buffer }, [out.buffer]);
}

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'init') {
      modem = new XaraModem(msg);
      filled = 0;
      txQueue = new Float32Array(BLOCK);
      txLen = BLOCK;
      lastBuffered = 0;
      parentPort.postMessage({ type: 'ready' });
      return;
    }
    if (!modem) return;
    if (msg.type === 'audio') audio(new Float32Array(msg.samples));
    else if (msg.type === 'command') {
      modem.command(msg.line);
      collect();
    } else if (msg.type === 'send') {
      modem.send(Buffer.from(msg.data));
      collect();
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message });
  }
});
