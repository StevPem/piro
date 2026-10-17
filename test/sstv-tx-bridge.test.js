// Run with: node test/sstv-tx-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { SstvTxBridge, sstvTxSeconds } = require('../src/server/sstv-tx-bridge');
const { EVENT } = require('../src/server/protocol');
const { SstvReceiver } = require('../src/audio/sstv-rx');
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
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
  async setPttFromServer(on) {
    this.civ?.log.push(`ptt ${on}`);
    this.state.ptt = on;
  }
}
function setup({ mode = 'R8BW', civ = new StubCiv(), ...opts } = {}) {
  const controlServer = new StubControlServer(civ);
  const playback = { writes: [], restarts: 0, write(b) { this.writes.push(b); }, restart() { this.restarts++; } };
  const bridge = new SstvTxBridge({ controlServer, audioBridge: { sampleRate: 48000, playback }, mode, callsign: 'VK3TR', pttReleaseMarginMs: 20, ...opts });
  bridge.start();
  return { controlServer, playback, bridge, civ };
}
const statuses = (cs) => cs.broadcasts.filter((b) => b.type === EVENT.SSTV_TX_STATUS).map((b) => b.data);

(async () => {
  {
    const { controlServer } = setup({ mode: 'S1' });
    const s = controlServer.state.sstvTx;
    check(s.mode === 'S1' && s.name === 'Scottie S1' && s.width === 320 && s.lines === 256 && s.fskId && s.cwId, 'connect snapshot carries the TX mode and picture size (Scottie S1, 320 x 256)');
    check(Math.abs(s.durationSec - sstvTxSeconds('S1', 'VK3TR')) < 0.1 && s.durationSec > 112 && s.durationSec < 117, `Scottie S1 with both IDs takes about ${s.durationSec} s`);
  }
  {
    // a whole Robot 8 B/W transmission through the real encode worker, decoded back
    const { controlServer, playback, bridge, civ } = setup({ txPowerW: 40 });
    const w = 320;
    const h = 120;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) rgb.fill(i % w < 160 ? 240 : 20, i * 3, i * 3 + 3);
    controlServer.emit('sstv-send', { rgb, width: w, height: h });
    const t0 = Date.now();
    while (statuses(controlServer).at(-1)?.status !== 'sent' && Date.now() - t0 < 30000) await sleep(20);
    const st = statuses(controlServer).map((s) => s.status);
    check(st.join() === 'encoding,sending,sent', `status: ${st.join(' -> ')}`);
    check(civ.log.join(' | ') === 'data true | power 40 | ptt true | ptt false | power 100 | data false', 'DATA MODE on, power 40 W, PTT, then all put back: ' + civ.log.join(' | '));
    const pcm = playback.writes[0];
    const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    const x = new StreamDecimator(48000, 12000).process(Int16Array.from(i16));
    const rx = new SstvReceiver();
    const ev = [...rx.process(x), ...rx.process(new Float32Array(12000))];
    const end = ev.find((e) => e.type === 'end');
    let err = 0;
    if (end) for (let i = 0; i < end.rgb.length; i++) err += Math.abs(end.rgb[i] - rgb[i]);
    check(end?.mode === 'R8BW' && end.complete && err / end.rgb.length < 8, `the audio sent decodes back to the picture (mean error ${(err / (end?.rgb.length || 1)).toFixed(1)})`);
    check(ev.find((e) => e.type === 'fskid')?.text === 'VK3TR', 'and its FSK ID reads VK3TR');
    const sending = statuses(controlServer).find((s) => s.status === 'sending');
    check(Math.abs(sending.durationSec - sstvTxSeconds('R8BW', 'VK3TR')) < 0.05 && Math.abs(i16.length / 48000 - sending.durationSec) < 0.01, `duration as predicted (${sending.durationSec.toFixed(2)} s)`);
    const own = controlServer.broadcasts.find((b) => b.type === EVENT.SSTV_PICTURE)?.data;
    check(own?.own === true && own.width === 320 && controlServer.sstvPictures.at(-1) === own, 'the sent picture is added to the recent pictures as our own');
    check(!bridge.transmitting, 'not transmitting afterwards');
  }
  {
    const { controlServer, playback, bridge, civ } = setup({ mode: 'M1' });
    const rgb = new Uint8Array(320 * 256 * 3).fill(100);
    const p = bridge.send({ rgb, width: 320, height: 256 });
    while (statuses(controlServer).at(-1)?.status !== 'sending') await sleep(10);
    bridge.abort();
    await p;
    check(statuses(controlServer).at(-1).status === 'aborted' && playback.restarts === 1 && civ.log.at(-1) === 'data false' && civ.log.includes('ptt false'), 'Stop: audio dropped, PTT off, DATA MODE off');
    check(!controlServer.broadcasts.some((b) => b.type === EVENT.SSTV_PICTURE), 'a stopped picture is not added');
  }
  {
    // the last browser going away stops the transmission
    const { controlServer, bridge, civ } = setup({ mode: 'M1' });
    controlServer.clients = new Set(['a']);
    const p = bridge.send({ rgb: new Uint8Array(320 * 256 * 3).fill(50), width: 320, height: 256 });
    while (statuses(controlServer).at(-1)?.status !== 'sending') await sleep(10);
    controlServer.emit('client-disconnected', 'b');
    check(bridge.transmitting, 'one browser of several leaving does not stop it');
    controlServer.clients.clear();
    controlServer.emit('client-disconnected', 'a');
    await p;
    check(statuses(controlServer).at(-1).status === 'aborted' && civ.log.at(-1) === 'data false' && civ.log.includes('ptt false'), 'the last browser leaving stops it: PTT off, DATA MODE off');
  }
  {
    // Stop while still encoding: the radio is never keyed
    const { controlServer, bridge, civ } = setup({ mode: 'M1' });
    const p = bridge.send({ rgb: new Uint8Array(320 * 256 * 3).fill(50), width: 320, height: 256 });
    while (statuses(controlServer).at(-1)?.status !== 'encoding') await sleep(1);
    bridge.abort();
    await p;
    check(statuses(controlServer).at(-1).status === 'aborted' && !civ.log.some((e) => e.startsWith('ptt')), 'Stop while encoding: aborted without keying');
  }
  {
    const { controlServer, bridge } = setup({ mode: 'S1' });
    let e1 = null;
    await bridge.send({ rgb: new Uint8Array(160 * 128 * 3), width: 160, height: 128 }).catch((e) => (e1 = e));
    check(/320 x 256/.test(e1?.message || ''), 'a picture of the wrong size is refused');
    const lsb = setup({ civ: new StubCiv('CW') });
    let e2 = null;
    await lsb.bridge.send({ rgb: new Uint8Array(320 * 120 * 3), width: 320, height: 120 }).catch((e) => (e2 = e));
    check(/LSB or USB/.test(e2?.message || '') && lsb.civ.log.length === 0, 'refused unless the radio is on LSB or USB, with nothing keyed');
    controlServer.state.ptt = true;
    let e3 = null;
    await bridge.send({ rgb: new Uint8Array(320 * 256 * 3), width: 320, height: 256 }).catch((e) => (e3 = e));
    check(/already transmitting/.test(e3?.message || ''), 'refused while the radio is transmitting');
  }
  {
    // lineHeight 2 modes take the picture at its displayed height too
    const { bridge, controlServer } = setup({ mode: 'R8BW', fskId: false, cwId: false });
    check(controlServer.state.sstvTx.lineHeight === 2 && !controlServer.state.sstvTx.fskId, 'Robot 8 B/W: lines drawn twice; IDs can be turned off');
    const p = bridge.send({ rgb: new Uint8Array(320 * 240 * 3), width: 320, height: 240 });
    while (statuses(controlServer).at(-1)?.status !== 'sending' && statuses(controlServer).at(-1)?.status !== 'error') await sleep(10);
    check(statuses(controlServer).at(-1).status === 'sending', 'a 320 x 240 picture is accepted for a 120-line mode');
    bridge.abort();
    await p;
  }
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall SSTV transmit tests passed');
})();
