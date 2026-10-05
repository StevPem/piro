'use strict';

// Run with: node test/audio-bridge.test.js
// Exercises the full RX (radio->clients) and TX (client->radio) audio
// paths over a real WebSocket connection, for both the default 'pcm'
// codec and the legacy 'opus' codec, with fake ALSA capture/playback
// standing in for arecord/aplay so this needs no sound hardware.

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { ControlServer } = require('../src/server/ws-server');
const { AudioBridge } = require('../src/server/audio-bridge');
const { OpusCodec } = require('../src/audio/opus-codec');
const { BINARY_TYPE, EVENT } = require('../src/server/protocol');

class StubCivDriver extends EventEmitter {
  constructor() {
    super();
    this.radioAddr = 0x94;
  }
}

class FakeCapture extends EventEmitter {
  start() {}
  stop() {}
}

class FakePlayback extends EventEmitter {
  constructor() {
    super();
    this.written = [];
  }
  start() {}
  write(buf) {
    this.written.push(buf);
  }
  stop() {}
}

// Same race-avoidance pattern as ws-server.test.js: attach the message
// listener synchronously at connect time, queue anything received before
// nextMessage() consumes it.
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws._queue = [];
    ws._waiters = [];
    ws.on('message', (raw, isBinary) => {
      const item = isBinary
        ? { isBinary: true, data: raw }
        : { isBinary: false, data: JSON.parse(raw.toString()) };
      if (ws._waiters.length) ws._waiters.shift()(item);
      else ws._queue.push(item);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws) {
  if (ws._queue.length) return Promise.resolve(ws._queue.shift());
  return new Promise((resolve) => ws._waiters.push(resolve));
}

// Lets the microtask queue (and any pending setImmediate-scheduled work)
// settle before asserting on side effects of a synchronous emit() call.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sineFrame(samplesPerFrame, freq = 440, sampleRate = 48000, amplitude = 8000) {
  const buf = Buffer.alloc(samplesPerFrame * 2);
  for (let i = 0; i < samplesPerFrame; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  return buf;
}

/** Every binary frame carries a 1-byte BINARY_TYPE tag as its first byte (see protocol.js). */
function tagAudio(payload) {
  return Buffer.concat([Buffer.from([BINARY_TYPE.AUDIO]), payload]);
}

/**
 * A stub RnnoiseFilter — good enough to exercise AudioBridge's own
 * RNNoise wiring (start/stop lifecycle, write() calls, 'data'/'error'
 * propagation) without a real rnnoise_demo binary. Not a stream — write()
 * just records what it was given; a test drives the "filtered result"
 * back out by calling emit('data', ...) itself, same as the real
 * RnnoiseFilter would once the real child process actually produces
 * output.
 */
class StubRnnoiseFilter extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.started = false;
    this.stopped = false;
    this.written = [];
  }
  start() {
    this.started = true;
  }
  write(chunk) {
    this.written.push(chunk);
  }
  stop() {
    this.stopped = true;
  }
}

/** Returns an rnnoiseFilterFactory (for AudioBridge's opts.rnnoiseFilterFactory) that records every StubRnnoiseFilter it creates. */
function makeRnnoiseFilterFactory() {
  const created = [];
  const factory = (opts) => {
    const filter = new StubRnnoiseFilter(opts);
    created.push(filter);
    return filter;
  };
  factory.created = created;
  return factory;
}

/** Same role as StubRnnoiseFilter, for HamnoiseFilter (see ../src/audio/hamnoise-filter.js) — a stand-in good enough to exercise AudioBridge's wiring (start/stop lifecycle, write() calls, 'data'/'error' propagation, setModel() calls for mode-aware switching) without the real WASM engines. */
class StubHamnoiseFilter extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.started = false;
    this.stopped = false;
    this.written = [];
    this.modelCalls = [];
    // When set, the matching method throws synchronously instead of its
    // normal behavior — for exercising AudioBridge's own try/catch guards
    // around these calls (see audio-bridge.js's _stopHamNoiseFilterSafely(),
    // _writeHamNoiseFilterSafely(), and _handleCivModeChange()'s own
    // try/catch), which stand in for a real WASM-boundary throw from
    // hamnoise-filter.js that this stub can't itself produce.
    this.throwOn = {};
  }
  start() {
    this.started = true;
  }
  write(chunk) {
    if (this.throwOn.write) throw new Error(this.throwOn.write);
    this.written.push(chunk);
  }
  setModel(target) {
    if (this.throwOn.setModel) throw new Error(this.throwOn.setModel);
    this.modelCalls.push(target);
  }
  stop() {
    if (this.throwOn.stop) throw new Error(this.throwOn.stop);
    this.stopped = true;
  }
}

/** Returns a hamnoiseFilterFactory (for AudioBridge's opts.hamnoiseFilterFactory) that records every StubHamnoiseFilter it creates. */
function makeHamnoiseFilterFactory() {
  const created = [];
  const factory = (opts) => {
    const filter = new StubHamnoiseFilter(opts);
    created.push(filter);
    return filter;
  };
  factory.created = created;
  return factory;
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

async function testPcmMode() {
  console.log('\n-- pcm mode (default) --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const bridge = new AudioBridge({ controlServer: server, capture, playback, codecType: 'pcm' });
  bridge.start();

  const client = await connect(port);
  const hello = await nextMessage(client);
  check(!hello.isBinary && hello.data.type === 'connected', 'client connects and gets the control-layer hello');

  // --- RX path: fake radio audio -> broadcast, tagged, byte-for-byte, no framing/codec ---
  const rxChunk = sineFrame(500); // arbitrary size — pcm mode doesn't require frame alignment
  capture.emit('data', rxChunk);
  const rxMsg = await nextMessage(client);
  check(rxMsg.isBinary === true, 'RX audio arrives at the client as a binary WebSocket frame');
  check(rxMsg.data[0] === BINARY_TYPE.AUDIO, 'RX audio frame is tagged as BINARY_TYPE.AUDIO');
  check(
    Buffer.compare(rxMsg.data.subarray(1), rxChunk) === 0,
    'RX audio (after the tag byte) arrives byte-for-byte identical (no encoding)'
  );

  // Odd-sized, non-frame-aligned chunk — should still pass straight through.
  const oddChunk = Buffer.from([1, 2, 3, 4, 5]);
  capture.emit('data', oddChunk);
  const rxMsg2 = await nextMessage(client);
  check(Buffer.compare(rxMsg2.data.subarray(1), oddChunk) === 0, 'arbitrary-sized RX chunks pass through unmodified');

  // --- TX path: client sends tagged raw PCM -> written straight to playback (tag stripped) ---
  const txChunk = sineFrame(500, 220);
  client.send(tagAudio(txChunk));
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(playback.written.length === 1, 'TX audio from the client reaches the (fake) playback device');
  check(
    playback.written[0] && Buffer.compare(playback.written[0], txChunk) === 0,
    'TX PCM written to playback is byte-for-byte identical to what the client sent (tag stripped)'
  );

  bridge.stop();
  client.close();
  await server.close();
}

/**
 * setRxMuted()/setTxMuted() — added for RadeBridge (see rade-bridge.js),
 * which needs to substitute its own decoded/encoded audio for this
 * class's default passthrough rather than just observing it the way
 * CW/RTTY/FT8's RX decoders do. Only the 'pcm' codec path is exercised
 * here (opus mode is legacy/unused by the current client — see this
 * class's own doc comment — and the mute checks are the same one-line
 * gate in both branches).
 */
async function testMuting() {
  console.log('\n-- setRxMuted()/setTxMuted() --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const bridge = new AudioBridge({ controlServer: server, capture, playback, codecType: 'pcm' });
  bridge.start();

  const client = await connect(port);
  await nextMessage(client); // hello

  // --- RX muted: raw capture audio does NOT reach the client ---
  bridge.setRxMuted(true);
  capture.emit('data', sineFrame(500));
  // Prove silence by racing a second, unmuted chunk behind it — if the
  // first (muted) chunk had gone out, it would arrive before this one.
  bridge.setRxMuted(false);
  const marker = sineFrame(50, 999);
  capture.emit('data', marker);
  const onlyMsg = await nextMessage(client);
  check(Buffer.compare(onlyMsg.data.subarray(1), marker) === 0, 'while setRxMuted(true), a captured chunk never reaches the client at all (the next unmuted chunk is the first thing received)');

  // --- RX unmuted again: normal passthrough resumes ---
  const rxChunk = sineFrame(500);
  capture.emit('data', rxChunk);
  const rxMsg = await nextMessage(client);
  check(Buffer.compare(rxMsg.data.subarray(1), rxChunk) === 0, 'setRxMuted(false) restores normal RX passthrough');

  // --- TX muted: a client's mic audio does NOT reach playback ---
  bridge.setTxMuted(true);
  client.send(tagAudio(sineFrame(500, 220)));
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(playback.written.length === 0, 'while setTxMuted(true), TX audio from the client never reaches playback');

  // --- TX unmuted again: normal passthrough resumes ---
  bridge.setTxMuted(false);
  const txChunk = sineFrame(500, 220);
  client.send(tagAudio(txChunk));
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(playback.written.length === 1 && Buffer.compare(playback.written[0], txChunk) === 0, 'setTxMuted(false) restores normal TX passthrough');

  bridge.stop();
  client.close();
  await server.close();
}

/**
 * RNNoise's single most important correctness property (see
 * audio-bridge.js's own doc comment): whatever CW/RTTY/FT8/RADE's own
 * independent listeners see on `capture`'s raw 'data' event must be
 * COMPLETELY UNCHANGED — byte-identical — regardless of whether RNNoise
 * is enabled or disabled. Filtering only ever happens on the SEPARATE
 * broadcast/'rx-pcm' path. This test simulates one of those external
 * decoders as a second, totally independent 'data' listener on the same
 * `capture` object AudioBridge itself listens on.
 */
async function testRnnoise() {
  console.log('\n-- RNNoise 5-state level (setRnnoiseLevel) --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const rnnoiseFilterFactory = makeRnnoiseFilterFactory();
  const bridge = new AudioBridge({
    controlServer: server,
    capture,
    playback,
    codecType: 'pcm',
    rnnoiseBin: 'rnnoise_demo',
    rnnoiseFilterFactory,
  });
  bridge.start();

  const client = await connect(port);
  await nextMessage(client); // hello

  // A stand-in for CW/RTTY/FT8/RADE's own independent tap on the SAME
  // raw capture stream — registered completely separately from anything
  // AudioBridge itself does internally.
  const externalDecoderChunks = [];
  capture.on('data', (chunk) => externalDecoderChunks.push(chunk));

  const rxPcmEvents = [];
  bridge.on('rx-pcm', (chunk) => rxPcmEvents.push(chunk));

  // --- disabled by default: no filter spawned, raw chunk broadcast as-is ---
  check(rnnoiseFilterFactory.created.length === 0, 'no RnnoiseFilter is spawned until the toggle is actually switched on (lazy)');
  const rawChunk1 = sineFrame(200);
  capture.emit('data', rawChunk1);
  const rxMsg1 = await nextMessage(client);
  check(Buffer.compare(rxMsg1.data.subarray(1), rawChunk1) === 0, 'RNNoise disabled: the raw chunk is broadcast to clients unmodified');
  check(rxPcmEvents.length === 1 && rxPcmEvents[0] === rawChunk1, "RNNoise disabled: 'rx-pcm' is emitted with the exact same raw chunk");
  check(
    externalDecoderChunks.length === 1 && externalDecoderChunks[0] === rawChunk1,
    "REGRESSION GUARD: an independent capture 'data' listener (standing in for CW/RTTY/FT8/RADE) sees the exact same unmodified chunk — RNNoise's own machinery never touches the raw capture event at all"
  );

  // --- level 1 ("RNN 1"): lazily spawns the filter, routes subsequent chunks through it instead of broadcasting them directly ---
  bridge.setRnnoiseLevel(1);
  check(rnnoiseFilterFactory.created.length === 1, 'setRnnoiseLevel(1) lazily spawns exactly one RnnoiseFilter');
  const filter = rnnoiseFilterFactory.created[0];
  check(filter.opts.bin === 'rnnoise_demo', 'the filter is constructed with the configured rnnoiseBin');
  check(filter.opts.wet === 0.25, 'level 1 ("RNN 1") is constructed with a wet ratio of 0.25 (25% denoised / 75% original)');
  check(filter.started === true, 'setRnnoiseLevel(1) starts the filter');

  const rawChunk2 = sineFrame(200, 300);
  capture.emit('data', rawChunk2);
  await flush();
  check(filter.written.length === 1 && filter.written[0] === rawChunk2, 'while enabled, each captured chunk is written into the filter, not broadcast directly');
  check(
    externalDecoderChunks.length === 2 && externalDecoderChunks[1] === rawChunk2,
    "REGRESSION GUARD: the independent capture 'data' listener STILL sees the raw, unfiltered chunk even while RNNoise is enabled and actively routing the broadcast path through the filter"
  );

  // Simulate the filter producing filtered output — this is what actually gets broadcast/emitted while enabled.
  const filteredChunk = sineFrame(200, 300, 48000, 4000); // stand-in for "the same audio, denoised"
  filter.emit('data', filteredChunk);
  const rxMsg2 = await nextMessage(client);
  check(Buffer.compare(rxMsg2.data.subarray(1), filteredChunk) === 0, "RNNoise enabled: the FILTERED chunk (not the original raw one) is what's broadcast to clients");
  check(
    rxPcmEvents.length === 2 && rxPcmEvents[1] === filteredChunk,
    "RNNoise enabled: 'rx-pcm' is emitted with the filtered chunk, so server-side listeners hear exactly what the operator hears"
  );

  // --- back to level 0 ("RNN Off"): filter is stopped, raw passthrough resumes ---
  bridge.setRnnoiseLevel(0);
  check(filter.stopped === true, 'setRnnoiseLevel(0) stops the filter');
  const rawChunk3 = sineFrame(200, 400);
  capture.emit('data', rawChunk3);
  const rxMsg3 = await nextMessage(client);
  check(Buffer.compare(rxMsg3.data.subarray(1), rawChunk3) === 0, 'after dropping to level 0, raw passthrough resumes immediately');
  check(rnnoiseFilterFactory.created.length === 1, 're-setting to level 0 does not spawn a second filter');

  // --- moving between two non-zero levels stops and restarts the filter with the new fixed ratio ---
  bridge.setRnnoiseLevel(4);
  const filter2 = rnnoiseFilterFactory.created[1];
  check(filter2.started === true, 'moving to level 4 spawns a fresh filter');
  check(filter2.opts.wet === 1.0, 'level 4 ("RNN 4") is constructed with a wet ratio of 1.0 (100% denoised)');

  // --- a filter error falls back to unfiltered passthrough, reports AUDIO_ERROR and resets the level to 0, never breaks the pipeline ---
  // _handleRnnoiseError() sends TWO broadcasts back-to-back — AUDIO_ERROR
  // (via _reportError()) then RNNOISE_LEVEL ({level: 0}), so both need to
  // be drained here before the next RX-audio check below, or the second
  // one would be mistaken for the next audio frame.
  const errorEventPromise = nextMessage(client);
  filter2.emit('error', new Error('rnnoise_demo: ENOENT'));
  const errorEvent = await errorEventPromise;
  check(
    !errorEvent.isBinary && errorEvent.data.type === EVENT.AUDIO_ERROR,
    'a filter error is reported to clients as EVENT.AUDIO_ERROR, not silently swallowed'
  );
  const levelResetEvent = await nextMessage(client);
  check(
    !levelResetEvent.isBinary && levelResetEvent.data.type === EVENT.RNNOISE_LEVEL && levelResetEvent.data.data.level === 0,
    'a filter error also broadcasts EVENT.RNNOISE_LEVEL {level: 0}, so every connected client sees the button reset itself'
  );
  const rawChunk4 = sineFrame(200, 500);
  capture.emit('data', rawChunk4);
  const rxMsg4 = await nextMessage(client);
  check(
    Buffer.compare(rxMsg4.data.subarray(1), rawChunk4) === 0,
    'after a filter error, RX audio automatically falls back to unfiltered passthrough rather than breaking the pipeline'
  );

  // --- wired via controlServer's 'rnnoise-level' internal event too (self-contained, no index.js glue needed) ---
  const filterFactoryCountBefore = rnnoiseFilterFactory.created.length;
  server.emit('rnnoise-level', 2);
  check(rnnoiseFilterFactory.created.length === filterFactoryCountBefore + 1, "AudioBridge self-subscribes to controlServer's 'rnnoise-level' event and reacts to it directly");
  check(rnnoiseFilterFactory.created[rnnoiseFilterFactory.created.length - 1].opts.wet === 0.5, "level 2 ('RNN 2') is constructed with a wet ratio of 0.5 (50/50 mix)");
  server.emit('rnnoise-level', 0);
  check(rnnoiseFilterFactory.created[rnnoiseFilterFactory.created.length - 1].stopped === true, "the 'rnnoise-level' event also handles dropping back to 0 (off)");

  bridge.stop();
  client.close();
  await server.close();
}

/**
 * The "RNN" button's wet ratios (and so its total number of levels) are
 * configurable via src/server/index.js's RNNOISE_WET env var parsing,
 * threaded through as AudioBridge's `rnnoiseWetLevels` option — see
 * audio-bridge.js's own doc comment on `_rnnoiseWetLevels`. This checks
 * AudioBridge actually uses a custom list rather than the hardcoded
 * 25/50/75/100% default, for both a shorter and a longer list than the
 * original 4-value one.
 */
async function testRnnoiseConfigurableWetLevels() {
  console.log('\n-- RNNoise configurable wet levels (rnnoiseWetLevels option) --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();

  // --- a short custom list (2 values -> a 3-state button: Off/1/2) ---
  {
    const rnnoiseFilterFactory = makeRnnoiseFilterFactory();
    const bridge = new AudioBridge({
      controlServer: server,
      capture,
      playback,
      codecType: 'pcm',
      rnnoiseBin: 'rnnoise_demo',
      rnnoiseFilterFactory,
      rnnoiseWetLevels: [0.1, 0.9],
    });
    bridge.start();

    bridge.setRnnoiseLevel(1);
    check(rnnoiseFilterFactory.created[0].opts.wet === 0.1, 'a custom 2-value list: level 1 uses the first configured ratio (0.1), not the default 0.25');
    bridge.setRnnoiseLevel(2);
    check(rnnoiseFilterFactory.created[1].opts.wet === 0.9, 'a custom 2-value list: level 2 uses the second configured ratio (0.9)');

    bridge.stop();
  }

  // --- a longer custom list than the original 4-value default ---
  {
    const rnnoiseFilterFactory = makeRnnoiseFilterFactory();
    const bridge = new AudioBridge({
      controlServer: server,
      capture,
      playback,
      codecType: 'pcm',
      rnnoiseBin: 'rnnoise_demo',
      rnnoiseFilterFactory,
      rnnoiseWetLevels: [0.2, 0.4, 0.6, 0.8, 1.0, 0.5],
    });
    bridge.start();

    bridge.setRnnoiseLevel(6);
    check(rnnoiseFilterFactory.created[0].opts.wet === 0.5, 'a 6-value custom list: the 6th level uses the 6th configured ratio (0.5), beyond the original 4-level range');

    bridge.stop();
  }

  await server.close();
}

/**
 * HamNoise (setHamNoiseEnabled) — the same RX-broadcast-only scope as
 * RNNoise (see testRnnoise()'s own doc comment: independent capture 'data'
 * listeners, standing in for CW/RTTY/FT8/RADE, must never see filtered
 * audio), plus its own two extra behaviors RNNoise doesn't have: mutual
 * exclusion with RNNoise in both directions, and mode-aware model
 * selection via `civ`'s 'mode' events.
 */
async function testHamNoise() {
  console.log('\n-- HamNoise toggle (setHamNoiseEnabled) --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const hamnoiseFilterFactory = makeHamnoiseFilterFactory();
  const bridge = new AudioBridge({
    controlServer: server,
    civ,
    capture,
    playback,
    codecType: 'pcm',
    hamnoiseFilterFactory,
  });
  bridge.start();

  const client = await connect(port);
  await nextMessage(client); // hello

  const externalDecoderChunks = [];
  capture.on('data', (chunk) => externalDecoderChunks.push(chunk));
  const rxPcmEvents = [];
  bridge.on('rx-pcm', (chunk) => rxPcmEvents.push(chunk));

  // --- disabled by default: no filter spawned, raw chunk broadcast as-is ---
  check(hamnoiseFilterFactory.created.length === 0, 'no HamnoiseFilter is spawned until the toggle is actually switched on (lazy)');
  const rawChunk1 = sineFrame(200);
  capture.emit('data', rawChunk1);
  const rxMsg1 = await nextMessage(client);
  check(Buffer.compare(rxMsg1.data.subarray(1), rawChunk1) === 0, 'HamNoise disabled: the raw chunk is broadcast to clients unmodified');
  check(
    externalDecoderChunks.length === 1 && externalDecoderChunks[0] === rawChunk1,
    "REGRESSION GUARD: an independent capture 'data' listener sees the exact same unmodified chunk — HamNoise's own machinery never touches the raw capture event at all"
  );

  // --- enabling it: lazily spawns the filter with the current mode's target, routes subsequent chunks through it instead of broadcasting them directly ---
  bridge.setHamNoiseEnabled(true);
  check(hamnoiseFilterFactory.created.length === 1, 'setHamNoiseEnabled(true) lazily spawns exactly one HamnoiseFilter');
  const filter = hamnoiseFilterFactory.created[0];
  check(filter.opts.target === 'voice', 'with no mode known yet, the filter is constructed targeting the voice model (the default)');
  check(filter.started === true, 'setHamNoiseEnabled(true) starts the filter');

  const rawChunk2 = sineFrame(200, 300);
  capture.emit('data', rawChunk2);
  await flush();
  check(filter.written.length === 1 && filter.written[0] === rawChunk2, 'while enabled, each captured chunk is written into the filter, not broadcast directly');
  check(
    externalDecoderChunks.length === 2 && externalDecoderChunks[1] === rawChunk2,
    "REGRESSION GUARD: the independent capture 'data' listener STILL sees the raw, unfiltered chunk even while HamNoise is enabled"
  );

  const filteredChunk = sineFrame(200, 300, 48000, 4000);
  filter.emit('data', filteredChunk);
  const rxMsg2 = await nextMessage(client);
  check(Buffer.compare(rxMsg2.data.subarray(1), filteredChunk) === 0, "HamNoise enabled: the FILTERED chunk (not the original raw one) is what's broadcast to clients");
  check(rxPcmEvents.length === 2 && rxPcmEvents[1] === filteredChunk, "HamNoise enabled: 'rx-pcm' is emitted with the filtered chunk");

  // --- a civ 'mode' event while HamNoise is running switches the live filter's model immediately ---
  // ControlServer itself also listens for civ's 'mode' event and broadcasts
  // EVENT.MODE to clients (see ws-server.js's _wireCivEvents()) — unrelated
  // to HamNoise, but it lands in the same client message stream, so each
  // emit here is drained before the next nextMessage() call expects audio.
  civ.emit('mode', { mode: 'CW' });
  const modeEvent1 = await nextMessage(client);
  check(!modeEvent1.isBinary && modeEvent1.data.type === EVENT.MODE, "(unrelated to HamNoise) ControlServer also broadcasts EVENT.MODE for this civ 'mode' event");
  check(filter.modelCalls.length === 1 && filter.modelCalls[0] === 'cw', "a civ 'mode' event of CW immediately switches the running filter to the 'cw' target");
  civ.emit('mode', { mode: 'USB' });
  const modeEvent2 = await nextMessage(client);
  check(!modeEvent2.isBinary && modeEvent2.data.type === EVENT.MODE, '(unrelated to HamNoise) same for the mode change back to USB');
  check(filter.modelCalls[1] === 'voice', 'switching back to a voice mode (e.g. USB) switches the running filter back to the voice target');

  // --- disabling: filter is stopped, raw passthrough resumes ---
  bridge.setHamNoiseEnabled(false);
  check(filter.stopped === true, 'setHamNoiseEnabled(false) stops the filter');
  const rawChunk3 = sineFrame(200, 400);
  capture.emit('data', rawChunk3);
  const rxMsg3 = await nextMessage(client);
  check(Buffer.compare(rxMsg3.data.subarray(1), rawChunk3) === 0, 'after disabling, raw passthrough resumes immediately');
  check(hamnoiseFilterFactory.created.length === 1, 're-disabling does not spawn a second filter');

  // --- re-enabling after a mode change picks up the now-known mode immediately at construction time ---
  // (back to CW — the last civ event above moved _currentMode to 'USB'/voice
  // while HamNoise was still enabled; move it to CW again here, while
  // HamNoise is OFF, specifically to check the mode is still remembered and
  // applied at construction time on the next enable, with no separate
  // setModel() call needed.)
  civ.emit('mode', { mode: 'CW' });
  const modeEvent3 = await nextMessage(client);
  check(!modeEvent3.isBinary && modeEvent3.data.type === EVENT.MODE, '(unrelated to HamNoise) ControlServer broadcasts EVENT.MODE here too, while HamNoise happens to be disabled');

  bridge.setHamNoiseEnabled(true);
  const filter2 = hamnoiseFilterFactory.created[1];
  check(filter2.opts.target === 'cw', 're-enabling after the mode moved to CW (while disabled) constructs the new filter already targeting the cw model (not voice, and not needing a separate setModel() call)');

  // --- a filter error falls back to unfiltered passthrough, reports AUDIO_ERROR, resets the toggle to off, never breaks the pipeline ---
  const errorEventPromise = nextMessage(client);
  filter2.emit('error', new Error('hamnoise-filter: simulated load failure'));
  const errorEvent = await errorEventPromise;
  check(!errorEvent.isBinary && errorEvent.data.type === EVENT.AUDIO_ERROR, 'a filter error is reported to clients as EVENT.AUDIO_ERROR');
  const toggleResetEvent = await nextMessage(client);
  check(
    !toggleResetEvent.isBinary && toggleResetEvent.data.type === EVENT.HAMNOISE_ENABLED && toggleResetEvent.data.data.enabled === false,
    'a filter error also broadcasts EVENT.HAMNOISE_ENABLED {enabled: false}, so every connected client sees the button reset itself'
  );
  const rawChunk4 = sineFrame(200, 500);
  capture.emit('data', rawChunk4);
  const rxMsg4 = await nextMessage(client);
  check(
    Buffer.compare(rxMsg4.data.subarray(1), rawChunk4) === 0,
    'after a filter error, RX audio automatically falls back to unfiltered passthrough'
  );

  // --- wired via controlServer's 'hamnoise-enabled' internal event too (self-contained, no index.js glue needed) ---
  const filterFactoryCountBefore = hamnoiseFilterFactory.created.length;
  server.emit('hamnoise-enabled', true);
  check(hamnoiseFilterFactory.created.length === filterFactoryCountBefore + 1, "AudioBridge self-subscribes to controlServer's 'hamnoise-enabled' event and reacts to it directly");
  server.emit('hamnoise-enabled', false);
  check(hamnoiseFilterFactory.created[hamnoiseFilterFactory.created.length - 1].stopped === true, "the 'hamnoise-enabled' event also handles disabling");

  bridge.stop();
  client.close();
  await server.close();
}

/**
 * The operator's explicit requirement: RNN and HamNoise must never run at
 * the same time — selecting one always forces the other off, in both
 * directions, with the forced-off state broadcast so every connected
 * client's button reflects it (not just the one that triggered it).
 */
async function testRnnoiseHamNoiseMutualExclusion() {
  console.log('\n-- RNN / HamNoise mutual exclusion --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const rnnoiseFilterFactory = makeRnnoiseFilterFactory();
  const hamnoiseFilterFactory = makeHamnoiseFilterFactory();
  const bridge = new AudioBridge({
    controlServer: server,
    civ,
    capture,
    playback,
    codecType: 'pcm',
    rnnoiseBin: 'rnnoise_demo',
    rnnoiseFilterFactory,
    hamnoiseFilterFactory,
  });
  bridge.start();

  const client = await connect(port);
  await nextMessage(client); // hello

  // --- enabling HamNoise while RNN is active forces RNN off, broadcasting RNNOISE_LEVEL:0 ---
  bridge.setRnnoiseLevel(2);
  const rnnFilter = rnnoiseFilterFactory.created[0];
  check(rnnFilter.started === true, 'RNN starts normally first');

  const rnnResetPromise = nextMessage(client);
  bridge.setHamNoiseEnabled(true);
  check(hamnoiseFilterFactory.created.length === 1, 'enabling HamNoise spawns its filter');
  check(rnnFilter.stopped === true, 'enabling HamNoise stops the active RNN filter');
  const rnnResetEvent = await rnnResetPromise;
  check(
    !rnnResetEvent.isBinary && rnnResetEvent.data.type === EVENT.RNNOISE_LEVEL && rnnResetEvent.data.data.level === 0,
    'enabling HamNoise broadcasts EVENT.RNNOISE_LEVEL {level: 0} so every client sees the RNN button reset'
  );
  check(server.state.rnnoiseLevel === 0, "enabling HamNoise also updates controlServer.state.rnnoiseLevel directly (not just the broadcast)");

  // --- enabling RNN while HamNoise is active forces HamNoise off, broadcasting HAMNOISE_ENABLED:false ---
  const hamResetPromise = nextMessage(client);
  bridge.setRnnoiseLevel(3);
  const rnnFilter2 = rnnoiseFilterFactory.created[1];
  check(rnnFilter2.started === true, 'RNN restarts normally');
  check(hamnoiseFilterFactory.created[0].stopped === true, 'enabling RNN stops the active HamNoise filter');
  const hamResetEvent = await hamResetPromise;
  check(
    !hamResetEvent.isBinary && hamResetEvent.data.type === EVENT.HAMNOISE_ENABLED && hamResetEvent.data.data.enabled === false,
    'enabling RNN broadcasts EVENT.HAMNOISE_ENABLED {enabled: false} so every client sees the HamNoise button reset'
  );
  check(server.state.hamNoiseEnabled === false, 'enabling RNN also updates controlServer.state.hamNoiseEnabled directly');

  // --- re-setting RNN to level 0 (off) while HamNoise is NOT active never disturbs HamNoise's (already-off) state or broadcasts a spurious reset ---
  const extraEvents = [];
  const collector = (raw, isBinary) => {
    if (!isBinary) extraEvents.push(JSON.parse(raw.toString()));
  };
  client.on('message', collector);
  bridge.setRnnoiseLevel(0);
  await flush();
  client.off('message', collector);
  check(
    !extraEvents.some((e) => e.type === EVENT.HAMNOISE_ENABLED),
    'turning RNN off while HamNoise is already off does not broadcast a spurious HAMNOISE_ENABLED event'
  );

  bridge.stop();
  client.close();
  await server.close();
}

/**
 * A real user report: the server process crashed when disabling HamNoise.
 * hamnoise-filter.js's real WASM calls (stop()/write()/setModel()) are a
 * native boundary this project has never been able to exercise against
 * real hardware (see models/hamnoise/NOTICE.md's own disclosed upstream
 * caveat) — if any of them ever throws for a reason not already handled
 * internally, AudioBridge must not let that take the whole server down,
 * the same resilience standard every other external-process/native call
 * in this file already meets (RNNoise's spawn/exit handling, Opus
 * encode/decode errors, etc.). This stub can't reproduce a real WASM trap,
 * but it can simulate "the call throws synchronously" and confirm
 * AudioBridge's own try/catch guards (_stopHamNoiseFilterSafely(),
 * _writeHamNoiseFilterSafely(), _handleCivModeChange()) actually catch it
 * rather than letting it propagate and crash the process.
 */
async function testHamNoiseResilientToThrows() {
  console.log('\n-- HamNoise: a throwing stop()/write()/setModel() never crashes the server --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const hamnoiseFilterFactory = makeHamnoiseFilterFactory();
  const bridge = new AudioBridge({
    controlServer: server,
    civ,
    capture,
    playback,
    codecType: 'pcm',
    hamnoiseFilterFactory,
  });
  bridge.start();

  const client = await connect(port);
  await nextMessage(client); // hello

  // --- a throwing stop() (e.g. the operator disabling the toggle) is caught, reported, and never propagates ---
  bridge.setHamNoiseEnabled(true);
  const filter1 = hamnoiseFilterFactory.created[0];
  filter1.throwOn.stop = 'simulated native stop() trap';

  const errorEventPromise = nextMessage(client);
  let threw = false;
  try {
    bridge.setHamNoiseEnabled(false);
  } catch {
    threw = true;
  }
  check(!threw, 'a throwing stop() during setHamNoiseEnabled(false) does not propagate out of the call');
  const errorEvent = await errorEventPromise;
  check(
    !errorEvent.isBinary && errorEvent.data.type === EVENT.AUDIO_ERROR && errorEvent.data.data.context === 'hamnoise',
    'a throwing stop() is still reported to clients as an AUDIO_ERROR rather than silently swallowed'
  );
  check(bridge._hamNoiseEnabled === false, 'the toggle still ends up off despite stop() throwing');

  // --- a throwing write() (simulating a WASM trap on a captured chunk) is caught, resets the toggle, and falls back to raw passthrough for that chunk ---
  bridge.setHamNoiseEnabled(true);
  const filter2 = hamnoiseFilterFactory.created[1];
  filter2.throwOn.write = 'simulated native write() trap';

  const rxPcmEvents = [];
  bridge.on('rx-pcm', (chunk) => rxPcmEvents.push(chunk));
  const audioErrorPromise = nextMessage(client);
  const toggleResetPromise = nextMessage(client);
  const badChunk = sineFrame(200, 123);
  let threw2 = false;
  try {
    capture.emit('data', badChunk);
  } catch {
    threw2 = true;
  }
  check(!threw2, 'a throwing write() triggered from a captured chunk does not propagate out of the capture listener');
  const audioError = await audioErrorPromise;
  check(
    !audioError.isBinary && audioError.data.type === EVENT.AUDIO_ERROR && audioError.data.data.context === 'hamnoise',
    'the throwing write() is reported as an AUDIO_ERROR'
  );
  const toggleReset = await toggleResetPromise;
  check(
    !toggleReset.isBinary && toggleReset.data.type === EVENT.HAMNOISE_ENABLED && toggleReset.data.data.enabled === false,
    'the throwing write() also resets the HamNoise toggle for every connected client'
  );
  const fallbackMsg = await nextMessage(client);
  check(
    fallbackMsg.isBinary && Buffer.compare(fallbackMsg.data.subarray(1), badChunk) === 0,
    'the chunk that triggered the throw is still broadcast raw (unfiltered fallback) rather than being dropped'
  );
  check(
    rxPcmEvents.length === 1 && rxPcmEvents[0] === badChunk,
    "the fallback chunk is also emitted on 'rx-pcm', same as any other unfiltered passthrough chunk"
  );

  // --- a throwing setModel() (triggered by a civ 'mode' event while HamNoise is running) is caught and resets the toggle, without crashing ---
  bridge.setHamNoiseEnabled(true);
  const filter3 = hamnoiseFilterFactory.created[2];
  filter3.throwOn.setModel = 'simulated native setModel() trap';

  const modeAudioErrorPromise = nextMessage(client);
  let threw3 = false;
  try {
    civ.emit('mode', { mode: 'CW' });
  } catch {
    threw3 = true;
  }
  check(!threw3, "a throwing setModel() triggered from a civ 'mode' event does not propagate");
  // Three messages land from this single civ.emit() call: ControlServer's
  // own EVENT.MODE broadcast (unrelated to HamNoise, see testHamNoise()'s
  // own note on this — ControlServer's civ listener fires before
  // AudioBridge's, since it's registered first), then AudioBridge's
  // _handleHamNoiseError() broadcasting EVENT.AUDIO_ERROR followed by
  // EVENT.HAMNOISE_ENABLED for the caught setModel() failure. Order
  // between the two AudioBridge events is fixed (see _handleHamNoiseError's
  // own body), but this just confirms all three actually arrive rather
  // than asserting exact ordering against ControlServer's unrelated one.
  const seen = [await modeAudioErrorPromise, await nextMessage(client), await nextMessage(client)];
  check(
    seen.some((m) => !m.isBinary && m.data.type === EVENT.MODE),
    "(unrelated to HamNoise) ControlServer's own EVENT.MODE broadcast for this civ 'mode' event still arrives"
  );
  check(
    seen.some((m) => !m.isBinary && m.data.type === EVENT.AUDIO_ERROR && m.data.data.context === 'hamnoise'),
    'the throwing setModel() is reported as an AUDIO_ERROR'
  );
  check(
    seen.some((m) => !m.isBinary && m.data.type === EVENT.HAMNOISE_ENABLED && m.data.data.enabled === false),
    'the throwing setModel() also broadcasts the toggle reset'
  );
  check(bridge._hamNoiseEnabled === false, 'the toggle is reset off after a throwing setModel()');

  bridge.stop();
  client.close();
  await server.close();
}

async function testOpusMode() {
  console.log('\n-- opus mode (legacy/optional) --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const bridge = new AudioBridge({ controlServer: server, capture, playback, codecType: 'opus' });
  bridge.start();

  const client = await connect(port);
  await nextMessage(client); // hello

  const codec = new OpusCodec(); // mirrors the bridge's default opus config
  const originalFrame = sineFrame(codec.samplesPerFrame);
  capture.emit('data', originalFrame);

  const rxMsg = await nextMessage(client);
  check(rxMsg.isBinary === true, '[opus] RX audio arrives as a binary WebSocket frame');
  check(rxMsg.data[0] === BINARY_TYPE.AUDIO, '[opus] RX audio frame is tagged as BINARY_TYPE.AUDIO');
  const decodedRx = codec.decode(rxMsg.data.subarray(1));
  check(decodedRx.length === codec.frameBytes, '[opus] decoded RX audio has the expected PCM frame length');
  check(rxMsg.data.subarray(1).length < originalFrame.length, '[opus] RX audio is actually compressed on the wire');

  const txFrame = sineFrame(codec.samplesPerFrame, 220);
  const txPacket = codec.encode(txFrame);
  client.send(tagAudio(txPacket));
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(playback.written.length === 1, '[opus] TX audio from the client reaches the (fake) playback device');
  check(
    playback.written[0] && playback.written[0].length === codec.frameBytes,
    '[opus] decoded TX PCM has the expected frame length'
  );

  bridge.stop();
  client.close();
  await server.close();
}

async function testVolumeMaximizedOnStart() {
  console.log('\n-- start() maximizes volume on the ALSA card before starting streams --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const mixerCalls = [];
  const fakeMixer = async (cardId) => {
    mixerCalls.push(cardId);
    return [{ name: 'Speaker', ok: true }];
  };

  const bridge = new AudioBridge({
    controlServer: server,
    capture,
    playback,
    rxDevice: 'plughw:CODEC,0',
    txDevice: 'plughw:CODEC,0',
    mixer: fakeMixer,
  });

  let captureStarted = false;
  capture.start = () => {
    captureStarted = true;
  };

  await bridge.start();
  check(mixerCalls.length === 1, 'mixer is called exactly once (rx/tx device on the same card is deduped)');
  check(mixerCalls[0] === 'CODEC', 'mixer is called with the card id extracted from the device string');
  check(captureStarted === true, 'capture still starts normally after the mixer step');

  await server.close();
}

async function testVolumeMaximizeCanBeDisabled() {
  console.log('\n-- maximizeVolumeOnStart: false skips the mixer step --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  let mixerCalled = false;
  const fakeMixer = async () => {
    mixerCalled = true;
    return [];
  };

  const bridge = new AudioBridge({
    controlServer: server,
    capture,
    playback,
    rxDevice: 'plughw:CODEC,0',
    txDevice: 'plughw:CODEC,0',
    mixer: fakeMixer,
    maximizeVolumeOnStart: false,
  });

  await bridge.start();
  check(mixerCalled === false, 'mixer is not called when maximizeVolumeOnStart is false');

  await server.close();
}

async function testVolumeMaximizeFailureDoesNotBlockStart() {
  console.log('\n-- a mixer failure does not prevent audio from starting --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  await server.listen();

  const capture = new FakeCapture();
  const playback = new FakePlayback();
  let captureStarted = false;
  capture.start = () => {
    captureStarted = true;
  };
  const throwingMixer = async () => {
    throw new Error('simulated: amixer not found');
  };

  const bridge = new AudioBridge({
    controlServer: server,
    capture,
    playback,
    rxDevice: 'plughw:CODEC,0',
    txDevice: 'plughw:CODEC,0',
    mixer: throwingMixer,
  });

  await bridge.start(); // should not throw/reject despite the mixer failing
  check(captureStarted === true, 'capture starts even though the mixer step threw');

  await server.close();
}

async function run() {
  await testPcmMode();
  await testMuting();
  await testRnnoise();
  await testRnnoiseConfigurableWetLevels();
  await testHamNoise();
  await testRnnoiseHamNoiseMutualExclusion();
  await testHamNoiseResilientToThrows();
  await testOpusMode();
  await testVolumeMaximizedOnStart();
  await testVolumeMaximizeCanBeDisabled();
  await testVolumeMaximizeFailureDoesNotBlockStart();

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
