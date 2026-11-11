'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { ControlServer } = require('../src/server/ws-server');
const { CwTxBridge } = require('../src/server/cw-tx-bridge');
const { EVENT } = require('../src/server/protocol');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await sleep(10);
  }
}

async function setup(t) {
  const peer = await new IcomPeer().start();
  peer.mode = 3;
  const driver = new IcomLanDriver(peer.config());
  driver.on('error', () => {});
  await driver.open();
  const server = new ControlServer({ civ: driver });
  const statuses = [];
  const broadcast = server.broadcastJsonEvent.bind(server);
  server.broadcastJsonEvent = (type, data) => {
    if (type === EVENT.CW_TX_STATUS) statuses.push(data);
    broadcast(type, data);
  };
  const bridge = new CwTxBridge({ controlServer: server, estimateSeconds: () => 0.001,
    txEndQuietMs: 5, txEndMaxWaitMs: 35 });
  server.cwTxBusy = () => bridge.transmitting;
  const original = peer.civ.bind(peer);
  const settingsWhileTransmitting = [];
  let rejectRxRead = false;
  let rejectStop = true;
  let stopEndsCw = true;
  peer.civ = (p, a) => {
    if (p[4] === 0x17) {
      if (p[5] === 0xff) {
        if (!rejectStop && stopEndsCw) peer.ptt = false;
        return peer.replyCiv([rejectStop ? 0xfa : 0xfb], a);
      }
      peer.ptt = true; // Radio continues sending past the local estimate.
      return peer.replyCiv([0xfb], a);
    }
    if (p[4] === 0x1c && p[5] === 0) {
      if (p.length > 7) return peer.replyCiv([0xfb], a); // PTT-off doesn't stop autonomous CW.
      if (rejectRxRead) return peer.replyCiv([0xfa], a);
    }
    if (peer.ptt && ((p[4] === 0x16 && p[5] === 0x47 && p.length > 7)
      || (p[4] === 0x14 && p[5] === 0x0c && p.length > 7))) settingsWhileTransmitting.push(Buffer.from(p));
    return original(p, a);
  };
  t.after(async () => {
    bridge.stop();
    clearTimeout(server._pttWatchdogTimer);
    peer.civ = original;
    await driver.close();
    await peer.close();
  });
  return { peer, driver, server, bridge, statuses, settingsWhileTransmitting,
    rejectRxRead: (on) => { rejectRxRead = on; },
    allowStop: ({ endsCw = true } = {}) => { rejectStop = false; stopEndsCw = endsCw; } };
}

for (const action of ['timeout', 'abort', 'send error']) {
  test(`CW ${action}: rejected STOP holds transmit state and settings until actual RX`, async (t) => {
    const { peer, driver, server, bridge, statuses, settingsWhileTransmitting } = await setup(t);
    if (action === 'send error') {
      const send = driver.sendCw.bind(driver);
      driver.sendCw = async (text) => { await send(text); throw new Error('CW send failed after acceptance'); };
    }
    const sending = bridge.send({ text: 'E', wpm: 25 });
    if (action === 'abort') {
      await until(() => peer.ptt);
      bridge.abort();
    }
    if (action === 'send error') await assert.rejects(sending, /after acceptance/);
    else await sending;
    assert.equal(peer.ptt, true);
    assert.equal(bridge.transmitting, true);
    assert.equal(server.state.transmitting, true);
    assert.equal(server.receiveConfirmed, false);
    assert.equal(statuses.at(-1).status, 'error');
    assert.equal(statuses.at(-1).transmitting, true);
    assert.match(statuses.at(-1).error, /stop not confirmed/);
    assert.deepEqual(settingsWhileTransmitting, []);
    assert.equal(await driver.getBreakIn(), 1);
    assert.equal(await driver.getKeySpeed(), 25);
    assert.equal(server._heldRestores.length, 1);
    await assert.rejects(bridge.send({ text: 'AGAIN' }), /Already sending/);
    await assert.rejects(server.setPttFromServer(true), /receive has not been confirmed/);

    // A browser's ordinary PTT-off ACK cannot release the autonomous CW hold.
    await server.setPttFromServer(false);
    assert.equal(peer.ptt, true);
    assert.equal(server.transmitting, true);
    assert.equal(server.receiveConfirmed, false);
    assert.equal(server._heldRestores.length, 1);

    peer.ptt = false; // The keyer finally finishes (or an operator stops it).
    await until(() => !bridge.transmitting);
    await server._restoreChain;
    assert.equal(server.receiveConfirmed, true);
    assert.equal(server.state.transmitting, false);
    assert.equal(await driver.getBreakIn(), 0);
    assert.equal(await driver.getKeySpeed(), 20);
    assert.equal(server._heldRestores.length, 0);
    assert.deepEqual(settingsWhileTransmitting, []);
    assert.equal(statuses.at(-1).status, 'error');
    assert.equal(statuses.at(-1).transmitting, false);
    assert.match(statuses.at(-1).error, /Receive is now confirmed/);
  });
}

test('held CW restoration preserves changes made at the radio; unreadable RX never confirms release', async (t) => {
  const { peer, driver, server, bridge, rejectRxRead } = await setup(t);
  await bridge.send({ text: 'E', wpm: 25 });
  peer.breakIn = 2;
  peer.keySpeed = driver._encodeMeterValue(require('../src/civ/commands').wpmToKeySpeed(30));
  rejectRxRead(true);
  peer.ptt = false;
  await sleep(550);
  assert.equal(server.receiveConfirmed, false);
  assert.equal(server.transmitting, true);
  assert.equal(server._heldRestores.length, 1);
  rejectRxRead(false);
  await until(() => !bridge.transmitting);
  assert.equal(await driver.getBreakIn(), 2);
  assert.equal(await driver.getKeySpeed(), 30);
  assert.equal(server.receiveConfirmed, true);
});

test('STOP ACK while radio still reports TX is not a confirmed CW release', async (t) => {
  const { peer, server, bridge, allowStop } = await setup(t);
  // A successful STOP write can still precede the radio returning to RX.
  allowStop({ endsCw: false });
  await bridge.send({ text: 'E', wpm: 25 });
  assert.equal(peer.ptt, true);
  assert.equal(server.transmitting, true);
  assert.equal(server.receiveConfirmed, false);
  peer.ptt = false;
  await until(() => !bridge.transmitting);
});

test('another Stop retries a rejected command while keeping the receive hold', async (t) => {
  const { peer, driver, server, bridge, allowStop } = await setup(t);
  await bridge.send({ text: 'E', wpm: 25 });
  assert.equal(peer.ptt, true);
  allowStop();
  bridge.abort();
  assert.equal(server.transmitting, true);
  await until(() => !bridge.transmitting);
  assert.equal(peer.ptt, false);
  assert.equal(server.receiveConfirmed, true);
  assert.equal(await driver.getBreakIn(), 0);
  assert.equal(await driver.getKeySpeed(), 20);
});

test('a new browser receives the uncertain CW status and later recovery', async (t) => {
  const { peer, server, bridge } = await setup(t);
  bridge.start();
  await bridge.send({ text: 'E', wpm: 25 });
  const messages = [];
  const client = { OPEN: 1, readyState: 1, send: (packet) => messages.push(JSON.parse(packet)) };
  server.emit('client-connected', client);
  assert.equal(messages.at(-1).type, EVENT.CW_TX_STATUS);
  assert.equal(messages.at(-1).data.transmitting, true);
  assert.equal(messages.at(-1).data.status, 'error');
  assert.equal(server.state.cwTx.transmitting, true);
  peer.ptt = false;
  await until(() => !bridge.transmitting);
  server.emit('client-connected', client);
  assert.equal(messages.at(-1).data.transmitting, false);
  assert.equal(messages.at(-1).data.status, 'error');
});
