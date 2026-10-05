'use strict';

/**
 * Manual smoke test against real hardware. Not part of the automated test
 * suite (which is test/frame.test.js and needs no radio).
 *
 * Usage:
 *   node test/manual-civ-test.js /dev/ttyUSB0
 *   node test/manual-civ-test.js /dev/ttyUSB0 0x94   # skip auto-detect
 *
 * Baud rate defaults to 19200; override with CIV_BAUD_RATE if you've
 * changed the radio's CI-V USB Baud Rate setting (e.g. to 115200 for
 * spectrum scope use — see docs/civ-notes.md):
 *   CIV_BAUD_RATE=115200 node test/manual-civ-test.js /dev/ttyUSB0
 */

const { CivDriver } = require('../src/civ');

async function main() {
  const path = process.argv[2];
  const explicitAddr = process.argv[3] ? parseInt(process.argv[3], 16) : undefined;
  const baudRate = process.env.CIV_BAUD_RATE ? parseInt(process.env.CIV_BAUD_RATE, 10) : undefined;

  if (!path) {
    console.error('Usage: node test/manual-civ-test.js <serial-path> [radio-addr-hex]');
    process.exit(1);
  }

  const civ = new CivDriver({ path, radioAddr: explicitAddr, baudRate });
  console.log(`Baud rate: ${civ.baudRate}${baudRate ? '' : ' (default — set CIV_BAUD_RATE to override)'}`);

  civ.on('error', (err) => console.error('[error]', err.message));
  civ.on('frequency', (hz) => console.log(`[unsolicited] frequency -> ${hz} Hz`));
  civ.on('mode', (m) => console.log('[unsolicited] mode ->', m));
  civ.on('unknown-frame', (f) =>
    console.log('[unknown-frame]', f.raw.toString('hex'))
  );

  console.log(`Opening ${path}...`);
  await civ.open();
  console.log('Port open.');

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

  const freq = await civ.getFrequency();
  console.log(`Current frequency: ${freq} Hz`);

  const mode = await civ.getMode();
  console.log('Current mode:', mode);

  const smeter = await civ.getSMeter();
  console.log('S-meter level:', smeter);

  console.log('\nListening for unsolicited transceive updates for 15s.');
  console.log('Try changing frequency/mode on the radio front panel now...');
  await new Promise((resolve) => setTimeout(resolve, 15000));

  await civ.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
