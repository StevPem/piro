'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { ControlServer } = require('../src/server/ws-server');
const { wireRadioConnection } = require('../src/server/radio-connection');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Radio manager condition timed out');
    await sleep(5);
  }
}

async function client(t, port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  const pending = new Map();
  let id = 0, snapshot;
  ws.on('message', (p, binary) => {
    if (binary) return;
    const message = JSON.parse(p);
    messages.push(message);
    if (message.type === 'connected') snapshot = message.data;
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  await until(() => snapshot);
  return {
    ws, messages, snapshot,
    request(type, extra = {}) {
      const key = String(++id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(key); reject(new Error(`${type} reply timed out`)); }, 3000);
        pending.set(key, (message) => { clearTimeout(timer); resolve(message); });
        ws.send(JSON.stringify({ id: key, type, ...extra }));
      });
    },
  };
}

async function setup(t, options = {}) {
  const peer = await new IcomPeer().start();
  const driver = new IcomLanDriver(peer.config({ reconnectAttempts: 2, reconnectMs: 50, ...options }));
  driver.on('error', () => {});
  let cs, manager;
  t.after(async () => {
    if (manager) {
      manager.setConnected(false);
      await until(() => cs.state.radioConnection?.manual && cs.state.radioConnection.state === 'disconnected');
    }
    if (cs) await cs.close();
    await driver.close();
    await peer.close();
  });
  await driver.open();
  cs = new ControlServer({ civ: driver, port: 0 });
  await cs.listen();
  manager = wireRadioConnection(driver, cs);
  assert.ok(manager);
  return { peer, driver, cs, manager };
}

async function off({ cs, manager }) {
  manager.setConnected(false);
  await until(() => cs.state.radioConnection.manual && cs.state.radioConnection.state === 'disconnected');
}

async function on({ manager }) {
  manager.setConnected(true);
  await until(() => manager.ready);
}

function handshakes(peer) {
  return peer.received.filter(({ packet }) => packet.readUInt16LE(4) === 3).length;
}

test('two browsers share manual radio disconnection and reconnect without losing their server links', async (t) => {
  const rig = await setup(t);
  const { peer, driver, cs, manager } = rig;
  const a = await client(t, cs.port);
  const b = await client(t, cs.port);
  assert.equal(a.snapshot.radioConnection.managed, true);
  assert.equal(a.snapshot.radioConnection.manual, false);
  assert.equal((await a.request('setRadioConnected', { connected: 'false' })).ok, false);
  assert.equal((await a.request('setRadioConnected', { connected: false })).ok, true);
  await until(() => cs.state.radioConnection.state === 'disconnected');
  await until(() => b.messages.some((e) => e.type === 'radio-connection' && e.data.manual && e.data.state === 'disconnected'));
  assert.equal(driver.session.stopped, true);
  assert.equal(driver.session.connected, false);
  assert.equal(a.ws.readyState, WebSocket.OPEN);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  const fresh = await client(t, cs.port);
  assert.equal(fresh.snapshot.radioConnection.manual, true);
  assert.equal(fresh.snapshot.radioConnection.state, 'disconnected');
  assert.ok(!JSON.stringify(fresh.snapshot.radioConnection).includes('beer'), 'Radio credentials stay out of the browser status');
  const commands = peer.commands.length;
  for (const [type, fields] of [
    ['setFrequency', { value: 14080000 }], ['setPtt', { value: true }],
    ['setFrequency', { value: 14080000, active: false }],
    ['sendCw', { text: 'TEST' }],
  ]) assert.equal((await a.request(type, fields)).ok, false, `${type} must not operate an intentionally disconnected radio`);
  assert.equal(peer.commands.length, commands);
  const before = b.messages.length;
  assert.equal((await b.request('setRadioConnected', { connected: true })).ok, true);
  await until(() => manager.ready);
  await until(() => b.messages.slice(before).some((e) => e.type === 'radio-connection' && !e.data.manual && e.data.state === 'connected'));
  const read = await a.request('getFrequency');
  assert.equal(read.ok, true);
  assert.equal(read.data.value, 14074000);
});

test('USB server rejects native LAN management without opening or closing its serial transport', async (t) => {
  const civ = new EventEmitter();
  let calls = 0;
  civ.open = civ.close = () => { ++calls; };
  const cs = new ControlServer({ civ, port: 0 });
  await cs.listen();
  t.after(() => cs.close());
  wireRadioConnection(civ, cs);
  const browser = await client(t, cs.port);
  assert.equal(browser.snapshot.radioConnection.transport, 'usb');
  assert.equal((await browser.request('setRadioConnected', { connected: false })).ok, false);
  assert.equal(calls, 0);
});

test('repeated manual reopen restores paced audio without accumulating transport listeners', async (t) => {
  const rig = await setup(t);
  const { peer, driver } = rig;
  driver.capture.start();
  driver.playback.start();
  const initialListeners = driver.port.listenerCount('data');
  const chunks = [];
  driver.capture.on('data', (pcm) => chunks.push(pcm));
  for (let cycle = 0; cycle < 3; ++cycle) {
    await off(rig);
    assert.equal(driver.capture.active, false);
    assert.equal(driver.playback.active, false);
    assert.equal(peer.parameters.get('0079')[0], 1, 'Original AF source is restored while detached');
    await on(rig);
    assert.equal(driver.port.listenerCount('data'), initialListeners);
    assert.equal(driver.capture.active, true);
    assert.equal(driver.playback.active, true);
    assert.equal(peer.parameters.get('0079')[0], 0, 'LAN receive AF is selected again');
    const before = chunks.length;
    for (let frame = 0; frame < 4; ++frame) {
      const pcm = Buffer.alloc(1920);
      for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1234 + cycle, i);
      peer.rxAudio(pcm.subarray(0, 1364));
      peer.rxAudio(pcm.subarray(1364));
    }
    await until(() => chunks.slice(before).some((pcm) => pcm.readInt16LE(0) === 1234 + cycle));
  }
});

test('manual disconnect cancels an automatic reconnect and stays off despite late peer packets', async (t) => {
  const rig = await setup(t, { reconnectMs: 500 });
  const { peer, driver, cs } = rig;
  peer.release();
  await until(() => cs.state.radioConnection.state === 'reconnecting');
  await off(rig);
  const starts = handshakes(peer);
  peer.release();
  await sleep(650);
  assert.equal(handshakes(peer), starts);
  assert.equal(driver.session.connected, false);
  assert.equal(cs.state.radioConnection.manual, true);
  assert.equal(cs.state.radioConnection.state, 'disconnected');
});

test('manual disconnect during transport teardown cannot be followed by an automatic reopen', async (t) => {
  const rig = await setup(t, { reconnectMs: 50 });
  const { peer, driver, manager, cs } = rig;
  driver.once('transport-lost', () => manager.setConnected(false));
  peer.release();
  await until(() => cs.state.radioConnection.manual && cs.state.radioConnection.state === 'disconnected');
  const starts = handshakes(peer);
  await sleep(150);
  assert.equal(driver.session.connected, false);
  assert.equal(handshakes(peer), starts);
  assert.equal(cs.state.radioConnection.state, 'disconnected');
});

test('Disconnect cancels an in-flight manual connect before its retry budget, and a later Connect works', async (t) => {
  const rig = await setup(t, { timeoutMs: 1500, reconnectAttempts: 3 });
  const { peer, manager, driver, cs } = rig;
  await off(rig);
  peer.options.silent = true;
  manager.setConnected(true);
  await until(() => cs.state.radioConnection.state === 'connecting');
  const started = performance.now();
  await off(rig);
  assert.ok(performance.now() - started < 750, 'Manual stop must not wait through handshake/retry timeout');
  const starts = handshakes(peer);
  await sleep(150);
  assert.equal(handshakes(peer), starts);
  assert.equal(driver.session.connected, false);
  peer.options.silent = false;
  await on(rig);
  assert.equal(cs.state.radioConnection.manual, false);
});

test('cancelling initialized LAN open restores changed receive settings before releasing the session', async (t) => {
  const rig = await setup(t);
  const { peer, driver, manager, cs } = rig;
  await off(rig);
  assert.equal(peer.parameters.get('0079')[0], 1);
  assert.equal(peer.parameters.get('0080')[0], 1);
  const close = driver.session.close.bind(driver.session);
  const closingSettings = [];
  driver.session.close = (...args) => {
    closingSettings.push([peer.parameters.get('0079')[0], peer.parameters.get('0080')[0]]);
    return close(...args);
  };
  const respond = peer.civ.bind(peer);
  let heldFrequencyRead = false;
  peer.civ = (frame, association) => {
    if (!heldFrequencyRead && frame[4] === 3) {
      heldFrequencyRead = true;
      peer.schedule(() => respond(frame, association), 100);
      return;
    }
    respond(frame, association);
  };
  manager.setConnected(true);
  await until(() => heldFrequencyRead && peer.parameters.get('0079')[0] === 0 && peer.parameters.get('0080')[0] === 0);
  assert.equal(driver.prepared, false, 'Open is still initializing, not ready for transmission');
  manager.setConnected(false);
  await until(() => cs.state.radioConnection.manual && cs.state.radioConnection.state === 'disconnected');
  assert.equal(peer.parameters.get('0079')[0], 1, 'Cancelling open must restore the original AF source');
  assert.equal(peer.parameters.get('0080')[0], 1, 'Cancelling open must restore the original AF squelch');
  assert.ok(closingSettings.length > 0);
  assert.deepEqual(closingSettings[0], [1, 1], 'Receive settings must be restored before the session is released');
  assert.equal(driver.session.connected, false);
});

test('disconnect during an initialization parameter write waits for its ACK before same-session rollback', async (t) => {
  const rig = await setup(t);
  const { peer, driver, manager, cs } = rig;
  await off(rig);
  const respond = peer.civ.bind(peer);
  const reply = peer.replyCiv.bind(peer);
  let holdNextAck = false, heldWrite = false, ackReleased = false;
  peer.civ = (frame, association) => {
    if (!heldWrite && frame[4] === 0x1a && frame[5] === 5
      && frame.subarray(6, 8).toString('hex') === '0079' && frame.length === 10 && frame[8] === 0) holdNextAck = true;
    respond(frame, association);
  };
  peer.replyCiv = (body, association, fault) => {
    if (holdNextAck && body[0] === 0xfb) {
      holdNextAck = false;
      heldWrite = true;
      peer.schedule(() => { ackReleased = true; reply(body, association, fault); }, 100);
      return;
    }
    return reply(body, association, fault);
  };
  const close = driver.session.close.bind(driver.session);
  const closing = [];
  driver.session.close = (...args) => {
    closing.push({ ackReleased, settings: [peer.parameters.get('0079')[0], peer.parameters.get('0080')[0]] });
    return close(...args);
  };
  manager.setConnected(true);
  await until(() => heldWrite && peer.parameters.get('0079')[0] === 0);
  const starts = handshakes(peer);
  assert.equal(ackReleased, false, 'The initialization write is still awaiting its ACK');
  manager.setConnected(false);
  await until(() => cs.state.radioConnection.manual && cs.state.radioConnection.state === 'disconnected');
  assert.equal(ackReleased, true);
  assert.ok(closing.length > 0);
  assert.deepEqual(closing[0], { ackReleased: true, settings: [1, 1] });
  assert.equal(handshakes(peer), starts, 'Rollback must finish on the existing association');
  assert.equal(driver.session.connected, false);
});

test('rapid requests from multiple callers settle at the latest requested state', async (t) => {
  const rig = await setup(t);
  const { manager, cs, driver } = rig;
  manager.setConnected(false);
  manager.setConnected(true);
  manager.setConnected(false);
  await until(() => cs.state.radioConnection.manual && cs.state.radioConnection.state === 'disconnected');
  assert.equal(driver.session.connected, false);
  manager.setConnected(true);
  manager.setConnected(false);
  manager.setConnected(true);
  await until(() => manager.ready);
  assert.equal(cs.state.radioConnection.state, 'connected');
  assert.equal(cs.state.radioConnection.manual, false);
  assert.equal(driver.session.stopped, false, 'Latest Connect must re-enable normal automatic recovery');
  await sleep(75);
  assert.equal(manager.ready, true, 'A stale close cannot override the latest Connect');
});

test('latest Connect during authenticated initialization keeps automatic recovery enabled', async (t) => {
  const rig = await setup(t);
  const { peer, driver, manager } = rig;
  await off(rig);
  const respond = peer.civ.bind(peer);
  let held = false;
  peer.civ = (frame, association) => {
    if (!held && frame[4] === 3) {
      held = true;
      peer.schedule(() => respond(frame, association), 100);
      return;
    }
    respond(frame, association);
  };
  manager.setConnected(true);
  await until(() => held);
  manager.setConnected(false);
  manager.setConnected(true);
  await until(() => manager.ready);
  assert.equal(driver.session.stopped, false, 'A cancelled Disconnect must not leave retry suppression set');
  const association = peer.associations.civ;
  peer.release();
  await until(() => peer.associations.civ !== association && manager.ready);
  assert.equal(driver.prepared, true);
});

test('disconnect releases active mock transmission, restores routing and discards audio before reconnect', async (t) => {
  const rig = await setup(t);
  const { peer, driver } = rig;
  driver.playback.start();
  await driver.setMode('USB');
  await driver.setPtt(true);
  assert.equal(peer.ptt, true);
  driver.playback.write(Buffer.alloc(1920 * 20, 7));
  await off(rig);
  assert.equal(peer.ptt, false);
  assert.equal(driver.playback.queue.bytes, 0);
  assert.equal(peer.parameters.get('0084')[0], 0, 'Original voice modulation source is restored');
  const sent = peer.txAudio.length;
  await on(rig);
  await sleep(100);
  assert.equal(peer.ptt, false);
  assert.equal(peer.txAudio.length, sent, 'Reconnect must not send the previous transmission');
});
