'use strict';

/**
 * Diagnostic tool for the S-meter read command (15 02). This has needed
 * two real-world corrections already — see CivDriver#getSMeter()'s doc
 * comment and docs/civ-notes.md for the full history — both guesses
 * about where padding sits relative to the real 2-byte value, neither
 * confirmed against real hardware before shipping. Rather than guess a
 * third time, this bypasses CivDriver#getSMeter()'s decoding logic
 * entirely and just shows you the raw reply bytes directly, alongside
 * every plausible interpretation of them, so the correct one can be
 * identified from what you actually see on screen — compared against
 * what the radio's own front-panel S-meter shows at the same moment —
 * instead of another unverified guess from here.
 *
 * Run this, and while it's running, watch the radio's own front-panel
 * S-meter and try a few different signal levels (switch bands, adjust
 * an attenuator/preamp, or just compare against a strong vs. weak
 * signal) — then share the full output, including which column actually
 * tracked what you saw on the radio.
 *
 * IMPORTANT: stop the main server (npm start / node src/server/index.js)
 * before running this. Only one process can hold the serial port open at
 * a time — if the server is also connected (it polls the S-meter every
 * 500ms on its own), you'll get two independent CI-V controllers writing
 * to the same bus, which typically shows up as every single request
 * timing out with no reply at all, not a decoding problem. If you see
 * that, it's very likely this, not a new bug — stop the server and
 * re-run.
 *
 * Usage:
 *   node test/manual-smeter-diagnostics.js /dev/ttyUSB0
 *   node test/manual-smeter-diagnostics.js /dev/ttyUSB0 0x94
 *   node test/manual-smeter-diagnostics.js /dev/ttyUSB0 0x94 30   (30 reads instead of the default 20)
 *
 * Defaults to 19200 baud, same as CivDriver itself — set the CIV_BAUD_RATE
 * env var to override if your radio's CI-V USB Baud Rate menu setting is
 * different (e.g. scope work typically needs 115200 — see docs/civ-notes.md):
 *   CIV_BAUD_RATE=115200 node test/manual-smeter-diagnostics.js /dev/ttyUSB0 0x94
 */

const { CivDriver } = require('../src/civ');
const { CMD, SUBCMD } = require('../src/civ/commands');
const { bcdToFreq } = require('../src/civ/frame');

function hex(buf) {
  return [...buf].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ');
}

function tryDecode(buf) {
  try {
    const value = bcdToFreq(buf);
    return String(value);
  } catch {
    return '(decode error)';
  }
}

async function main() {
  const path = process.argv[2];
  const explicitAddr = process.argv[3] ? parseInt(process.argv[3], 16) : undefined;
  const readCount = process.argv[4] ? parseInt(process.argv[4], 10) : 20;
  const baudRate = process.env.CIV_BAUD_RATE ? parseInt(process.env.CIV_BAUD_RATE, 10) : undefined;

  if (!path) {
    console.error('Usage: node test/manual-smeter-diagnostics.js <serial-path> [radio-addr-hex] [read-count]');
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

  console.log(
    `\nReading S-meter ${readCount} times, once per second. Watch the radio's own front-panel ` +
      'S-meter and try varying the signal level partway through (band change, attenuator, etc.).\n'
  );
  console.log(
    [
      'reading'.padEnd(8),
      'raw bytes'.padEnd(20),
      'len'.padEnd(4),
      'first-2-bytes'.padEnd(14),
      'last-2-bytes'.padEnd(14),
      'full-buffer (old, broken)',
    ].join(' | ')
  );
  console.log('-'.repeat(90));

  const CONSECUTIVE_TIMEOUT_THRESHOLD = 3;
  let consecutiveTimeouts = 0;
  let hintShown = false;

  for (let i = 1; i <= readCount; i++) {
    try {
      const frame = await civ._send(CMD.READ_SMETER, SUBCMD.SMETER);
      consecutiveTimeouts = 0;
      if (frame.cmd === CMD.NG) {
        console.log(`${String(i).padEnd(8)} | NG (rejected)`);
      } else if (!frame.data || frame.data.length === 0) {
        console.log(`${String(i).padEnd(8)} | (no data bytes in reply)`);
      } else {
        const data = frame.data;
        const first2 = data.length >= 2 ? tryDecode(data.subarray(0, 2)) : '(n/a, <2 bytes)';
        const last2 = data.length >= 2 ? tryDecode(data.subarray(-2)) : '(n/a, <2 bytes)';
        const full = tryDecode(data);
        console.log(
          [
            String(i).padEnd(8),
            hex(data).padEnd(20),
            String(data.length).padEnd(4),
            first2.padEnd(14),
            last2.padEnd(14),
            full,
          ].join(' | ')
        );
      }
    } catch (err) {
      console.log(`${String(i).padEnd(8)} | ERROR: ${err.message}`);
      if (/timed out/.test(err.message)) {
        consecutiveTimeouts++;
        if (consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_THRESHOLD && !hintShown) {
          hintShown = true;
          console.error(
            `\n${consecutiveTimeouts} requests in a row timed out with no reply at all — this is a ` +
              "different symptom from a decoding bug (those get a reply, just with wrong bytes). The " +
              'most likely cause: the main server (npm start) is also connected to this serial port right ' +
              'now. Only one process can hold it at a time — two CI-V controllers writing to the same bus ' +
              'produces exactly this. Stop the server and re-run this script. If that\'s not it, also ' +
              'check that CI-V Transceive is enabled on the radio and that the baud rate matches its menu ' +
              'setting.\n'
          );
          console.log('Stopping early rather than burning through the remaining reads on a bus that\'s not responding.\n');
          break;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  await civ.close();
  console.log(
    '\nDone. Please share this FULL output, along with what the radio\'s own front-panel S-meter ' +
      'showed at a couple of points during the run (e.g. "reading #5 the radio showed S4, reading #15 it showed S9").'
  );
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
