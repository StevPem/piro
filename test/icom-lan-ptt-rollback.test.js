'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');

test('lost key acknowledgement resets the association and retains LAN routing until reconnect confirms RX', async (t) => {
  const peer = await new IcomPeer().start();
  t.after(() => peer.close());
  const civ = new IcomLanDriver({ ...peer.config(), requestTimeoutMs: 80 });
  t.after(() => civ.close());
  await civ.open();
  const respond = peer.civ.bind(peer);
  let rejectRelease = true;
  peer.civ = (frame, association) => {
    if (frame[4] === 0x1c && frame[5] === 0 && frame.length > 7) {
      if (frame[6] === 1) {
        peer.ptt = true; // Applied, but its CI-V acknowledgement never arrives.
        return;
      }
      if (rejectRelease) { peer.replyCiv([0xfa], association); return; }
    }
    respond(frame, association);
  };
  await assert.rejects(civ.setPtt(true), /timed out/);
  assert.equal(peer.ptt, true);
  assert.equal(peer.parameters.get('0084')[0], 5, 'do not restore MIC while release is unconfirmed');
  assert.equal(civ.txSaved.length, 1, 'retain the original setting for a later safe retry');
  assert.equal(civ.session.connected, false, 'late acknowledgements cannot reach the old association');
  rejectRelease = false;
  const deadline = Date.now() + 1000;
  while (civ.session.state !== 'failed') {
    assert.ok(Date.now() < deadline, 'association disposal did not finish');
    await new Promise((resolve) => setImmediate(resolve));
  }
  await civ.open();
  assert.equal(peer.ptt, false);
  assert.equal(peer.parameters.get('0084')[0], 0);
  assert.equal(civ.txSaved.length, 0);
});
