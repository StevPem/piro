'use strict';

/**
 * Runs CW3 (DeepCW)'s spectrogram and model off the server's main thread,
 * for DeepCwDecoder (deepcw-decoder.js). On the main thread, onnxruntime's
 * inference and the spectrogram held up everything else, including the
 * audio to the browsers, every 8 s window: heard as dropouts in CW mode.
 *
 * In: {type: 'decode', id, window: ArrayBuffer of Float32 audio at the
 * model's sample rate}. Out: {type: 'ready'} or {type: 'load-error',
 * message} once, then {type: 'text', id, text} or {type: 'decode-error',
 * id, message} per window, in order.
 * A close request drains accepted work, then acknowledges with 'closed'.
 */

const { parentPort, workerData } = require('worker_threads');
const { DeepCwEngine } = require('./deepcw-decoder');

const engine = new DeepCwEngine({ modelPath: workerData.modelPath, metadata: workerData.metadata });

const loading = engine.load().then(
  () => {
    parentPort.postMessage({ type: 'ready' });
    return true;
  },
  (err) => {
    parentPort.postMessage({ type: 'load-error', message: err.message });
    return false;
  }
);

// One window at a time, in the order they came.
let queue = Promise.resolve();
let closing = false;
parentPort.on('message', (msg) => {
  if (closing) return;
  if (msg.type === 'close') {
    closing = true;
    // Never tear down the worker while an ONNX native callback still owns
    // its environment. Acknowledge only after all accepted work has settled.
    queue = queue.then(() => loading)
      // Leave the native completion callback's turn before acknowledging
      // teardown; promise continuations alone can still run inside it.
      .then(() => new Promise((resolve) => setImmediate(resolve)))
      .then(() => {
        engine.close();
        parentPort.postMessage({ type: 'closed' });
      });
    return;
  }
  if (msg.type !== 'decode') return;
  queue = queue.then(async () => {
    if (!(await loading)) return;
    try {
      const text = await engine.decode(new Float32Array(msg.window));
      parentPort.postMessage({ type: 'text', id: msg.id, text });
    } catch (err) {
      parentPort.postMessage({ type: 'decode-error', id: msg.id, message: err.message });
    }
  });
});
