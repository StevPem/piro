'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CivDriver } = require('../src/civ/driver');
const { encodeFrame, freqToBCD } = require('../src/civ/frame');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { IcomPeer } = require('./fixtures/icom-lan-peer');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await sleep(5);
  }
}

function startsRf(frame) {
  return (frame[4] === 0x1c && ((frame[5] === 0 && frame[6] === 1)
    || (frame[5] === 1 && frame[6] === 2))) || (frame[4] === 0x17 && frame[5] !== 0xff);
}

class UsbTransport extends EventEmitter {
  constructor() { super(); this.isOpen = true; this.written = []; this.lines = []; }
  write(bytes, callback) { this.written.push(Buffer.from(bytes)); callback?.(); }
  set(value, callback) { this.lines.push(value); callback?.(); }
  close(callback) { this.isOpen = false; callback?.(); }
  reply(cmd, subCmd, data) {
    this.emit('data', encodeFrame({ to: 0xe0, from: 0x94, cmd, subCmd, data }));
  }
}

test('USB emergency OFF retires queued RF starts while allowing OFF and cleanup', async () => {
  const transport = new UsbTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: 0x94, transport });
  await driver.open();
  const poll = driver.getFrequency();
  const starts = Promise.allSettled([driver.setPtt(true), driver.sendCw('E'), driver.setTuner(2)]);
  const release = driver.setPtt(false);
  assert.equal(await driver.forcePttOff(), true);
  const results = await starts;
  assert.ok(results.every((r) => r.status === 'rejected' && /emergency unkey/.test(r.reason.message)));

  // Let the old poll finish: it must dequeue only the permitted release.
  transport.reply(3, undefined, freqToBCD(14074000));
  assert.equal(await poll, 14074000);
  transport.reply(0xfb);
  await release;
  assert.equal(transport.written.filter(startsRf).length, 0);
  assert.equal(transport.written.filter((p) => p[4] === 0x1c).length, 2);
  await driver.close();
});

test('USB emergency fence also refuses later RF starts and key-line assertions', async () => {
  const transport = new UsbTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: 0x94, transport });
  await driver.open();
  await driver.forcePttOff();
  for (const start of [() => driver.setPtt(true), () => driver.sendCw('E'),
    () => driver.setTuner(2), () => driver.setKeyLine('dtr', true), () => driver.setKeyLine('rts', true)]) {
    await assert.rejects(start(), /emergency unkey/);
  }
  await driver.setKeyLine('dtr', false);
  assert.deepEqual(transport.lines, [{ dtr: false }]);
  const stop = driver.stopCw(); transport.reply(0xfb); await stop;
  const tunerOff = driver.setTuner(0); transport.reply(0xfb); await tunerOff;
  assert.equal(transport.written.filter(startsRf).length, 0);
  await driver.close();
});

async function radio(t) {
  const peer = await new IcomPeer().start();
  const driver = new IcomLanDriver(peer.config({ txBufferMs: 0 }));
  driver.on('error', () => {});
  t.after(async () => { await driver.close(); await peer.close(); });
  await driver.open();
  await driver.setMode('CW');
  return { peer, driver };
}

test('LAN emergency OFF cannot be followed by a PTT-on queued behind a poll', async (t) => {
  const { peer, driver } = await radio(t);
  let poll;
  const enqueuePoll = (frame) => {
    if (frame[4] !== 4) return;
    peer.off('command', enqueuePoll);
    poll = driver.getFrequency().catch(() => {});
  };
  peer.on('command', enqueuePoll);
  const original = peer.civ.bind(peer);
  peer.civ = (frame, association) => {
    if (frame[4] === 3) peer.options.delayNextReply = 100;
    return original(frame, association);
  };
  const before = peer.commands.length;
  const start = driver.setPtt(true);
  const result = Promise.allSettled([start]);
  await until(() => driver._queue.some((job) => startsRf(job.raw)));
  assert.equal(await driver.forcePttOff(), true);
  assert.equal((await result)[0].status, 'rejected');
  await poll;
  await sleep(150); // delayed poll and emergency replies have both arrived
  assert.equal(peer.commands.slice(before).filter(startsRf).length, 0);
  assert.equal(peer.ptt, false);
});

test('LAN emergency OFF cancels PTT preparation and refuses starts prepared later', async (t) => {
  const { peer, driver } = await radio(t);
  const before = peer.commands.length;
  peer.options.delayNextReply = 100;
  const start = driver.setPtt(true);
  const result = Promise.allSettled([start]);
  await until(() => driver._current !== null);
  await driver.forcePttOff();
  assert.equal((await result)[0].status, 'rejected');
  await assert.rejects(driver.setPtt(true), /emergency unkey/);
  await assert.rejects(driver.sendCw('E'), /emergency unkey/);
  await assert.rejects(driver.setTuner(2), /emergency unkey/);
  assert.equal(peer.commands.slice(before).filter(startsRf).length, 0);
  assert.equal(peer.ptt, false);
});
