// Run with: node test/fax-decoder-bridge.test.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { FaxDecoderBridge, encodeFaxLineFrame } = require('../src/server/fax-decoder-bridge');
const { EVENT, BINARY_TYPE } = require('../src/server/protocol');
const { encodeFax, FAX_WIDTH } = require('../src/audio/fax-tx');
const { upsampleFloatToPcm } = require('../src/audio/resample');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

class StubControlServer extends EventEmitter {
  constructor() {
    super();
    this.state = { faxActive: false };
    this.broadcasts = [];
    this.binary = [];
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
  broadcastBinary(buf) {
    this.binary.push(buf);
  }
}
const W = FAX_WIDTH;
function feed(capture, pcm, chunk = 96000) {
  for (let i = 0; i < pcm.length; i += chunk) capture.emit('data', pcm.subarray(i, i + chunk));
}
/** Pixels of a greyscale PNG (as png.js writes it: one IDAT, Sub filter). */
function decodeGreyPng(buf) {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  check(buf[25] === 0, 'the chart PNG is greyscale');
  let o = 33;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (raw[y * (w + 1) + 1 + x] + (x ? px[y * w + x - 1] : 0)) & 0xff;
  return { w, h, px };
}

(async () => {
  {
    const f = encodeFaxLineFrame(9, 3, Uint8Array.of(1, 2, 3));
    check(f[0] === BINARY_TYPE.FAX_LINE && f.readUInt16LE(1) === 9 && f.readUInt16LE(3) === 3 && f.readUInt16LE(5) === 3 && f.subarray(7).join() === '1,2,3', 'FAX_LINE frame layout: tag, chart id, line, width, grey bytes');
  }
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fax-save-'));
  const cs = new StubControlServer();
  const capture = new EventEmitter();
  const stateFile = path.join(saveDir, 'state', 'fax.json');
  const bridge = new FaxDecoderBridge({ controlServer: cs, audioBridge: { capture, sampleRate: 48000 }, saveDir, stateFile });
  bridge.start();
  check(!bridge.attached && cs.state.fax.state === 'idle', 'idle until Radiofax is selected');
  cs.emit('fax-active', true);
  check(bridge.attached && capture.listenerCount('data') === 1 && cs.state.fax.state === 'listening', 'listening once Radiofax is selected');

  const H = 30;
  const grey = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grey[y * W + x] = x < W / 2 ? 0 : 255;
  feed(capture, upsampleFloatToPcm(encodeFax({ grey, width: W, lines: H, phasingSec: 5, leadSec: 1, rateError: 1.5e-4 }), 12000, 48000));
  await bridge.settled();
  await new Promise((r) => setTimeout(r, 50));
  const kept = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check(kept.clockPpm.length === 1 && Math.abs(kept.clockPpm[0] + 150) <= 25 && Math.abs(bridge.clockPpm + 150) <= 25, `the clock error measured on a lined-up chart is kept (${kept.clockPpm[0]} ppm)`);
  {
    const again = new FaxDecoderBridge({ controlServer: new StubControlServer(), audioBridge: { capture: new EventEmitter(), sampleRate: 48000 }, stateFile });
    again.start();
    again.controlServer.emit('fax-active', true);
    check(again.clockPpm === kept.clockPpm[0] && again._rx.clockPpm === kept.clockPpm[0], 'and used from the start after a restart, so a chart started by hand is straight too');
    again.stop();
  }
  {
    // a chart without measured phasing teaches the clock by its slant
    const b3 = new FaxDecoderBridge({ controlServer: new StubControlServer(), audioBridge: { capture: new EventEmitter(), sampleRate: 48000 }, stateFile: null });
    b3._finish({ type: 'end', lines: 0, phased: false, clockMeasured: false, slantPpm: -140 });
    b3._finish({ type: 'end', lines: 0, phased: true, clockMeasured: false, clockPpm: 400, slantPpm: null });
    check(b3.clockPpm === -140, `the clock error from a straightened chart's slant is kept too (${b3.clockPpm}); a phasing that didn't measure the clock is not`);
  }
  const types = cs.broadcasts.map((b) => b.type);
  check(types.includes(EVENT.FAX_START) && types.includes(EVENT.FAX_PICTURE), 'a chart is announced and, at its end, broadcast');
  const lines = cs.binary.filter((b) => b[0] === BINARY_TYPE.FAX_LINE);
  check(lines.length >= H - 1 && lines.every((b) => b.readUInt16LE(5) === W), `its lines go out as FAX_LINE frames as they arrive (${lines.length})`);
  const pic = cs.broadcasts.find((b) => b.type === EVENT.FAX_PICTURE).data;
  check(pic.complete && pic.reason === 'the stop signal' && pic.phased === true && Math.abs(pic.lines - H) <= 2 && pic.width === W, `the chart: ${pic.width} x ${pic.lines}, ended by ${pic.reason}`);
  const png = decodeGreyPng(Buffer.from(pic.png, 'base64'));
  check(png.w === W && png.h === pic.lines && png.px[5 * W + 400] < 40 && png.px[5 * W + 1400] > 215, 'the PNG is the chart (black left half, white right half)');
  check(cs.faxPictures.length === 1 && cs.faxPictures[0] === pic, 'kept for pages that connect later');
  const saved = fs.readdirSync(saveDir).filter((f) => f.endsWith('.png'));
  check(saved.length === 1 && /^\d{8}-\d{6}z-fax\.png$/.test(saved[0]), `saved to FAX_SAVE_DIR as ${saved[0]}`);
  check(cs.broadcasts.filter((b) => b.type === EVENT.FAX_STATUS).map((b) => b.data.state).join(' ').includes('listening phasing receiving'), 'status follows the receiver: listening, phasing, receiving, listening');

  // Start now; a page connecting part-way gets the chart so far; Stop keeps it
  cs.emit('fax-start-now');
  feed(capture, upsampleFloatToPcm(encodeFax({ grey: grey.subarray(0, W * 10), width: W, lines: 10, apt: false, phasingSec: 0 }), 12000, 48000));
  const current = await cs.faxCurrent();
  check(current && current.phased === false && current.linesSoFar >= 9 && current.png, `a page that connects part-way gets the chart so far (${current?.linesSoFar} lines)`);
  cs.emit('fax-stop');
  await bridge.settled();
  check(cs.faxPictures.length === 2 && cs.faxPictures[1].reason === 'Stop' && cs.faxPictures[1].complete === false, 'Stop ends it and keeps it');
  check((await cs.faxCurrent()) === null, 'and then there is no chart coming in');

  cs.emit('ptt', true);
  check(!bridge.attached && cs.state.fax.state === 'idle', 'detaches while transmitting');
  cs.emit('ptt', false);
  check(bridge.attached, 'and comes back after');
  cs.emit('fax-active', false);
  check(!bridge.attached && capture.listenerCount('data') === 0, 'detaches when Radiofax is deselected');
  bridge.stop();
  check(cs.listenerCount('fax-active') === 0 && cs.listenerCount('fax-stop') === 0, 'stop() removes its listeners');
  fs.rmSync(saveDir, { recursive: true, force: true });

  {
    const cs2 = new StubControlServer();
    const b2 = new FaxDecoderBridge({ controlServer: cs2, audioBridge: { capture: new EventEmitter(), sampleRate: 44100 }, stateFile: null });
    b2.start();
    cs2.emit('fax-active', true);
    check(!b2.attached && cs2.broadcasts.some((b) => b.type === EVENT.AUDIO_ERROR && /multiple of 12000/.test(b.data.message)), 'an unsupported capture rate is reported, not attached');
    b2.stop();
  }

  {
    // the radio is set up for fax (NR off, notch off, FIL1) and put back after
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
        return { mode: this.mode ?? 'USB', filter: this.filter };
      }
      async setFilter(f) {
        this.log.push(['filter', f]);
        this.filter = f;
      }
    }
    const civ = new StubCiv(true, true, 2);
    const cs3 = new StubControlServer();
    const b3 = new FaxDecoderBridge({ controlServer: cs3, civ, audioBridge: { capture: new EventEmitter(), sampleRate: 48000 }, stateFile: null });
    b3.start();
    cs3.emit('fax-active', true);
    await b3.radioSettled();
    check(!civ.nr && !civ.notch && civ.filter === 1, `Radiofax turns NR and the auto notch off and selects FIL1 (${JSON.stringify(civ.log)})`);
    cs3.emit('fax-active', false);
    await b3.radioSettled();
    check(civ.nr && civ.notch && civ.filter === 2, 'leaving Radiofax puts them back');
    civ.log = [];
    cs3.emit('fax-active', true);
    await b3.radioSettled();
    await civ.setNoiseReduction(true); // the operator turns NR back on during fax
    cs3.emit('fax-active', false);
    await b3.radioSettled();
    check(civ.nr && civ.notch && civ.filter === 2 && civ.log.filter(([k]) => k === 'nr').length === 2, "a setting changed by the operator during fax is left as they set it");
    civ.log = [];
    cs3.emit('fax-active', true);
    await b3.radioSettled();
    civ.mode = 'CW'; // left fax by choosing CW (which picks its own filter)
    cs3.emit('fax-active', false);
    await b3.radioSettled();
    civ.mode = 'USB';
    check(civ.log.filter(([k]) => k === 'filter').length === 1, "after a change of mode, that mode's filter is left alone");
    civ.filter = 2;
    const civ2 = new StubCiv(false, false, 1);
    const cs4 = new StubControlServer();
    const b4 = new FaxDecoderBridge({ controlServer: cs4, civ: civ2, audioBridge: { capture: new EventEmitter(), sampleRate: 48000 }, stateFile: null });
    b4.start();
    cs4.emit('fax-active', true);
    await b4.radioSettled();
    b4.stop();
    await b4.radioSettled();
    check(civ2.log.length === 0, 'a radio already set up for fax is not touched');
    cs3.emit('fax-active', true);
    await b3.radioSettled();
    b3.stop();
    await b3.radioSettled();
    check(civ.nr && civ.notch && civ.filter === 2, 'stopping the server (or the last browser leaving) puts them back too');
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall radiofax bridge tests passed');
})();
