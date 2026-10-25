'use strict';

// Run with: node test/easypal-tx.test.js
// EasyPal (HamDRM) transmit: the transmitter (src/audio/drm/transmitter.js,
// a port of QSSTV's) decoded by our receiver in several modes, the picture
// fitting (tx-picture.js), the settings from the environment, and the
// transmit bridge (server/easypal-tx-bridge.js) with the real encode worker.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const jpegJs = require('jpeg-js');
const { HamDrmTransmitter, normaliseSettings, transportId, crc } = require('../src/audio/drm/transmitter');
const { fitPicture } = require('../src/audio/drm/tx-picture');
const { HamDrmReceiver } = require('../src/audio/drm/receiver');
const { StreamDecimator } = require('../src/audio/decimator');
const rs = require('../src/audio/drm/rs');
const { EasypalTxBridge, easypalTxConfig } = require('../src/server/easypal-tx-bridge');
const { EVENT } = require('../src/server/protocol');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

/** 48 kHz float audio -> 12 kHz -> the receiver; returns the files. */
function receive(audio48) {
  const dec = new StreamDecimator(48000, 12000);
  const x = Float32Array.from(dec.process(Float32Array.from(audio48)));
  const files = [];
  const rx = new HamDrmReceiver({ sampleRate: 12000, onEvent: (e) => e.type === 'file' && files.push(e) });
  // a second of silence first, as on the air
  rx.process(new Float32Array(12000));
  for (let i = 0; i < x.length; i += 1200) rx.process(x.subarray(i, i + 1200));
  rx.process(new Float32Array(24000));
  return files;
}

/** A test picture, w x h, as a JPEG: smooth shading with a few soft
 * shapes and some fine texture, so it compresses about as a photo does. */
function testJpeg(w, h, quality = 95) {
  const data = Buffer.alloc(w * h * 4);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const u = x / w;
      const v = y / h;
      const blob = Math.exp(-((u - 0.6) ** 2 + (v - 0.4) ** 2) * 20);
      const n = (rnd() - 0.5) * 12;
      data[i] = Math.max(0, Math.min(255, 60 + 150 * u + 40 * blob + n));
      data[i + 1] = Math.max(0, Math.min(255, 90 + 100 * v * (1 - blob) + 30 * Math.sin(u * 9) + n));
      data[i + 2] = Math.max(0, Math.min(255, 180 - 120 * v + 60 * blob + n));
      data[i + 3] = 255;
    }
  }
  return jpegJs.encode({ data, width: w, height: h }, quality).data;
}

const small = fs.readFileSync(path.join(__dirname, 'fixtures', 'easypal-tiny.jpg'));

// --- the parts ---
{
  check(crc(Buffer.from('123456789'), 16) !== undefined, 'CRC-16 runs');
  check(transportId('picture.jpg') === transportId('picture.jpg') && transportId('a.jpg') !== transportId('b.jpg'), 'transport id is a hash of the file name');
  let threw = 0;
  for (const bad of [{ mode: 'C' }, { bandwidth: 3 }, { qam: 8 }, { protection: 'low' }, { interleave: 'medium' }]) {
    try {
      normaliseSettings(bad);
    } catch {
      threw++;
    }
  }
  check(threw === 5, 'bad settings are refused');
  const t = new HamDrmTransmitter({ mode: 'B', qam: 16 });
  check(t.bytesPerFrame === 116, `mode B 16-QAM high protection carries ${t.bytesPerFrame} bytes a frame (116)`);
  const s1 = t.secondsFor(10000);
  const s2 = t.secondsFor(20000);
  check(s2 > s1 + 30 && Math.abs(s2 - 89) < 4, `20 kB takes about 89 s in mode B 16-QAM (${s2.toFixed(1)} s; 10 kB ${s1.toFixed(1)} s)`);
}

// --- the transmitter decoded by our receiver ---
for (const settings of [
  { mode: 'B', qam: 16, interleave: 'short', rs: 'rs2' },
  { mode: 'A', qam: 64, interleave: 'short', protection: 'normal' },
  { mode: 'E', qam: 4, interleave: 'long', bandwidth: 2.3 },
]) {
  const tx = new HamDrmTransmitter({ ...settings, callsign: 'VK3TST' });
  const name = 'VK3TST-test';
  const data = settings.rs ? rs.encodeFile(small, 'jpg', settings.rs) : small;
  const ext = settings.rs || 'jpg';
  const t0 = Date.now();
  const { audio, frames, seconds } = tx.encode(data, name, ext);
  const ms = Date.now() - t0;
  let peak = 0;
  for (const v of audio) peak = Math.max(peak, Math.abs(v));
  check(Math.abs(peak - 0.9) < 1e-6 && Math.abs(seconds - frames * 0.4) < 1e-9 && audio.length === Math.round(seconds * 48000), `${JSON.stringify(settings)}: ${frames} frames, ${seconds.toFixed(1)} s, peak 0.9, made in ${ms} ms`);
  const files = receive(audio);
  const f = files[0];
  check(files.length === 1 && f && Buffer.compare(Buffer.from(f.data), small) === 0, `${JSON.stringify(settings)}: our receiver gets the JPEG back exactly${f ? ` (${f.fileName}, from ${f.callsign})` : ''}`);
  check(f && f.callsign === 'VK3TST', `${JSON.stringify(settings)}: the callsign comes through`);
}

// --- fitting a picture to the time ---
{
  const tx = new HamDrmTransmitter({ mode: 'B', qam: 16 });
  const big = testJpeg(1600, 1200);
  const p = fitPicture(big, { tx, seconds: 60, rsType: 'rs2', name: 'VK3TST-1' });
  check(p.width <= 800 && Math.abs(p.width / p.height - 4 / 3) < 0.01 && p.quality >= 30, `a 1600 x 1200 picture is shrunk to ${p.width} x ${p.height} (quality ${p.quality})`);
  check(p.seconds <= 60 && p.seconds > 50, `it fits 60 s (${p.seconds.toFixed(1)} s, ${p.data.length} bytes with RS2)`);
  check(p.ext === 'rs2' && p.data.length > p.jpeg.length, 'the payload is the .rs2 file');
  const p2 = fitPicture(big, { tx, seconds: 120, rsType: 'rs2', name: 'VK3TST-1' });
  check(p2.width * 100 + p2.quality > p.width * 100 + p.quality && p2.seconds <= 120, `more time gives a bigger or better picture (${p2.width} x ${p2.height}, quality ${p2.quality})`);
  const p3 = fitPicture(big, { tx, seconds: 400, rsType: 'rs2', name: 'VK3TST-1' });
  check(p3.width === 800 && p3.height === 600, `with time enough it is sent at 800 x 600 (quality ${p3.quality}, ${p3.seconds.toFixed(1)} s)`);
  const tight = fitPicture(big, { tx, seconds: 30, rsType: null, name: 'VK3TST-1' });
  check(tight.seconds <= 30 && tight.width < 400 && Math.abs(tight.width / tight.height - 4 / 3) < 0.02, `30 s needs a small picture: ${tight.width} x ${tight.height}, quality ${tight.quality}, ${tight.seconds.toFixed(1)} s`);
  const never = fitPicture(big, { tx, seconds: 5, rsType: null, name: 'VK3TST-1' });
  check(never.seconds > 5 && never.quality === 10, `when nothing fits it returns the smallest (${never.width} x ${never.height}, ${never.seconds.toFixed(1)} s) for the caller to refuse`);
  const tall = fitPicture(testJpeg(300, 900), { tx, seconds: 90, rsType: null, name: 'x' });
  check(tall.height === 600 && tall.width === 200, `a tall picture keeps its shape (${tall.width} x ${tall.height})`);
  const tiny = fitPicture(testJpeg(320, 240), { tx, seconds: 300, rsType: null, name: 'x' });
  check(tiny.width === 320 && tiny.quality === 90, 'a small picture is not enlarged, and gets the top quality');
}

// --- settings from the environment ---
{
  const d = easypalTxConfig({}, 'vk3tst');
  check(d.settings.mode === 'B' && d.settings.bandwidth === 2.5 && d.settings.qam === 16 && d.settings.protection === 'high' && d.settings.interleave === 'short' && d.rsType === 'rs2' && d.seconds === 90 && d.warnings.length === 0, 'defaults: B, 2.5 kHz, 16-QAM, high, short, RS2, 90 s');
  const c = easypalTxConfig({ EASYPAL_TX_MODE: 'a', EASYPAL_TX_BANDWIDTH: '2.3', EASYPAL_TX_QAM: '64', EASYPAL_TX_PROTECTION: 'Normal', EASYPAL_TX_INTERLEAVE: 'long', EASYPAL_TX_RS: 'off', EASYPAL_TX_SECONDS: '120' });
  check(c.settings.mode === 'A' && c.settings.bandwidth === 2.3 && c.settings.qam === 64 && c.settings.protection === 'normal' && c.settings.interleave === 'long' && c.rsType === null && c.seconds === 120, 'every setting can be changed');
  const b = easypalTxConfig({ EASYPAL_TX_MODE: 'D', EASYPAL_TX_QAM: '32', EASYPAL_TX_SECONDS: '900', EASYPAL_TX_RS: 'rs9' });
  check(b.settings.mode === 'B' && b.settings.qam === 16 && b.seconds === 90 && b.rsType === 'rs2' && b.warnings.length === 4, 'bad values give a warning and the default (900 s is over the limit)');
}

// --- the transmit bridge ---
class StubCiv {
  constructor(mode = 'USB') {
    this.mode = mode;
    this.power = 100;
    this.dataMode = false;
    this.log = [];
  }
  async getMode() {
    return { mode: this.mode, filter: 1 };
  }
  async setDataMode(on) {
    this.log.push(`data ${on}`);
    this.dataMode = on;
  }
  async getDataMode() {
    return this.dataMode;
  }
  async getTxPower() {
    return this.power;
  }
  async setTxPower(w) {
    this.log.push(`power ${w}`);
    this.power = w;
  }
}
class StubControlServer extends EventEmitter {
  constructor(civ) {
    super();
    this.civ = civ;
    this.state = { ptt: false };
    this.broadcasts = [];
    this.clients = new Set([{}]);
    this.sent = [];
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
  sendJsonEvent(ws, type, data) {
    this.sent.push({ ws, type, data });
  }
  async setPttFromServer(on) {
    this.civ?.log.push(`ptt ${on}`);
    this.state.ptt = on;
  }
}
function setup({ civ = new StubCiv(), ...opts } = {}) {
  const controlServer = new StubControlServer(civ);
  const playback = { writes: [], restarts: 0, write(b) { this.writes.push(b); }, restart() { this.restarts++; } };
  const bridge = new EasypalTxBridge({
    controlServer,
    audioBridge: { sampleRate: 48000, playback },
    settings: { mode: 'B', qam: 16 },
    rsType: 'rs2',
    seconds: 40,
    callsign: 'vk3tst',
    pttReleaseMarginMs: 20,
    dataSettleMs: 0,
    dataWatchMs: 50,
    ...opts,
  });
  bridge.start();
  return { controlServer, playback, bridge, civ };
}
const statuses = (cs) => cs.broadcasts.filter((b) => b.type === EVENT.EASYPAL_TX_STATUS).map((b) => b.data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 20000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

(async () => {
  {
    const { controlServer } = setup();
    const s = controlServer.state.easypalTx;
    check(s.mode === 'B' && s.qam === 16 && s.rs === 'rs2' && s.seconds === 40 && s.bytesPerSecond === 290 && s.maxWidth === 800 && s.callsign === 'VK3TST', 'connect snapshot carries the settings');
  }
  {
    // a whole transmission through the real worker, at a shortened time
    // (the audio isn't played in real time by the stub: the bridge waits its length)
    const { controlServer, playback, bridge, civ } = setup({ txPowerW: 30, now: () => Date.UTC(2026, 9, 25, 1, 2, 3) });
    const pic = testJpeg(1024, 768);
    controlServer.emit('easypal-send', { jpeg: pic });
    check(await until(() => statuses(controlServer).some((s) => s.status === 'sending')), 'it starts sending');
    const sending = statuses(controlServer).find((s) => s.status === 'sending');
    check(statuses(controlServer)[0].status === 'preparing', 'it says "preparing" first');
    check(civ.log.join(',') === 'data true,power 30,ptt true', `DATA mode on, power set, then PTT (${civ.log.join(',')})`);
    check(sending.fileName === 'VK3TST-20261025-010203.rs2' && Math.abs(sending.width / sending.height - 4 / 3) < 0.01 && sending.durationSec <= 40 && sending.durationSec > 30 && sending.jpeg.length > 1000, `sending ${sending.fileName}, ${sending.width} x ${sending.height}, quality ${sending.quality}, ${sending.bytes} bytes, ${sending.durationSec.toFixed(1)} s`);
    const pcm = playback.writes[0];
    check(pcm && Math.abs(pcm.length / 2 / 48000 - sending.durationSec) < 0.01, 'the audio written is the length announced');
    // what went out decodes
    const audio = new Float32Array(pcm.length / 2);
    for (let i = 0; i < audio.length; i++) audio[i] = pcm.readInt16LE(i * 2) / 32768;
    const files = receive(audio);
    check(files.length === 1 && Buffer.compare(Buffer.from(files[0].data), Buffer.from(sending.jpeg, 'base64')) === 0, 'our receiver decodes the audio sent to the same JPEG');
    // a page joining part-way
    controlServer.emit('client-connected', 'ws1');
    const joined = controlServer.sent.find((m) => m.type === EVENT.EASYPAL_TX_STATUS);
    check(joined && joined.data.status === 'sending' && joined.data.elapsedSec >= 0, 'a page that connects now gets the status');
    bridge.abort(); // the test doesn't wait the full time
    check(await until(() => !bridge.transmitting), 'aborted');
    check(civ.log.join(',') === 'data true,power 30,ptt true,ptt false,power 100,data false', `PTT off, power and DATA mode put back (${civ.log.join(',')})`);
    check(statuses(controlServer).at(-1).status === 'aborted' && playback.restarts === 1, 'status "aborted", playback cut');
    check(!controlServer.broadcasts.some((b) => b.type === EVENT.EASYPAL_PICTURE), 'an aborted picture is not added to the pictures');
  }
  {
    // a short one sent to the end, then added as our own picture
    // (a stand-in encoder making 1 s of audio, so the test needn't wait 30 s)
    const encode = async () => ({ durationSec: 1, frames: 2, pcm: Buffer.alloc(96000), jpeg: small, width: 16, height: 16, quality: 90, fileName: 'VK3TST-1.jpg', bytes: small.length });
    const { controlServer, bridge, civ } = setup({ encode });
    controlServer.emit('easypal-send', { jpeg: small });
    check(await until(() => statuses(controlServer).some((s) => s.status === 'sent'), 30000), 'a short picture is sent to the end');
    check(!bridge.transmitting && civ.log.join(',') === 'data true,ptt true,ptt false,data false', `PTT and DATA mode in order (${civ.log.join(',')})`);
    const own = controlServer.broadcasts.find((b) => b.type === EVENT.EASYPAL_PICTURE);
    check(own && own.data.own && own.data.mime === 'image/jpeg' && own.data.callsign === 'VK3TST' && controlServer.easypalPictures.length === 1 && own.data.id > 0xffff, 'the sent picture is added as our own');
  }
  {
    // refusals
    const { controlServer, bridge, civ } = setup({ civ: new StubCiv('LSB') });
    await bridge.send({ jpeg: small }).catch(() => {});
    check(statuses(controlServer).at(-1).status === 'error' && /USB/.test(statuses(controlServer).at(-1).error) && civ.log.length === 0, 'refused off USB, nothing changed');
    await bridge.send({ jpeg: Buffer.from('not a jpeg') }).catch(() => {});
    check(/JPEG/.test(statuses(controlServer).at(-1).error), 'refused if not a JPEG');
    controlServer.state.ptt = true;
    civ.mode = 'USB';
    await bridge.send({ jpeg: small }).catch(() => {});
    check(/already transmitting/.test(statuses(controlServer).at(-1).error) && civ.log.length === 0, 'refused while the radio is transmitting');
  }
  {
    // too long even at the smallest: refused before PTT
    const { controlServer, bridge, civ } = setup({ encode: async () => ({ durationSec: 700, pcm: Buffer.alloc(4), jpeg: small }) });
    await bridge.send({ jpeg: small }).catch(() => {});
    check(/longer than allowed/.test(statuses(controlServer).at(-1).error) && !civ.log.includes('ptt true'), 'a transmission over the time allowed is refused before PTT');
  }
  {
    // the last browser leaving stops it, also while preparing
    let release;
    const { controlServer, bridge, civ } = setup({ encode: () => new Promise((r) => (release = r)) });
    const p = bridge.send({ jpeg: small });
    await until(() => release);
    controlServer.clients.clear();
    controlServer.emit('client-disconnected');
    release({ durationSec: 1, pcm: Buffer.alloc(96000), jpeg: small, fileName: 'x', bytes: 1 });
    await p;
    check(statuses(controlServer).at(-1).status === 'aborted' && !civ.log.includes('ptt true'), 'aborted while preparing when the last browser leaves: no PTT');
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
