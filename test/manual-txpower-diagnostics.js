'use strict';

/**
 * Diagnostic tool for the transmit power set command (14 0A). A first
 * attempt (standard little-endian BCD) was rejected outright (NG) on
 * real hardware — reasoned root cause: that encoding puts an invalid
 * "hundreds" nibble first for higher values (see
 * CivDriver#setTxPower()'s doc comment). The current implementation
 * switched to the same packing already hardware-confirmed for
 * S-meter/SWR, but that's a reasoned correction, not independently
 * confirmed for *this* command the way S-meter itself is — see
 * docs/civ-notes.md.
 *
 * **This is safe to run**: setting the RF power *level* never engages
 * PTT and never transmits anything by itself — only actually keying up
 * (front panel, or this app's PTT button) does that. This tool only
 * ever writes the power level and reads it back; it does not transmit.
 *
 * This bypasses CivDriver#setTxPower() entirely and pokes the CI-V bus
 * directly (via the internal _send() method) so every candidate can be
 * tried in turn without an NG throwing partway through. For each one, it
 * reports whether the radio accepted (OK) or rejected (NG) the write,
 * and attempts to read the level back afterward for corroboration
 * (though, per the S-meter saga, an accepted write is the primary signal
 * — some radios don't support reading a given level back at all).
 *
 * Run this and share the FULL output. If you can also check the
 * radio's own menu (power level is typically shown live in the display
 * even without transmitting) after a candidate that reports OK, that
 * would be a valuable additional confirmation.
 *
 * Usage:
 *   node test/manual-txpower-diagnostics.js /dev/ttyUSB0
 *   node test/manual-txpower-diagnostics.js /dev/ttyUSB0 0x94
 *
 * Defaults to 19200 baud, same as CivDriver itself — set the CIV_BAUD_RATE
 * env var to override if your radio's CI-V USB Baud Rate menu setting is
 * different (scope work typically needs 115200 — see docs/civ-notes.md):
 *   CIV_BAUD_RATE=115200 node test/manual-txpower-diagnostics.js /dev/ttyUSB0 0x94
 */

const { CivDriver } = require('../src/civ');
const { CMD, LEVEL_SUBCMD } = require('../src/civ/commands');
const { freqToBCD } = require('../src/civ/frame');

const TARGET_RAW = 191; // corresponds to 75W at 100W max — a mid-range, unambiguous value

function hex(buf) {
  return [...buf].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ');
}

function meterStylePacking(raw) {
  const hundreds = Math.floor(raw / 100);
  const tensOnes = raw % 100;
  return Buffer.from([hundreds, freqToBCD(tensOnes, 1)[0]]);
}

const CANDIDATES = [
  {
    label: 'PRIMARY (current implementation): S-meter-style packing — hundreds nibble + 2-digit BCD byte',
    data: meterStylePacking(TARGET_RAW),
  },
  {
    label: 'Standard little-endian BCD pair (the first, rejected attempt — kept for comparison)',
    data: freqToBCD(TARGET_RAW, 2),
  },
  {
    label: 'Single raw byte, direct binary value (not BCD at all)',
    data: Buffer.from([TARGET_RAW]),
  },
  {
    label: 'Two-byte raw binary (not BCD), little-endian',
    data: Buffer.from([TARGET_RAW & 0xff, (TARGET_RAW >> 8) & 0xff]),
  },
];

async function main() {
  const path = process.argv[2];
  const explicitAddr = process.argv[3] ? parseInt(process.argv[3], 16) : undefined;
  const baudRate = process.env.CIV_BAUD_RATE ? parseInt(process.env.CIV_BAUD_RATE, 10) : undefined;

  if (!path) {
    console.error('Usage: node test/manual-txpower-diagnostics.js <serial-path> [radio-addr-hex]');
    console.error('       (set CIV_BAUD_RATE env var to override the default 19200 baud)');
    process.exit(1);
  }

  const civ = new CivDriver({ path, radioAddr: explicitAddr, baudRate });
  civ.on('error', (err) => console.error('[civ error]', err.message));

  console.log(`Opening ${path}...`);
  console.log(`Baud rate: ${civ.baudRate}${baudRate ? '' : ' (default — set CIV_BAUD_RATE to override if your radio uses a different rate)'}`);
  await civ.open();

  if (explicitAddr === undefined) {
    console.log('Auto-detecting radio CI-V address...');
    try {
      const addr = await civ.detectRadioAddress();
      console.log(`Detected radio address: 0x${addr.toString(16)}`);
    } catch (err) {
      console.error(`\nAuto-detection failed: ${err.message}`);
      console.error(
        'This only works reliably when exactly one radio is on the CI-V bus, and can fail for other ' +
          'reasons too (baud rate mismatch, CI-V Transceive disabled on the radio, etc.) — it is not ' +
          'required. Skip it entirely by passing the address explicitly as the second argument. The ' +
          "IC-7300's factory-default CI-V address is 0x94:\n" +
          `  node ${require('path').basename(__filename)} ${path} 0x94\n`
      );
      await civ.close().catch(() => {});
      process.exit(1);
    }
  }

  console.log(`\nTarget raw value: ${TARGET_RAW} (corresponds to 75W at 100W max)`);
  console.log('This will NOT engage PTT or transmit anything — only the power level is written.\n');

  for (const candidate of CANDIDATES) {
    console.log(`--- Trying: ${candidate.label} ---`);
    console.log(`Sending data bytes: ${hex(candidate.data)}`);

    let writeResult;
    try {
      const frame = await civ._send(CMD.LEVEL, LEVEL_SUBCMD.RF_PWR, candidate.data);
      if (frame.cmd === CMD.OK) writeResult = 'OK (accepted)';
      else if (frame.cmd === CMD.NG) writeResult = 'NG (rejected)';
      else writeResult = `unexpected reply cmd=0x${frame.cmd.toString(16)}`;
    } catch (err) {
      writeResult = `ERROR (${err.message})`;
    }
    console.log(`Write reply: ${writeResult}`);

    try {
      const readFrame = await civ._send(CMD.LEVEL, LEVEL_SUBCMD.RF_PWR);
      if (readFrame.cmd === CMD.NG) {
        console.log('Read-back: NG (not supported for this command, or nothing to confirm)');
      } else if (readFrame.data && readFrame.data.length) {
        console.log(`Read-back raw bytes: ${hex(readFrame.data)}`);
      } else {
        console.log('Read-back: no data returned');
      }
    } catch (err) {
      console.log(`Read-back failed: ${err.message}`);
    }

    console.log('');
  }

  await civ.close();
  console.log('Done. Please share this FULL output.');
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
