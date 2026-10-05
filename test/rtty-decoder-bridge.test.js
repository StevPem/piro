// Run with: node test/rtty-decoder-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { RttyDecoderBridge } = require('../src/server/rtty-decoder-bridge');
const { EVENT } = require('../src/server/protocol');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

class StubCiv extends EventEmitter {
  constructor(initialMode = 'USB') {
    super();
    this._mode = initialMode;
  }
  async getMode() {
    return { mode: this._mode, filter: 1 };
  }
}

class StubControlServer extends EventEmitter {
  constructor() {
    super();
    this.broadcasts = [];
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
}

class StubDecoder extends EventEmitter {
  constructor() {
    super();
    this.resetCalls = 0;
    this.reversed = false;
    this.setReversedCalls = [];
  }
  reset() {
    this.resetCalls++;
  }
  setReversed(value) {
    this.reversed = value;
    this.setReversedCalls.push(value);
  }
  pushSamples() {
    // not exercised here — the real decoder's own DSP is covered by
    // test/rtty-decoder.test.js; this test is only about the bridge's
    // wiring/attachment logic
  }
}

class StubCapture extends EventEmitter {}

function makeStubAudioBridge() {
  return { capture: new StubCapture(), sampleRate: 48000 };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  // --- constructor validation ---
  {
    let threw = false;
    try {
      new RttyDecoderBridge({});
    } catch {
      threw = true;
    }
    check(threw, 'constructor throws without opts.civ');
  }

  // --- start() picks up an already-RTTY mode and attaches immediately ---
  {
    const civ = new StubCiv('RTTY');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    check(audioBridge.capture.listenerCount('data') === 1, 'start() attaches to the PCM stream immediately if the radio is already in RTTY mode');
    bridge.stop();
  }

  // --- start() does NOT attach if mode isn't RTTY ---
  {
    const civ = new StubCiv('USB');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    check(audioBridge.capture.listenerCount('data') === 0, 'start() does not attach to the PCM stream when the radio is not in RTTY mode');
    bridge.stop();
  }

  // --- Mode change to RTTY attaches and resets the decoder ---
  {
    const civ = new StubCiv('USB');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    civ.emit('mode', { mode: 'RTTY', filter: 1 });
    await flush();
    check(audioBridge.capture.listenerCount('data') === 1, 'switching mode to RTTY attaches to the PCM stream');
    check(decoder.resetCalls === 1, "switching mode to RTTY resets the decoder's prior state");
    bridge.stop();
  }

  // --- Staying in RTTY mode (a re-fired 'mode' event with the same mode) does not reset the decoder again ---
  {
    const civ = new StubCiv('RTTY');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    check(decoder.resetCalls === 1, 'sanity: entering RTTY mode reset the decoder exactly once');
    civ.emit('mode', { mode: 'RTTY', filter: 2 }); // e.g. a filter-only change, still RTTY
    check(decoder.resetCalls === 1, "a 'mode' event that doesn't actually change mode away-then-back doesn't reset the decoder again");
    bridge.stop();
  }

  // --- Mode change away from RTTY detaches ---
  {
    const civ = new StubCiv('RTTY');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    civ.emit('mode', { mode: 'USB', filter: 1 });
    check(audioBridge.capture.listenerCount('data') === 0, 'switching mode away from RTTY detaches from the PCM stream');
    bridge.stop();
  }

  // --- PTT engaging pauses decoding; releasing resumes it ---
  {
    const civ = new StubCiv('RTTY');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    check(audioBridge.capture.listenerCount('data') === 1, 'sanity: attached before PTT test begins');

    controlServer.emit('ptt', true);
    check(audioBridge.capture.listenerCount('data') === 0, 'engaging PTT detaches from the PCM stream (nothing useful to decode in our own TX)');

    controlServer.emit('ptt', false);
    check(audioBridge.capture.listenerCount('data') === 1, 'releasing PTT re-attaches to the PCM stream (still in RTTY mode)');
    bridge.stop();
  }

  // --- PTT engaging while NOT in RTTY mode has no effect (nothing attached either way) ---
  {
    const civ = new StubCiv('USB');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    controlServer.emit('ptt', true);
    controlServer.emit('ptt', false);
    check(audioBridge.capture.listenerCount('data') === 0, 'PTT toggling while not in RTTY mode never attaches to the PCM stream');
    bridge.stop();
  }

  // --- Decoded characters broadcast as EVENT.RTTY_TEXT ---
  {
    const civ = new StubCiv('RTTY');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    decoder.emit('char', 'C');
    decoder.emit('char', 'Q');
    decoder.emit('char', ' ');
    check(
      controlServer.broadcasts.length === 3 &&
        controlServer.broadcasts[0].type === EVENT.RTTY_TEXT &&
        controlServer.broadcasts[0].data.text === 'C' &&
        controlServer.broadcasts[1].data.text === 'Q' &&
        controlServer.broadcasts[2].data.text === ' ',
      `each decoded character broadcasts as a separate EVENT.RTTY_TEXT, got ${JSON.stringify(controlServer.broadcasts)}`
    );
    bridge.stop();
  }

  // --- 'rtty-reversed' event calls decoder.setReversed() and resets stale decode state ---
  {
    const civ = new StubCiv('RTTY');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    check(decoder.resetCalls === 1, 'sanity: entering RTTY mode reset the decoder exactly once so far');

    controlServer.emit('rtty-reversed', true);
    check(
      decoder.setReversedCalls.length === 1 && decoder.setReversedCalls[0] === true,
      "the 'rtty-reversed' event calls decoder.setReversed() with the new value"
    );
    check(
      decoder.resetCalls === 2,
      'toggling reversed also resets the decoder — clears any in-progress frame/bit-sync state built up under the old polarity assumption'
    );

    controlServer.emit('rtty-reversed', false);
    check(
      decoder.setReversedCalls.length === 2 && decoder.setReversedCalls[1] === false,
      'toggling back to non-reversed calls setReversed(false)'
    );
    check(decoder.resetCalls === 3, 'toggling back also resets the decoder again');

    bridge.stop();
  }

  // --- constructor picks up controlServer.state.rttyReversed as the decoder's initial polarity ---
  {
    const civ = new StubCiv('USB');
    const controlServer = new StubControlServer();
    controlServer.state = { rttyReversed: true };
    const audioBridge = makeStubAudioBridge();
    // No `decoder` override here — this exercises the bridge's own default
    // RttyDecoder construction (the only place `controlServer.state` is
    // actually read), not the StubDecoder.
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge });
    check(
      bridge.decoder.reversed === true,
      'a freshly-constructed RttyDecoder starts reversed when controlServer.state.rttyReversed was already true (e.g. after a server restart with a saved setting)'
    );
    bridge.stop();
  }

  // --- constructor doesn't crash when controlServer.state is absent (e.g. a bare test stub) ---
  {
    const civ = new StubCiv('USB');
    const controlServer = new StubControlServer(); // no .state at all
    const audioBridge = makeStubAudioBridge();
    let threw = false;
    let bridge;
    try {
      bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge });
    } catch {
      threw = true;
    }
    check(!threw, 'constructing without controlServer.state does not throw — defaults to non-reversed');
    if (bridge) {
      check(bridge.decoder.reversed === false, 'defaults to non-reversed when controlServer.state is absent');
      bridge.stop();
    }
  }

  // --- stop() fully detaches and removes all listeners ---
  {
    const civ = new StubCiv('RTTY');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new RttyDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    bridge.stop();
    check(audioBridge.capture.listenerCount('data') === 0, 'stop() detaches from the PCM stream');
    check(civ.listenerCount('mode') === 0, 'stop() removes the mode-change listener from civ');
    check(controlServer.listenerCount('ptt') === 0, 'stop() removes the ptt listener from controlServer');
    check(controlServer.listenerCount('rtty-reversed') === 0, 'stop() removes the rtty-reversed listener from controlServer');
    check(decoder.listenerCount('char') === 0, "stop() removes this bridge's listener from the decoder");

    // Mode/PTT changes after stop() should have no further effect.
    civ.emit('mode', { mode: 'RTTY', filter: 1 });
    controlServer.emit('ptt', false);
    check(audioBridge.capture.listenerCount('data') === 0, 'events after stop() are correctly ignored (bridge is fully detached)');
  }

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
