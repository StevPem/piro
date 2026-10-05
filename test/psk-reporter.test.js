// Run with: node test/psk-reporter.test.js
'use strict';

const { PskReporterClient, encodeReportPacket, extractSpot } = require('../src/audio/psk-reporter');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

// A fake UDP socket: records every send() call instead of touching a real
// network — see src/audio/psk-reporter.js's own doc comment on why this
// module's tests can't confirm delivery to the real pskreporter.info
// service, only that the packets built here match the reference
// implementation's own byte layout.
class FakeSocket {
  constructor() {
    this.sent = [];
  }
  send(packet, port, host, cb) {
    this.sent.push({ packet, port, host });
    if (cb) cb(null);
  }
  close() {
    this.closed = true;
  }
}

function run() {
  // --- extractSpot(): pulling a callsign+grid out of decoded FT8 text ---
  {
    check(
      JSON.stringify(extractSpot('CQ VK2IO QF56')) === JSON.stringify({ call: 'VK2IO', grid: 'QF56' }),
      'a CQ with a grid extracts the call and grid'
    );
    check(
      JSON.stringify(extractSpot('CQ VK2IO')) === JSON.stringify({ call: 'VK2IO', grid: null }),
      'a CQ with no grid extracts just the call'
    );
    check(
      JSON.stringify(extractSpot('CQ DX VK2IO QF56MC')) === JSON.stringify({ call: 'VK2IO', grid: 'QF56MC' }),
      'a CQ with a qualifier ("CQ DX") and a 6-character grid still extracts correctly'
    );
    check(extractSpot('CQ') === null, 'a bare "CQ" with nothing else has no spottable call');
    check(
      JSON.stringify(extractSpot('K1ABC W9XYZ QF56')) === JSON.stringify({ call: 'W9XYZ', grid: 'QF56' }),
      'a standard exchange spots the *transmitting* station (2nd token), with its grid if sent'
    );
    check(
      JSON.stringify(extractSpot('K1ABC W9XYZ -08')) === JSON.stringify({ call: 'W9XYZ', grid: null }),
      'a signal-report exchange still spots the transmitting station, just without a grid'
    );
    check(
      JSON.stringify(extractSpot('K1ABC W9XYZ RR73')) === JSON.stringify({ call: 'W9XYZ', grid: null }),
      'an RR73 exchange still spots the transmitting station'
    );
    check(extractSpot('RR73') === null, 'a lone "RR73" (no callsigns at all) has nothing to spot');
    check(extractSpot('') === null, 'empty text has nothing to spot');
    check(extractSpot(null) === null, 'null text has nothing to spot (does not throw)');
  }

  // --- encodeReportPacket(): byte-for-byte structure ---
  {
    // Empty spot list: still a valid packet (header + both template sets
    // + an Rx Info data set + an empty Tx Info data set), matching the
    // reference's own logic. Verify the exact known-shape byte layout at
    // each fixed offset rather than a giant hardcoded hex blob, so a
    // deliberate future field-order change is easy to update here field
    // by field.
    const packet = encodeReportPacket({
      sequenceNumber: 1,
      randomId: 0xdeadbeef,
      exportTimeSec: 0x11223344,
      rxCall: 'VK3XYZ',
      rxGrid: 'QF22',
      progId: 'SPARC-PiRO',
      rxAntenna: '',
      spots: [],
    });

    check(packet.readUInt16BE(0) === 0x000a, 'IPFIX header: version is 0x000A');
    check(packet.readUInt32BE(4) === 0x11223344, 'IPFIX header: export time carried through unchanged');
    check(packet.readUInt32BE(8) === 1, 'IPFIX header: sequence number carried through unchanged');
    check(packet.readUInt32BE(12) === 0xdeadbeef, 'IPFIX header: random observation-domain ID carried through unchanged');
    check(packet.readUInt16BE(2) === packet.length, 'IPFIX header: declared total length matches the actual packet length');

    // Rx Info Template Set starts right after the 16-byte header.
    check(packet.readUInt16BE(16) === 0x0003, 'Rx Info Template Set: Set ID 0x0003 (Options Template Set)');
    check(packet.readUInt16BE(16 + 4) === 0x50e2, 'Rx Info Template Set: Template ID 0x50E2');
    const rxTemplateSetLen = packet.readUInt16BE(16 + 2);
    check(rxTemplateSetLen === 0x002c, 'Rx Info Template Set: declared length is 0x002C (44), matching the reference');

    // Tx Info Template Set follows immediately.
    const txTemplateOffset = 16 + rxTemplateSetLen;
    check(packet.readUInt16BE(txTemplateOffset) === 0x0002, 'Tx Info Template Set: Set ID 0x0002 (regular Template Set)');
    check(packet.readUInt16BE(txTemplateOffset + 4) === 0x50e3, 'Tx Info Template Set: Template ID 0x50E3');
    const txTemplateSetLen = packet.readUInt16BE(txTemplateOffset + 2);
    check(txTemplateSetLen === 0x003c, 'Tx Info Template Set: declared length is 0x003C (60), matching the reference');

    // Rx Info Data Set follows the two template sets.
    const rxDataOffset = txTemplateOffset + txTemplateSetLen;
    check(packet.readUInt16BE(rxDataOffset) === 0x50e2, 'Rx Info Data Set: Set ID matches the Rx template (0x50E2)');
    let cursor = rxDataOffset + 4;
    const rxDataLen = packet.readUInt16BE(rxDataOffset + 2);
    function readLenPrefixedString(offset) {
      const len = packet.readUInt8(offset);
      return { value: packet.toString('utf8', offset + 1, offset + 1 + len), next: offset + 1 + len };
    }
    const rxCallField = readLenPrefixedString(cursor);
    check(rxCallField.value === 'VK3XYZ', 'Rx Info Data Set: Rx Call round-trips correctly');
    const rxGridField = readLenPrefixedString(rxCallField.next);
    check(rxGridField.value === 'QF22', 'Rx Info Data Set: Rx Grid round-trips correctly');
    const rxSoftField = readLenPrefixedString(rxGridField.next);
    check(rxSoftField.value === 'SPARC-PiRO', 'Rx Info Data Set: Rx Software (progId) round-trips correctly');
    const rxAntField = readLenPrefixedString(rxSoftField.next);
    check(rxAntField.value === '', 'Rx Info Data Set: Rx Antenna round-trips correctly (empty string)');
    check(rxDataOffset + rxDataLen === rxAntField.next + 2, 'Rx Info Data Set: declared length accounts for the trailing 2-byte padding');

    // Tx Info Data Set follows, and with an empty spot list should be
    // exactly a 4-byte header (Set ID + length) plus the 2-byte trailer.
    const txDataOffset = rxDataOffset + rxDataLen;
    check(packet.readUInt16BE(txDataOffset) === 0x50e3, 'Tx Info Data Set: Set ID matches the Tx template (0x50E3)');
    check(packet.readUInt16BE(txDataOffset + 2) === 6, 'Tx Info Data Set: with no spots queued, length is just the 4-byte header + 2-byte trailer');
    check(txDataOffset + 6 === packet.length, 'Tx Info Data Set is the last thing in the packet');
  }

  {
    // One queued spot: verify every Tx Info field round-trips, including
    // a negative SNR (the reference takes the low byte of a signed 32-bit
    // value — Buffer#writeInt8 does the equivalent two's-complement
    // encoding directly).
    const packet = encodeReportPacket({
      sequenceNumber: 2,
      randomId: 1,
      exportTimeSec: 1700000000,
      rxCall: 'VK3XYZ',
      rxGrid: 'QF22',
      spots: [{ call: 'VK2IO', grid: 'QF56', freqHz: 14074123, snr: -8, mode: 'FT8', timeSec: 1700000001 }],
    });

    // Locate the Tx Info Data Set the same way as above rather than
    // hardcoding an offset, so this test doesn't silently break if the Rx
    // Info Data Set's own length changes independently.
    const rxTemplateSetLen = packet.readUInt16BE(16 + 2);
    const txTemplateOffset = 16 + rxTemplateSetLen;
    const txTemplateSetLen = packet.readUInt16BE(txTemplateOffset + 2);
    const rxDataOffset = txTemplateOffset + txTemplateSetLen;
    const rxDataLen = packet.readUInt16BE(rxDataOffset + 2);
    const txDataOffset = rxDataOffset + rxDataLen;

    let cursor = txDataOffset + 4; // past the Set ID + length header
    const callLen = packet.readUInt8(cursor);
    const call = packet.toString('utf8', cursor + 1, cursor + 1 + callLen);
    cursor += 1 + callLen;
    check(call === 'VK2IO', 'Tx Info Data Set: spotted call round-trips correctly');

    const freq = packet.readUInt32BE(cursor);
    cursor += 4;
    check(freq === 14074123, 'Tx Info Data Set: spotted frequency (absolute Hz) round-trips correctly');

    const snr = packet.readInt8(cursor);
    cursor += 1;
    check(snr === -8, 'Tx Info Data Set: negative SNR round-trips correctly as a signed byte');

    const modeLen = packet.readUInt8(cursor);
    const mode = packet.toString('utf8', cursor + 1, cursor + 1 + modeLen);
    cursor += 1 + modeLen;
    check(mode === 'FT8', 'Tx Info Data Set: mode round-trips correctly');

    const gridLen = packet.readUInt8(cursor);
    const grid = packet.toString('utf8', cursor + 1, cursor + 1 + gridLen);
    cursor += 1 + gridLen;
    check(grid === 'QF56', 'Tx Info Data Set: spotted grid round-trips correctly');

    const infoSrc = packet.readUInt8(cursor);
    cursor += 1;
    check(infoSrc === 1, 'Tx Info Data Set: info source is the constant REPORTER_SOURCE_AUTOMATIC (1)');

    const timeSec = packet.readUInt32BE(cursor);
    cursor += 4;
    check(timeSec === 1700000001, 'Tx Info Data Set: report timestamp round-trips correctly');
  }

  // --- PskReporterClient: batching, rate limiting, and the "no station identity -> no-op" guard ---
  {
    const socket = new FakeSocket();
    const client = new PskReporterClient({ rxCall: null, rxGrid: null, socket });
    client.addSpot({ call: 'VK2IO', grid: 'QF56', freqHz: 14074000, snr: -5, mode: 'FT8' });
    client._sendReport();
    check(socket.sent.length === 0, 'with no rxCall configured, addSpot() is a no-op and nothing is ever sent');
  }

  {
    const socket = new FakeSocket();
    let nowMs = 1700000000000;
    const client = new PskReporterClient({
      rxCall: 'VK3XYZ',
      rxGrid: 'QF22',
      socket,
      now: () => nowMs,
      randomId: 42,
    });

    client._sendReport();
    check(socket.sent.length === 0, 'an empty queue never sends a packet, matching the reference implementation');

    client.addSpot({ call: 'VK2IO', grid: 'QF56', freqHz: 14074000, snr: -5, mode: 'FT8' });
    client.addSpot({ call: 'VK4ABC', grid: null, freqHz: 14075500, snr: 2, mode: 'FT8' });
    client._sendReport();
    check(socket.sent.length === 1, 'two queued spots are batched into a single sent packet');
    check(socket.sent[0].host === 'report.pskreporter.info', 'sends to the correct PSK Reporter host');
    check(socket.sent[0].port === 4739, 'sends to the correct PSK Reporter port');

    client._sendReport();
    check(socket.sent.length === 1, 'the queue is cleared after sending, so an immediate re-send with nothing new queued sends nothing further');

    client.addSpot({ call: 'VK5DEF', grid: null, freqHz: 3573000, snr: 0, mode: 'FT8' });
    nowMs += 1000;
    client._sendReport();
    check(socket.sent.length === 2, 'a spot queued after the previous send goes out in the next batch');

    client.stop();
    // socket was injected (not owned), so stop() should NOT close it —
    // only a socket this client created itself (dgram.createSocket) is
    // this client's to close.
    check(!socket.closed, "stop() doesn't close an injected socket it doesn't own");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll checks passed.');
  }
}

run();
