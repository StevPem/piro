'use strict';

// Run with: node test/civ-driver.test.js
// Exercises CivDriver against a fake serial transport (no real hardware
// needed) — in particular, the request/reply matcher's subCmd
// disambiguation (see driver.js's _frameMatchesCurrent doc comment) and
// the end-to-end scope waveform pipeline.

const { EventEmitter } = require('events');
const { CivDriver } = require('../src/civ/driver');
const { encodeFrame, freqToBCD, bcdToFreq } = require('../src/civ/frame');
const {
  CMD,
  SUBCMD,
  SCOPE_SUBCMD,
  SCOPE_MODE,
  FUNCTION_SUBCMD,
  LEVEL_SUBCMD,
  OPTIONAL_SUBCMD,
  DATA_MODE_PARAM_BYTES,
  AF_OUTPUT_LEVEL_USB_PARAM_BYTES,
  MOD_INPUT_LEVEL_USB_PARAM_BYTES,
  MODE,
  DEFAULT_CONTROLLER_ADDR,
} = require('../src/civ/commands');

const RADIO_ADDR = 0x94;

/** Minimal stand-in for a `serialport` SerialPort instance. */
class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.isOpen = true;
    this.written = [];
  }
  write(buf, cb) {
    this.written.push(buf);
    if (cb) cb();
  }
  close(cb) {
    this.isOpen = false;
    if (cb) cb();
  }
  /** Test helper: simulate the radio sending a frame back. */
  sendFrame(opts) {
    this.emit('data', encodeFrame({ to: DEFAULT_CONTROLLER_ADDR, from: RADIO_ADDR, ...opts }));
  }
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

function scopeHeaderFrame({ total = 1, mode = SCOPE_MODE.CENTER, centerFreq = 14195000, span = 25000 } = {}) {
  return {
    cmd: CMD.SCOPE,
    subCmd: SCOPE_SUBCMD.WAVEFORM_DATA,
    data: Buffer.concat([
      Buffer.from([0x00, 0x01, total, mode]),
      freqToBCD(centerFreq),
      freqToBCD(span),
    ]),
  };
}

async function testBasicRequestReply() {
  console.log('\n-- basic request/reply over the fake transport --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  const freqPromise = driver.getFrequency();
  transport.sendFrame({ cmd: CMD.SEND_FREQ, data: freqToBCD(14195000) });
  const hz = await freqPromise;
  check(hz === 14195000, 'getFrequency() resolves with the value from the simulated reply');
}

async function testFilter() {
  console.log('\n-- setFilter()/getFilter() read/preserve mode via the mode-set command\'s filter byte --');

  // setFilter() has to read the current mode first (no standalone
  // "set filter" command exists — see setFilter()'s doc comment), then
  // resend it unchanged alongside the new filter byte.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();

    const promise = driver.setFilter(2);
    await new Promise((resolve) => setImmediate(resolve));
    // First: setFilter() internally calls getMode() — reply with USB, filter 1.
    const firstFrame = [...transport.written[transport.written.length - 1]];
    check(firstFrame[4] === CMD.SEND_MODE, 'setFilter() first reads the current mode');
    transport.sendFrame({ cmd: CMD.SEND_MODE, data: Buffer.from([MODE.USB, 1]) });

    await new Promise((resolve) => setImmediate(resolve));
    // Second: setMode(USB, 2) — mode preserved, filter changed.
    const secondFrame = [...transport.written[transport.written.length - 1]];
    check(
      secondFrame[4] === CMD.SET_MODE && secondFrame[5] === MODE.USB && secondFrame[6] === 2,
      `setFilter(2) resends the current mode (USB) with the new filter byte (2), got frame [${secondFrame.join(',')}]`
    );
    transport.sendFrame({ cmd: CMD.OK });
    await promise;

    await driver.close();
  }

  // setFilter() rejects an invalid slot without touching the radio at all.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    let threw = false;
    try {
      await driver.setFilter(4);
    } catch {
      threw = true;
    }
    check(threw, 'setFilter() rejects a value other than 1, 2, or 3');
    check(transport.written.length === 0, 'setFilter() with an invalid value sends nothing at all');
    await driver.close();
  }

  // getFilter() just reads the mode and returns its filter component.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getFilter();
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.SEND_MODE, data: Buffer.from([MODE.CW, 3]) });
    const filter = await promise;
    check(filter === 3, `getFilter() returns the filter byte from the current mode reply, got ${filter}`);
    await driver.close();
  }
}

async function testTxPower() {
  console.log('\n-- setTxPower()/getTxPower() use the S-meter-style packing, not standard BCD (the rejected first attempt) --');

  function meterStylePacking(raw) {
    const hundreds = Math.floor(raw / 100);
    const tensOnes = raw % 100;
    return Buffer.from([hundreds, freqToBCD(tensOnes, 1)[0]]);
  }

  const CASES = [
    [100, 255],
    [75, 191],
    [50, 128],
    [25, 64],
    [5, 13],
  ];

  for (const [watts, expectedRaw] of CASES) {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.setTxPower(watts);
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    const dataBytes = lastFrame.slice(6, lastFrame.length - 1);
    const expectedBytes = [...meterStylePacking(expectedRaw)];
    check(
      lastFrame[4] === CMD.LEVEL &&
        lastFrame[5] === LEVEL_SUBCMD.RF_PWR &&
        dataBytes.join(',') === expectedBytes.join(','),
      `setTxPower(${watts}) sends cmd=0x14 subcmd=0x0A with S-meter-style bytes [${expectedBytes.join(',')}] (raw ${expectedRaw}), got [${dataBytes.join(',')}]`
    );
    // The byte that carries the hundreds digit must itself be a valid
    // hundreds digit (0-2) — this is exactly the property the earlier,
    // rejected standard-BCD encoding violated for higher values (see
    // setTxPower()'s doc comment).
    check(dataBytes[0] <= 2, `the hundreds-digit byte (${dataBytes[0]}) is a valid 0-2 value, not something a radio would plausibly reject`);
    transport.sendFrame({ cmd: CMD.OK });
    const applied = await promise;
    check(applied === watts, `setTxPower(${watts}) round-trips back to exactly ${watts}W, got ${applied}`);
    await driver.close();
  }

  // getTxPower() reads the raw level back (S-meter-style packing) and converts to watts.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getTxPower();
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    check(
      lastFrame[4] === CMD.LEVEL && lastFrame[5] === LEVEL_SUBCMD.RF_PWR && lastFrame.length === 7,
      'getTxPower() sends a bare read request (no data) for cmd=0x14 subcmd=0x0A'
    );
    transport.sendFrame({ cmd: CMD.LEVEL, subCmd: LEVEL_SUBCMD.RF_PWR, data: meterStylePacking(191) }); // raw 191 -> 75W
    const watts = await promise;
    check(watts === 75, `getTxPower() decodes S-meter-style bytes for raw 191 back to 75W, got ${watts}`);
    await driver.close();
  }
}

async function testRxGain() {
  console.log('\n-- setRxGain()/getRxGain() use the same S-meter-style packing, raw 0-255 with no unit conversion --');

  function meterStylePacking(raw) {
    const hundreds = Math.floor(raw / 100);
    const tensOnes = raw % 100;
    return Buffer.from([hundreds, freqToBCD(tensOnes, 1)[0]]);
  }

  for (const raw of [0, 1, 126, 200, 255]) {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.setRxGain(raw);
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    const dataBytes = lastFrame.slice(6, lastFrame.length - 1);
    const expectedBytes = [...meterStylePacking(raw)];
    check(
      lastFrame[4] === CMD.LEVEL &&
        lastFrame[5] === LEVEL_SUBCMD.RF_GAIN &&
        dataBytes.join(',') === expectedBytes.join(','),
      `setRxGain(${raw}) sends cmd=0x14 subcmd=0x02 with S-meter-style bytes [${expectedBytes.join(',')}], got [${dataBytes.join(',')}]`
    );
    transport.sendFrame({ cmd: CMD.OK });
    const applied = await promise;
    check(applied === raw, `setRxGain(${raw}) resolves with the raw value applied (no unit conversion), got ${applied}`);
    await driver.close();
  }

  // Out-of-range input is clamped, not rejected or silently wrapped.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.setRxGain(9999);
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    const dataBytes = lastFrame.slice(6, lastFrame.length - 1);
    check(dataBytes.join(',') === [...meterStylePacking(255)].join(','), 'setRxGain(9999) clamps to the max (255), not sent as garbage');
    transport.sendFrame({ cmd: CMD.OK });
    const applied = await promise;
    check(applied === 255, `setRxGain(9999) resolves with the clamped value 255, got ${applied}`);
    await driver.close();
  }

  // getRxGain() reads the raw level back with no conversion.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getRxGain();
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    check(
      lastFrame[4] === CMD.LEVEL && lastFrame[5] === LEVEL_SUBCMD.RF_GAIN && lastFrame.length === 7,
      'getRxGain() sends a bare read request (no data) for cmd=0x14 subcmd=0x02'
    );
    transport.sendFrame({ cmd: CMD.LEVEL, subCmd: LEVEL_SUBCMD.RF_GAIN, data: meterStylePacking(200) });
    const value = await promise;
    check(value === 200, `getRxGain() decodes S-meter-style bytes for raw 200 back to 200 (no scaling), got ${value}`);
    await driver.close();
  }
}

/**
 * Regression test for a real bug: CwDecoderBridge and RttyDecoderBridge
 * both gate their behavior purely on this driver's own
 * 'mode' event — but setMode() used to never emit it itself, only ever
 * relying on the radio separately echoing an unsolicited
 * CMD.TRANSCEIVE_MODE notification back, which depends on the radio's own
 * "CI-V Transceive" setting and isn't guaranteed for a mode-set command
 * the radio received over this same CI-V link. Net effect: switching into
 * CW mode through the app could show "CW" in the UI (which updates
 * optimistically — see app.js) while CwDecoderBridge never actually
 * attached to the RX audio stream, so no CW decoder of any kind ever
 * produced output, no matter how clean or strong the signal. See
 * setMode()'s own doc comment for the full account.
 */
async function testSetModeEmitsModeEvent() {
  console.log("\n-- setMode()/setFilter() emit this driver's own 'mode' event immediately on success, not just on an unsolicited echo --");

  // setMode() emits 'mode' itself, synchronously with the OK reply —
  // never requires a separate unsolicited transceive notification.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();

    const events = [];
    driver.on('mode', (value) => events.push(value));

    const promise = driver.setMode('CW', 1);
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.OK });
    await promise;

    check(
      events.length === 1 && events[0].mode === 'CW' && events[0].filter === 1,
      `setMode('CW', 1) emits 'mode' with the newly-set value as soon as the radio confirms it, got ${JSON.stringify(events)}`
    );

    await driver.close();
  }

  // A real subsequent unsolicited transceive notification carrying the
  // same value is a harmless, idempotent duplicate, not a conflict —
  // every consumer treats 'mode' as a snapshot of current state.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();

    const events = [];
    driver.on('mode', (value) => events.push(value));

    const promise = driver.setMode('CW', 1);
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.OK });
    await promise;
    transport.sendFrame({ cmd: CMD.TRANSCEIVE_MODE, data: Buffer.from([MODE.CW, 1]) });

    check(
      events.length === 2 && events[0].mode === 'CW' && events[1].mode === 'CW',
      `a genuine transceive echo after the local setMode() just produces a second, consistent 'mode' event, got ${JSON.stringify(events)}`
    );

    await driver.close();
  }

  // setFilter() goes through setMode() internally, so it inherits the
  // same fix for free — confirmed explicitly since RttyDecoderBridge/
  // CwDecoderBridge don't distinguish how a mode change
  // happened to arrive.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();

    const events = [];
    driver.on('mode', (value) => events.push(value));

    const promise = driver.setFilter(2);
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.SEND_MODE, data: Buffer.from([MODE.USB, 1]) });
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.OK });
    await promise;

    check(
      events.length === 1 && events[0].mode === 'USB' && events[0].filter === 2,
      `setFilter(2) also emits 'mode' (via its internal setMode() call), got ${JSON.stringify(events)}`
    );

    await driver.close();
  }
}

async function testCwPitch() {
  console.log('\n-- getCwPitch() decodes raw 0-255 into Hz, matching the manual\'s exact reference points --');

  function meterStylePacking(raw) {
    const hundreds = Math.floor(raw / 100);
    const tensOnes = raw % 100;
    return Buffer.from([hundreds, freqToBCD(tensOnes, 1)[0]]);
  }

  // Icom's manual documents these exact examples: 0000=300Hz, 0128=600Hz, 0255=900Hz.
  const CASES = [
    [0, 300],
    [128, 600],
    [255, 900],
  ];

  for (const [raw, expectedHz] of CASES) {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getCwPitch();
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    check(
      lastFrame[4] === CMD.LEVEL && lastFrame[5] === LEVEL_SUBCMD.CW_PITCH && lastFrame.length === 7,
      `getCwPitch() sends a bare read request for cmd=0x14 subcmd=0x09, got [${lastFrame.join(',')}]`
    );
    transport.sendFrame({ cmd: CMD.LEVEL, subCmd: LEVEL_SUBCMD.CW_PITCH, data: meterStylePacking(raw) });
    const hz = await promise;
    check(hz === expectedHz, `raw ${raw} decodes to ${expectedHz}Hz (manual's documented example), got ${hz}`);
    await driver.close();
  }
}

async function testGetSMeter() {
  console.log('\n-- getSMeter() decodes the confirmed real byte format (hundreds nibble + 2-digit BCD byte) --');

  // Confirmed real-hardware capture: 20 live S-meter readings from
  // test/manual-smeter-diagnostics.js, correlated against the radio's
  // own front-panel S-meter (observed reading S9 to S9+10dB throughout).
  // These are a genuine regression test against real captured data, not
  // synthetic examples — see getSMeter()'s doc comment for the full story.
  const REAL_CAPTURED_READINGS = [
    { bytes: [0x01, 0x27], expected: 127 },
    { bytes: [0x01, 0x24], expected: 124 },
    { bytes: [0x01, 0x37], expected: 137 },
    { bytes: [0x01, 0x33], expected: 133 },
    { bytes: [0x01, 0x36], expected: 136 },
    { bytes: [0x01, 0x27], expected: 127 },
    { bytes: [0x01, 0x26], expected: 126 },
    { bytes: [0x01, 0x34], expected: 134 },
    { bytes: [0x01, 0x44], expected: 144 },
    { bytes: [0x01, 0x31], expected: 131 },
    { bytes: [0x01, 0x36], expected: 136 },
    { bytes: [0x01, 0x25], expected: 125 },
    { bytes: [0x01, 0x37], expected: 137 },
    { bytes: [0x01, 0x34], expected: 134 },
    { bytes: [0x01, 0x36], expected: 136 },
    { bytes: [0x01, 0x39], expected: 139 },
    { bytes: [0x01, 0x43], expected: 143 },
    { bytes: [0x01, 0x30], expected: 130 },
    { bytes: [0x01, 0x43], expected: 143 },
    { bytes: [0x01, 0x41], expected: 141 },
  ];

  for (const { bytes, expected } of REAL_CAPTURED_READINGS) {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getSMeter();
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.READ_SMETER, subCmd: SUBCMD.SMETER, data: Buffer.from(bytes) });
    const value = await promise;
    check(
      value === expected,
      `real captured bytes [0x${bytes[0].toString(16)}, 0x${bytes[1].toString(16)}] decode to ${expected}, got ${value}`
    );
    await driver.close();
  }

  // Every one of the 20 real readings above should fall in S9 or
  // S9+10dB per the calibration table, matching what was actually
  // observed on the radio's front panel during capture.
  {
    const values = REAL_CAPTURED_READINGS.map((r) => r.expected);
    const allInExpectedRange = values.every((v) => v >= 124 && v <= 144); // S8's top edge through S9+10dB's low-mid
    check(allInExpectedRange, 'all 20 real captured readings decode within the observed S8-S9+10dB range (124-144)');
  }

  // Fewer than 2 data bytes is a clear error, not a silent misinterpretation.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getSMeter();
    promise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.READ_SMETER, subCmd: SUBCMD.SMETER, data: Buffer.from([0x20]) });
    let threw = false;
    try {
      await promise;
    } catch {
      threw = true;
    }
    check(threw, 'a reply with fewer than 2 data bytes throws rather than misinterpreting it');
    await driver.close();
  }

  // A hundreds nibble of 3+ is impossible for a real 0-255 reading (max
  // valid hundreds digit is 2) and pushes the result out of range —
  // throws a clear error rather than returning garbage.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getSMeter();
    promise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.READ_SMETER, subCmd: SUBCMD.SMETER, data: Buffer.from([0x05, 0x00]) }); // hundreds=5 -> 500+
    let threw = false;
    try {
      await promise;
    } catch (err) {
      threw = true;
      check(/out-of-range/.test(err.message), 'the error clearly names the problem as an out-of-range decode');
    }
    check(threw, 'a hundreds nibble that pushes the value past 255 throws rather than returning garbage silently');
    await driver.close();
  }

  // A byte1 that isn't valid BCD (a nibble outside 0-9) decodes to NaN,
  // not a number that happens to be in range — this must also be caught,
  // not silently pass the numeric range check (NaN comparisons are
  // always false, a real gap that was found and fixed while adding this
  // test).
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getSMeter();
    promise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.READ_SMETER, subCmd: SUBCMD.SMETER, data: Buffer.from([0x01, 0xab]) }); // 0xab is not valid BCD
    let threw = false;
    try {
      await promise;
    } catch (err) {
      threw = true;
      check(/out-of-range/.test(err.message), 'a NaN-producing (non-BCD) byte1 is also caught as an out-of-range decode');
    }
    check(threw, 'a non-BCD byte1 throws rather than silently passing through as NaN');
    await driver.close();
  }
}

async function testGetSWR() {
  console.log('\n-- getSWR() decodes using the same confirmed meter format, verified against the manual\'s documented examples --');

  // Icom's official manual documents these exact reply examples for this
  // command: 00 00=SWR1.0, 00 48=SWR1.5, 00 80=SWR2.0, 01 20=SWR3.0.
  // Decoded with the confirmed S-meter byte format (not a standard BCD
  // pair), these give clean, round raw values — see getSWR()'s doc
  // comment for why that's good circumstantial evidence this command
  // shares S-meter's encoding, short of independent hardware confirmation.
  const DOCUMENTED_EXAMPLES = [
    { bytes: [0x00, 0x00], expected: 0 }, // SWR 1.0
    { bytes: [0x00, 0x48], expected: 48 }, // SWR 1.5
    { bytes: [0x00, 0x80], expected: 80 }, // SWR 2.0
    { bytes: [0x01, 0x20], expected: 120 }, // SWR 3.0
  ];

  for (const { bytes, expected } of DOCUMENTED_EXAMPLES) {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getSWR();
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    check(
      lastFrame[4] === CMD.READ_SMETER && lastFrame[5] === SUBCMD.SWR,
      `getSWR() sends cmd=0x15 subcmd=0x12, got cmd=0x${lastFrame[4].toString(16)} subcmd=0x${lastFrame[5].toString(16)}`
    );
    transport.sendFrame({ cmd: CMD.READ_SMETER, subCmd: SUBCMD.SWR, data: Buffer.from(bytes) });
    const value = await promise;
    check(
      value === expected,
      `documented example [0x${bytes[0].toString(16)}, 0x${bytes[1].toString(16)}] decodes to ${expected}, got ${value}`
    );
    await driver.close();
  }

  // Same defensive checks as getSMeter() apply here too, since they
  // share the same underlying decode helper.
  {
    const transport = new FakeTransport();
    const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
    await driver.open();
    const promise = driver.getSWR();
    promise.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    transport.sendFrame({ cmd: CMD.READ_SMETER, subCmd: SUBCMD.SWR, data: Buffer.from([0x20]) });
    let threw = false;
    try {
      await promise;
    } catch {
      threw = true;
    }
    check(threw, 'getSWR() also throws on a too-short reply, sharing the S-meter decode\'s defensiveness');
    await driver.close();
  }
}

async function testSubCmdDisambiguation() {
  console.log('\n-- matcher subCmd disambiguation (the fix) --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  let scopeLine = null;
  driver.on('scope-line', (line) => (scopeLine = line));

  // A pending read-style request sharing cmd=0x27 with the scope waveform
  // push, but a different subCmd (0x10 = on/off status vs 0x00 = waveform).
  const pending = driver._send(CMD.SCOPE, SCOPE_SUBCMD.ON_OFF);
  let pendingSettled = false;
  pending.then(() => (pendingSettled = true), () => (pendingSettled = true));

  // An unsolicited scope waveform frame arrives first (single-chunk line,
  // so it completes immediately).
  const header = scopeHeaderFrame({ total: 1 });
  transport.sendFrame(header);

  await new Promise((resolve) => setImmediate(resolve));
  check(
    scopeLine !== null && scopeLine.centerFreq === 14195000,
    'the unsolicited scope frame was routed to the scope assembler, not swallowed as a reply'
  );
  check(pendingSettled === false, 'the pending on/off-status request is still unresolved (correctly NOT matched)');

  // Now the real reply for the pending request arrives.
  transport.sendFrame({ cmd: CMD.SCOPE, subCmd: SCOPE_SUBCMD.ON_OFF, data: Buffer.from([0x01]) });
  const reply = await pending;
  check(
    reply.cmd === CMD.SCOPE && reply.subCmd === SCOPE_SUBCMD.ON_OFF && reply.data[0] === 0x01,
    'the correctly-matching reply resolves the pending request once it arrives'
  );
}

async function testEnableScopeOutputAndFullLine() {
  console.log('\n-- enableScopeOutput() + multi-chunk scope-line end to end --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  const enablePromise = driver.enableScopeOutput();
  // enableScopeOutput() sends two sequential set commands; reply OK to each in turn.
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK });
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK });
  await enablePromise;

  const writtenFrames = transport.written.map((buf) => [...buf]);
  check(
    writtenFrames.some((f) => f[4] === CMD.SCOPE && f[5] === SCOPE_SUBCMD.ON_OFF && f[6] === 0x01),
    'enableScopeOutput() sends a scope-on-off ON command'
  );
  check(
    writtenFrames.some((f) => f[4] === CMD.SCOPE && f[5] === SCOPE_SUBCMD.DATA_OUTPUT && f[6] === 0x01),
    'enableScopeOutput() sends a scope-data-output ON command'
  );

  let scopeLine = null;
  driver.on('scope-line', (line) => (scopeLine = line));

  transport.sendFrame(scopeHeaderFrame({ total: 3, centerFreq: 7150000, span: 50000 }));
  transport.sendFrame({
    cmd: CMD.SCOPE,
    subCmd: SCOPE_SUBCMD.WAVEFORM_DATA,
    data: Buffer.from([0x00, 0x02, 0x03, 10, 20, 30]),
  });
  transport.sendFrame({
    cmd: CMD.SCOPE,
    subCmd: SCOPE_SUBCMD.WAVEFORM_DATA,
    data: Buffer.from([0x00, 0x03, 0x03, 40, 50, 60]),
  });

  check(scopeLine !== null, 'a scope-line event fired once all 3 chunks arrived');
  check(scopeLine.centerFreq === 7150000 && scopeLine.span === 50000, 'the line carries the correct frequency info');
  check(
    [...scopeLine.points].join(',') === '10,20,30,40,50,60',
    'the line carries the correctly concatenated sample points'
  );

  await driver.close();
}

async function testScopeSpanClamping() {
  console.log('\n-- setScopeSpan() clamps to the nearest allowed preset --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  // Request 15kHz — not a valid preset — should clamp up to 25kHz, and
  // the reply resolves with the *applied* value, not the requested one.
  const spanPromise = driver.setScopeSpan(15000);
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK });
  const applied = await spanPromise;
  check(applied === 25000, 'requesting 15kHz clamps up to the 25kHz preset');

  // A request above the largest preset clamps down to 500kHz, not left unbounded.
  const bigSpanPromise = driver.setScopeSpan(2000000);
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK });
  const bigApplied = await bigSpanPromise;
  check(bigApplied === 500000, 'requesting a span above the largest preset clamps down to 500kHz');

  await driver.close();
}

async function testScopeSpanWireFormat() {
  console.log(
    '\n-- setScopeSpan() sends the value directly in Hz (0x00 prefix + 5-byte BCD), ' +
      'per Icom\'s own official CI-V reference manual --'
  );
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  // Every one of the 5 UI span buttons' values should map to an exact
  // preset (no clamping).
  const values = [25000, 50000, 100000, 250000, 500000];

  for (const requestedHz of values) {
    const promise = driver.setScopeSpan(requestedHz);
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    // FE FE <to> <from> 27 15 <6 data bytes> FD
    const dataBytes = lastFrame.slice(6, 12);
    const expectedData = [0x00, ...freqToBCD(requestedHz, 5)];
    check(
      lastFrame.length === 13 && dataBytes.join(',') === expectedData.join(','),
      `${requestedHz}Hz encodes as [0x00, ...BCD] = [${expectedData.join(',')}], got [${dataBytes.join(',')}]`
    );
    transport.sendFrame({ cmd: CMD.OK });
    const applied = await promise;
    check(applied === requestedHz, `${requestedHz}Hz is applied exactly (an official preset, no clamping needed)`);
  }

  await driver.close();
}

async function testGetScopeSpan() {
  console.log('\n-- getScopeSpan() decodes the 6-byte read-back reply (0x00 prefix + 5-byte BCD) --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  const promise = driver.getScopeSpan();
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({
    cmd: CMD.SCOPE,
    subCmd: SCOPE_SUBCMD.SPAN,
    data: Buffer.from([0x00, ...freqToBCD(100000, 5)]),
  });
  const span = await promise;
  check(span === 100000, `decodes a 0x00-prefixed 5-byte BCD reply to 100000Hz, got ${span}`);

  await driver.close();
}

async function testGetScopeSpanUnsupportedReply() {
  console.log('\n-- getScopeSpan() throws a clear error on an unexpected/short reply (older firmware) --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  const promise = driver.getScopeSpan();
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.SCOPE, subCmd: SCOPE_SUBCMD.SPAN, data: Buffer.from([0x05]) }); // old-style short reply

  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    check(/older firmware/.test(err.message), 'the error mentions older firmware as a likely explanation');
  }
  check(threw, 'getScopeSpan() throws rather than misinterpreting a short/unexpected reply');

  await driver.close();
}

async function testFunctionToggles() {
  console.log('\n-- setPreamp/setNoiseReduction/setNoiseBlanker/setNotch send the correct bytes --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  async function expectFrame(callFn, expectedSubCmd, expectedData) {
    const promise = callFn();
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    // FE FE <to> <from> 16 <subcmd> <data...> FD
    const gotSubCmd = lastFrame[5];
    const gotData = lastFrame.slice(6, lastFrame.length - 1);
    const ok =
      lastFrame[4] === CMD.FUNCTION &&
      gotSubCmd === expectedSubCmd &&
      gotData.join(',') === expectedData.join(',');
    check(
      ok,
      `expected cmd=0x16 subcmd=0x${expectedSubCmd.toString(16)} data=[${expectedData.join(',')}], ` +
        `got cmd=0x${lastFrame[4].toString(16)} subcmd=0x${gotSubCmd.toString(16)} data=[${gotData.join(',')}]`
    );
    transport.sendFrame({ cmd: CMD.OK });
    await promise;
  }

  await expectFrame(() => driver.setPreamp(0), FUNCTION_SUBCMD.PREAMP, [0]);
  await expectFrame(() => driver.setPreamp(1), FUNCTION_SUBCMD.PREAMP, [1]);
  await expectFrame(() => driver.setPreamp(2), FUNCTION_SUBCMD.PREAMP, [2]);
  await expectFrame(() => driver.setNoiseReduction(true), FUNCTION_SUBCMD.NOISE_REDUCTION, [1]);
  await expectFrame(() => driver.setNoiseReduction(false), FUNCTION_SUBCMD.NOISE_REDUCTION, [0]);
  await expectFrame(() => driver.setNoiseBlanker(true), FUNCTION_SUBCMD.NOISE_BLANKER, [1]);
  await expectFrame(() => driver.setNoiseBlanker(false), FUNCTION_SUBCMD.NOISE_BLANKER, [0]);
  await expectFrame(() => driver.setNotch(true), FUNCTION_SUBCMD.AUTO_NOTCH, [1]);
  await expectFrame(() => driver.setNotch(false), FUNCTION_SUBCMD.AUTO_NOTCH, [0]);

  let threw = false;
  try {
    await driver.setPreamp(3);
  } catch {
    threw = true;
  }
  check(threw, 'setPreamp() rejects an invalid value (not 0, 1, or 2) without sending anything');

  await driver.close();
}

async function testSetTuner() {
  console.log('\n-- setTuner() sends 0=OFF/1=ON/2=start-tuning under the PTT command group (1C 01) --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  async function expectFrame(value) {
    const promise = driver.setTuner(value);
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    // FE FE <to> <from> 1C 01 <value> FD
    const ok = lastFrame[4] === CMD.PTT && lastFrame[5] === SUBCMD.TUNER && lastFrame[6] === value;
    check(ok, `setTuner(${value}) sends cmd=0x1C subcmd=0x01 data=[${value}], got frame [${lastFrame.join(',')}]`);
    transport.sendFrame({ cmd: CMD.OK });
    await promise;
  }

  await expectFrame(0); // OFF
  await expectFrame(1); // ON
  await expectFrame(2); // start tuning now

  let threw = false;
  try {
    await driver.setTuner(3);
  } catch {
    threw = true;
  }
  check(threw, 'setTuner() rejects an invalid value (not 0, 1, or 2) without sending anything');

  await driver.close();
}

async function testFunctionAndTunerGetters() {
  console.log('\n-- getPreamp/getNoiseReduction/getNoiseBlanker/getNotch/getTuner read the actual current value --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  async function expectRead(callFn, expectedCmd, expectedSubCmd, replyByte, expected) {
    const promise = callFn();
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    // FE FE <to> <from> <cmd> <subcmd> FD — a bare read request, no data bytes
    const isBareRead = lastFrame.length === 7 && lastFrame[4] === expectedCmd && lastFrame[5] === expectedSubCmd;
    check(isBareRead, `sends a bare read request (no data) for cmd=0x${expectedCmd.toString(16)} subcmd=0x${expectedSubCmd.toString(16)}, got [${lastFrame.join(',')}]`);
    transport.sendFrame({ cmd: expectedCmd, subCmd: expectedSubCmd, data: Buffer.from([replyByte]) });
    const result = await promise;
    check(result === expected, `resolves with ${JSON.stringify(expected)} for reply byte ${replyByte}, got ${JSON.stringify(result)}`);
  }

  await expectRead(() => driver.getPreamp(), CMD.FUNCTION, FUNCTION_SUBCMD.PREAMP, 2, 2);
  await expectRead(() => driver.getNoiseReduction(), CMD.FUNCTION, FUNCTION_SUBCMD.NOISE_REDUCTION, 1, true);
  await expectRead(() => driver.getNoiseReduction(), CMD.FUNCTION, FUNCTION_SUBCMD.NOISE_REDUCTION, 0, false);
  await expectRead(() => driver.getNoiseBlanker(), CMD.FUNCTION, FUNCTION_SUBCMD.NOISE_BLANKER, 1, true);
  await expectRead(() => driver.getNotch(), CMD.FUNCTION, FUNCTION_SUBCMD.AUTO_NOTCH, 1, true);
  await expectRead(() => driver.getTuner(), CMD.PTT, SUBCMD.TUNER, 1, 1);
  await expectRead(() => driver.getTuner(), CMD.PTT, SUBCMD.TUNER, 0, 0);

  // A reply with no data bytes at all is a clear error, not a silent wrong answer.
  const promise = driver.getPreamp();
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.FUNCTION, subCmd: FUNCTION_SUBCMD.PREAMP, data: Buffer.alloc(0) });
  let threw = false;
  try {
    await promise;
  } catch {
    threw = true;
  }
  check(threw, 'a reply with no data bytes throws rather than returning undefined silently');

  await driver.close();
}

async function testDataMode() {
  console.log(
    '\n-- setDataMode()/getDataMode() use the "1A 05 00 63" two-part-addressed command with a ' +
      '2-byte value field (confirmed against real IC-7300 hardware — see docs/civ-notes.md) --'
  );
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  async function expectSet(on) {
    const promise = driver.setDataMode(on);
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    // FE FE <to> <from> 1A 05 00 63 00 <on> FD — a 2-byte value field
    // ([0x00, on?1:0]), not a single byte: a real hardware read-back
    // (test/manual-data-mode-diagnostics.js) showed the radio's own
    // reply for this parameter is 4 data bytes wide, not 3.
    const expected = [CMD.OPTIONAL, OPTIONAL_SUBCMD.DATA_MODE, ...DATA_MODE_PARAM_BYTES, 0x00, on ? 1 : 0];
    const got = [lastFrame[4], lastFrame[5], lastFrame[6], lastFrame[7], lastFrame[8], lastFrame[9]];
    check(
      got.join(',') === expected.join(','),
      `setDataMode(${on}) sends [${expected.join(',')}], got [${got.join(',')}]`
    );
    transport.sendFrame({ cmd: CMD.OK });
    await promise;
  }

  await expectSet(true);
  await expectSet(false);

  const promise = driver.getDataMode();
  await new Promise((resolve) => setImmediate(resolve));
  const lastFrame = [...transport.written[transport.written.length - 1]];
  // A bare read: just the 2-byte parameter number, no value bytes yet.
  const isBareParamRead =
    lastFrame.length === 9 &&
    lastFrame[4] === CMD.OPTIONAL &&
    lastFrame[5] === OPTIONAL_SUBCMD.DATA_MODE &&
    lastFrame[6] === DATA_MODE_PARAM_BYTES[0] &&
    lastFrame[7] === DATA_MODE_PARAM_BYTES[1];
  check(isBareParamRead, `getDataMode() reads with just the 2-byte parameter number, got [${lastFrame.join(',')}]`);
  transport.sendFrame({
    cmd: CMD.OPTIONAL,
    subCmd: OPTIONAL_SUBCMD.DATA_MODE,
    data: Buffer.from([...DATA_MODE_PARAM_BYTES, 0x00, 1]),
  });
  const on = await promise;
  check(on === true, `getDataMode() decodes the echoed [param, param, valueHi, valueLo] reply, got ${on}`);

  // A 3-byte reply (the old, wrong assumption) is a clear error, not a
  // silently-wrong answer — same "throw rather than misinterpret" rule
  // this project applies to getScopeSpan()'s short-reply case.
  const shortPromise = driver.getDataMode();
  shortPromise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({
    cmd: CMD.OPTIONAL,
    subCmd: OPTIONAL_SUBCMD.DATA_MODE,
    data: Buffer.from([...DATA_MODE_PARAM_BYTES, 1]),
  });
  let threwOnShortReply = false;
  try {
    await shortPromise;
  } catch {
    threwOnShortReply = true;
  }
  check(threwOnShortReply, 'getDataMode() throws on an unexpectedly short (3-byte) reply rather than misreading it');

  await driver.close();
}

async function testUsbAudioLevels() {
  console.log(
    '\n-- setAfOutputLevelUsb()/setModInputLevelUsb() use the same "1A 05" two-part addressing as DATA ' +
      'MODE, but with the meter-style 0-255 value encoding (given directly from a real IC-7300, along with ' +
      'a worked "02 55" = 255/max example) --'
  );
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  async function expectSet(methodName, paramBytes, value, expectedValueBytes) {
    const promise = driver[methodName](value);
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    // FE FE <to> <from> 1A 05 <param,param> <valueHi,valueLo> FD
    const expected = [CMD.OPTIONAL, OPTIONAL_SUBCMD.DATA_MODE, ...paramBytes, ...expectedValueBytes];
    const got = lastFrame.slice(4, 10);
    check(
      got.join(',') === expected.join(','),
      `${methodName}(${value}) sends [${expected.join(',')}], got [${got.join(',')}]`
    );
    transport.sendFrame({ cmd: CMD.OK });
    await promise;
  }

  // The operator's own worked example: 255 (max) encodes as 02 55 —
  // hundreds-digit nibble (2) + a 2-digit BCD byte (55) — the same
  // packing already hardware-confirmed for S-meter/TX power/RX gain.
  await expectSet('setAfOutputLevelUsb', AF_OUTPUT_LEVEL_USB_PARAM_BYTES, 255, [0x02, 0x55]);
  await expectSet('setModInputLevelUsb', MOD_INPUT_LEVEL_USB_PARAM_BYTES, 255, [0x02, 0x55]);
  // A default call with no argument should behave identically to an
  // explicit 255 — this is what src/server/index.js's startup call relies on.
  await expectSet('setAfOutputLevelUsb', AF_OUTPUT_LEVEL_USB_PARAM_BYTES, undefined, [0x02, 0x55]);
  // A mid-range value exercises the encoding beyond just the one given example.
  await expectSet('setModInputLevelUsb', MOD_INPUT_LEVEL_USB_PARAM_BYTES, 128, [0x01, 0x28]);

  async function expectGet(methodName, paramBytes, replyValueBytes, expectedValue) {
    const promise = driver[methodName]();
    await new Promise((resolve) => setImmediate(resolve));
    const lastFrame = [...transport.written[transport.written.length - 1]];
    const isBareParamRead =
      lastFrame.length === 9 &&
      lastFrame[4] === CMD.OPTIONAL &&
      lastFrame[5] === OPTIONAL_SUBCMD.DATA_MODE &&
      lastFrame[6] === paramBytes[0] &&
      lastFrame[7] === paramBytes[1];
    check(isBareParamRead, `${methodName}() reads with just the 2-byte parameter number, got [${lastFrame.join(',')}]`);
    transport.sendFrame({
      cmd: CMD.OPTIONAL,
      subCmd: OPTIONAL_SUBCMD.DATA_MODE,
      data: Buffer.from([...paramBytes, ...replyValueBytes]),
    });
    const value = await promise;
    check(value === expectedValue, `${methodName}() decodes the echoed [param, param, valueHi, valueLo] reply, got ${value}`);
  }

  await expectGet('getAfOutputLevelUsb', AF_OUTPUT_LEVEL_USB_PARAM_BYTES, [0x02, 0x55], 255);
  await expectGet('getModInputLevelUsb', MOD_INPUT_LEVEL_USB_PARAM_BYTES, [0x00, 0x00], 0);

  // Same "throw rather than misread" rule as DATA MODE's own short-reply test.
  const shortPromise = driver.getAfOutputLevelUsb();
  shortPromise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({
    cmd: CMD.OPTIONAL,
    subCmd: OPTIONAL_SUBCMD.DATA_MODE,
    data: Buffer.from([...AF_OUTPUT_LEVEL_USB_PARAM_BYTES, 0x02]),
  });
  let threwOnShortReply = false;
  try {
    await shortPromise;
  } catch {
    threwOnShortReply = true;
  }
  check(threwOnShortReply, 'getAfOutputLevelUsb() throws on an unexpectedly short (3-byte) reply rather than misreading it');

  await driver.close();
}

async function testTuneScopeToRange() {
  console.log('\n-- tuneScopeToRange() sets Center mode then an appropriately-clamped span --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  const tunePromise = driver.tuneScopeToRange(7000000, 7300000); // 40m, 300kHz wide
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK }); // reply to setScopeMode
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK }); // reply to setScopeSpan
  const applied = await tunePromise;

  check(applied === 500000, '300kHz-wide range clamps up to the 500kHz preset (next one covering it)');

  const writtenFrames = transport.written.map((buf) => [...buf]);
  check(
    // Mode data is 2 bytes: [0x00, modeValue] — see setScopeMode's doc comment.
    writtenFrames.some((f) => f[4] === CMD.SCOPE && f[5] === SCOPE_SUBCMD.MODE && f[6] === 0x00 && f[7] === SCOPE_MODE.CENTER),
    'tuneScopeToRange() sets scope mode to Center (2-byte payload: 0x00 prefix + mode value)'
  );
  check(
    writtenFrames.some((f) => f[4] === CMD.SCOPE && f[5] === SCOPE_SUBCMD.SPAN),
    'tuneScopeToRange() sets the scope span'
  );

  await driver.close();
}

async function testCenterScope() {
  console.log('\n-- centerScope() sets Center mode + a fixed span, no target range needed --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  const centerPromise = driver.centerScope(100000);
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK }); // reply to setScopeMode
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK }); // reply to setScopeSpan
  const applied = await centerPromise;

  check(applied === 100000, 'centerScope(100000) applies exactly 100kHz (an official preset)');

  const writtenFrames = transport.written.map((buf) => [...buf]);
  check(
    writtenFrames.some((f) => f[4] === CMD.SCOPE && f[5] === SCOPE_SUBCMD.MODE && f[6] === 0x00 && f[7] === SCOPE_MODE.CENTER),
    'centerScope() sets scope mode to Center'
  );
  check(
    writtenFrames.some((f) => f[4] === CMD.SCOPE && f[5] === SCOPE_SUBCMD.SPAN),
    'centerScope() sets the scope span'
  );

  await driver.close();
}

async function testCenterScopeDefaultSpan() {
  console.log('\n-- centerScope() defaults to 100kHz when called with no argument --');
  const transport = new FakeTransport();
  const driver = new CivDriver({ path: '/fake', radioAddr: RADIO_ADDR, transport });
  await driver.open();

  const centerPromise = driver.centerScope();
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK });
  await new Promise((resolve) => setImmediate(resolve));
  transport.sendFrame({ cmd: CMD.OK });
  const applied = await centerPromise;

  check(applied === 100000, 'centerScope() with no argument defaults to exactly 100kHz (an official preset)');

  await driver.close();
}

async function run() {
  await testBasicRequestReply();
  await testFilter();
  await testSetModeEmitsModeEvent();
  await testTxPower();
  await testRxGain();
  await testCwPitch();
  await testGetSMeter();
  await testGetSWR();
  await testSubCmdDisambiguation();
  await testEnableScopeOutputAndFullLine();
  await testScopeSpanClamping();
  await testScopeSpanWireFormat();
  await testGetScopeSpan();
  await testGetScopeSpanUnsupportedReply();
  await testFunctionToggles();
  await testSetTuner();
  await testFunctionAndTunerGetters();
  await testDataMode();
  await testUsbAudioLevels();
  await testTuneScopeToRange();
  await testCenterScope();
  await testCenterScopeDefaultSpan();

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
