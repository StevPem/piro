'use strict';

// Run with: node test/easypal-decoder-bridge.test.js
// EasypalDecoderBridge (src/server/easypal-decoder-bridge.js) with the real
// worker: QSSTV-made transmissions played into a stub capture stream at
// 48 kHz, and what the browsers are sent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { EasypalDecoderBridge } = require('../src/server/easypal-decoder-bridge');
const { EVENT } = require('../src/server/protocol');
const { upsampleFloatToPcm } = require('../src/audio/resample');
const fx = require('./fixtures/easypal-audio');

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
    this.state = { easypalActive: false, ...state };
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

class StubCiv {
  constructor(nr, notch, filter) {
    Object.assign(this, { nr, notch, filter, log: [] });
  }
  async getNoiseReduction() {
    return this.nr;
  }
  async setNoiseReduction(on) {
    this.log.push(['nr', on]);
    this.nr = on;
  }
  async getNotch() {
    return this.notch;
  }
  async setNotch(on) {
    this.log.push(['notch', on]);
    this.notch = on;
  }
  async getFilter() {
    return this.filter;
  }
  async getMode() {
    return { mode: 'USB', filter: this.filter };
  }
  async setFilter(f) {
    this.log.push(['filter', f]);
    this.filter = f;
  }
}

/** Plays 12 kHz audio into the capture stream at 48 kHz, in 0.1 s chunks, then waits until `until()` or a timeout. */
async function play(capture, audio, until, timeoutMs = 20000) {
  const pcm = upsampleFloatToPcm(audio, 12000, 48000);
  for (let i = 0; i < pcm.length; i += 9600) {
    capture.emit('data', pcm.subarray(i, i + 9600));
    if (i % (9600 * 20) === 0) await sleep(1);
  }
  const t0 = Date.now();
  while (!until() && Date.now() - t0 < timeoutMs) await sleep(20);
}

(async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easypal-save-'));
  const capture = new EventEmitter();
  const cs = new StubControlServer();
  const civ = new StubCiv(true, true, 2);
  const bridge = new EasypalDecoderBridge({ controlServer: cs, audioBridge: { capture, sampleRate: 48000 }, saveDir, civ, keep: 2 });
  bridge.start();
  const of = (type) => cs.broadcasts.filter((b) => b.type === type).map((b) => b.data);

  capture.emit('data', Buffer.alloc(9600));
  check(!bridge.attached, 'not listening until EasyPal is selected');
  cs.emit('easypal-active', true);
  await bridge.radioSettled();
  check(bridge.attached && cs.state.easypal.state === 'listening' && of(EVENT.EASYPAL_STATUS).at(-1)?.state === 'listening', 'selecting EasyPal starts the receiver: "listening"');
  check(!civ.nr && !civ.notch && civ.filter === 1, `and sets the radio up: NR off, auto notch off, FIL1 (${JSON.stringify(civ.log)})`);

  // a JPEG
  {
    const { audio, file, meta } = fx.loadFixture('a64');
    await play(capture, audio, () => of(EVENT.EASYPAL_PICTURE).length >= 1);
    const p = of(EVENT.EASYPAL_PICTURE)[0];
    check(p && p.fileName === 'tiny.jpg' && p.mime === 'image/jpeg' && Buffer.from(p.data, 'base64').equals(file), 'a received JPEG is broadcast as it was sent');
    check(p && p.callsign === meta.callsign && p.mode?.mode === 'A' && p.mode?.qam === 64 && p.width === 160 && p.height === 120 && p.size === file.length, `with the sender, the mode and the size (${p && `${p.callsign}, ${p.mode?.mode} ${p.mode?.qam}-QAM, ${p.width}x${p.height}`})`);
    const rec = of(EVENT.EASYPAL_STATUS).filter((s) => s.state === 'receiving');
    check(rec.length > 3 && rec.at(-1).callsign === meta.callsign && Number.isFinite(rec.at(-1).snr) && Math.abs(rec.at(-1).offsetHz) <= 2, `status while receiving: S/N ${rec.at(-1)?.snr} dB, mistuning ${rec.at(-1)?.offsetHz} Hz, callsign ${rec.at(-1)?.callsign}`);
    check(rec.some((s) => s.file && s.file.received > 0 && s.file.total >= s.file.received), 'and the file coming in, segment by segment');
    check(cs.easypalPictures.length === 1 && cs.easypalPictures[0].fileName === 'tiny.jpg', 'kept for pages that connect later');
    await sleep(100);
    const saved = fs.readdirSync(saveDir);
    check(saved.length === 1 && /^\d{8}-\d{6}z-VK2XYZ-tiny\.jpg$/.test(saved[0]) && fs.readFileSync(path.join(saveDir, saved[0])).equals(file), `saved as sent (${saved[0]})`);
  }
  // a JPEG 2000 picture, sent with Reed-Solomon
  {
    const { audio, file } = fx.loadFixture('b16-rs2');
    await play(capture, Float32Array.from([...new Float32Array(36000), ...audio]), () => of(EVENT.EASYPAL_PICTURE).length >= 2);
    const p = of(EVENT.EASYPAL_PICTURE)[1];
    check(p && p.fileName === 'tiny.jp2' && p.mime === 'image/png' && Buffer.from(p.data, 'base64').subarray(1, 4).toString() === 'PNG' && p.width === 160, 'a JPEG 2000 picture (sent as .rs2) is decoded and broadcast as a PNG');
    await sleep(100);
    const saved = fs.readdirSync(saveDir).filter((n) => n.endsWith('.jp2'));
    check(saved.length === 1 && fs.readFileSync(path.join(saveDir, saved[0])).equals(file), 'and saved as the .jp2 it was');
  }
  // the third is kept, the first forgotten (keep: 2)
  {
    const { audio } = fx.loadFixture('e4');
    await play(capture, Float32Array.from([...new Float32Array(36000), ...audio]), () => of(EVENT.EASYPAL_PICTURE).length >= 3);
    check(cs.easypalPictures.length === 2 && cs.easypalPictures[0].mode?.mode === 'B' && cs.easypalPictures[1].mode?.mode === 'E', 'only the newest few files are kept');
  }

  // transmitting stops the receiver; the end of transmitting starts it again
  cs.emit('ptt', true);
  check(!bridge.attached && cs.state.easypal.state === 'idle', 'PTT: the receiver stops ("idle")');
  cs.emit('ptt', false);
  check(bridge.attached && cs.state.easypal.state === 'listening', 'PTT released: listening again');
  check(cs.binary.length > 0, 'the audio spectrum is sent for tuning');

  cs.emit('easypal-active', false);
  await bridge.radioSettled();
  check(!bridge.attached && civ.nr && civ.notch && civ.filter === 2, "leaving EasyPal stops the receiver and puts the radio's NR, notch and filter back");
  bridge.stop();

  {
    const cs2 = new StubControlServer();
    const b2 = new EasypalDecoderBridge({ controlServer: cs2, audioBridge: { capture: new EventEmitter(), sampleRate: 44100 } });
    b2.start();
    cs2.emit('easypal-active', true);
    check(!b2.attached && cs2.broadcasts.some((b) => b.type === EVENT.AUDIO_ERROR && /multiple of 12000/.test(b.data.message)), 'an unsupported capture rate is reported, not attached');
    b2.stop();
  }
  fs.rmSync(saveDir, { recursive: true });

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall EasyPal bridge tests passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
