// Run with: node test/cw-decoder-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { CwDecoderBridge } = require('../src/server/cw-decoder-bridge');
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
    this._pitch = 600;
    this._pitchError = null; // set to an Error to simulate a failed getCwPitch() read
  }
  async getMode() {
    return { mode: this._mode, filter: 1 };
  }
  async getCwPitch() {
    if (this._pitchError) throw this._pitchError;
    return this._pitch;
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
    this.pitchesSet = [];
  }
  reset() {
    this.resetCalls++;
  }
  setPitch(hz) {
    this.pitchesSet.push(hz);
  }
  pushSamples() {
    // not exercised here — the real decoder's own DSP is covered by
    // test/cw-decoder.test.js; this test is only about the bridge's
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
  // --- start() picks up an already-CW mode and attaches immediately ---
  {
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    check(audioBridge.capture.listenerCount('data') === 1, 'start() attaches to the PCM stream immediately if the radio is already in CW mode');
    check(decoder.pitchesSet.length === 1 && decoder.pitchesSet[0] === 600, 'start() reads the radio\'s current CW pitch and applies it');
    bridge.stop();
  }

  // --- start() does NOT attach if mode isn't CW ---
  {
    const civ = new StubCiv('USB');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    check(audioBridge.capture.listenerCount('data') === 0, 'start() does not attach to the PCM stream when the radio is not in CW mode');
    bridge.stop();
  }

  // --- Mode change to CW attaches, resets the decoder, and refreshes pitch ---
  {
    const civ = new StubCiv('USB');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    civ._pitch = 700;
    civ.emit('mode', { mode: 'CW', filter: 1 });
    await flush();
    check(audioBridge.capture.listenerCount('data') === 1, 'switching mode to CW attaches to the PCM stream');
    check(decoder.resetCalls === 1, 'switching mode to CW resets the decoder\'s prior state');
    check(decoder.pitchesSet.includes(700), 'switching mode to CW refreshes the pitch from the radio, picking up the new value');
    bridge.stop();
  }

  // --- Mode change away from CW detaches ---
  {
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    civ.emit('mode', { mode: 'USB', filter: 1 });
    check(audioBridge.capture.listenerCount('data') === 0, 'switching mode away from CW detaches from the PCM stream');
    bridge.stop();
  }

  // --- PTT engaging pauses decoding; releasing resumes it ---
  {
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    check(audioBridge.capture.listenerCount('data') === 1, 'sanity: attached before PTT test begins');

    controlServer.emit('ptt', true);
    check(audioBridge.capture.listenerCount('data') === 0, 'engaging PTT detaches from the PCM stream (nothing useful to decode in our own TX)');

    controlServer.emit('ptt', false);
    check(audioBridge.capture.listenerCount('data') === 1, 'releasing PTT re-attaches to the PCM stream (still in CW mode)');
    bridge.stop();
  }

  // --- PTT engaging while NOT in CW mode has no effect (nothing attached either way) ---
  {
    const civ = new StubCiv('USB');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    controlServer.emit('ptt', true);
    controlServer.emit('ptt', false);
    check(audioBridge.capture.listenerCount('data') === 0, 'PTT toggling while not in CW mode never attaches to the PCM stream');
    bridge.stop();
  }

  // --- Decoded characters/spaces broadcast as EVENT.CW_TEXT ---
  {
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    decoder.emit('char', 'E');
    decoder.emit('char', 'S');
    decoder.emit('space');
    check(
      controlServer.broadcasts.length === 3 &&
        controlServer.broadcasts[0].type === EVENT.CW_TEXT &&
        controlServer.broadcasts[0].data.text === 'E' &&
        controlServer.broadcasts[1].data.text === 'S' &&
        controlServer.broadcasts[2].data.text === ' ',
      `each decoded character/space broadcasts as a separate EVENT.CW_TEXT, got ${JSON.stringify(controlServer.broadcasts)}`
    );
    bridge.stop();
  }

  // --- CW1/CW2 variant switching ---
  {
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder1 = new StubDecoder();
    const decoder2 = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder: decoder1, decoder2 });
    await bridge.start();
    await flush();

    check(bridge.variant === 'CW1', 'defaults to the CW1 variant');
    check(bridge.decoder === decoder1, 'the "decoder" getter returns the active (CW1) decoder by default');

    decoder1.emit('char', 'E');
    decoder2.emit('char', 'X'); // the inactive decoder's output must never reach the ticker
    check(
      controlServer.broadcasts.length === 1 && controlServer.broadcasts[0].data.text === 'E',
      `only the active decoder's output is broadcast, got ${JSON.stringify(controlServer.broadcasts)}`
    );

    const decoder1ResetCallsBeforeSwitch = decoder1.resetCalls; // start() already reset it once, entering CW mode
    controlServer.emit('cw-decoder-variant', 'CW2');
    check(bridge.variant === 'CW2', 'emitting cw-decoder-variant switches the active variant');
    check(bridge.decoder === decoder2, 'the "decoder" getter now returns CW2');
    check(decoder2.resetCalls === 1, 'switching variant resets the newly-active decoder');
    check(
      decoder1.resetCalls === decoder1ResetCallsBeforeSwitch,
      'switching variant does not reset the decoder being switched away from'
    );

    controlServer.broadcasts.length = 0;
    decoder1.emit('char', 'E'); // now inactive
    decoder2.emit('char', 'X');
    check(
      controlServer.broadcasts.length === 1 && controlServer.broadcasts[0].data.text === 'X',
      `after switching, only CW2's output is broadcast, got ${JSON.stringify(controlServer.broadcasts)}`
    );

    bridge.stop();
    check(
      decoder1.listenerCount('char') === 0 && decoder2.listenerCount('char') === 0,
      'stop() removes this bridge\'s listeners from BOTH decoders'
    );
  }

  // --- A real (non-stub) HamfistCwDecoder is used for CW2 by default ---
  {
    const { HamfistCwDecoder } = require('../src/audio/hamfist-cw-decoder');
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder1 = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder: decoder1 });
    check(bridge.decoders.CW2 instanceof HamfistCwDecoder, 'CW2 defaults to a real HamfistCwDecoder when not injected');
    bridge.stop();
  }

  // --- A real (non-stub) DeepCwDecoder is used for CW3 by default ---
  {
    const { DeepCwDecoder } = require('../src/audio/deepcw-decoder');
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder1 = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder: decoder1 });
    check(bridge.decoders.CW3 instanceof DeepCwDecoder, 'CW3 defaults to a real DeepCwDecoder when not injected');
    // Swallow the model-loading promise's rejection/resolution noise —
    // this test only cares about which class got instantiated, not
    // whether the ONNX model actually loads in this environment.
    bridge.decoders.CW3._ready.catch(() => {});
    bridge.stop();
  }

  // --- Three-way variant cycling (CW1 -> CW2 -> CW3 -> CW1), including CW3 ---
  {
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder1 = new StubDecoder();
    const decoder2 = new StubDecoder();
    const decoder3 = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder: decoder1, decoder2, decoder3 });
    await bridge.start();
    await flush();

    check(bridge.variant === 'CW1', 'cycling test starts at CW1');

    controlServer.emit('cw-decoder-variant', 'CW2');
    check(bridge.variant === 'CW2', 'cycling: CW1 -> CW2');

    controlServer.emit('cw-decoder-variant', 'CW3');
    check(bridge.variant === 'CW3', 'cycling: CW2 -> CW3');
    check(bridge.decoder === decoder3, 'the "decoder" getter now returns CW3');
    check(decoder3.resetCalls === 1, 'switching to CW3 resets it');

    controlServer.broadcasts.length = 0;
    decoder1.emit('char', 'E');
    decoder2.emit('char', 'X');
    decoder3.emit('char', 'Y');
    check(
      controlServer.broadcasts.length === 1 && controlServer.broadcasts[0].data.text === 'Y',
      `while CW3 is active, only its output is broadcast, got ${JSON.stringify(controlServer.broadcasts)}`
    );

    controlServer.emit('cw-decoder-variant', 'CW1');
    check(bridge.variant === 'CW1', 'cycling: CW3 -> CW1');

    // Invalid variant is ignored rather than crashing or clearing state.
    controlServer.emit('cw-decoder-variant', 'bogus');
    check(bridge.variant === 'CW1', 'an unrecognized variant is ignored, leaving the active variant unchanged');

    bridge.stop();
    check(
      decoder3.listenerCount('char') === 0 && decoder3.listenerCount('error') === 0,
      'stop() removes this bridge\'s listeners from CW3 too, including its error listener'
    );
  }

  // --- CW3's 'error' event broadcasts AUDIO_ERROR only while CW3 is active ---
  {
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder1 = new StubDecoder();
    const decoder3 = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder: decoder1, decoder3 });
    await bridge.start();
    await flush();

    decoder3.emit('error', new Error('no onnxruntime-node binary for this platform'));
    check(controlServer.broadcasts.length === 0, 'CW3 errors are not broadcast while CW3 is inactive');

    controlServer.emit('cw-decoder-variant', 'CW3');
    controlServer.broadcasts.length = 0;
    decoder3.emit('error', new Error('no onnxruntime-node binary for this platform'));
    check(
      controlServer.broadcasts.length === 1 &&
        controlServer.broadcasts[0].type === EVENT.AUDIO_ERROR &&
        controlServer.broadcasts[0].data.message.includes('CW3 decoder') &&
        controlServer.broadcasts[0].data.message.includes('no onnxruntime-node binary'),
      `CW3's error is broadcast as EVENT.AUDIO_ERROR while it's active, got ${JSON.stringify(controlServer.broadcasts)}`
    );

    bridge.stop();
  }

  // --- stop() fully detaches and removes all listeners ---
  {
    const civ = new StubCiv('CW');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    check(decoder.listenerCount('pitch') === 1, 'sanity: the bridge is listening for the decoder\'s own pitch-calibration event');
    bridge.stop();
    check(audioBridge.capture.listenerCount('data') === 0, 'stop() detaches from the PCM stream');
    check(civ.listenerCount('mode') === 0, 'stop() removes the mode-change listener from civ');
    check(controlServer.listenerCount('ptt') === 0, 'stop() removes the ptt listener from controlServer');
    check(decoder.listenerCount('char') === 0 && decoder.listenerCount('space') === 0, 'stop() removes this bridge\'s listeners from the decoder');
    check(decoder.listenerCount('pitch') === 0, 'stop() removes the pitch-calibration listener from the decoder too');

    // Mode/PTT changes after stop() should have no further effect.
    civ.emit('mode', { mode: 'CW', filter: 1 });
    controlServer.emit('ptt', false);
    check(audioBridge.capture.listenerCount('data') === 0, 'events after stop() are correctly ignored (bridge is fully detached)');
  }

  // --- A failed CW-pitch read is surfaced, not silently swallowed ---
  // (Regression test: a real user recording completely failed to decode
  // with no visible error anywhere, root-caused to exactly this —
  // see cw-decoder.js's autoCalibratePitch doc comment and
  // docs/ui-notes.md for the full story.)
  {
    const civ = new StubCiv('CW');
    civ._pitchError = new Error('CI-V timeout');
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const decoder = new StubDecoder();
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge, decoder });
    await bridge.start();
    await flush();
    const errEvents = controlServer.broadcasts.filter((b) => b.type === EVENT.RIG_ERROR);
    check(
      errEvents.length === 1 && /CI-V timeout/.test(errEvents[0].data.message),
      `a failed getCwPitch() read broadcasts a RIG_ERROR naming the underlying failure instead of failing silently, got ${JSON.stringify(controlServer.broadcasts)}`
    );
    check(decoder.pitchesSet.length === 0, 'the decoder keeps whatever pitch it already had when the read fails, rather than being set to something bogus');
    bridge.stop();
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
