'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/icom-lan/protocol');
const { IcomStream } = require('../src/icom-lan/stream');
const { envelope } = require('./fixtures/icom-lan-peer');
const { FrameParser } = require('../src/civ/frame');

test('independent byte vectors pin headers, credentials and mixed-endian sequences', () => {
  // Literal expectations derived from the wire field layouts, not a round
  // trip through production builders. Credential vector also exists in
  // AetherSDR tests/icom_protocol_test.cpp:testPasscode at the pinned revision.
  assert.equal(P.packet(16, 3, 0x11223344).toString('hex'), '10000000030000001122334400000000');
  assert.equal(P.packet(16, 6, 0x11223344, 0xaabbccdd, 1).toString('hex'), '100000000600010011223344aabbccdd');
  assert.equal(P.passcode('beer').toString('hex'), '2b3f555c000000000000000000000000');
  for (const bad of ['', 'x'.repeat(17), 'é', '\n']) assert.throws(() => P.passcode(bad));
  const auth = P.auth(1, 2, 256, Buffer.from('010203040506', 'hex'));
  assert.equal(auth.subarray(16, 32).toString('hex'), '00000030010501000000010203040506');
  const serial = P.serial(1, 2, 0x102, Buffer.from('fefeb6e003fd', 'hex'));
  assert.equal(serial.subarray(16).toString('hex'), 'c106000102fefeb6e003fd');
  const audio = P.audio(1, 2, 0x304, Buffer.from('0080ff7f0000', 'hex'));
  assert.equal(audio.subarray(16).toString('hex'), '80000304000000060080ff7f0000');
  assert.equal(P.serialPayload(P.serial(1, 2, 0, Buffer.alloc(498))).length, 498);
  const request = P.streamRequest(1, 2, 1, { authId: Buffer.alloc(6), radioId: Buffer.alloc(16),
    radioName: 'MK2', username: 'beer', civPort: 12345, audioPort: 12346 });
  assert.equal(request.subarray(112, 140).toString('hex'), '010104040000bb800000bb80000030390000303a0000012c01000000');
  assert.throws(() => P.streamRequest(1, 2, 0, { codec: 64 }));
});

test('malformed envelopes and truncated serial/audio cannot reach decoders', () => {
  for (const p of [Buffer.alloc(2), Buffer.alloc(5000), Buffer.alloc(16)]) assert.equal(P.header(p), null);
  const zeroLengthPing = envelope(21, 7, 1, 2);
  zeroLengthPing.writeUInt32LE(0, 0);
  assert.ok(P.header(zeroLengthPing));
  const serial = P.serial(1, 2, 1, Buffer.alloc(500));
  serial[17] = 0;
  assert.equal(P.serialPayload(serial), null);
  const audio = P.audio(1, 2, 1, Buffer.alloc(3));
  assert.equal(P.audioPayload(audio), null);
  const parser = new FrameParser();
  assert.throws(() => parser.push(Buffer.concat([Buffer.from([0xfe, 0xfe]), Buffer.alloc(4096)])), /4096/);
  assert.equal(parser.push(Buffer.from('fefee0b6030040071400fd', 'hex')).length, 1);
});

function memoryStream(options = {}) {
  let now = 0;
  const stream = new IcomStream({ role: 'CI-V', now: () => now, reorderMs: 10, maxPackets: 4, ...options });
  stream.localId = 1;
  stream.remoteId = 2;
  stream.ready = true;
  stream.lastRx = stream.lastIdle = stream.lastPing = 0;
  const sent = [], delivered = [];
  stream.raw = (p) => sent.push(Buffer.from(p));
  stream.on('payload', (p) => delivered.push(p.readUInt16LE(6)));
  const receive = (seq) => stream.receive(envelope(24, 0, 2, 1, seq));
  return { stream, sent, delivered, receive, advance: (n) => { now += n; stream.tick(); } };
}

test('stream repairs gaps, removes duplicates and crosses both sequence boundaries', () => {
  for (const start of [254, 65534]) {
    const { stream, sent, delivered, receive, advance } = memoryStream();
    receive(start);
    receive((start + 2) & 65535);
    advance(11);
    assert.equal(sent.at(-1).readUInt16LE(4), 1);
    assert.equal(sent.at(-1).readUInt16LE(6), (start + 1) & 65535);
    receive((start + 1) & 65535);
    receive((start + 1) & 65535);
    assert.deepEqual(delivered, [start, (start + 1) & 65535, (start + 2) & 65535]);
    assert.equal(stream.counters.duplicates, 1);
    receive((start + 4) & 65535);
    advance(25);
    assert.equal(stream.counters.lost, 1);
    assert.equal(delivered.at(-1), (start + 4) & 65535);
  }
});

test('replay is bounded, wraps by insertion order, and never replays superseded keying', () => {
  const { stream, sent } = memoryStream();
  stream.txSeq = 65534;
  for (let n = 0; n < 6; n++) stream.tracked(P.packet(24, 0, 1, 2));
  assert.deepEqual([...stream.replay.keys()], [0, 1, 2, 3]);
  const keyed = stream.tracked(P.packet(24, 0, 1, 2), { group: 'ptt' });
  stream.tracked(P.packet(24, 0, 1, 2), { group: 'ptt' });
  stream.receive(envelope(16, 1, 2, 1, keyed));
  assert.equal(sent.at(-1).length, 16); // retired command replaced by idle.
  stream.receive(envelope(16, 1, 2, 1, 3));
  assert.equal(sent.at(-1).length, 24);
});

test('old associations, malformed packets, ping stamps and reorder caps', () => {
  const { stream, sent, delivered, receive } = memoryStream();
  stream.receive(envelope(24, 0, 99, 1, 1));
  stream.receive(Buffer.alloc(4));
  assert.equal(stream.counters.stale, 1);
  assert.equal(stream.counters.malformed, 1);
  const ping = envelope(21, 7, 2, 1, 52);
  ping.writeUInt32LE(0x12345678, 17);
  stream.receive(ping);
  assert.equal(sent.at(-1).subarray(16).toString('hex'), '0178563412');
  assert.equal(delivered.length, 0);
  receive(1);
  for (let seq = 10; seq < 30; seq += 2) receive(seq);
  assert.ok(stream.reorder.size <= 4);
  assert.ok(stream.counters.lost > 0);
});
