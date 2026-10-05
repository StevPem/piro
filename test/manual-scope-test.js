'use strict';

/**
 * Manual test: confirms whether your radio actually delivers spectrum
 * scope data over CI-V. Real-world reliability of this feature varies by
 * radio/firmware — see docs/civ-notes.md — so this is worth running and
 * confirming BEFORE any further work goes into broadcasting/rendering it.
 *
 * Usage:
 *   node test/manual-scope-test.js /dev/ttyUSB0
 *   node test/manual-scope-test.js /dev/ttyUSB0 0x94   # skip auto-detect
 *
 * Baud rate defaults to 19200; scope data is high-volume enough that you
 * may need a higher CI-V USB Baud Rate on the radio (115200 is common) —
 * if so, set CIV_BAUD_RATE to match:
 *   CIV_BAUD_RATE=115200 node test/manual-scope-test.js /dev/ttyUSB0
 *
 * What to expect if it's working: within a few seconds, you should see
 * repeated "line received" logs (5-10Hz is typical over USB per Icom's
 * own documentation). If you see NOTHING after ~15s despite the radio
 * actively receiving a signal, that's a strong signal (no pun intended)
 * this radio/firmware/connection doesn't cooperate with CI-V scope output
 * — see the troubleshooting notes this script prints at the end.
 */

const { CivDriver } = require('../src/civ');

async function main() {
  const path = process.argv[2];
  const explicitAddr = process.argv[3] ? parseInt(process.argv[3], 16) : undefined;
  const baudRate = process.env.CIV_BAUD_RATE ? parseInt(process.env.CIV_BAUD_RATE, 10) : undefined;

  if (!path) {
    console.error('Usage: node test/manual-scope-test.js <serial-path> [radio-addr-hex]');
    process.exit(1);
  }

  const civ = new CivDriver({ path, radioAddr: explicitAddr, baudRate });
  console.log(`Baud rate: ${civ.baudRate}${baudRate ? '' : ' (default — set CIV_BAUD_RATE to override)'}`);

  civ.on('error', (err) => console.error('[error]', err.message));
  civ.on('unknown-frame', (f) => console.log('[unknown-frame]', f.raw.toString('hex')));

  let lineCount = 0;
  let firstLine = null;
  civ.on('scope-line', (line) => {
    lineCount++;
    if (!firstLine) firstLine = line;
    const modeNames = ['Center', 'Fixed', 'Scroll-C', 'Scroll-F'];
    const freqDesc =
      line.centerFreq != null
        ? `center=${(line.centerFreq / 1e6).toFixed(4)}MHz span=${(line.span / 1e3).toFixed(1)}kHz`
        : `start=${(line.startFreq / 1e6).toFixed(4)}MHz end=${(line.endFreq / 1e6).toFixed(4)}MHz inRange=${line.inRange}`;
    const min = Math.min(...line.points);
    const max = Math.max(...line.points);
    console.log(
      `[scope-line #${lineCount}] mode=${modeNames[line.mode] ?? line.mode} ${freqDesc} ` +
        `points=${line.points.length} min=${min} max=${max}`
    );
  });

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

  console.log('Enabling scope output (scope on/off + data output)...');
  try {
    await civ.enableScopeOutput();
    console.log('Scope output enabled (radio accepted both commands).');
  } catch (err) {
    console.error('Radio rejected the enable-scope commands:', err.message);
    console.error('This alone suggests scope-over-CI-V is not supported/enabled on this setup.');
  }

  console.log('\nListening for scope-line events for 15s...');
  console.log('(Make sure the radio is actively receiving a signal so there\'s something to plot.)\n');
  await new Promise((resolve) => setTimeout(resolve, 15000));

  try {
    await civ.disableScopeOutput();
  } catch {
    // best-effort cleanup
  }
  await civ.close();

  console.log(`\n${lineCount} scope line(s) received in 15s.`);
  if (lineCount === 0) {
    console.log(`
No scope data arrived. Things worth checking:
  - Is "Scope Output" / "CI-V USB Echo Back" enabled in the radio's menu
    (separate from the CI-V settings used for frequency/mode control)?
  - Some radios/firmware only send scope data over a specific connection
    method (e.g. native USB vs an external CI-V-to-USB adapter, or a LAN
    connection on models that support it) — check your exact model's
    behavior; this is a documented pain point for other CI-V projects
    (see docs/civ-notes.md for links).
  - Try a firmware update if you haven't in a while — this feature has
    reportedly been inconsistent across firmware versions on some models.
  - If your radio has a "Main/Sub" dual scope, this test assumes Main.
`);
  } else {
    console.log('Scope data is working on this setup — safe to proceed to the WebSocket/UI phase.');
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
