'use strict';

/**
 * Diagnostic tool for the IC-7300 "DATA MODE" set/read command
 * (1A 05 00 63), which CivDriver#setDataMode()/getDataMode() implement —
 * see that method's doc comment in src/civ/driver.js and the "DATA MODE"
 * section of docs/civ-notes.md for the full story.
 *
 * History: a first version of this script (and of setDataMode()) assumed
 * a single value byte after the 2-byte parameter number (3 data bytes
 * total: [0x00, 0x63, on?1:0]). A user ran that version against a real
 * IC-7300 and got a very informative result: the SET command came back
 * OK, but a read-back afterward showed no change at all, AND the bare
 * read itself came back as **4** data bytes (`[0x00, 0x63, 0x00, 0x01]`)
 * — not 3 — proving the value itself is a 2-byte field, not 1. The
 * driver has since been corrected to send/parse the full 4-byte
 * structure ([param, param, valueHi, valueLo]). This script now verifies
 * that fix directly, using CivDriver's real setDataMode()/getDataMode()
 * rather than hand-rolled frames, plus prints the raw hex on every step
 * so the wire format stays visible either way.
 *
 * What it does, in order:
 *   1. Reads the current operating mode (should already be USB if FT8
 *      mode was entered in the app right before running this).
 *   2. Reads DATA MODE's current value (baseline) via getDataMode().
 *   3. Turns it ON via setDataMode(true) and reports OK/NG.
 *   4. Reads it back — this is the key check: does it now read `true`,
 *      and does the radio's own display agree (watch it while this runs)?
 *   5. Turns it back OFF via setDataMode(false) and reads it back once
 *      more, confirming it can toggle both ways, then leaves the radio
 *      in a known (OFF) state rather than whatever it started in.
 *
 * Run this with FT8 mode already selected in the app (so the radio is
 * already on USB) and watch the radio's own display throughout.
 *
 * Usage:
 *   node test/manual-data-mode-diagnostics.js /dev/ttyUSB0
 *   node test/manual-data-mode-diagnostics.js /dev/ttyUSB0 0x94
 *
 * Defaults to 19200 baud, same as CivDriver itself — set CIV_BAUD_RATE
 * to override if your radio's CI-V USB Baud Rate menu setting differs:
 *   CIV_BAUD_RATE=115200 node test/manual-data-mode-diagnostics.js /dev/ttyUSB0 0x94
 */

const { CivDriver } = require('../src/civ');

async function main() {
  const path = process.argv[2];
  const explicitAddr = process.argv[3] ? parseInt(process.argv[3], 16) : undefined;
  const baudRate = process.env.CIV_BAUD_RATE ? parseInt(process.env.CIV_BAUD_RATE, 10) : undefined;

  if (!path) {
    console.error('Usage: node test/manual-data-mode-diagnostics.js <serial-path> [radio-addr-hex]');
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
        'This only works reliably when exactly one radio is on the CI-V bus. Skip it entirely by passing ' +
          "the address explicitly as the second argument. The IC-7300's factory-default CI-V address is " +
          `0x94:\n  node ${require('path').basename(__filename)} ${path} 0x94\n`
      );
      await civ.close().catch(() => {});
      process.exit(1);
    }
  }

  console.log('\n--- Step 1: current operating mode ---');
  try {
    const mode = await civ.getMode();
    console.log(`Mode: ${JSON.stringify(mode)}${mode.mode !== 'USB' ? ' (NOTE: not USB — put the radio in FT8 mode via the app first for a realistic test)' : ''}`);
  } catch (err) {
    console.log(`Failed to read mode: ${err.message}`);
  }

  console.log('\n--- Step 2: DATA MODE baseline (before any write) ---');
  try {
    const baseline = await civ.getDataMode();
    console.log(`DATA MODE is currently: ${baseline ? 'ON' : 'OFF'}`);
  } catch (err) {
    console.log(`Failed to read DATA MODE: ${err.message}`);
  }

  console.log('\n--- Step 3: setDataMode(true) ---');
  console.log('>>> Watch the radio\'s own display now — does it change to "USB-D" / show a DATA indicator? <<<');
  try {
    await civ.setDataMode(true);
    console.log('setDataMode(true): accepted (OK)');
  } catch (err) {
    console.log(`setDataMode(true) FAILED: ${err.message}`);
  }

  console.log('\n--- Step 4: read DATA MODE back ---');
  try {
    const afterOn = await civ.getDataMode();
    console.log(`DATA MODE now reads: ${afterOn ? 'ON' : 'OFF'}`);
    if (afterOn) {
      console.log('*** Confirmed: DATA MODE is genuinely ON at the CI-V level. ***');
      console.log('If the display still does not show a DATA indicator, the CI-V side is now correct and');
      console.log('the remaining question is purely the radio\'s own "MOD Input (DATA ON)" menu setting —');
      console.log('see docs/civ-notes.md\'s "DATA MODE" section for exactly where to check it.');
    } else {
      console.log('*** Still reads OFF — this fix did not resolve it. Please share this full output. ***');
    }
  } catch (err) {
    console.log(`Failed to read DATA MODE: ${err.message}`);
  }

  console.log('\n--- Step 5: setDataMode(false), and confirm it reads back OFF (leaving the radio as found) ---');
  try {
    await civ.setDataMode(false);
    const afterOff = await civ.getDataMode();
    console.log(`DATA MODE now reads: ${afterOff ? 'ON' : 'OFF'}${afterOff ? ' *** did not turn off — please share this output ***' : ' (toggled off successfully)'}`);
  } catch (err) {
    console.log(`setDataMode(false) or read-back FAILED: ${err.message}`);
  }

  await civ.close();
  console.log('\nDone. Please share this FULL output.');
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
