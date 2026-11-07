'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IcomSession } = require('../src/icom-lan/session');

function setup() {
  const session = new IcomSession({ host: '127.0.0.1', username: 'beer', password: 'beer' });
  session.radioId = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  session.authId = Buffer.from('010203040506', 'hex');
  session.requested = session.authenticated = true;
  session.granted = false;
  let starts = 0;
  session.serial = session.audio = { start() { ++starts; } };
  // Literal ConnInfo field layout, cross-checked against the physical MK2.
  const packet = Buffer.alloc(144);
  packet.writeUInt32LE(144, 0);
  packet[20] = 3; packet[21] = 0; packet[96] = 1;
  session.authId.copy(packet, 26); session.radioId.copy(packet, 32);
  return { session, packet, starts: () => starts };
}

test('stream grant identifies the authenticated requested radio and permits reference token rotation', () => {
  const { session, packet, starts } = setup();
  const next = Buffer.from('090807060504', 'hex');
  next.copy(packet, 26);
  session.controlPayload(packet);
  assert.equal(session.granted, true);
  assert.equal(starts(), 2);
  assert.deepEqual(session.authId, next);
  session.controlPayload(packet);
  assert.equal(starts(), 2, 'Duplicate grant must not start media twice');
});

test('unrelated ConnInfo packets cannot open media or replace the current token', async (t) => {
  for (const [name, change] of [
    ['wrong reply type', ({ packet }) => { packet[20] = 0; }],
    ['wrong kind', ({ packet }) => { packet[21] = 3; }],
    ['different radio', ({ packet }) => { packet[32] ^= 1; }],
    ['missing radio identity', ({ packet }) => { packet.fill(0, 32, 48); }],
    ['not authenticated', ({ session }) => { session.authenticated = false; }],
    ['no stream request', ({ session }) => { session.requested = false; }],
    ['not granted', ({ packet }) => { packet[96] = 0; }],
  ]) await t.test(name, () => {
    const context = setup(); const before = Buffer.from(context.session.authId);
    change(context);
    context.packet.fill(0xff, 26, 32);
    context.session.controlPayload(context.packet);
    assert.equal(context.session.granted, false);
    assert.equal(context.starts(), 0);
    assert.deepEqual(context.session.authId, before);
  });
});
