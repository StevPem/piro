// Run with: node test/wspr-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { WsprBridge, wsprDialFor, WSPR_DIAL_HZ, nextWsprBand, parseBandList } = require('../src/server/wspr-bridge');
const { spotBodies, slotDateTime } = require('../src/server/wsprnet');
const { EVENT } = require('../src/server/protocol');
const codec = require('../src/audio/wspr-codec');
const { decodeWspr } = require('../src/audio/wspr-rx');
const { StreamDecimator } = require('../src/audio/decimator');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await sleep(10);
  return fn();
}

class StubCiv {
  constructor() {
    this.mode = 'USB';
    this.filter = 1;
    this.frequency = 14095600;
    this.dataMode = true;
    this.power = 100;
    this.log = [];
  }
  async getMode() {
    return { mode: this.mode, filter: this.filter };
  }
  async setMode(mode, filter) {
    this.log.push(`mode ${mode}`);
    this.mode = mode;
    this.filter = filter;
    this.dataMode = false; // as the radio: the mode command turns DATA off
  }
  async getFrequency() {
    return this.frequency;
  }
  async setFrequency(hz) {
    this.log.push(`freq ${hz}`);
    this.frequency = hz;
  }
  async getDataMode() {
    return this.dataMode;
  }
  async setDataMode(on) {
    this.log.push(`data ${on}`);
    this.dataMode = on;
  }
  async getTxPower() {
    return this.power;
  }
  async setTxPower(w) {
    this.log.push(`power ${w}`);
    this.power = w;
  }
  // antenna tuner: 2 starts a tune, which reads back as 2 (and transmitting) for a few reads
  async setTuner(v) {
    this.log.push(`tuner ${v}`);
    this.tuner = v;
    this.tuneReads = v === 2 ? 2 : 0;
  }
  async getTuner() {
    if (this.tuner === 2 && !this.tuneStuck && this.tuneReads-- <= 0) this.tuner = 1;
    return this.tuner ?? 1;
  }
  async getTransmitting() {
    return this.tuner === 2;
  }
  async setPtt(on) {
    this.log.push(`setPtt ${on}`);
  }
}

class StubControlServer extends EventEmitter {
  constructor(civ) {
    super();
    this.civ = civ;
    this.state = { frequency: civ.frequency, ptt: false, wsprActive: false };
    this.clients = new Set(['a']);
    this.broadcasts = [];
    this.binary = [];
    this.sent = [];
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
  broadcastBinary(buf) {
    this.binary.push(buf);
  }
  sendJsonEvent(ws, type, data) {
    this.sent.push({ ws, type, data });
  }
  async setPttFromServer(on) {
    this.civ.log.push(`ptt ${on}`);
    this.state.ptt = on;
    this.emit('ptt', on);
  }
}

class StubSlotClock extends EventEmitter {
  constructor(now) {
    super();
    this.now = now;
  }
  currentSlotStart(t = this.now()) {
    return t - (t % 120000);
  }
  start() {}
  stop() {}
  fire(slotStartMs) {
    this.emit('boundary', { slotStartMs, slotMs: 120000 });
  }
}

function setup(opts = {}) {
  let t = opts.t0 ?? 0;
  const now = () => t;
  const civ = new StubCiv();
  const controlServer = new StubControlServer(civ);
  const capture = new EventEmitter();
  const playback = { writes: [], restarts: 0, write(b) { this.writes.push(b); }, restart() { this.restarts++; } };
  const slotClock = new StubSlotClock(now);
  const uploads = [];
  const wsprnet = { upload: async (slot) => { uploads.push(slot); return { sent: 1, spots: 1 }; } };
  const bridge = new WsprBridge({
    controlServer,
    audioBridge: { capture, playback, sampleRate: 48000 },
    callsign: 'VK3TR',
    grid: 'QF22LB',
    slotClock,
    wsprnet,
    now,
    random: () => 0,
    dataSettleMs: 0,
    dataWatchMs: 1000000,
    pttReleaseMarginMs: 0,
    spectrumIntervalMs: 1000000,
    ...opts,
  });
  bridge.start();
  return { bridge, civ, controlServer, capture, playback, slotClock, uploads, setTime: (v) => (t = v) };
}
const statusOf = (cs) => cs.state.wspr;

// mulberry32, for repeatable noise
let seed = 99;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return (((x ^ (x >>> 14)) >>> 0) + 0.5) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());

/** 114 s of 48 kHz PCM with one WSPR signal (SNR in 2500 Hz) starting 1 s in. */
function slotPcm(msg, hz, snr) {
  const rate = 48000;
  const n = 114 * rate;
  const sigma = 0.02;
  const amp = Math.sqrt(2 * 10 ** (snr / 10) * sigma * sigma * (2500 / (rate / 2)));
  const w = codec.synthesize(codec.encodeMessage(...msg).symbols, { baseHz: hz, sampleRate: rate, amplitude: amp, rampMs: 0 });
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = sigma * gauss() + (i >= rate && i - rate < w.length ? w[i - rate] : 0);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 2 * i);
  }
  return buf;
}
function feed(capture, pcm, chunk = 19200) {
  for (let i = 0; i < pcm.length; i += chunk) capture.emit('data', pcm.subarray(i, i + chunk));
}

(async () => {
  {
    check(wsprDialFor(14074000) === 14095600 && wsprDialFor(7100000) === 7038600 && wsprDialFor(3600000) === 3568600 && wsprDialFor(50313000) === 50293000, 'the WSPR dial frequency is picked for the band the radio is on');
    check(wsprDialFor(null) === WSPR_DIAL_HZ['20m'] && wsprDialFor(144200000) === WSPR_DIAL_HZ['20m'], 'and 20 m when the band has none');
  }
  {
    const bodies = spotBodies({
      rcall: 'VK3TR',
      rgrid: 'QF22LB',
      dialHz: 14095600,
      slotStartMs: Date.UTC(2026, 9, 22, 9, 10),
      decodes: [{ snr: -21, dt: 0.4, drift: 0, audioHz: 1520.3, callsign: 'K1ABC', grid: 'FN42', dbm: 37 }],
      version: 'PiRO-v87',
    });
    const q = new URLSearchParams(bodies[0]);
    check(
      bodies.length === 1 && q.get('function') === 'wspr' && q.get('date') === '261022' && q.get('time') === '0910' && q.get('sig') === '-21' && q.get('dt') === '0.4' && q.get('tqrg') === '14.097120' && q.get('tcall') === 'K1ABC' && q.get('tgrid') === 'FN42' && q.get('dbm') === '37' && q.get('rcall') === 'VK3TR' && q.get('rgrid') === 'QF22LB' && q.get('rqrg') === '14.095600' && q.get('mode') === '2',
      `a spot is posted as WSJT-X posts it: ${bodies[0]}`
    );
    const none = new URLSearchParams(spotBodies({ rcall: 'VK3TR', rgrid: 'QF22', dialHz: 7038600, slotStartMs: 0, decodes: [], tpct: 20, txHz: 1500, dbm: 37 })[0]);
    check(none.get('function') === 'wsprstat' && none.get('tpct') === '20' && none.get('tqrg') === '7.040100' && none.get('rqrg') === '7.038600', 'a slot with nothing heard sends a wsprstat report');
    check(slotDateTime(Date.UTC(2026, 0, 2, 3, 4)).date === '260102', 'dates are yymmdd UTC');
  }
  {
    const { bridge, controlServer } = setup({ callsign: 'VK3TR/P' });
    const s = statusOf(controlServer);
    check(s.canTransmit === false && /plain callsign/.test(s.txReason), `a compound callsign can't transmit: ${s.txReason}`);
    bridge.setTx({ enabled: true });
    check(statusOf(controlServer).txEnabled === false, 'so transmit stays off');
    bridge.stop();
  }
  {
    // receive: a whole slot through the real decode worker, spots broadcast and uploaded
    const { bridge, civ, controlServer, capture, slotClock, uploads } = setup();
    const s = statusOf(controlServer);
    check(s.canTransmit && s.txMessage === 'VK3TR QF22' && s.upload === true && s.txEnabled === false, 'the connect snapshot has the WSPR state: can transmit, upload on, transmit off');
    check(!bridge.attached && capture.listenerCount('data') === 0, 'idle until WSPR is selected');
    controlServer.state.wsprActive = true;
    controlServer.emit('wspr-active', true);
    await until(() => bridge.attached);
    check(bridge.attached && civ.log.join() === 'power 5', `WSPR on: receiving, and the power is held at 5 W: ${civ.log.join()}`);
    feed(capture, slotPcm(['K1ABC', 'FN42', 37], 1520, -18));
    slotClock.fire(120000);
    const ok = await until(() => controlServer.broadcasts.some((b) => b.type === EVENT.WSPR_DECODES), 60000);
    const ev = controlServer.broadcasts.find((b) => b.type === EVENT.WSPR_DECODES)?.data;
    const d = ev?.decodes?.[0];
    check(ok && ev.slotStartMs === 0 && ev.dialHz === 14095600 && d?.message === 'K1ABC FN42 37' && Math.abs(d.audioHz - 1520) < 1 && Math.abs(d.snr + 18) <= 2, `the slot is decoded: ${d?.message} at ${d?.audioHz?.toFixed(1)} Hz, ${d?.snr} dB`);
    await until(() => uploads.length === 1);
    check(uploads[0]?.rcall === 'VK3TR' && uploads[0].rgrid === 'QF22LB' && uploads[0].decodes[0].callsign === 'K1ABC' && uploads[0].tpct === 0, 'and uploaded to wsprnet.org');
    await until(() => statusOf(controlServer).uploadStatus);
    check(statusOf(controlServer).uploadStatus?.ok === true && statusOf(controlServer).lastDecodeCount === 1, 'the upload result is in the WSPR status');
    controlServer.emit('client-connected', 'late');
    const late = controlServer.sent.find((m) => m.ws === 'late' && m.type === EVENT.WSPR_DECODES);
    check(late && late.data.replace === true && late.data.decodes[0].callsign === 'K1ABC', 'a page that opens later is sent the spots so far');

    // a slot during which the radio was retuned is not decoded
    controlServer.broadcasts.length = 0;
    feed(capture, slotPcm(['K1ABC', 'FN42', 37], 1520, -18).subarray(0, 48000 * 2 * 70));
    controlServer.state.frequency = 7038600;
    slotClock.fire(240000);
    await sleep(300);
    check(!controlServer.broadcasts.some((b) => b.type === EVENT.WSPR_DECODES), 'a slot the radio was retuned in is skipped');

    controlServer.emit('wspr-active', false);
    await until(() => civ.log.includes('power 100'));
    check(!bridge.attached && civ.log.at(-1) === 'power 100', 'WSPR off: receiving stops and the power is put back');
    bridge.stop();
  }
  {
    // transmit: planned a slot ahead, never twice running; the audio decodes back
    const { bridge, civ, controlServer, playback, slotClock, setTime } = setup();
    controlServer.emit('wspr-active', true);
    await until(() => bridge.attached);
    controlServer.emit('wspr-tx', { enabled: true, txHz: 1555 });
    const s = statusOf(controlServer);
    check(s.txEnabled === true && s.txHz === 1555 && s.nextTx === 120000, `transmit on: the next slot is planned (nextTx ${s.nextTx})`);
    setTime(121500); // past the 1 s start, so the test needn't wait for it
    slotClock.fire(120000);
    await until(() => playback.writes.length === 1);
    const st = statusOf(controlServer);
    check(st.phase === 'tx' && st.txMessage === 'VK3TR QF22 37' && st.nextTx === null, `transmitting ${st.txMessage} (5 W = 37 dBm); the slot after is not planned`);
    check(civ.log.slice(1).join() === 'ptt true' && !bridge.attached, `keyed after checking the mode, power and DATA mode; receive paused: ${civ.log.join()}`);
    const pcm = playback.writes[0];
    check(Math.abs(pcm.length / 2 / 48000 - codec.TX_SECONDS) < 0.01, `the transmission is ${(pcm.length / 2 / 48000).toFixed(1)} s`);
    const x = new StreamDecimator(48000, 12000).process(Int16Array.from(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)));
    const audio = new Float32Array(114 * 12000);
    audio.set(x.subarray(0, audio.length - 12000), 12000);
    for (let i = 0; i < audio.length; i++) audio[i] += 0.01 * gauss();
    const back = decodeWspr(audio);
    check(back.length === 1 && back[0].message === 'VK3TR QF22 37' && Math.abs(back[0].audioHz - 1555) < 0.5, `the transmitted audio decodes as ${back[0]?.message} at ${back[0]?.audioHz.toFixed(1)} Hz`);
    controlServer.emit('wspr-tx', { enabled: false });
    await until(() => civ.log.at(-1) === 'ptt false');
    check(playback.restarts === 1 && civ.log.at(-1) === 'ptt false' && !bridge.transmitting, 'transmit off cuts the transmission short and releases PTT');
    await until(() => bridge.attached);
    check(bridge.attached && statusOf(controlServer).phase === 'rx', 'and receiving resumes');
    bridge.stop();
  }
  {
    // the power is held at 5 W at transmit time too
    const { bridge, civ, controlServer, playback, slotClock, setTime } = setup();
    controlServer.emit('wspr-active', true);
    await until(() => bridge.attached);
    controlServer.emit('wspr-tx', { enabled: true });
    civ.power = 50;
    setTime(121500);
    slotClock.fire(120000);
    await until(() => playback.writes.length === 1);
    check(civ.power === 5 && statusOf(controlServer).txMessage === 'VK3TR QF22 37', 'a power turned up during WSPR is brought back to 5 W before keying');
    // the last browser leaves: the transmission stops
    controlServer.clients.clear();
    controlServer.emit('client-disconnected', 'a');
    await until(() => civ.log.at(-1) === 'ptt false');
    check(playback.restarts === 1 && civ.log.at(-1) === 'ptt false', 'the last browser leaving stops a transmission');
    bridge.stop();
  }
  {
    // unattended receive: off by default
    const { bridge, controlServer, civ } = setup({ unattendedDelayMs: 20 });
    controlServer.clients.clear();
    controlServer.emit('client-disconnected', 'a');
    await sleep(80);
    check(!bridge.attached && civ.log.length === 0 && statusOf(controlServer).unattendedEnabled === false, 'unattended receive is off unless WSPR_UNATTENDED is set');
    bridge.stop();
  }
  {
    const { bridge, controlServer, civ, capture } = setup({ unattended: true, unattendedDelayMs: 50 });
    civ.mode = 'LSB';
    civ.dataMode = false;
    civ.frequency = 7100000;
    controlServer.state.frequency = 7100000;
    controlServer.clients.clear();
    controlServer.emit('client-disconnected', 'a');
    await sleep(20);
    check(!bridge.attached, 'nothing happens straight after the last browser leaves');
    await until(() => bridge.attached, 2000);
    check(bridge.attached && capture.listenerCount('data') === 1 && statusOf(controlServer).unattended === true, 'after the delay, WSPR receives on its own');
    check(civ.log.join() === 'mode USB,data true,freq 7038600' && controlServer.state.frequency === 7038600, `on the band's WSPR frequency, USB with DATA on: ${civ.log.join()}`);
    check(controlServer.state.wsprActive === false && statusOf(controlServer).txEnabled === false && !bridge.transmitting, 'receive only');
    civ.log.length = 0;
    controlServer.clients.add('b');
    controlServer.emit('client-connected', 'b');
    await until(() => civ.log.includes('freq 7100000'));
    check(!bridge.attached && statusOf(controlServer).unattended === false, 'a browser connecting ends it');
    check(civ.log.join() === 'mode LSB,data false,freq 7100000' && civ.mode === 'LSB' && !civ.dataMode, `and the radio is put back: ${civ.log.join()}`);
    check(controlServer.broadcasts.some((b) => b.type === EVENT.FREQUENCY && b.data.value === 7100000), 'the browsers are told the frequency');
    bridge.stop();
  }
  {
    check(nextWsprBand(14095600) === '17m' && nextWsprBand(50293000) === '160m', 'the band cycle goes up, and round from 6 m to 160 m');
    check(nextWsprBand(28124600, ['80m', '40m', '20m']) === '80m' && nextWsprBand(50293000, ['40m', '20m']) === '40m', 'skipped bands are passed over');
    const p = parseBandList('160m, 6 ,40M; 99');
    check(p.bands.join() === '160m,6m,40m' && p.unknown.join() === '99', 'WSPR_SKIP_BANDS takes "160m" or "160", any case, and reports unknown names');
  }
  /** Runs unattended receive slot by slot; returns the frequency after each boundary and the dial each decode was reported on. */
  async function unattendedRun(opts, slots, before) {
    const decoder = { decode: async () => ({ decodes: [], hashtab: [] }), terminate() {} };
    const t = setup({ unattended: true, unattendedDelayMs: 10, decoder, tuneStartMs: 5, tunePollMs: 5, ...opts });
    before?.(t);
    t.controlServer.clients.clear();
    t.controlServer.emit('client-disconnected', 'a');
    await until(() => t.bridge.attached, 2000);
    const startFreq = t.civ.frequency;
    const freqs = [];
    const quiet = Buffer.alloc(48000 * 2 * 70);
    for (let slot = 1; slot <= slots; slot++) {
      t.setTime(slot * 120000);
      feed(t.capture, quiet, 96000);
      t.slotClock.fire(slot * 120000);
      await until(() => !t.bridge._hop);
      await sleep(10);
      freqs.push(t.civ.frequency);
    }
    const decoded = t.controlServer.broadcasts.filter((b) => b.type === EVENT.WSPR_DECODES).map((b) => b.data.dialHz);
    return { ...t, startFreq, freqs, decoded };
  }
  const mhz = (list) => list.map((f) => (f / 1e6).toFixed(4)).join(' ');
  {
    // the default: 6 minutes (3 slots) a band, with the tuner after each change
    const r = await unattendedRun({}, 7);
    check(r.startFreq === 14095600 && statusOf(r.controlServer).bandMinutes === 6 && statusOf(r.controlServer).unattendedBand === '15m', 'unattended receive starts on the band the radio was on (20 m); the status says which band it is on now');
    check(r.freqs.join() === '14095600,14095600,18104600,18104600,18104600,21094600,21094600', `6 minutes on each band by default: ${mhz(r.freqs)}`);
    check(r.decoded.join() === '14095600,14095600,14095600,18104600,18104600,18104600,21094600', 'every slot is decoded and reported on the band it was heard on');
    const log = r.civ.log.join();
    check(/freq 18104600,tuner 2,.*freq 21094600,tuner 2/.test(log) && (log.match(/tuner 2/g) || []).length === 2, `the tuner is started straight after each band change, and only then: ${log}`);
    check(!/setPtt|power|ptt true/.test(log), 'nothing else is transmitted');
    r.civ.log.length = 0;
    r.controlServer.clients.add('b');
    r.controlServer.emit('client-connected', 'b');
    await until(() => r.civ.log.includes('freq 14095600'));
    check(r.civ.log.at(-1) === 'freq 14095600' && !r.bridge.attached, 'a browser connecting puts the radio back on the frequency from before');
    r.bridge.stop();
  }
  {
    // WSPR_BAND_MINUTES=2 and WSPR_SKIP_BANDS=160m,6m: every slot, round from 10 m to 80 m
    const r = await unattendedRun({ bandMinutes: 2, skipBands: ['160m', '6m'] }, 3, (t) => {
      t.civ.frequency = 28124600;
      t.controlServer.state.frequency = 28124600;
    });
    check(r.freqs.join() === '3568600,7038600,10138700', `2 minutes a band, 6 m and 160 m skipped: ${mhz(r.freqs)}`);
    check(statusOf(r.controlServer).cycleBands.join() === '80m,40m,30m,20m,17m,15m,12m,10m', 'the status lists the bands in the cycle');
    r.bridge.stop();
  }
  {
    // the radio on a skipped band: start on the next one
    const r = await unattendedRun({ skipBands: ['6m'] }, 1, (t) => {
      t.civ.frequency = 50313000;
      t.controlServer.state.frequency = 50313000;
    });
    check(r.startFreq === 1836600, `on a skipped band (6 m), it starts on the next (${mhz([r.startFreq])})`);
    r.bridge.stop();
  }
  {
    // a tuner that doesn't finish is stopped
    const r = await unattendedRun({ bandMinutes: 2, tuneLimitMs: 60 }, 1, (t) => {
      t.civ.tuneStuck = true;
    });
    const log = r.civ.log.join();
    check(/tuner 2,tuner 0,setPtt false,tuner 1/.test(log) && r.controlServer.broadcasts.some((b) => b.type === EVENT.AUDIO_ERROR && /tuner was still going/.test(b.data.message)), `a tune still going after the limit is stopped (tuner off, PTT off, tuner on): ${log}`);
    check(r.decoded.length === 1 && r.bridge.attached, 'and receiving carries on');
    r.bridge.stop();
  }
  {
    // a browser connecting while the tuner runs: the tune ends first, then the radio is put back
    const decoder = { decode: async () => ({ decodes: [], hashtab: [] }), terminate() {} };
    const t = setup({ unattended: true, unattendedDelayMs: 10, decoder, bandMinutes: 2, tuneStartMs: 5, tunePollMs: 5, tuneLimitMs: 150 });
    t.civ.tuneStuck = true;
    t.controlServer.clients.clear();
    t.controlServer.emit('client-disconnected', 'a');
    await until(() => t.bridge.attached, 2000);
    t.setTime(120000);
    feed(t.capture, Buffer.alloc(48000 * 2 * 70), 96000);
    t.slotClock.fire(120000);
    await until(() => t.civ.log.includes('tuner 2'));
    t.controlServer.clients.add('b');
    t.controlServer.emit('client-connected', 'b');
    await until(() => t.civ.log.at(-1) === 'freq 14095600', 3000);
    const log = t.civ.log.join();
    check(log.indexOf('tuner 1') < log.lastIndexOf('freq 14095600') && t.civ.frequency === 14095600 && !t.bridge.attached, `a browser arriving mid-tune: tune stopped, then the radio put back: ${log}`);
    t.bridge.stop();
  }
  {
    // WSPR_BAND_CYCLE=off: unattended receive stays on its band
    const decoder = { decode: async () => ({ decodes: [], hashtab: [] }), terminate() {} };
    const { bridge, controlServer, civ, capture, slotClock, setTime } = setup({ unattended: true, unattendedDelayMs: 10, bandCycle: false, decoder });
    controlServer.clients.clear();
    controlServer.emit('client-disconnected', 'a');
    await until(() => bridge.attached, 2000);
    for (let slot = 1; slot <= 2; slot++) {
      setTime(slot * 120000);
      feed(capture, Buffer.alloc(48000 * 2 * 70), 96000);
      slotClock.fire(slot * 120000);
      await sleep(50);
    }
    const decodes = controlServer.broadcasts.filter((b) => b.type === EVENT.WSPR_DECODES).map((b) => b.data.dialHz);
    check(civ.frequency === 14095600 && decodes.join() === '14095600,14095600' && statusOf(controlServer).bandCycle === false, 'with the band cycle off, every slot is on 20 m');
    bridge.stop();
  }
  {
    // a browser arriving during the delay cancels it
    const { bridge, controlServer, civ } = setup({ unattended: true, unattendedDelayMs: 60 });
    controlServer.clients.clear();
    controlServer.emit('client-disconnected', 'a');
    await sleep(20);
    controlServer.clients.add('b');
    controlServer.emit('client-connected', 'b');
    await sleep(100);
    check(!bridge.attached && civ.log.length === 0, 'a browser connecting within the 10 minutes cancels unattended receive');
    bridge.stop();
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall WSPR bridge tests passed');
})();
