'use strict';

/**
 * Diagnostic tool for the scope span-set command (27 15). This command
 * has been genuinely hard to get right — see docs/civ-notes.md for the
 * full history of prior attempts, all wrong for different reasons.
 *
 * This version's candidates are grounded in Icom's own official IC-7300
 * CI-V reference manual (Section 19), which — unlike every prior source
 * consulted — explicitly confirms the *value* itself: the span is
 * transmitted directly in Hz (2500-500000, matching SCOPE_SPAN_PRESETS_HZ
 * exactly, confirmed against the manual's own reference table), not an
 * index and not a half-width needing doubling, both of which an earlier,
 * less authoritative source claimed incorrectly. What the manual's
 * digit-position diagram doesn't make 100% unambiguous (PDF extraction of
 * a diagram with arrows pointing from labels into nibble positions is
 * inherently lossy) is the *exact byte position* of that value within
 * the 6-byte payload — so this tries a few well-reasoned placements, all
 * using the value directly in Hz, all using this project's already
 * hardware-verified little-endian BCD encoding (the exact same routine
 * proven correct for the main frequency field).
 *
 * This bypasses CivDriver#setScopeSpan() entirely and pokes the CI-V bus
 * directly (via the internal _send() method) so every candidate can be
 * tried in turn without an NG throwing partway through. For each one, it
 * checks whether the radio's own subsequent unsolicited scope-line
 * broadcast actually reports the target span — that decoder is trusted
 * independently of any assumption being tested here.
 *
 * Run this and share the FULL output.
 *
 * Usage:
 *   node test/manual-scope-span-diagnostics.js /dev/ttyUSB0
 *   node test/manual-scope-span-diagnostics.js /dev/ttyUSB0 0x94
 *
 * Defaults to 19200 baud, same as CivDriver itself — set the CIV_BAUD_RATE
 * env var to override if your radio's CI-V USB Baud Rate menu setting is
 * different (scope work typically needs 115200 — see docs/civ-notes.md):
 *   CIV_BAUD_RATE=115200 node test/manual-scope-span-diagnostics.js /dev/ttyUSB0 0x94
 */

const { CivDriver } = require('../src/civ');
const { CMD, SCOPE_SUBCMD, SCOPE_MODE } = require('../src/civ/commands');
const { freqToBCD } = require('../src/civ/frame');

const TARGET_HZ = 100000; // the "100 kHz" preset — one of Icom's own 8 official presets

function hex(buf) {
  return [...buf].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ');
}

function placeBcdAt(bcdBytes, totalLen, offset) {
  const buf = Buffer.alloc(totalLen);
  bcdBytes.copy(buf, offset);
  return buf;
}

const CANDIDATES = [
  {
    label: 'PRIMARY: [0x00] (1-byte prefix) + 5-byte direct-Hz BCD (current implementation — grounded in the official manual\'s reference table + cross-validated byte convention)',
    data: Buffer.concat([Buffer.from([0x00]), freqToBCD(TARGET_HZ, 5)]),
  },
  {
    label: '[0x00 0x00] (2-byte prefix) + 4-byte direct-Hz BCD — an alternate reading of the same diagram',
    data: Buffer.concat([Buffer.from([0x00, 0x00]), freqToBCD(TARGET_HZ, 4)]),
  },
  {
    label: '4-byte direct-Hz BCD placed at offset 0 of 6 (no prefix at all, 2 trailing padding bytes)',
    data: placeBcdAt(freqToBCD(TARGET_HZ, 4), 6, 0),
  },
  {
    label: 'Single byte: preset index (0-7) — an earlier, less authoritative source\'s claim, now believed wrong per the official manual, kept only for completeness',
    data: Buffer.from([0x04]), // index of 100000 in that earlier (now-abandoned) doubled-value table
  },
];

async function waitForNextScopeLine(getLastLine, timeoutMs) {
  const start = Date.now();
  const before = getLastLine();
  while (Date.now() - start < timeoutMs) {
    const current = getLastLine();
    if (current && current !== before) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function main() {
  const path = process.argv[2];
  const explicitAddr = process.argv[3] ? parseInt(process.argv[3], 16) : undefined;
  const baudRate = process.env.CIV_BAUD_RATE ? parseInt(process.env.CIV_BAUD_RATE, 10) : undefined;

  if (!path) {
    console.error('Usage: node test/manual-scope-span-diagnostics.js <serial-path> [radio-addr-hex]');
    console.error('       (set CIV_BAUD_RATE env var to override the default 19200 baud)');
    process.exit(1);
  }

  const civ = new CivDriver({ path, radioAddr: explicitAddr, baudRate });
  civ.on('error', (err) => console.error('[civ error]', err.message));

  let lastLine = null;
  civ.on('scope-line', (line) => {
    lastLine = line;
  });

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

  console.log('Enabling scope output + setting Center mode (same as normal startup)...');
  await civ.enableScopeOutput();
  await civ.setScopeMode(SCOPE_MODE.CENTER);

  console.log('Waiting up to 3s for scope data to start flowing...');
  await waitForNextScopeLine(() => lastLine, 3000);
  if (lastLine) {
    console.log(`Baseline (before any span changes): span=${lastLine.span}Hz, center=${lastLine.centerFreq}Hz`);
  } else {
    console.log(
      'WARNING: no scope-line data received at all yet. If this never arrives, the problem is upstream ' +
        'of span-setting entirely (scope output enable/mode/general CI-V scope support) — see ' +
        'test/manual-scope-test.js for isolating that separately.'
    );
  }

  const results = [];

  for (const candidate of CANDIDATES) {
    console.log(`\n--- Trying: ${candidate.label} ---`);
    console.log(`Sending data bytes: ${hex(candidate.data)}`);

    let replyDescription;
    try {
      const frame = await civ._send(CMD.SCOPE, SCOPE_SUBCMD.SPAN, candidate.data);
      if (frame.cmd === CMD.OK) replyDescription = 'OK (accepted)';
      else if (frame.cmd === CMD.NG) replyDescription = 'NG (rejected)';
      else replyDescription = `unexpected reply cmd=0x${frame.cmd.toString(16)}`;
    } catch (err) {
      replyDescription = `ERROR (${err.message})`;
    }
    console.log(`Write reply: ${replyDescription}`);

    console.log('Waiting up to 3s for the next scope-line to see if the span actually changed...');
    const newLine = await waitForNextScopeLine(() => lastLine, 3000);
    let effectDescription;
    if (newLine) {
      const matched = newLine.span === TARGET_HZ;
      effectDescription = `live data now reports span=${newLine.span}Hz, center=${newLine.centerFreq}Hz` + (matched ? ' — *** MATCHES TARGET, THIS ENCODING WORKED ***' : ' — does not match target');
    } else {
      effectDescription = 'no new scope-line arrived to check';
    }
    console.log(effectDescription);

    results.push({ label: candidate.label, data: candidate.data, replyDescription, effectDescription });
  }

  console.log('\n--- Raw read-back attempt (27 15, no data) ---');
  try {
    const frame = await civ._send(CMD.SCOPE, SCOPE_SUBCMD.SPAN);
    console.log(`Reply cmd=0x${frame.cmd.toString(16)}, raw payload bytes: ${frame.data && frame.data.length ? hex(frame.data) : '(none)'}`);
  } catch (err) {
    console.log(`Read attempt failed: ${err.message}`);
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.label}\n  bytes: ${hex(r.data)}\n  write: ${r.replyDescription}\n  effect: ${r.effectDescription}\n`);
  }

  await civ.close();
  console.log('Done. Please share this FULL output.');
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
