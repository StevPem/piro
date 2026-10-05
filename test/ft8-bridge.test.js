// Run with: node test/ft8-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const {
  Ft8Bridge,
  FT8_SLOT_MS,
  FT4_SLOT_MS,
  FT8_SPECTRUM_FFT_SIZE,
  FT8_SPECTRUM_MAX_HZ,
  FT8_SPECTRUM_DYNAMIC_RANGE_DB,
  DEFAULT_TX_BASE_FREQUENCY_HZ,
  PTT_RELEASE_MARGIN_MS,
  _dbToScaledBytes,
} = require('../src/audio/ft8-bridge');
const { EVENT, BINARY_TYPE } = require('../src/server/protocol');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

class StubCiv extends EventEmitter {}

class StubControlServer extends EventEmitter {
  constructor() {
    super();
    this.broadcasts = [];
    this.pttCalls = [];
    this.binaryBroadcasts = [];
    // Mirrors the real ControlServer's `state.stationCallsign`/`stationGrid`/
    // `frequency` fields that Ft8Bridge reads for PSK Reporter spotting —
    // see src/audio/psk-reporter.js and _reportSpots() in ft8-bridge.js.
    // Unset by default (null), same as the real thing before STATION_CALLSIGN
    // is configured; tests that need spotting enabled set these explicitly.
    this.state = { stationCallsign: null, stationGrid: null, frequency: null };
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
  broadcastBinary(buffer) {
    this.binaryBroadcasts.push(buffer);
  }
  async setPttFromServer(on) {
    this.pttCalls.push(on);
  }
}

class StubCapture extends EventEmitter {}

class StubPlayback {
  constructor() {
    this.written = [];
  }
  write(pcm) {
    this.written.push(pcm);
  }
}

function makeStubAudioBridge() {
  return { capture: new StubCapture(), playback: new StubPlayback(), sampleRate: 48000 };
}

// A fake SlotClock with a manually-firable 'boundary' event and a
// controllable nextSlotStart(), so tests don't depend on real timers.
class StubSlotClock extends EventEmitter {
  constructor() {
    super();
    this.started = false;
    this.stopped = false;
    this._next = 15000;
    this.slotMs = FT8_SLOT_MS;
    this.setSlotMsCalls = []; // records every setSlotMs() call, for setVariant() tests
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  nextSlotStart() {
    return this._next;
  }
  setSlotMs(slotMs) {
    this.setSlotMsCalls.push(slotMs);
    this.slotMs = slotMs;
  }
  fireBoundary(slotStartMs) {
    this.emit('boundary', { slotStartMs, slotMs: this.slotMs });
  }
}

// A fake worker: capture posted messages and let the test manually
// deliver a 'message' reply, rather than actually spawning a
// worker_thread (which the CW decoder's own bridge tests avoid too).
class StubWorker extends EventEmitter {
  constructor() {
    super();
    this.posted = [];
    this.terminated = false;
  }
  postMessage(msg) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  reply(msg) {
    this.emit('message', msg);
  }
}

// A fake PskReporterClient: records addSpot() calls and start()/stop()
// without touching a real UDP socket, so ft8-bridge tests can assert on
// PSK Spot wiring without any network access — see test/psk-reporter.test.js
// for the actual protocol/encoding tests against the real class.
class StubPskReporter {
  constructor() {
    this.spots = [];
    this.started = false;
    this.stopped = false;
  }
  addSpot(spot) {
    this.spots.push(spot);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

function makeBridge(overrides = {}) {
  const civ = overrides.civ ?? new StubCiv();
  const controlServer = overrides.controlServer ?? new StubControlServer();
  const audioBridge = overrides.audioBridge ?? makeStubAudioBridge();
  const slotClock = overrides.slotClock ?? new StubSlotClock();
  const worker = overrides.worker ?? new StubWorker();
  const encodeFn = overrides.encodeFn ?? ((message) => new Float32Array(120));
  const encodeFnFt4 = overrides.encodeFnFt4 ?? ((message) => new Float32Array(60));
  const pskReporter = overrides.pskReporter ?? new StubPskReporter();
  const bridge = new Ft8Bridge({
    civ,
    controlServer,
    audioBridge,
    slotClock,
    worker,
    encodeFn,
    encodeFnFt4,
    pskReporter,
    computeSpectrumFn: overrides.computeSpectrumFn,
    spectrumIntervalMs: overrides.spectrumIntervalMs,
    // Defaults to 0 (not PTT_RELEASE_MARGIN_MS's real 300ms) so the many
    // tests below that await a real send()/PTT-release round trip stay
    // fast and deterministic; the margin itself is exercised explicitly
    // below by overriding it and inspecting the actual setTimeout delay.
    pttReleaseMarginMs: overrides.pttReleaseMarginMs ?? 0,
  });
  return { bridge, civ, controlServer, audioBridge, slotClock, worker, encodeFn, encodeFnFt4, pskReporter };
}

async function run() {
  // --- constructor validation ---
  {
    let threw = false;
    try {
      new Ft8Bridge({});
    } catch {
      threw = true;
    }
    check(threw, 'constructor throws when required dependencies are missing');
  }

  // --- setActive/PTT attach/detach logic ---
  {
    const { bridge, audioBridge } = makeBridge();
    check(audioBridge.capture.listenerCount('data') === 0, 'not attached to RX audio before setActive(true)');

    bridge.setActive(true);
    check(audioBridge.capture.listenerCount('data') === 1, 'setActive(true) attaches to the RX PCM stream');

    bridge.setActive(false);
    check(audioBridge.capture.listenerCount('data') === 0, 'setActive(false) detaches from the RX PCM stream');
    bridge.stop();
  }

  {
    // PTT going active should detach even while the FT8 panel is open —
    // we should never decode our own TX audio.
    const { bridge, audioBridge, controlServer } = makeBridge();
    bridge.setActive(true);
    check(audioBridge.capture.listenerCount('data') === 1, 'attached while active and not transmitting');

    controlServer.emit('ptt', true);
    check(audioBridge.capture.listenerCount('data') === 0, 'PTT going active detaches RX decoding even while the panel is open');

    controlServer.emit('ptt', false);
    check(audioBridge.capture.listenerCount('data') === 1, 're-attaches once PTT releases, since the panel is still open');
    bridge.stop();
  }

  {
    // The 'ft8-active' internal event (from a SET_FT8_ACTIVE request) is
    // equivalent to calling setActive() directly.
    const { bridge, audioBridge, controlServer } = makeBridge();
    controlServer.emit('ft8-active', true);
    check(audioBridge.capture.listenerCount('data') === 1, "the 'ft8-active' event arms RX decoding the same way setActive() does");
    bridge.stop();
  }

  // --- start()/stop() wire the slot clock and worker ---
  {
    const { bridge, slotClock, worker } = makeBridge();
    bridge.start();
    check(slotClock.started, 'start() starts the injected slot clock');
    bridge.stop();
    check(slotClock.stopped, 'stop() stops the slot clock');
    check(worker.terminated, 'stop() terminates the decode worker');
  }

  // --- RX: boundary decodes the slot that just ended and broadcasts results ---
  {
    const { bridge, audioBridge, slotClock, worker, controlServer } = makeBridge();
    bridge.setActive(true);

    // Push two chunks of RX PCM (16-bit LE, 48kHz) during the "slot".
    const chunkA = Buffer.alloc(4800 * 2);
    const chunkB = Buffer.alloc(2400 * 2);
    audioBridge.capture.emit('data', chunkA);
    audioBridge.capture.emit('data', chunkB);

    slotClock.fireBoundary(15000);
    check(worker.posted.length === 1, 'a boundary with buffered RX audio posts exactly one decode request to the worker');
    const posted = worker.posted[0];
    check(posted.type === 'decode', 'the posted message has type "decode"');
    check(posted.sampleRate === 12000, 'the posted message resamples to FT8_SAMPLE_RATE (12000)');
    check(Array.isArray(posted.knownCallsigns) && posted.knownCallsigns.length === 0, 'no known callsigns yet on the first decode');

    const fakeMessages = [{ freq: 999.9, dt: 0.1, snr: -5, msg: 'CQ VK2IO QF56' }];
    worker.reply({ type: 'decoded', requestId: posted.requestId, messages: fakeMessages, discoveredCallsigns: ['VK2IO'] });

    const decodeEvents = controlServer.broadcasts.filter((b) => b.type === EVENT.FT8_DECODES);
    check(decodeEvents.length === 1, 'a decoded reply broadcasts exactly one FT8_DECODES event');
    check(decodeEvents[0].data.slotStartMs === 0, 'the broadcast slot-start is the slot that just ended (boundary - slotMs)');
    check(decodeEvents[0].data.messages === fakeMessages, 'the broadcast carries the decoded messages through unchanged');
    bridge.stop();
  }

  {
    // Discovered callsigns from one slot should be remembered and fed
    // into the next slot's decode request.
    const { bridge, audioBridge, slotClock, worker } = makeBridge();
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    slotClock.fireBoundary(15000);
    worker.reply({ type: 'decoded', requestId: worker.posted[0].requestId, messages: [], discoveredCallsigns: ['VK2IO', 'VK3XYZ'] });

    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    slotClock.fireBoundary(30000);
    check(worker.posted.length === 2, 'a second boundary posts a second decode request');
    check(
      worker.posted[1].knownCallsigns.includes('VK2IO') && worker.posted[1].knownCallsigns.includes('VK3XYZ'),
      'callsigns discovered in an earlier slot are carried into the next decode request'
    );
    bridge.stop();
  }

  {
    // A boundary with no buffered RX audio (e.g. panel not active) should
    // not post any decode request at all.
    const { bridge, slotClock, worker } = makeBridge();
    slotClock.fireBoundary(15000);
    check(worker.posted.length === 0, 'a boundary with nothing captured does not post a decode request');
    bridge.stop();
  }

  {
    // A decode-error reply should surface as a RIG_ERROR broadcast, not throw.
    const { bridge, audioBridge, slotClock, worker, controlServer } = makeBridge();
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    slotClock.fireBoundary(15000);
    worker.reply({ type: 'decode-error', requestId: worker.posted[0].requestId, error: 'boom' });
    const errEvents = controlServer.broadcasts.filter((b) => b.type === EVENT.RIG_ERROR);
    check(errEvents.length === 1 && /boom/.test(errEvents[0].data.message), 'a decode-error worker reply broadcasts a RIG_ERROR event instead of throwing');
    bridge.stop();
  }

  // --- PSK Spot: decoded stations get reported to pskreporter.info ---
  {
    // No STATION_CALLSIGN configured (controlServer.state.stationCallsign
    // unset, the default) -> spotting is a no-op even though PSK Spot
    // itself defaults to enabled, matching PskReporterClient#addSpot()'s
    // own "nothing to identify the receiver" guard.
    const { bridge, audioBridge, slotClock, worker, pskReporter } = makeBridge();
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    slotClock.fireBoundary(15000);
    worker.reply({
      type: 'decoded',
      requestId: worker.posted[0].requestId,
      messages: [{ freq: 1000, dt: 0.1, snr: -5, msg: 'CQ VK2IO QF56' }],
      discoveredCallsigns: ['VK2IO'],
    });
    check(pskReporter.spots.length === 0, 'no STATION_CALLSIGN configured -> nothing is queued for spotting, even though PSK Spot defaults enabled');
    bridge.stop();
  }

  {
    // With a station identity configured and the radio parked on a known
    // dial frequency, a CQ decode should be queued with the absolute
    // (dial + audio-offset) frequency, matching what every other PSK
    // Reporter client reports (see _reportSpots()'s doc comment).
    const { bridge, audioBridge, slotClock, worker, controlServer, pskReporter } = makeBridge();
    controlServer.state.stationCallsign = 'VK3XYZ';
    controlServer.state.stationGrid = 'QF22';
    controlServer.state.frequency = 14074000;
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    slotClock.fireBoundary(15000);
    worker.reply({
      type: 'decoded',
      requestId: worker.posted[0].requestId,
      messages: [
        { freq: 1500, dt: 0.1, snr: -8, msg: 'CQ VK2IO QF56' },
        { freq: 800, dt: 0.2, snr: 3, msg: 'RR73' }, // no identifiable callsign -> should not spot
      ],
      discoveredCallsigns: ['VK2IO'],
    });
    check(pskReporter.spots.length === 1, 'exactly one of the two decoded messages has a spottable callsign');
    const spot = pskReporter.spots[0];
    check(spot.call === 'VK2IO', 'the spotted call is the CQ station heard');
    check(spot.grid === 'QF56', "the CQ's own grid is carried through as the spot's grid");
    check(spot.freqHz === 14074000 + 1500, 'the spotted frequency is the dial frequency plus the audio-domain offset, not the offset alone');
    check(spot.snr === -8, 'the spotted SNR matches the decode');
    check(spot.mode === 'FT8', 'the spotted mode is always "FT8"');
    bridge.stop();
  }

  {
    // Unchecking "PSK Spot" (REQUEST.SET_PSK_SPOT_ENABLED -> ws-server.js
    // emits 'psk-spot-enabled' on controlServer) should stop new spots
    // from being queued, even with a station identity configured.
    const { bridge, audioBridge, slotClock, worker, controlServer, pskReporter } = makeBridge();
    controlServer.state.stationCallsign = 'VK3XYZ';
    controlServer.emit('psk-spot-enabled', false);
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    slotClock.fireBoundary(15000);
    worker.reply({
      type: 'decoded',
      requestId: worker.posted[0].requestId,
      messages: [{ freq: 1500, dt: 0.1, snr: -8, msg: 'CQ VK2IO QF56' }],
      discoveredCallsigns: ['VK2IO'],
    });
    check(pskReporter.spots.length === 0, 'disabling PSK Spot stops new decodes from being queued');
    bridge.stop();
  }

  {
    // start()/stop() should drive the PskReporterClient's own lifecycle
    // alongside the slot clock and decode worker.
    const { bridge, pskReporter } = makeBridge();
    bridge.start();
    check(pskReporter.started, 'start() starts the injected PskReporterClient');
    bridge.stop();
    check(pskReporter.stopped, 'stop() stops the injected PskReporterClient');
  }

  // --- TX: send() queues, transmits at the next boundary via PTT, and resolves ---
  {
    const { bridge, audioBridge, slotClock, controlServer, encodeFn } = makeBridge();
    const sendPromise = bridge.send('CQ VK2IO QF56');

    const scheduled = controlServer.broadcasts.filter((b) => b.type === EVENT.FT8_TX_STATUS && b.data.status === 'scheduled');
    check(scheduled.length === 1, 'send() immediately broadcasts a "scheduled" FT8_TX_STATUS event');
    check(scheduled[0].data.message === 'CQ VK2IO QF56', 'the scheduled event carries the message text');

    slotClock.fireBoundary(15000);
    await flush();
    await sendPromise;

    check(controlServer.pttCalls[0] === true, 'transmitting keys PTT on before playback');
    check(audioBridge.playback.written.length === 1, 'the encoded/upsampled waveform is written to audio playback');
    check(controlServer.pttCalls[controlServer.pttCalls.length - 1] === false, 'PTT is released after the transmission finishes');

    const sentEvents = controlServer.broadcasts.filter((b) => b.type === EVENT.FT8_TX_STATUS && b.data.status === 'sent');
    check(sentEvents.length === 1, 'a completed transmission broadcasts a "sent" FT8_TX_STATUS event');
    bridge.stop();
  }

  {
    // The 'ft8-send' internal event (from a SEND_FT8 request) drives the
    // same queuing path as calling send() directly.
    const { bridge, slotClock, controlServer } = makeBridge();
    controlServer.emit('ft8-send', 'CQ VK2IO QF56');
    await flush();
    const scheduled = controlServer.broadcasts.filter((b) => b.type === EVENT.FT8_TX_STATUS && b.data.status === 'scheduled');
    check(scheduled.length === 1, "the 'ft8-send' event queues a transmission the same way send() does");
    slotClock.fireBoundary(15000);
    await flush();
    bridge.stop();
  }

  {
    // A second send() before the first has gone out should replace it,
    // not queue both.
    const { bridge, slotClock, controlServer } = makeBridge();
    // Note: the superseded first promise is intentionally left unsettled
    // by the bridge (its resolve/reject are simply discarded when
    // replaced) — attach a no-op handler so it doesn't surface as an
    // unhandled-rejection warning, but don't await it, since it never
    // settles.
    const first = bridge.send('FIRST MESSAGE HERE');
    first.catch(() => {});
    first.then(() => {});
    bridge.send('SECOND MESSAGE HERE');
    slotClock.fireBoundary(15000);
    await flush();
    const sendingEvents = controlServer.broadcasts.filter((b) => b.type === EVENT.FT8_TX_STATUS && b.data.status === 'sending');
    check(sendingEvents.length === 1 && sendingEvents[0].data.message === 'SECOND MESSAGE HERE', 'a second send() before the first goes out replaces it rather than queuing both');
    bridge.stop();
  }

  {
    // An encode failure should release PTT (best-effort), broadcast an
    // error status, and reject the send() promise rather than hang.
    const { bridge, slotClock, controlServer } = makeBridge({
      encodeFn: () => {
        throw new Error('encode blew up');
      },
    });
    const sendPromise = bridge.send('CQ VK2IO QF56');
    slotClock.fireBoundary(15000);
    let caught = null;
    try {
      await sendPromise;
    } catch (err) {
      caught = err;
    }
    check(caught !== null && /encode blew up/.test(caught.message), 'send() rejects when encoding fails');
    const errorEvents = controlServer.broadcasts.filter((b) => b.type === EVENT.FT8_TX_STATUS && b.data.status === 'error');
    check(errorEvents.length === 1, 'an encode failure broadcasts an "error" FT8_TX_STATUS event');
    check(controlServer.pttCalls[controlServer.pttCalls.length - 1] === false, 'PTT is still released (best-effort) after an encode failure');
    bridge.stop();
  }

  // --- TX: an explicit freqHz targets that frequency instead of the default ---
  // (Regression coverage for the guided FT8 QSO sequencer — see
  // src/client/ft8-qso.js and docs/ui-notes.md — which needs a reply to
  // go out at the specific frequency the other station is listening on,
  // not this bridge's one fixed default.)
  {
    const seenOptions = [];
    const { bridge, slotClock, controlServer } = makeBridge({
      encodeFn: (message, options) => {
        seenOptions.push(options);
        return new Float32Array(120);
      },
    });
    const sendPromise = bridge.send('VK2IO VK3XU R-08', { freqHz: 1523 });

    const scheduled = controlServer.broadcasts.filter((b) => b.type === EVENT.FT8_TX_STATUS && b.data.status === 'scheduled');
    check(scheduled.length === 1 && scheduled[0].data.freqHz === 1523, 'the "scheduled" status event reports the requested freqHz');

    slotClock.fireBoundary(15000);
    await flush();
    await sendPromise;

    check(seenOptions.length === 1 && seenOptions[0].baseFrequency === 1523, 'the requested freqHz is passed to encodeFn as baseFrequency, not the bridge\'s own default');
    const sentEvents = controlServer.broadcasts.filter((b) => b.type === EVENT.FT8_TX_STATUS && b.data.status === 'sent');
    check(sentEvents.length === 1 && sentEvents[0].data.freqHz === 1523, 'the "sent" status event also reports the actual freqHz used');
    bridge.stop();
  }

  // --- TX: omitting freqHz still falls back to the bridge's own default ---
  {
    const seenOptions = [];
    const { bridge, slotClock } = makeBridge({
      encodeFn: (message, options) => {
        seenOptions.push(options);
        return new Float32Array(120);
      },
    });
    const sendPromise = bridge.send('CQ VK2IO QF56'); // no freqHz — a plain manual/CQ send
    slotClock.fireBoundary(15000);
    await flush();
    await sendPromise;
    check(
      seenOptions.length === 1 && seenOptions[0].baseFrequency === DEFAULT_TX_BASE_FREQUENCY_HZ,
      `a send() with no freqHz still uses the bridge's own DEFAULT_TX_BASE_FREQUENCY_HZ, got ${seenOptions[0].baseFrequency}`
    );
    bridge.stop();
  }

  // --- TX: the 'ft8-send' internal event also accepts {message, freqHz} (ws-server.js's SEND_FT8 shape) ---
  {
    const seenOptions = [];
    const { bridge, slotClock, controlServer } = makeBridge({
      encodeFn: (message, options) => {
        seenOptions.push(options);
        return new Float32Array(120);
      },
    });
    controlServer.emit('ft8-send', { message: 'VK2IO VK3XU R-08', freqHz: 987 });
    await flush();
    slotClock.fireBoundary(15000);
    await flush();
    check(
      seenOptions.length === 1 && seenOptions[0].baseFrequency === 987,
      "the 'ft8-send' event's freqHz is honored when the payload is an object, same as calling send() directly"
    );
    bridge.stop();
  }

  // --- TX: PTT release waits durationMs *plus* the configured margin ---
  // (Regression coverage for the real "no successful QSOs" bug: PTT used
  // to be released exactly at the nominal PCM playback duration, with no
  // allowance for the pipe + ALSA buffering latency between
  // AlsaPlayback.write() returning and the audio actually reaching the
  // speaker — see PTT_RELEASE_MARGIN_MS's doc comment in ft8-bridge.js.
  // This intercepts the real global setTimeout just long enough to
  // capture the delay _transmitNow() actually requests, without waiting
  // for it in real wall-clock time.)
  {
    const testMarginMs = 250;
    const { bridge, audioBridge, slotClock } = makeBridge({ pttReleaseMarginMs: testMarginMs });
    check(bridge.pttReleaseMarginMs === testMarginMs, 'pttReleaseMarginMs is injectable via the constructor');

    const realSetTimeout = global.setTimeout;
    let capturedDelay = null;
    global.setTimeout = (fn, delay) => {
      capturedDelay = delay;
      return realSetTimeout(fn, 0); // fire almost immediately so the test doesn't actually wait
    };
    try {
      const sendPromise = bridge.send('CQ VK2IO QF56');
      slotClock.fireBoundary(15000);
      await sendPromise;
    } finally {
      global.setTimeout = realSetTimeout;
    }

    const pcm = audioBridge.playback.written[0];
    const nominalDurationMs = (pcm.length / 2 / audioBridge.sampleRate) * 1000;
    check(capturedDelay !== null, 'the PTT-release wait goes through setTimeout, as expected');
    check(
      Math.abs(capturedDelay - (nominalDurationMs + testMarginMs)) < 1e-6,
      `PTT release waits the nominal PCM duration (${nominalDurationMs}ms) plus the configured margin (${testMarginMs}ms), got ${capturedDelay}ms`
    );
    bridge.stop();
  }

  {
    // The exported default itself should be generous enough to matter —
    // this is mostly a guard against someone "cleaning up" the constant
    // back down to something too small to actually cover real ALSA/pipe
    // buffering latency (see the constant's own doc comment for the
    // reasoning behind 300ms).
    check(PTT_RELEASE_MARGIN_MS >= 200, `PTT_RELEASE_MARGIN_MS (${PTT_RELEASE_MARGIN_MS}ms) is generous enough to plausibly cover real ALSA/pipe drain latency`);
  }

  // --- stop() rejects any pending decode requests rather than leaking them ---
  {
    const { bridge, audioBridge, slotClock, worker } = makeBridge();
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    slotClock.fireBoundary(15000);
    check(worker.posted.length === 1, 'a decode request is in flight');
    bridge.stop();
    // Delivering a late reply after stop() should not throw (pending map cleared).
    let threw = false;
    try {
      worker.reply({ type: 'decoded', requestId: worker.posted[0].requestId, messages: [], discoveredCallsigns: [] });
    } catch {
      threw = true;
    }
    check(!threw, 'a late worker reply after stop() is harmlessly ignored rather than throwing');
  }

  // --- Audio-domain FFT spectrum (see docs/ui-notes.md and src/audio/fft.js) ---
  {
    const { bridge, audioBridge } = makeBridge();
    check(bridge._spectrumTimer === null, 'no spectrum timer runs before setActive(true)');

    bridge.setActive(true);
    check(bridge._spectrumTimer !== null, 'setActive(true) starts a periodic spectrum timer');

    bridge.setActive(false);
    check(bridge._spectrumTimer === null, 'setActive(false) stops the spectrum timer');
    check(bridge._spectrumBytes === 0, 'detaching also clears the rolling spectrum buffer');
    bridge.stop();
  }

  {
    // With no audio buffered yet (e.g. immediately after arming FT8),
    // _emitSpectrum() should quietly no-op rather than broadcast garbage.
    const { bridge, controlServer } = makeBridge();
    bridge.setActive(true);
    bridge._emitSpectrum();
    check(controlServer.binaryBroadcasts.length === 0, '_emitSpectrum() does not broadcast before any RX audio has arrived');
    bridge.stop();
  }

  {
    // A stubbed computeSpectrumFn keeps this test fast and deterministic
    // (real FFT correctness is covered by test/fft.test.js) while still
    // exercising Ft8Bridge's own framing/broadcast logic end to end.
    const fakeBinHz = 12000 / FT8_SPECTRUM_FFT_SIZE;
    const fakeMagnitudes = new Float64Array(FT8_SPECTRUM_FFT_SIZE / 2).fill(1);
    let computeSpectrumCalls = 0;
    const { bridge, audioBridge, controlServer } = makeBridge({
      computeSpectrumFn: (samples, opts) => {
        computeSpectrumCalls++;
        check(opts.fftSize === FT8_SPECTRUM_FFT_SIZE, 'computeSpectrumFn is called with FT8_SPECTRUM_FFT_SIZE');
        check(opts.sampleRate === 12000, 'computeSpectrumFn is called at FT8_SAMPLE_RATE (12000)');
        return { magnitudes: fakeMagnitudes, binHz: fakeBinHz };
      },
    });
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(9600 * 2)); // 200ms @ 48kHz
    bridge._emitSpectrum();

    check(computeSpectrumCalls === 1, '_emitSpectrum() calls the injected computeSpectrumFn exactly once');
    check(controlServer.binaryBroadcasts.length === 1, '_emitSpectrum() broadcasts exactly one binary frame');

    const frame = controlServer.binaryBroadcasts[0];
    check(frame[0] === BINARY_TYPE.FT8_SPECTRUM, 'the frame is tagged BINARY_TYPE.FT8_SPECTRUM');
    check(Math.abs(frame.readFloatLE(1) - fakeBinHz) < 1e-6, 'the frame header carries the reported binHz as a little-endian float');

    const expectedBinCount = Math.round(FT8_SPECTRUM_MAX_HZ / fakeBinHz);
    check(frame.length === 5 + expectedBinCount, `the frame is cropped to ${expectedBinCount} bins covering 0-${FT8_SPECTRUM_MAX_HZ}Hz, got ${frame.length - 5} bins`);

    // All-equal input magnitudes -> zero dB range -> every byte flattens to 0
    // rather than dividing by zero or producing NaN.
    let allZero = true;
    for (let i = 5; i < frame.length; i++) {
      if (frame[i] !== 0) allZero = false;
    }
    check(allZero, 'a flat (uniform-magnitude) spectrum autoscales to all-zero bytes rather than NaN/garbage');
    bridge.stop();
  }

  {
    // A spectrum with real variation should autoscale so its strongest
    // bin reaches the top of the 0-255 byte range.
    const fakeBinHz = 12000 / FT8_SPECTRUM_FFT_SIZE;
    const fakeMagnitudes = new Float64Array(FT8_SPECTRUM_FFT_SIZE / 2).fill(0.001);
    fakeMagnitudes[10] = 5;
    const { bridge, audioBridge, controlServer } = makeBridge({
      computeSpectrumFn: () => ({ magnitudes: fakeMagnitudes, binHz: fakeBinHz }),
    });
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(9600 * 2));
    bridge._emitSpectrum();

    const frame = controlServer.binaryBroadcasts[0];
    check(frame[5 + 10] === 255, 'the strongest bin in a varied spectrum autoscales to byte value 255');
    bridge.stop();
  }

  // --- _dbToScaledBytes: noise-floor-relative color scaling ---
  // (See that function's own doc comment for the full story — this
  // replaced a per-frame min/max stretch that made a frame of pure
  // noise look identical to one with a real signal, discovered from a
  // user-supplied reference screenshot/decode-SNR batch.)
  {
    // A uniform ("pure noise") spectrum should map to all-zero bytes —
    // the median noise floor sits right on top of every bin, so nothing
    // reads as "above the floor". This is the key regression check: the
    // old min/max-stretch algorithm would have forced whichever bin
    // happened to be (even fractionally) the largest up to byte 255
    // here, which is exactly the bug that produced an almost-solid-red
    // waterfall out of ordinary background noise.
    const bins = _dbToScaledBytes(new Float64Array(64).fill(1), 64);
    let allZero = true;
    for (const b of bins) if (b !== 0) allZero = false;
    check(allZero, 'a uniform ("pure noise") spectrum maps entirely to byte 0, not stretched up to 255');
  }

  {
    // A single bin exactly FT8_SPECTRUM_DYNAMIC_RANGE_DB above a stable
    // noise floor should land exactly at the top of the scale (255),
    // and one at half that dB span should land near the middle — a
    // *fixed* dB-to-byte mapping, unlike the old per-frame stretch.
    const magnitudes = new Float64Array(20).fill(1); // floor: 20*log10(1) = 0dB
    magnitudes[5] = 10 ** (FT8_SPECTRUM_DYNAMIC_RANGE_DB / 20); // exactly +DYNAMIC_RANGE dB above the floor
    magnitudes[10] = 10 ** (FT8_SPECTRUM_DYNAMIC_RANGE_DB / 2 / 20); // exactly halfway there
    const bins = _dbToScaledBytes(magnitudes, magnitudes.length);
    check(bins[5] === 255, `a bin exactly FT8_SPECTRUM_DYNAMIC_RANGE_DB (${FT8_SPECTRUM_DYNAMIC_RANGE_DB}dB) above the noise floor maps to byte 255, got ${bins[5]}`);
    check(Math.abs(bins[10] - 128) <= 1, `a bin halfway (in dB) to the top of the range maps to roughly the middle of the byte scale, got ${bins[10]}`);
    check(bins[0] === 0, 'an ordinary noise-floor bin stays at byte 0 even while a strong signal is present elsewhere in the same frame');
  }

  {
    // A bin quieter than the noise floor (e.g. a notch) should clamp to
    // 0 rather than go negative/wrap.
    const magnitudes = new Float64Array(10).fill(1);
    magnitudes[3] = 0.001; // well below the floor
    const bins = _dbToScaledBytes(magnitudes, magnitudes.length);
    check(bins[3] === 0, 'a bin quieter than the noise floor clamps to byte 0 rather than going negative');
  }

  {
    // The median floor should stay anchored to the noise even with
    // several strong signal bins present in the same frame (a busy FT8
    // slot can easily have 5-10+ simultaneous decodes) — robustness the
    // old min-based (or plain-average-based) floor wouldn't have had.
    const n = 100;
    const magnitudes = new Float64Array(n).fill(1);
    for (let i = 0; i < 8; i++) magnitudes[i] = 50; // a handful of strong signal bins
    const bins = _dbToScaledBytes(magnitudes, n);
    let noiseBinsStillLow = true;
    for (let i = 20; i < n; i++) if (bins[i] > 5) noiseBinsStillLow = false;
    check(noiseBinsStillLow, 'the noise floor stays anchored to the majority-noise bins even with several strong signals present in the same frame');
    check(bins[0] > bins[20], 'the strong signal bins still read visibly higher than the ordinary noise floor');
  }

  // --- FT8/FT4 variant switching (setVariant()) ---
  {
    const { bridge } = makeBridge();
    check(bridge._protocol === 'FT8', 'Ft8Bridge defaults to the FT8 protocol');
  }

  {
    let threw = null;
    const { bridge } = makeBridge();
    try {
      bridge.setVariant('WSPR');
    } catch (err) {
      threw = err;
    }
    check(threw !== null && /Unknown FT8\/FT4 variant/.test(threw.message), 'setVariant() rejects anything other than "FT8"/"FT4"');
  }

  {
    // Switching re-grids the slot clock to the new protocol's slot length.
    const { bridge, slotClock } = makeBridge();
    bridge.setVariant('FT4');
    check(bridge._protocol === 'FT4', 'setVariant("FT4") updates the tracked protocol');
    check(
      slotClock.setSlotMsCalls.length === 1 && slotClock.setSlotMsCalls[0] === FT4_SLOT_MS,
      `setVariant("FT4") re-grids the slot clock to FT4_SLOT_MS (${FT4_SLOT_MS}), got ${JSON.stringify(slotClock.setSlotMsCalls)}`
    );
    bridge.setVariant('FT8');
    check(
      slotClock.setSlotMsCalls[1] === FT8_SLOT_MS,
      `switching back to FT8 re-grids the slot clock to FT8_SLOT_MS (${FT8_SLOT_MS})`
    );
  }

  {
    // Setting the already-active variant is a no-op — no redundant
    // slot-clock re-grid, no clobbering of in-flight state.
    const { bridge, slotClock } = makeBridge();
    bridge.setVariant('FT8');
    check(slotClock.setSlotMsCalls.length === 0, 'setVariant() with the already-active protocol is a no-op');
  }

  {
    // The internal 'ft8-variant' event (from ws-server.js's SET_FT8_VARIANT
    // handler) drives the same path as calling setVariant() directly.
    const { bridge, controlServer, slotClock } = makeBridge();
    controlServer.emit('ft8-variant', 'FT4');
    check(bridge._protocol === 'FT4', "the 'ft8-variant' event switches the active protocol the same way setVariant() does");
    check(slotClock.setSlotMsCalls[0] === FT4_SLOT_MS, "the 'ft8-variant' event re-grids the slot clock too");
    bridge.stop();
  }

  {
    // Switching variants discards any RX audio already buffered against
    // the old slot grid — it can't be usefully decoded as a slot of the
    // new (different) length.
    const { bridge, audioBridge } = makeBridge();
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    check(bridge._rxChunks.length === 1, 'RX audio accumulates while active, as a baseline for this test');
    bridge.setVariant('FT4');
    check(bridge._rxChunks.length === 0, 'setVariant() discards RX audio buffered under the previous protocol/slot grid');
    bridge.stop();
  }

  {
    // A transmission merely *scheduled* for the next boundary (not yet
    // sent) should be cancelled — not silently sent under the new
    // protocol — if the variant changes before that boundary arrives.
    const { bridge } = makeBridge();
    const sendPromise = bridge.send('CQ VK2IO QF56');
    bridge.setVariant('FT4');
    let caught = null;
    try {
      await sendPromise;
    } catch (err) {
      caught = err;
    }
    check(caught !== null && /mode changed/i.test(caught.message), 'switching variants rejects a merely-scheduled (not yet sent) transmission');
    bridge.stop();
  }

  {
    // TX: once switched to FT4, the FT4-specific encode function is used
    // instead of the FT8 one.
    let ft8Calls = 0;
    let ft4Calls = 0;
    const { bridge, slotClock } = makeBridge({
      encodeFn: (message, options) => {
        ft8Calls++;
        return new Float32Array(120);
      },
      encodeFnFt4: (message, options) => {
        ft4Calls++;
        return new Float32Array(60);
      },
    });
    bridge.setVariant('FT4');
    const sendPromise = bridge.send('CQ VK2IO QF56');
    slotClock.fireBoundary(7500);
    await flush();
    await sendPromise;
    check(ft4Calls === 1 && ft8Calls === 0, 'transmitting while in FT4 mode uses the FT4 encode function, not the FT8 one');
    bridge.stop();
  }

  {
    // RX: the decode request posted to the worker carries the active
    // protocol, so the worker knows to run decodeFT4 instead of decodeFT8.
    const { bridge, audioBridge, slotClock, worker } = makeBridge();
    bridge.setVariant('FT4');
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    slotClock.fireBoundary(7500);
    check(worker.posted.length === 1 && worker.posted[0].protocol === 'FT4', 'a decode request while in FT4 mode is tagged protocol: "FT4"');
    bridge.stop();
  }

  {
    // PSK Reporter spots should report whichever protocol was actually
    // active for that slot ("FT4", not always "FT8") — see
    // src/audio/psk-reporter.js and docs/ui-notes.md's "PSK Spot" section.
    const controlServer = new StubControlServer();
    controlServer.state.stationCallsign = 'VK2IO';
    controlServer.state.stationGrid = 'QF56';
    controlServer.state.frequency = 14080000;
    const { bridge, audioBridge, slotClock, worker, pskReporter } = makeBridge({ controlServer });
    bridge.setVariant('FT4');
    bridge.setActive(true);
    audioBridge.capture.emit('data', Buffer.alloc(4800 * 2));
    slotClock.fireBoundary(7500);
    worker.reply({
      type: 'decoded',
      requestId: worker.posted[0].requestId,
      messages: [{ freq: 1500, dt: 0.1, snr: -8, msg: 'CQ VK3XU QF22' }],
      discoveredCallsigns: ['VK3XU'],
    });
    await flush();
    check(pskReporter.spots.length === 1 && pskReporter.spots[0].mode === 'FT4', `a spot reported while in FT4 mode carries mode: "FT4", got ${JSON.stringify(pskReporter.spots[0])}`);
    bridge.stop();
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

run();
