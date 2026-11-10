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
 *
 * {type: 'close'} stops the worker cleanly: windows not yet started are
 * dropped, the model load and any inference in progress finish, the
 * onnxruntime session is released, then {type: 'closed'} and the worker
 * exits. Worker.terminate() during the model load or an inference
 * aborted the whole server process (issue #81).
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
  if (msg.type === 'close') {
    if (closing) return;
    closing = true;
    queue = queue.then(async () => {
      await loading;
      try {
        await engine.close();
      } catch {
        // nothing more to do; the worker exits anyway
      }
      parentPort.postMessage({ type: 'closed' });
      parentPort.close(); // nothing else keeps the worker running, so it exits
    });
    return;
  }
  if (msg.type !== 'decode' || closing) return;
  queue = queue.then(async () => {
    if (!(await loading) || closing) return;
    try {
      const text = await engine.decode(new Float32Array(msg.window));
      parentPort.postMessage({ type: 'text', id: msg.id, text });
    } catch (err) {
      parentPort.postMessage({ type: 'decode-error', id: msg.id, message: err.message });
    }
  });
});
