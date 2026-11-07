'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { ControlServer } = require('../src/server/ws-server');
const { wireRadioConnection } = require('../src/server/radio-connection');

async function setup(t, mode, intercept) {
  const peer = await new IcomPeer().start();
  peer.mode = mode;
  const respond = peer.civ.bind(peer);
  if (intercept) peer.civ = (frame, association) => intercept(peer, frame, association, respond);
  const driver = new IcomLanDriver(peer.config({ requestTimeoutMs: 100 }));
  driver.on('error', () => {});
  t.after(async () => { await driver.close(); await peer.close(); });
  return { peer, driver };
}

test('LAN startup connects outside CW without sending a mode-inapplicable CW stop', async (t) => {
  for (const [name, mode] of [['LSB', 0], ['USB', 1], ['AM', 2], ['RTTY', 4], ['FM', 5], ['RTTY_R', 8]]) {
    await t.test(name, async (t) => {
      const { peer, driver } = await setup(t, mode, (p, frame, association, respond) => {
        if (frame[4] === 0x17) {
          p.commands.push(Buffer.from(frame));
          p.replyCiv([0xfa], association); // Observed physical MK2 reply in USB.
        } else respond(frame, association);
      });
      await driver.open();
      assert.equal(driver.prepared, true);
      assert.equal((await driver.getMode()).mode, name);
      assert.equal(peer.commands.some((frame) => frame[4] === 0x17), false);
      assert.ok(peer.commands.some((frame) => frame.subarray(4, -1).toString('hex') === '1c0000'));
      assert.ok(peer.commands.some((frame) => frame.subarray(4, -1).toString('hex') === '1c00'));
      assert.equal(peer.ptt, false);
    });
  }
});

test('CW and CW-R startup still stop the keyer without changing mode or break-in', async (t) => {
  for (const [name, mode] of [['CW', 3], ['CW_R', 7]]) await t.test(name, async (t) => {
    const { peer, driver } = await setup(t, mode);
    await driver.open();
    assert.equal(peer.cwStopped, true);
    assert.equal((await driver.getMode()).mode, name);
    assert.equal(peer.breakIn, 0);
    assert.equal(peer.ptt, false);
  });
});

test('rejected CW stop in CW remains fatal after PTT release and before RX settings writes', async (t) => {
  const { peer, driver } = await setup(t, 3, (p, frame, association, respond) => {
    if (frame[4] === 0x17) p.replyCiv([0xfa], association);
    else respond(frame, association);
  });
  peer.ptt = true;
  await assert.rejects(driver.open(), /stop CW/);
  assert.equal(peer.ptt, false);
  assert.equal(driver.prepared, false);
  assert.equal(peer.parameters.get('0079')[0], 1);
  assert.equal(peer.parameters.get('0080')[0], 1);
});

test('non-CW startup still rejects failed PTT release', async (t) => {
  const { peer, driver } = await setup(t, 1, (p, frame, association, respond) => {
    if (frame.subarray(4, -1).toString('hex') === '1c0000') p.replyCiv([0xfa], association);
    else respond(frame, association);
  });
  await assert.rejects(driver.open(), /PTT/);
  assert.equal(driver.prepared, false);
  assert.equal(peer.parameters.get('0079')[0], 1);
});

test('startup requires actual receive readback even after the PTT-off ACK', async (t) => {
  const { peer, driver } = await setup(t, 1, (p, frame, association, respond) => {
    if (frame.subarray(4, -1).toString('hex') === '1c0000') {
      p.ptt = true; // ACK alone must not be treated as proof of receive.
      p.replyCiv([0xfb], association);
    } else respond(frame, association);
  });
  await assert.rejects(driver.open(), /confirm receive/);
  assert.equal(driver.prepared, false);
  assert.equal(peer.parameters.get('0079')[0], 1);
});

test('unknown mode and a failed mode read do not bypass startup checks', async (t) => {
  await t.test('unknown mode', async (t) => {
    const { driver } = await setup(t, 0xff);
    await assert.rejects(driver.open(), /Unknown radio mode/);
    assert.equal(driver.prepared, false);
  });
  await t.test('mode read timeout', async (t) => {
    const { driver } = await setup(t, 1, (_p, frame, association, respond) => {
      if (frame[4] !== 4) respond(frame, association);
    });
    await assert.rejects(driver.open(), /timed out/);
    assert.equal(driver.prepared, false);
  });
});

test('manual cancellation during PTT-off acknowledgement still stops CW before session release', async (t) => {
  const peer = await new IcomPeer().start();
  const driver = new IcomLanDriver(peer.config());
  driver.on('error', () => {});
  let cs, manager;
  const until = async (predicate) => {
    const deadline = performance.now() + 3000;
    while (!predicate()) {
      assert.ok(performance.now() < deadline, 'CW startup cancellation timed out');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  t.after(async () => {
    if (manager) {
      manager.setConnected(false);
      await until(() => cs.state.radioConnection.state === 'disconnected');
    }
    if (cs) await cs.close();
    await driver.close();
    await peer.close();
  });
  await driver.open();
  cs = new ControlServer({ civ: driver, port: 0 });
  await cs.listen();
  manager = wireRadioConnection(driver, cs);
  manager.setConnected(false);
  await until(() => cs.state.radioConnection.state === 'disconnected');
  peer.mode = 3;
  peer.cwStopped = false;
  const respond = peer.civ.bind(peer);
  let heldPttOff = false;
  peer.civ = (frame, association) => {
    if (!heldPttOff && frame.subarray(4, -1).toString('hex') === '1c0000') {
      heldPttOff = true;
      peer.options.delayNextReply = 100;
    }
    respond(frame, association);
  };
  const close = driver.session.close.bind(driver.session);
  let cwStoppedAtRelease;
  driver.session.close = (...args) => {
    if (cwStoppedAtRelease === undefined) cwStoppedAtRelease = peer.cwStopped;
    return close(...args);
  };
  manager.setConnected(true);
  await until(() => heldPttOff);
  manager.setConnected(false);
  await until(() => cs.state.radioConnection.state === 'disconnected');
  assert.equal(cwStoppedAtRelease, true, 'The keyer must be stopped before closing the authenticated association');
  assert.equal(peer.cwStopped, true);
  assert.equal(peer.ptt, false);
  assert.equal(driver.prepared, false);
});
