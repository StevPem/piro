'use strict';

// Run with: node test/tx-safety.test.js
// Transmit safety (issues #75-#79): PTT release confirmed by the radio,
// settings put back only on a radio confirmed unkeyed (held otherwise, and
// then only if unchanged by hand), and no setting changes while
// transmitting. A real ControlServer with a stand-in radio that can be
// made to reject PTT-off, as the issues' reproductions did.

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { ControlServer, TRANSMITTING_REFUSAL } = require('../src/server/ws-server');
const { EVENT } = require('../src/server/protocol');
const { settingStillIs } = require('../src/server/tx-safety');
const { SstvTxBridge } = require('../src/server/sstv-tx-bridge');
const { EasypalTxBridge } = require('../src/server/easypal-tx-bridge');
const { TtyBridge } = require('../src/audio/tty-bridge');
const { Js8Bridge } = require('../src/server/js8-bridge');
const { WsprBridge } = require('../src/server/wspr-bridge');
const { CwTxBridge } = require('../src/server/cw-tx-bridge');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (fn) => {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  return Promise.resolve(fn()).finally(() => Object.assign(console, { warn, error }));
};

/** A radio that records what it is told, in order, and can reject PTT-off. */
class Radio extends EventEmitter {
  constructor({ mode = 'USB', freq = 14095600, power = 100 } = {}) {
    super();
    this.radioAddr = 0x94;
    Object.assign(this, { mode, filter: 1, freq, power, dataMode: false, ptt: false, keySpeed: 20, breakIn: 0 });
    this.log = [];
    this.rejectOff = 0; // reject this many PTT-offs
  }
  async setPtt(on) {
    if (!on && this.rejectOff > 0) {
      this.rejectOff--;
      this.log.push('ptt-off REJECTED');
      throw new Error('Radio rejected request: set PTT');
    }
    this.ptt = on;
    this.log.push(`ptt ${on}`);
  }
  async getMode() {
    return { mode: this.mode, filter: this.filter };
  }
  async setMode(mode, filter = 1) {
    this.log.push(`mode ${mode}${this.ptt ? ' WHILE KEYED' : ''}`);
    Object.assign(this, { mode, filter });
  }
  async getFrequency() {
    return this.freq;
  }
  async setFrequency(hz) {
    this.log.push(`freq ${hz}${this.ptt ? ' WHILE KEYED' : ''}`);
    this.freq = hz;
  }
  async getDataMode() {
    return this.dataMode;
  }
  async setDataMode(on) {
    this.log.push(`data ${on}${this.ptt ? ' WHILE KEYED' : ''}`);
    this.dataMode = on;
  }
  async getTxPower() {
    return this.power;
  }
  async setTxPower(w) {
    this.log.push(`power ${w}${this.ptt ? ' WHILE KEYED' : ''}`);
    this.power = w;
  }
}

function server(radio, opts = {}) {
  const cs = new ControlServer({ civ: radio, port: 0, heartbeatMs: 0, ...opts });
  cs.events = [];
  const broadcast = cs._broadcast.bind(cs);
  cs._broadcast = (payload, except) => {
    try {
      cs.events.push(JSON.parse(payload));
    } catch {
      // not JSON
    }
    return broadcast(payload, except);
  };
  return cs;
}
const playback = () => ({ writes: 0, write() { this.writes++; }, restart() {} });
const pcmOf = (sec) => Buffer.alloc(Math.round(sec * 48000) * 2);
const keyedWrites = (radio) => radio.log.filter((l) => l.includes('WHILE KEYED'));

// A step that never finishes must fail the run, not let it end quietly.
const guard = setTimeout(() => {
  console.error('FAIL - the tests did not finish within 90 s');
  process.exit(1);
}, 90000);

async function run() {
  // ---------------- ControlServer ----------------
  {
    const radio = new Radio();
    const cs = server(radio);
    await cs.setPttFromServer(true);
    check(cs.transmitting && cs.state.transmitting, 'keyed: transmitting');
    check((await cs.releasePtt()) === true && !cs.state.ptt && cs.receiveConfirmed && !cs.transmitting, 'releasePtt: a PTT-off the radio accepts is confirmed');
    const tx = cs.events.filter((e) => e.type === EVENT.TRANSMITTING).map((e) => e.data.active);
    check(tx.join() === 'true,false', `'transmitting' is broadcast on, then off (${tx.join()})`);

    await cs.setPttFromServer(true);
    radio.rejectOff = 2;
    check((await cs.releasePtt()) === true && radio.log.slice(-3).join() === 'ptt-off REJECTED,ptt-off REJECTED,ptt false', 'two rejected PTT-offs, then accepted: confirmed on the third try');

    await cs.setPttFromServer(true);
    radio.rejectOff = 3;
    const ok = await quiet(() => cs.releasePtt());
    check(ok === false && cs.state.ptt === true && !cs.receiveConfirmed && cs.transmitting, 'all three rejected: not confirmed, PTT still shown on, still transmitting');
    check(cs.events.some((e) => e.type === EVENT.RIG_ERROR && /PTT release not confirmed/.test(e.data.message)), 'and every browser is told');
    check(cs._pttWatchdogTimer !== null, 'the watchdog stays armed');

    // A restore asked for now is held, and runs once a PTT-off is confirmed, told it was held.
    let ran = null;
    const now = await quiet(() => cs.restoreWhenReceiving(({ held }) => (ran = { held })));
    check(now === false && ran === null, 'restoreWhenReceiving while not confirmed: held, not run');
    await cs.setPttFromServer(false);
    await sleep(10);
    check(ran?.held === true, 'it runs once a PTT-off is confirmed, marked as held');
    ran = null;
    check((await cs.restoreWhenReceiving(({ held }) => (ran = { held }))) === true && ran?.held === false, 'on a radio confirmed unkeyed it runs at once');

    // A key-up waits for a restore that is running.
    let finishRestore;
    cs.restoreWhenReceiving(() => new Promise((r) => (finishRestore = r)));
    await sleep(5);
    const keying = cs.setPttFromServer(true);
    await sleep(20);
    check(radio.ptt === false, 'a key-up waits while a restore is running');
    finishRestore();
    await keying;
    check(radio.ptt === true, 'and goes ahead when it is done');
    await cs.releasePtt();
    cs.close();
  }

  // The watchdog: a failed force-off doesn't claim the radio released.
  {
    const radio = new Radio();
    const cs = server(radio, { pttWatchdogMs: 30 });
    const pttEvents = [];
    cs.on('ptt', (on) => pttEvents.push(on));
    await cs.setPttFromServer(true);
    radio.rejectOff = 1;
    await sleep(60);
    check(cs.state.ptt === true && !pttEvents.includes(false), "watchdog force-off rejected: PTT still shown on, no 'released' event");
    check(cs.events.some((e) => e.type === EVENT.RIG_ERROR && /force-off failed.*Trying again/.test(e.data.message)), 'every browser is told, and it tries again');
    cs._pttWatchdogTimer && clearTimeout(cs._pttWatchdogTimer);
    await cs._onPttWatchdogTimeout(); // the retry, without waiting 5 s
    check(cs.state.ptt === false && pttEvents.at(-1) === false && cs.receiveConfirmed, 'the retry is confirmed: released');
    cs.close();
  }

  // settingStillIs (the held-restore check)
  check((await settingStillIs(async () => 5, 5)) && (await settingStillIs(async () => 5.4, 5, 1)) && !(await settingStillIs(async () => 50, 5, 1)), 'settingStillIs: the same value (or within tolerance) is unchanged; another is changed');
  check(!(await settingStillIs(async () => {
    throw new Error('no answer');
  }, 5)), 'a failed read counts as changed: the setting is left alone');

  // ---------------- No setting changes while transmitting ----------------
  {
    const radio = new Radio();
    const cs = server(radio);
    const port = await cs.listen();
    const ws = new WebSocket(`ws://localhost:${port}`);
    const replies = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id) replies.set(m.id, m);
    });
    await new Promise((r) => ws.on('open', r));
    let n = 0;
    const ask = async (type, extra) => {
      const id = `r${++n}`;
      ws.send(JSON.stringify({ id, type, ...extra }));
      for (let i = 0; i < 100 && !replies.has(id); i++) await sleep(5);
      return replies.get(id);
    };
    await cs.setPttFromServer(true);
    const refused = [];
    for (const [type, extra] of [
      ['setFrequency', { value: 7074000 }],
      ['setMode', { mode: 'LSB' }],
      ['setDataMode', { on: false }],
      ['setTxPower', { watts: 50 }],
      ['setFilter', { value: 2 }],
      ['setPreamp', { value: 1 }],
      ['setTuner', { value: 2 }],
      ['setWsprActive', { active: true }],
    ]) {
      const r = await ask(type, extra);
      if (r?.ok === false && r.error === TRANSMITTING_REFUSAL) refused.push(type);
    }
    check(refused.length === 8, `while transmitting, setting changes are refused with "${TRANSMITTING_REFUSAL}" (${refused.join(', ')})`);
    check(radio.log.filter((l) => /^(freq|mode|data|power)/.test(l)).length === 0, 'and nothing reaches the radio');
    const same = await ask('setWsprActive', { active: false });
    check(same?.error !== TRANSMITTING_REFUSAL, 'setWsprActive {active: false} while WSPR is off: not refused');
    const off = await ask('setPtt', { value: false });
    check(off?.ok === true && radio.ptt === false, 'PTT release is never refused');
    const after = await ask('setFrequency', { value: 7074000 });
    check(after?.ok === true && radio.freq === 7074000, 'once the radio is receiving, settings change again');
    cs.state.cwKeying = true;
    cs.refreshTransmitting();
    check((await ask('setMode', { mode: 'CW' }))?.error === TRANSMITTING_REFUSAL, 'refused while the CW paddle keys');
    cs.state.cwKeying = false;
    cs.cwTxBusy = () => true;
    check((await ask('setMode', { mode: 'CW' }))?.error === TRANSMITTING_REFUSAL, 'refused while CW text is being sent');
    cs.cwTxBusy = () => false;
    ws.close();
    await cs.close();
  }

  // ---------------- #75: SSTV, EasyPal, RTTY ----------------
  const sstvSetup = (radio) => {
    const cs = server(radio);
    const bridge = new SstvTxBridge({
      controlServer: cs,
      audioBridge: { sampleRate: 48000, playback: playback() },
      mode: 'R8BW',
      callsign: 'VK3TR',
      txPowerW: 10,
      pttReleaseMarginMs: 1,
      dataSettleMs: 0,
      dataWatchMs: 1000000,
      encode: async () => ({ pcm: pcmOf(0.05), durationSec: 0.05 }),
    });
    const rgb = new Uint8Array(320 * 120 * 3);
    return { cs, bridge, send: () => bridge.send({ rgb, width: 320, height: 120 }) };
  };
  {
    const radio = new Radio();
    const { cs, bridge, send } = sstvSetup(radio);
    await send();
    check(radio.log.join(' | ') === 'data true | power 10 | ptt true | ptt false | power 100 | data false', 'SSTV, normal: key, release, then power and DATA back (as before): ' + radio.log.join(' | '));
    check(bridge && cs.events.some((e) => e.type === EVENT.SSTV_TX_STATUS && e.data.status === 'sent'), "reported 'sent'");
    cs.close();
  }
  {
    const radio = new Radio();
    const { cs, send } = sstvSetup(radio);
    radio.rejectOff = 3;
    await quiet(() => send().catch(() => {}));
    check(keyedWrites(radio).length === 0 && radio.power === 10 && radio.dataMode === true, 'SSTV, PTT-off rejected every time: DATA mode and power NOT changed while keyed (issue #75)');
    check(cs.events.some((e) => e.type === EVENT.SSTV_TX_STATUS && e.data.status === 'error' && /not confirmed/.test(e.data.error)), "status: error, release not confirmed (not 'sent')");
    radio.rejectOff = 0;
    await quiet(() => cs.setPttFromServer(false)); // e.g. the operator's Stop, or the watchdog
    await sleep(20);
    check(radio.power === 100 && radio.dataMode === false && keyedWrites(radio).length === 0, 'once a PTT-off is confirmed, power and DATA mode go back');
    cs.close();
  }
  {
    const radio = new Radio();
    const { cs, send } = sstvSetup(radio);
    radio.rejectOff = 1;
    await quiet(() => send().catch(() => {}));
    check(keyedWrites(radio).length === 0 && radio.power === 100 && radio.dataMode === false && !radio.ptt, 'SSTV, first PTT-off rejected, retry accepted: released, then everything put back');
    check(cs.events.some((e) => e.type === EVENT.SSTV_TX_STATUS && e.data.status === 'sent'), 'and reported sent');
    cs.close();
  }
  {
    const radio = new Radio();
    const { cs, send } = sstvSetup(radio);
    radio.rejectOff = 3;
    await quiet(() => send().catch(() => {}));
    radio.power = 50; // the operator changes the power on the radio meanwhile
    radio.rejectOff = 0;
    await quiet(async () => {
      await cs.setPttFromServer(false);
      await sleep(20);
    });
    check(radio.power === 50 && radio.dataMode === false, "option (b): power changed by hand while the restore was held is kept; DATA mode (unchanged) still goes back");
    check(cs.events.some((e) => e.type === EVENT.AUDIO_ERROR && /Power left as it is/.test(e.data.message)), 'and the operator is told why');
    cs.close();
  }
  {
    const radio = new Radio();
    const cs = server(radio);
    const bridge = new EasypalTxBridge({
      controlServer: cs,
      audioBridge: { sampleRate: 48000, playback: playback() },
      callsign: 'VK3TR',
      txPowerW: 10,
      pttReleaseMarginMs: 1,
      dataSettleMs: 0,
      dataWatchMs: 1000000,
      encode: async () => ({ pcm: pcmOf(0.05), durationSec: 0.05, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), fileName: 'a.jpg', bytes: 4, width: 8, height: 8, quality: 80 }),
    });
    radio.rejectOff = 3;
    await quiet(() => bridge.send({ jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }).catch(() => {}));
    check(keyedWrites(radio).length === 0 && radio.power === 10 && radio.dataMode === true, 'EasyPal, PTT-off rejected: DATA mode and power not changed while keyed (issue #75)');
    radio.rejectOff = 0;
    await quiet(async () => {
      await cs.setPttFromServer(false);
      await sleep(20);
    });
    check(radio.power === 100 && radio.dataMode === false, 'EasyPal: put back once a PTT-off is confirmed');
    cs.close();
  }
  {
    const radio = new Radio({ mode: 'RTTY', freq: 7050000 });
    const cs = server(radio);
    const bridge = new TtyBridge({ controlServer: cs, audioBridge: { sampleRate: 48000, playback: playback() }, pttReleaseMarginMs: 1, dataSettleMs: 0, dataWatchMs: 1000000 });
    bridge.start();
    radio.rejectOff = 3;
    await quiet(() => bridge.send({ mode: 'RTTY', text: 'E' }).catch(() => {}));
    check(keyedWrites(radio).length === 0 && radio.mode === 'LSB' && radio.dataMode === true, 'RTTY, PTT-off rejected: mode, DATA and tuning not changed while keyed (issue #75): ' + radio.log.join(' | '));
    radio.rejectOff = 0;
    await quiet(async () => {
      await cs.setPttFromServer(false);
      await sleep(20);
    });
    check(radio.mode === 'RTTY' && radio.freq === 7050000 && radio.dataMode === false, 'RTTY: back to RTTY on the mark frequency once a PTT-off is confirmed');

    radio.rejectOff = 3;
    await quiet(() => bridge.send({ mode: 'RTTY', text: 'E' }).catch(() => {}));
    radio.freq = 7060000; // retuned by hand while waiting
    radio.rejectOff = 0;
    await quiet(async () => {
      await cs.setPttFromServer(false);
      await sleep(20);
    });
    check(radio.freq === 7060000 && radio.mode === 'LSB', 'RTTY, option (b): retuned by hand while waiting, so mode and tuning are left alone');
    bridge.stop();
    cs.close();
  }

  // ---------------- #76: JS8 ----------------
  {
    const radio = new Radio({ mode: 'USB', freq: 14078000 });
    const cs = server(radio);
    const holds = [];
    const capture = new EventEmitter();
    const clock = new EventEmitter();
    Object.assign(clock, { start() {}, stop() {}, nextSlotStart: () => 30000 });
    const bridge = new Js8Bridge({
      controlServer: cs,
      audioBridge: { sampleRate: 48000, capture, playback: playback() },
      callsign: 'VK3TR',
      grid: 'QF22',
      slotClock: clock,
      now: () => 0,
      dataSettleMs: 0,
      setTimer: (fn, ms) => {
        holds.push(ms);
        return setTimeout(fn, 5);
      },
      clearTimer: (t) => clearTimeout(t),
    });
    bridge.start();
    cs.state.js8Active = true;
    cs.emit('js8-active', { active: true, txHz: 1500 });
    await sleep(10);
    await bridge.request({ action: 'send', text: 'CQ CQ CQ QF22 THIS IS A LONGER MESSAGE' }).catch(() => {});
    radio.rejectOff = 3;
    clock.emit('boundary', { slotStartMs: 30000, slotMs: 15000 });
    for (let i = 0; i < 100 && radio.rejectOff > 0; i++) await sleep(10);
    await quiet(() => sleep(300));
    const js8 = cs.state.js8;
    check(js8.keyed === true, 'JS8, PTT-off rejected: still shown keyed (issue #76)');
    check(!js8.sending, 'sending stopped: no further frames, the frame not counted as sent');
    const pttOns = radio.log.filter((l) => l === 'ptt true').length;
    clock.emit('boundary', { slotStartMs: 45000, slotMs: 15000 });
    await sleep(50);
    check(radio.log.filter((l) => l === 'ptt true').length === pttOns, 'the next slot keys nothing');
    await bridge.request({ action: 'stop' }).catch(() => {});
    await sleep(20);
    check(cs.state.js8.keyed === false && radio.ptt === false, 'Stop tries the release again; confirmed: shown released');
    bridge.stop?.();
    cs.close();
  }

  // ---------------- #77: WSPR ----------------
  {
    const radio = new Radio({ mode: 'USB', freq: 14095600, power: 100 });
    const cs = server(radio);
    let t = 0;
    const slotClock = Object.assign(new EventEmitter(), { currentSlotStart: () => 0, start() {}, stop() {} });
    const bridge = new WsprBridge({
      controlServer: cs,
      audioBridge: { capture: new EventEmitter(), playback: playback(), sampleRate: 48000 },
      callsign: 'VK3TR',
      grid: 'QF22LB',
      slotClock,
      wsprnet: { upload: async () => ({ sent: 0, spots: 0 }) },
      now: () => t,
      random: () => 0,
      dataSettleMs: 0,
      dataWatchMs: 1000000,
      pttReleaseMarginMs: 0,
      spectrumIntervalMs: 1000000,
    });
    bridge.start();
    await bridge.setActive(true);
    check(radio.power === 5, 'WSPR on: power limited to 5 W');
    const txing = bridge._transmit(0);
    for (let i = 0; i < 100 && !radio.ptt; i++) await sleep(5);
    check(radio.ptt, 'a WSPR transmission is on the air');
    // A slow PTT-off, so a power restore that doesn't wait for it would land first.
    const setPtt = radio.setPtt.bind(radio);
    radio.setPtt = async (on) => {
      if (!on) await sleep(50);
      return setPtt(on);
    };
    await bridge.setActive(false); // leave WSPR mid-transmission
    await txing;
    const i100 = radio.log.indexOf('power 100');
    const iOff = radio.log.indexOf('ptt false');
    check(iOff >= 0 && i100 > iOff && keyedWrites(radio).length === 0, 'leaving WSPR mid-transmission: PTT released first, then 100 W (issue #77): ' + radio.log.join(' | '));
    cs.close();
  }
  {
    const radio = new Radio({ mode: 'USB', freq: 14095600, power: 100 });
    const cs = server(radio);
    const slotClock = Object.assign(new EventEmitter(), { currentSlotStart: () => 0, start() {}, stop() {} });
    const bridge = new WsprBridge({
      controlServer: cs,
      audioBridge: { capture: new EventEmitter(), playback: playback(), sampleRate: 48000 },
      callsign: 'VK3TR',
      grid: 'QF22LB',
      slotClock,
      wsprnet: { upload: async () => ({ sent: 0, spots: 0 }) },
      now: () => 0,
      random: () => 0,
      dataSettleMs: 0,
      dataWatchMs: 1000000,
      pttReleaseMarginMs: 0,
      spectrumIntervalMs: 1000000,
    });
    bridge.start();
    await bridge.setActive(true);
    const txing = bridge._transmit(0);
    for (let i = 0; i < 100 && !radio.ptt; i++) await sleep(5);
    radio.rejectOff = 3;
    bridge._abortTx(); // the transmission ends (its release is rejected) while WSPR stays on
    await quiet(() => txing);
    check(bridge._active === true && !bridge._receiving() && radio.ptt, 'WSPR, PTT-off rejected: receive is not resumed on a radio that may be transmitting (issue #77)');
    await quiet(() => bridge.setActive(false));
    check(radio.power === 5 && keyedWrites(radio).length === 0, 'leaving WSPR then: the power stays at 5 W while keyed');
    radio.rejectOff = 0;
    await quiet(async () => {
      await cs.setPttFromServer(false);
      await sleep(20);
    });
    check(radio.power === 100, 'a confirmed PTT-off later: 100 W put back');
    bridge.stop();
    cs.close();
  }

  // ---------------- #78, #79: CW text ----------------
  const cwRadio = () => {
    const r = new Radio({ mode: 'CW', freq: 7020000 });
    r.txState = [];
    Object.assign(r, {
      async getKeySpeed() {
        return this.keySpeed;
      },
      async setKeySpeed(w) {
        this.log.push(`speed ${w}`);
        this.keySpeed = w;
      },
      async getBreakIn() {
        return this.breakIn;
      },
      async setBreakIn(v) {
        this.log.push(`breakin ${v}`);
        this.breakIn = v;
      },
      async sendCw(t) {
        this.log.push(`cw ${t}`);
        return true;
      },
      async stopCw() {
        this.log.push('stop cw');
      },
      async getTransmitting() {
        const v = this.txState.length > 1 ? this.txState.shift() : this.txState[0];
        if (v instanceof Error) throw v;
        return v;
      },
    });
    return r;
  };
  const cwBridge = (cs) => new CwTxBridge({ controlServer: cs, estimateSeconds: () => 0.01, leadSec: 0.01, txEndQuietMs: 30, txEndMaxWaitMs: 400 });
  const cwStatuses = (cs) => cs.events.filter((e) => e.type === EVENT.CW_TX_STATUS).map((e) => e.data);
  {
    const radio = cwRadio();
    const cs = server(radio);
    radio.txState = [false];
    await cwBridge(cs).send({ text: 'E', wpm: 20 }).catch(() => {});
    check(cwStatuses(cs).at(-1).status === 'sent', 'CW text, the radio reports receive for the quiet period: sent');
  }
  {
    const radio = cwRadio();
    const cs = server(radio);
    radio.txState = [new Error('Unexpected transmit state reply')];
    await cwBridge(cs).send({ text: 'E', wpm: 20 }).catch(() => {});
    const st = cwStatuses(cs).at(-1);
    check(st.status === 'error' && radio.log.includes('stop cw'), `CW text, transmit state can't be read: error, keyer stopped, not 'sent' (issue #78)`);
  }
  {
    const radio = cwRadio();
    const cs = server(radio);
    radio.txState = [true];
    await cwBridge(cs).send({ text: 'E', wpm: 20 }).catch(() => {});
    check(cwStatuses(cs).at(-1).status === 'error' && radio.log.includes('stop cw'), "CW text, still transmitting at the deadline: error, keyer stopped, not 'sent' (issue #78)");
  }
  {
    const radio = cwRadio();
    const cs = server(radio);
    const getMode = radio.getMode.bind(radio);
    radio.getMode = async () => {
      await sleep(80);
      return getMode();
    };
    const bridge = cwBridge(cs);
    const p = bridge.send({ text: 'CQ CQ', wpm: 25 });
    await sleep(20);
    bridge.abort(); // Stop while the mode read is still pending
    await p.catch(() => {});
    const st = cwStatuses(cs);
    check(!radio.log.some((l) => /^(speed|breakin|cw )/.test(l)), 'CW text, Stop during the first mode read: no keyer settings changed, nothing sent (issue #79): ' + radio.log.join(' | '));
    check(st.at(-1).status === 'aborted' && !st.some((s) => s.status === 'sending'), "status: 'aborted', with no 'sending' first");
  }

  clearTimeout(guard);
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exitCode = 1;
  } else console.log('\nAll transmit safety tests passed.');
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
