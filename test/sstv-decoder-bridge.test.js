// Run with: node test/sstv-decoder-bridge.test.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { SstvDecoderBridge, encodeSstvLineFrame } = require('../src/server/sstv-decoder-bridge');
const { EVENT, BINARY_TYPE } = require('../src/server/protocol');
const { encodeSstv } = require('../src/audio/sstv-tx');
const { upsampleFloatToPcm } = require('../src/audio/resample');
const { encodePng, crc32 } = require('../src/server/png');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StubControlServer extends EventEmitter {
  constructor(state = {}) {
    super();
    this.state = { sstvActive: false, ...state };
    this.broadcasts = [];
    this.binary = [];
  }
  broadcastBinary(buf) {
    this.binary.push(buf);
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
}

/** Reads a PNG written by encodePng() back into RGB (8-bit RGB, Sub filter only). */
function decodePng(buf) {
  check(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG: signature');
  let off = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  let crcOk = true;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== buf.readUInt32BE(off + 8 + len)) crcOk = false;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  check(crcOk, 'PNG: chunk CRCs');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let i = 0; i < w * 3; i++) {
      const v = raw[y * (w * 3 + 1) + 1 + i];
      rgb[y * w * 3 + i] = (v + (i >= 3 ? rgb[y * w * 3 + i - 3] : 0)) & 0xff;
    }
  }
  return { w, h, rgb };
}

(async () => {
  {
    const rgb = Uint8Array.from({ length: 5 * 3 * 3 }, (_, i) => (i * 37) & 0xff);
    const back = decodePng(encodePng(rgb, 5, 3));
    check(back.w === 5 && back.h === 3 && back.rgb.every((v, i) => v === rgb[i]), 'PNG round trip');
    const f = encodeSstvLineFrame(7, 12, 2, Uint8Array.of(1, 2, 3, 4, 5, 6));
    check(f[0] === BINARY_TYPE.SSTV_LINE && f.readUInt16LE(1) === 7 && f.readUInt16LE(3) === 12 && f.readUInt16LE(5) === 2 && f.subarray(7).join() === '1,2,3,4,5,6', 'SSTV_LINE frame: tag, picture id, line, width, RGB');
  }

  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sstv-'));
  const controlServer = new StubControlServer();
  const capture = new EventEmitter();
  const bridge = new SstvDecoderBridge({ controlServer, audioBridge: { capture, sampleRate: 48000 }, saveDir, now: () => Date.UTC(2026, 9, 17, 12, 34, 56) });
  bridge.start();
  check(!bridge.attached && capture.listenerCount('data') === 0, 'idle until SSTV is selected');
  controlServer.emit('sstv-active', true);
  check(bridge.attached && capture.listenerCount('data') === 1, 'attaches to capture when SSTV is selected');

  // a real (if short) Robot 8 B/W picture through the 48 kHz path and the worker
  const w = 320;
  const h = 120;
  const img = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) img.fill(i % w < 160 ? 255 : 0, i * 3, i * 3 + 3);
  const enc = encodeSstv(img, w, h, 'R8BW', { amplitude: 0.4 });
  const pcm = upsampleFloatToPcm(Float32Array.from([...new Float32Array(6000), ...enc.samples, ...new Float32Array(12000)]), 12000, 48000);
  for (let i = 0; i < pcm.length; i += 9600) {
    capture.emit('data', pcm.subarray(i, i + 9600));
    while ((bridge._sentSamples - bridge._ackedSamples) / 12000 > 2) await sleep(5);
  }
  const t0 = Date.now();
  while (!controlServer.broadcasts.some((b) => b.type === EVENT.SSTV_PICTURE) && Date.now() - t0 < 10000) await sleep(20);
  const start = controlServer.broadcasts.find((b) => b.type === EVENT.SSTV_START)?.data;
  const pic = controlServer.broadcasts.find((b) => b.type === EVENT.SSTV_PICTURE)?.data;
  const lines = controlServer.binary.filter((b) => b[0] === BINARY_TYPE.SSTV_LINE);
  const spectra = controlServer.binary.filter((b) => b[0] === BINARY_TYPE.FT8_SPECTRUM);
  check(start?.mode === 'R8BW' && start.width === 320 && start.lines === 120 && start.id === 1, `sstv-start broadcast (${start?.name}, ${start?.width} x ${start?.lines})`);
  check(lines.length === 120 && lines.every((f, i) => f.readUInt16LE(1) === 1 && f.readUInt16LE(3) === i), `120 SSTV_LINE frames, in order (${lines.length})`);
  check(pic && pic.complete && pic.mode === 'R8BW' && typeof pic.png === 'string', 'sstv-picture broadcast with the PNG');
  if (pic) {
    const back = decodePng(Buffer.from(pic.png, 'base64'));
    let err = 0;
    for (let i = 0; i < back.rgb.length; i++) err += Math.abs(back.rgb[i] - img[i]);
    check(back.w === 320 && back.h === 120 && err / back.rgb.length < 12, `the PNG is the picture (mean error ${(err / back.rgb.length).toFixed(1)})`);
  }
  check(controlServer.sstvPictures.length === 1 && controlServer.sstvPictures[0] === pic, 'kept for pages that connect later');
  check(spectra.length > 0, 'audio spectrum broadcast while SSTV is selected');
  await sleep(100);
  const saved = fs.readdirSync(saveDir);
  check(saved.length === 1 && saved[0] === '20261017-123456z-R8BW.png', `saved to SSTV_SAVE_DIR as ${saved[0]}`);

  controlServer.emit('ptt', true);
  check(!bridge.attached, 'detaches while transmitting');
  controlServer.emit('ptt', false);
  check(bridge.attached, 'reattaches after');
  controlServer.emit('sstv-active', false);
  check(!bridge.attached && capture.listenerCount('data') === 0, 'detaches when SSTV is deselected');
  bridge.stop();

  {
    const cs = new StubControlServer();
    const b = new SstvDecoderBridge({ controlServer: cs, audioBridge: { capture: new EventEmitter(), sampleRate: 44100 } });
    b.start();
    cs.emit('sstv-active', true);
    check(!b.attached && cs.broadcasts.some((x) => x.type === EVENT.AUDIO_ERROR && /multiple of 12000/.test(x.data.message)), 'an unsupported capture rate is reported, not attached');
    b.stop();
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall SSTV bridge tests passed');
})();
