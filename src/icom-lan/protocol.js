'use strict';

// SPDX-License-Identifier: GPL-3.0-only
// Adapted from AetherSDR contributors' IcomProtocol; attribution and license
// text are retained in third_party/icom-lan and docs/icom-lan-sources.md.

// RS-BA1 wire layout adapted from AetherSDR IcomProtocol (GPL-3.0), checked
// against wfview's packet structures. See docs/icom-lan-sources.md for pinned
// revisions, attribution and the distinction between documented CI-V and the
// independently implemented network envelope. Never log these packet buffers:
// login and control payloads contain reversible credentials/session tokens.
const TYPE = Object.freeze({ IDLE: 0, RETRANSMIT: 1, THERE: 3, HERE: 4, DISCONNECT: 5, READY: 6, PING: 7 });
const CODEC = 4; // LPCM, mono, signed 16-bit little endian, 48 kHz.
const PASSCODE = Buffer.from([
  0x47,0x5d,0x4c,0x42,0x66,0x20,0x23,0x46,0x4e,0x57,0x45,0x3d,0x67,0x76,0x60,0x41,
  0x62,0x39,0x59,0x2d,0x68,0x7e,0x7c,0x65,0x7d,0x49,0x29,0x72,0x73,0x78,0x21,0x6e,
  0x5a,0x5e,0x4a,0x3e,0x71,0x2c,0x2a,0x54,0x3c,0x3a,0x63,0x4f,0x43,0x75,0x27,0x79,
  0x5b,0x35,0x70,0x48,0x6b,0x56,0x6f,0x34,0x32,0x6c,0x30,0x61,0x6d,0x7b,0x2f,0x4b,
  0x64,0x38,0x2b,0x2e,0x50,0x40,0x3f,0x55,0x33,0x37,0x25,0x77,0x24,0x26,0x74,0x6a,
  0x28,0x53,0x4d,0x69,0x22,0x5c,0x44,0x31,0x36,0x58,0x3b,0x7a,0x51,0x5f,0x52,
]);

function packet(length, type, localId, remoteId = 0, seq = 0) {
  const p = Buffer.alloc(length);
  p.writeUInt32LE(length, 0);
  p.writeUInt16LE(type, 4);
  p.writeUInt16LE(seq & 0xffff, 6);
  p.writeUInt32BE(localId >>> 0, 8);
  p.writeUInt32BE(remoteId >>> 0, 12);
  return p;
}

function header(p) {
  if (!Buffer.isBuffer(p) || p.length < 16 || p.length > 4096) return null;
  const type = p.readUInt16LE(4);
  const len = p.readUInt32LE(0);
  // Radio pings sometimes have a zero length. Range retransmit requests can
  // declare 24 while carrying a longer list; all other lengths are exact.
  if (len !== p.length && !(type === TYPE.PING && p.length === 21 && len === 0)
    && !(type === TYPE.RETRANSMIT && len === 24 && p.length >= 24 && (p.length - 16) % 4 === 0)) return null;
  return { type, seq: p.readUInt16LE(6), sender: p.readUInt32BE(8), receiver: p.readUInt32BE(12) };
}

const distance = (a, b) => (a - b + 0x10000) & 0xffff;
const after = (a, b) => distance(a, b) > 0 && distance(a, b) < 0x8000;

function passcode(s) {
  if (typeof s !== 'string' || !/^[\x20-\x7e]{1,16}$/.test(s)) {
    throw new Error('Icom LAN credentials must be 1-16 printable ASCII characters');
  }
  const out = Buffer.alloc(16);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i) + i;
    if (c > 126) c = 32 + c % 127;
    out[i] = PASSCODE[c - 32];
  }
  return out;
}

function inner(length, localId, remoteId, sequence, requestType) {
  const p = packet(length, TYPE.IDLE, localId, remoteId);
  p.writeUInt32BE(length - 16, 16);
  p[20] = 1;
  p[21] = requestType;
  // Big-endian at 0x16. A shifted byte happens to work below 256, then
  // breaks token renewal on a long-lived MK2 session.
  p.writeUInt16BE(sequence & 0xffff, 22);
  return p;
}

function login(localId, remoteId, sequence, requestId, username, password) {
  const p = inner(128, localId, remoteId, sequence, 0);
  p.writeUInt16LE(requestId, 26);
  passcode(username).copy(p, 64);
  passcode(password).copy(p, 80);
  p.write('icom-pc', 96, 'ascii');
  return p;
}

function auth(localId, remoteId, sequence, authId, kind = 5) {
  const p = inner(64, localId, remoteId, sequence, kind);
  authId.copy(p, 26, 0, 6);
  return p;
}

function streamRequest(localId, remoteId, sequence, options) {
  const { authId, radioId, radioName, username, civPort, audioPort, txBufferMs = 300, codec = CODEC } = options;
  if (codec !== CODEC) throw new Error('Icom LAN supports codec 4 (48 kHz mono LPCM16) only');
  const p = inner(144, localId, remoteId, sequence, 3);
  authId.copy(p, 26, 0, 6);
  radioId.copy(p, 32, 0, 16);
  p.write(radioName.slice(0, 32), 64, 'ascii');
  passcode(username).copy(p, 96);
  p[112] = p[113] = 1;
  p[114] = p[115] = CODEC;
  p.writeUInt32BE(48000, 116);
  p.writeUInt32BE(48000, 120);
  p.writeUInt32BE(civPort, 124);
  p.writeUInt32BE(audioPort, 128);
  p.writeUInt32BE(txBufferMs, 132);
  p[136] = 1;
  return p;
}

function serialOpen(localId, remoteId, sequence, open = true) {
  const p = packet(22, 0, localId, remoteId);
  p[16] = 0xc0;
  p[17] = 1;
  p.writeUInt16BE(sequence & 0xffff, 19);
  p[21] = open ? 5 : 0;
  return p;
}

function serial(localId, remoteId, sequence, bytes) {
  const p = packet(21 + bytes.length, 0, localId, remoteId);
  p[16] = 0xc1;
  // u16 LE, including scope payloads larger than 255 bytes.
  p.writeUInt16LE(bytes.length, 17);
  p.writeUInt16BE(sequence & 0xffff, 19);
  bytes.copy(p, 21);
  return p;
}

function serialPayload(p) {
  return p.length > 21 && p[16] === 0xc1 && p.readUInt16LE(17) === p.length - 21 ? p.subarray(21) : null;
}

function audio(localId, remoteId, sequence, bytes) {
  const p = packet(24 + bytes.length, 0, localId, remoteId);
  p.writeUInt16BE(0x8000, 16);
  p.writeUInt16BE(sequence & 0xffff, 18);
  p.writeUInt16BE(bytes.length, 22);
  bytes.copy(p, 24);
  return p;
}

function audioPayload(p) {
  return p.length > 24 && p[16] !== 0xc0 && p[16] !== 0xc1
    && p.readUInt16BE(22) === p.length - 24 && (p.length - 24) % 2 === 0 ? p.subarray(24) : null;
}

module.exports = { TYPE, CODEC, packet, header, distance, after, passcode, login, auth, streamRequest, serialOpen, serial, serialPayload, audio, audioPayload };
