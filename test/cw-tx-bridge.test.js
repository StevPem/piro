// Run with: node test/cw-tx-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { CwTxBridge, cleanCwText, cwSeconds, cwChunks } = require('../src/server/cw-tx-bridge');
const { EVENT } = require('../src/server/protocol');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A radio with a CW keyer whose buffer holds `slots` pieces; each takes `pieceMs` to send. */
class StubCiv {
  constructor({ mode = 'CW', speed = 15, breakIn = 0, slots = 1, pieceMs = 40 } = {}) {
    Object.assign(this, { mode, speed, breakIn, slots, pieceMs });
    this.log = [];
    this.queue = 0;
    this.sent = [];
    this.transmittingUntil = 0;
  }
  async getMode() {
    return { mode: this.mode, filter: 1 };
  }
  async getKeySpeed() {
    return this.speed;
  }
  async setKeySpeed(w) {
    this.log.push(`speed ${w}`);
    this.speed = w;
  }
  async getBreakIn() {
    return this.breakIn;
  }
  async setBreakIn(v) {
    this.log.push(`breakin ${v}`);
    this.breakIn = v;
  }
  async sendCw(text) {
    if (this.queue >= this.slots) {
      this.log.push('cw NG');
      return false;
    }
    this.queue++;
    this.sent.push(text);
    this.log.push(`cw "${text}"`);
    this.transmittingUntil = Math.max(Date.now(), this.transmittingUntil) + this.pieceMs;
    setTimeout(() => this.queue--, this.pieceMs);
    return true;
  }
  async stopCw() {
    this.log.push('cw stop');
    this.queue = 0;
    this.transmittingUntil = 0;
  }
  async getTransmitting() {
    return Date.now() < this.transmittingUntil;
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
}
const statuses = (cs) => cs.broadcasts.filter((b) => b.type === EVENT.CW_TX_STATUS).map((b) => b.data);
function setup(civOpts, bridgeOpts) {
  const civ = new StubCiv(civOpts);
  const controlServer = new StubControlServer(civ);
  // tiny timings: each piece "takes" pieceMs to send
  const bridge = new CwTxBridge({ controlServer, estimateSeconds: (t) => (t.length / 30) * 0.04, leadSec: 0.01, txEndQuietMs: 30, ...bridgeOpts });
  bridge.start();
  return { civ, controlServer, bridge };
}

(async () => {
  // --- text handling and timing ---
  {
    const c = cleanCwText('  cq  cq de vk2io #k ~ ');
    check(c.text === 'CQ CQ DE VK2IO K' && c.dropped.join('') === '#~', `text cleaned to capitals, unsendable characters left out: "${c.text}", dropped ${c.dropped.join(' ')}`);
    check(Math.abs(cwSeconds('PARIS', 20) - 2.58) < 0.001 && Math.abs(cwSeconds('PARIS PARIS', 20) - 5.58) < 0.001, 'PARIS timing: 43 dots for the word, 7 between words (2.58 s at 20 WPM)');
    check(cwSeconds('^AR', 20) < cwSeconds('A R', 20) && cwSeconds('^AR', 20) < cwSeconds('AR', 20), 'a ^ prosign runs its two letters together');
    const ch = cwChunks('CQ CQ CQ DE VK2IO VK2IO VK2IO K CQ CQ CQ DE VK2IO VK2IO K');
    check(ch.every((p) => p.length <= 30) && ch.join('') === 'CQ CQ CQ DE VK2IO VK2IO VK2IO K CQ CQ CQ DE VK2IO VK2IO K' && ch[0].endsWith(' '), 'split into pieces of up to 30 characters at spaces (the space kept, so the word gap is sent): ' + ch.map((p) => `"${p}"`).join(' '));
    check(cwChunks('X'.repeat(65)).map((p) => p.length).join() === '30,30,5', 'a long word is split at 30 characters');
  }

  // --- a message: speed and break-in set, sent in pieces as the buffer frees, all put back ---
  {
    const { civ, controlServer, bridge } = setup({ slots: 1, pieceMs: 60 });
    const text = 'cq cq cq de vk2io vk2io vk2io k cq cq cq de vk2io vk2io k';
    await bridge.send({ text, wpm: 25 });
    const st = statuses(controlServer);
    check(st.map((s) => s.status).join() === 'sending,sent' && st[0].wpm === 25 && st[0].text === text.toUpperCase(), `status: ${st.map((s) => s.status).join(' -> ')}, at 25 WPM`);
    check(civ.sent.join('') === text.toUpperCase() && civ.sent.length === 2, 'the whole text handed to the keyer, in two pieces');
    check(civ.log[0] === 'speed 25' && civ.log[1] === 'breakin 1', 'key speed set to 25 WPM and semi break-in turned on first: ' + civ.log.slice(0, 2).join(' | '));
    check(civ.log.includes('cw NG'), 'the second piece waited (NG, retried) while the radio was still sending the first');
    check(civ.log.slice(-2).join(' | ') === 'breakin 0 | speed 15', 'afterwards break-in back off and the speed back to 15 WPM: ' + civ.log.slice(-2).join(' | '));
    check(civ.transmittingUntil <= Date.now(), "'sent' only once the radio had finished transmitting");
    check(!bridge.transmitting, 'not sending afterwards');
  }

  // --- break-in already on and the speed already right: left alone ---
  {
    const { civ, bridge } = setup({ breakIn: 2, speed: 20 });
    await bridge.send({ text: 'TEST', wpm: 20 });
    check(civ.log.join(' | ') === 'cw "TEST"', 'full break-in and the same speed: nothing changed, nothing to put back: ' + civ.log.join(' | '));
  }

  // --- refused unless the radio is in CW; nothing touched ---
  {
    const { civ, controlServer, bridge } = setup({ mode: 'USB' });
    await bridge.send({ text: 'TEST', wpm: 20 }).catch(() => {});
    const last = statuses(controlServer).at(-1);
    check(last.status === 'error' && /in CW first/.test(last.error) && civ.log.length === 0, 'not in CW: refused, the keyer and settings untouched: ' + last.error);
  }
  {
    const { civ, controlServer, bridge } = setup({ mode: 'CW-R' });
    await bridge.send({ text: 'TEST', wpm: 20 });
    check(statuses(controlServer).at(-1).status === 'sent' && civ.sent.join() === 'TEST', 'CW-R is fine too');
  }

  // --- what gets refused before anything is sent ---
  {
    const { civ, controlServer, bridge } = setup();
    await bridge.send({ text: '###', wpm: 20 }).catch(() => {});
    check(/Nothing to send/.test(statuses(controlServer).at(-1).error), 'text with nothing sendable is refused');
    await bridge.send({ text: 'X'.repeat(301), wpm: 20 }).catch(() => {});
    check(/At most 300/.test(statuses(controlServer).at(-1).error), 'more than 300 characters is refused');
    const real = new CwTxBridge({ controlServer });
    await real.send({ text: '00000 '.repeat(50).trim(), wpm: 6 }).catch(() => {});
    check(/minutes at 6 WPM/.test(statuses(controlServer).at(-1).error), 'something that would take over 9 minutes is refused: ' + statuses(controlServer).at(-1).error);
    controlServer.state.ptt = true;
    await bridge.send({ text: 'TEST', wpm: 20 }).catch(() => {});
    check(/already transmitting/.test(statuses(controlServer).at(-1).error) && civ.log.length === 0, 'refused while the radio is transmitting');
  }

  // --- the speed is kept to what the keyer can do ---
  {
    const { civ, controlServer, bridge } = setup();
    await bridge.send({ text: 'E', wpm: 99 });
    await bridge.send({ text: 'E', wpm: 2 });
    check(civ.log.includes('speed 48') && civ.log.includes('speed 6') && statuses(controlServer)[0].wpm === 48, 'WPM limited to the keyer\'s 6-48');
  }

  // --- Stop: the keyer told to stop, settings put back ---
  {
    const { civ, controlServer, bridge } = setup({ slots: 1, pieceMs: 400 });
    const p = bridge.send({ text: 'CQ CQ CQ DE VK2IO VK2IO VK2IO K CQ CQ', wpm: 20 });
    while (statuses(controlServer).at(-1)?.status !== 'sending') await sleep(5);
    await sleep(50);
    bridge.abort();
    await p;
    check(statuses(controlServer).at(-1).status === 'aborted' && civ.log.includes('cw stop') && civ.sent.length === 1, 'Stop: the keyer is stopped, the rest never sent');
    check(civ.log.slice(-2).join(' | ') === 'breakin 0 | speed 15', 'and break-in and speed put back');
  }

  // --- the last browser leaving stops it ---
  {
    const { civ, controlServer, bridge } = setup({ slots: 1, pieceMs: 400 });
    controlServer.clients = new Set(['a']);
    const p = bridge.send({ text: 'CQ CQ CQ DE VK2IO VK2IO VK2IO K CQ', wpm: 20 });
    while (statuses(controlServer).at(-1)?.status !== 'sending') await sleep(5);
    controlServer.clients.clear();
    controlServer.emit('client-disconnected', 'a');
    await p;
    check(statuses(controlServer).at(-1).status === 'aborted' && civ.log.includes('cw stop'), 'the last browser leaving stops the CW');
  }

  // --- one at a time ---
  {
    const { controlServer, bridge } = setup({ pieceMs: 200 });
    const p = bridge.send({ text: 'TEST', wpm: 20 });
    await bridge.send({ text: 'AGAIN', wpm: 20 }).catch(() => {});
    check(/Already sending/.test(statuses(controlServer).at(-1).error), 'a second message while one is going out is refused');
    await p;
  }

  console.log(failures ? `\n${failures} test(s) failed.` : '\nall CW transmit tests passed');
  process.exit(failures ? 1 : 0);
})();
