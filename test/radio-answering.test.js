'use strict';

// Run with: node test/radio-answering.test.js
// The radio stops answering CI-V (switched off, or its CI-V hung, as RF in
// the USB lead can do): CivDriver says so once several requests in a row
// have timed out and none has been answered for a while, and again when it
// answers; ControlServer tells the browsers; and radio-watch.js can give up
// after a set time (off unless CIV_SILENT_RESTART_MINUTES is set).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CivDriver } = require('../src/civ/driver');
const { ControlServer } = require('../src/server/ws-server');
const { EVENT } = require('../src/server/protocol');
const { watchRadio } = require('../src/server/radio-watch');
const { FakeCivRadio } = require('./fixtures/fake-civ-radio');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function driver(t, opts = {}) {
  const radio = new FakeCivRadio();
  const civ = new CivDriver({ path: 'stand-in', transport: radio, radioAddr: 0x94, requestTimeoutMs: 40, staleReplyGuardMs: 0, silentAfterMs: 150, ...opts });
  await civ.open();
  const seen = [];
  civ.on('answering', (a) => seen.push(a));
  t.after(() => radio.close());
  return { radio, civ, seen };
}

test('not answering: only after 3 timeouts in a row and no answer for silentAfterMs', async (t) => {
  const { radio, civ, seen } = await driver(t);
  assert.equal(await civ.getFrequency(), 14074000);
  assert.equal(civ.answering, true);
  radio.silent = true;
  for (let i = 0; i < 3; i++) await assert.rejects(civ.getFrequency(), /timed out/);
  assert.deepEqual(seen, [], 'three quick timeouts are not enough: the last answer was under 150 ms ago');
  await sleep(160);
  await assert.rejects(civ.getFrequency(), /timed out/);
  assert.deepEqual(seen, [false], 'then it is not answering');
  assert.equal(civ.answering, false);
  await assert.rejects(civ.getSMeter(), /timed out/);
  assert.deepEqual(seen, [false], 'said once, not on every timeout');
  radio.silent = false;
  assert.equal(await civ.getFrequency(), 14074000, 'requests are still tried');
  assert.deepEqual(seen, [false, true], 'the first answer: answering again');
  assert.equal(civ.answering, true);
});

test('an answer between timeouts starts the count again', async (t) => {
  const { radio, civ, seen } = await driver(t, { silentAfterMs: 0 });
  radio.silent = true;
  for (let i = 0; i < 2; i++) await assert.rejects(civ.getFrequency());
  radio.silent = false;
  await civ.getFrequency();
  radio.silent = true;
  for (let i = 0; i < 2; i++) await assert.rejects(civ.getFrequency());
  assert.deepEqual(seen, [], 'never 3 in a row');
  await assert.rejects(civ.getFrequency());
  assert.deepEqual(seen, [false]);
});

test('ControlServer tells the browsers, and new browsers get it in the snapshot', async (t) => {
  const { radio, civ } = await driver(t);
  const cs = new ControlServer({ civ, port: 0, heartbeatMs: 0 });
  t.after(() => cs.close());
  const events = [];
  const broadcast = cs._broadcast.bind(cs);
  cs._broadcast = (payload, except) => {
    events.push(JSON.parse(payload));
    return broadcast(payload, except);
  };
  const log = { error: console.error, log: console.log };
  console.error = console.log = () => {};
  t.after(() => Object.assign(console, log));
  assert.equal(cs.state.radioAnswering, true);
  radio.silent = true;
  await sleep(160);
  for (let i = 0; i < 3; i++) await assert.rejects(civ.getFrequency());
  assert.equal(cs.state.radioAnswering, false, 'in the snapshot');
  assert.deepEqual(events.filter((e) => e.type === EVENT.RADIO_ANSWERING).map((e) => e.data.answering), [false], 'broadcast');
  radio.silent = false;
  await civ.getFrequency();
  assert.equal(cs.state.radioAnswering, true);
  assert.deepEqual(events.filter((e) => e.type === EVENT.RADIO_ANSWERING).map((e) => e.data.answering), [false, true]);
});

test('radio-watch: off unless set; gives up after the time; an answer cancels it', () => {
  const civ = new EventEmitter();
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (t) => (t.cleared = true);
  let gaveUp = 0;
  const giveUp = () => gaveUp++;

  watchRadio({ civ, minutes: 0, giveUp, setTimer, clearTimer });
  civ.emit('answering', false);
  assert.equal(timers.length, 0, 'minutes 0: off');
  civ.removeAllListeners();

  const stop = watchRadio({ civ, minutes: 5, giveUp, setTimer, clearTimer });
  civ.emit('answering', false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 300000, '5 minutes');
  civ.emit('answering', false);
  assert.equal(timers.length, 1, 'one timer, not one per event');
  civ.emit('answering', true);
  assert.ok(timers[0].cleared, 'answering again cancels it');
  civ.emit('answering', false);
  timers[1].fn();
  assert.equal(gaveUp, 1, 'gives up when the time is up');
  civ.emit('answering', false);
  stop();
  assert.ok(timers[2].cleared && civ.listenerCount('answering') === 0, 'stop() removes the listener and the timer');
});
