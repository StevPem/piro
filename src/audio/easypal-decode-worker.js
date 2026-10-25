'use strict';

/**
 * Runs inside a Node worker_thread (spawned by server/easypal-decoder-bridge.js).
 * The HamDRM receiver (audio/drm/) costs about 2% of a desktop core and
 * more on a Pi, with bursts when it locks on (the Wiener filter set-up) and
 * when a JPEG 2000 picture is decoded at the end.
 *
 * Protocol (plain objects via postMessage):
 *   -> { type: 'samples', samples: ArrayBuffer (Float32, 12 kHz mono) }
 *   -> { type: 'reset' }      drop everything and listen afresh
 *   <- { type: 'status', stage, snr, mode, callsign, frequencyOffsetHz, packetOk, file }
 *   <- { type: 'header', transportId, fileName, bodySize }
 *   <- { type: 'segment', transportId, fileName, received, total, ... }
 *   <- { type: 'preview', transportId, fileName, mime, data: ArrayBuffer }  the start of a JPEG coming in
 *   <- { type: 'file', fileName, data: ArrayBuffer, display: {mime, data: ArrayBuffer, width, height}|{text}|null, callsign, modeCode, segments, recovered, seconds }
 *   <- { type: 'lost' }       the signal has gone
 *   <- { type: 'ack', samples }
 *   <- { type: 'error', error }
 */

const { parentPort } = require('worker_threads');
const { HamDrmReceiver } = require('./drm/receiver');
const { toDisplay, sniff } = require('./drm/picture');

const PREVIEW_EVERY_MS = 3000;

const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

let rx;
let lastPreview = { id: -1, have: 0, at: 0 };

function onEvent(ev) {
  if (ev.type === 'file') {
    let display = null;
    try {
      display = toDisplay(ev.data, ev.fileName);
    } catch (err) {
      parentPort.postMessage({ type: 'error', error: `couldn't show ${ev.fileName}: ${err.message}` });
    }
    const data = toArrayBuffer(ev.data);
    const transfer = [data];
    let disp = display;
    if (display && display.data) {
      disp = { ...display, data: display.data === ev.data ? data.slice(0) : toArrayBuffer(display.data) };
      transfer.push(disp.data);
    }
    parentPort.postMessage({ ...ev, data, display: disp }, transfer);
    return;
  }
  if (ev.type === 'segment') maybePreview(ev);
  parentPort.postMessage(ev);
}

/** While a plain JPEG comes in, its first part (the segments received in order) shows the top of the picture. */
function maybePreview(ev) {
  const tb = rx.source.transports.find((t) => t.id === ev.transportId);
  if (!tb || tb.done || /\.rs\d$/i.test(tb.fileName)) return;
  let n = 0;
  while (tb.segments[n]) n++;
  const now = Date.now();
  if (n < 2 || (lastPreview.id === tb.id && (n <= lastPreview.have || now - lastPreview.at < PREVIEW_EVERY_MS))) return;
  const data = Buffer.concat(tb.segments.slice(0, n));
  if (sniff(data) !== 'image/jpeg') return;
  lastPreview = { id: tb.id, have: n, at: now };
  const buf = toArrayBuffer(data);
  parentPort.postMessage({ type: 'preview', transportId: tb.id, fileName: tb.fileName, mime: 'image/jpeg', data: buf }, [buf]);
}

function reset() {
  rx = new HamDrmReceiver({ sampleRate: 12000, onEvent });
  lastPreview = { id: -1, have: 0, at: 0 };
}
reset();

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'samples': {
        const samples = new Float32Array(msg.samples);
        rx.process(samples);
        parentPort.postMessage({ type: 'ack', samples: samples.length });
        break;
      }
      case 'reset':
        reset();
        break;
      default:
        break;
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message });
  }
});
