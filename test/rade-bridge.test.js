// Run with: node test/rade-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { RadeBridge } = require('../src/server/rade-bridge');
const { EVENT, BINARY_TYPE } = require('../src/server/protocol');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

class StubControlServer extends EventEmitter {
  constructor() {
    super();
    this.broadcasts = [];
    this.binaryBroadcasts = [];
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
  broadcastBinary(payload) {
    this.binaryBroadcasts.push(payload);
  }
}

class StubCapture extends EventEmitter {}
class StubPlayback {
  constructor() {
    this.written = [];
  }
  write(buf) {
    this.written.push(buf);
  }
}

function makeStubAudioBridge() {
  const audioBridge = {
    capture: new StubCapture(),
    playback: new StubPlayback(),
    sampleRate: 48000,
    rxMuted: false,
    txMuted: false,
    setRxMuted(muted) {
      this.rxMuted = muted;
    },
    setTxMuted(muted) {
      this.txMuted = muted;
    },
  };
  return audioBridge;
}

/** A fake RadePipeline good enough for RadeBridge's own orchestration tests — see rade-pipeline.test.js for RadePipeline's own subprocess-plumbing tests. */
class StubPipeline extends EventEmitter {
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
  write(buf) {
    this.written.push(buf);
  }
  stop() {
    this.stopped = true;
  }
}

function makePipelineFactory() {
  const created = [];
  const factory = (opts) => {
    const pipeline = new StubPipeline(opts);
    created.push(pipeline);
    return pipeline;
  };
  factory.created = created;
  return factory;
}

/**
 * A small S16_LE PCM buffer — content doesn't matter for these tests,
 * only that it flows through untouched-but-for-resampling. 240 samples
 * (5ms @ 48kHz) is comfortably enough that every resample this bridge
 * does (48k<->8k, 48k<->16k in either direction) still produces at least
 * one output sample — a 2-sample buffer downsampled 48k->8k rounds to
 * zero output samples, which isn't a bug, just too small a buffer for
 * this test's own assertions to observe anything.
 */
function samplePcm() {
  const buf = Buffer.alloc(240 * 2);
  for (let i = 0; i < 240; i++) {
    buf.writeInt16LE(Math.round(1000 * Math.sin((2 * Math.PI * i) / 20)), i * 2);
  }
  return buf;
}

function tagAudio(payload) {
  return Buffer.concat([Buffer.from([BINARY_TYPE.AUDIO]), payload]);
}

/**
 * Interleaved complex float32 IQ Buffer (I,Q,I,Q,...) — radae_tx's actual
 * stdout shape (see rade-bridge.js's own doc comment) — `count` samples,
 * each with the same (real, imag) pair. Used by the TX real-part
 * extraction tests below; a real recording would work just as well for
 * "does *something* get written" tests, but a known, uniform value makes
 * it possible to check the *specific* extracted value, not just that
 * writing happened.
 */
function sampleComplexFloat32(real, imag, count) {
  const buf = Buffer.alloc(count * 8);
  for (let i = 0; i < count; i++) {
    buf.writeFloatLE(real, i * 8);
    buf.writeFloatLE(imag, i * 8 + 4);
  }
  return buf;
}

async function run() {
  // --- constructor validation ---
  {
    let threw = false;
    try {
      // eslint-disable-next-line no-new
      new RadeBridge({ audioBridge: makeStubAudioBridge() });
    } catch {
      threw = true;
    }
    check(threw, 'constructor throws without opts.controlServer');
  }
  {
    let threw = false;
    try {
      // eslint-disable-next-line no-new
      new RadeBridge({ controlServer: new StubControlServer() });
    } catch {
      threw = true;
    }
    check(threw, 'constructor throws without opts.audioBridge');
  }

  // --- armed + RADE variant + not transmitting attaches RX only ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });

    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);

    check(pipelineFactory.created.length === 1, 'arming while on the RADE variant, not transmitting, attaches exactly one pipeline (RX)');
    check(pipelineFactory.created[0].opts.label === 'rade-rx', 'the attached pipeline is the RX one');
    check(pipelineFactory.created[0].started, 'the RX pipeline is started');
    check(audioBridge.rxMuted === true, "AudioBridge's own RX broadcast is muted while RX is attached");
    check(audioBridge.capture.listenerCount('data') === 1, 'the bridge subscribes to audioBridge.capture for RX audio');
    bridge.stop();
  }

  // --- the bridge's own default variant is 'RADE' — arming with no prior setVariant() call attaches a pipeline ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });

    controlServer.emit('freedv-active', true); // no 'freedv-variant' event at all — relies on the constructor default

    check(
      pipelineFactory.created.length === 1,
      "the bridge defaults to the 'RADE' variant (not '700E') — arming with no prior setVariant() call still attaches a pipeline, mirroring ws-server.js's own state.freeDvVariant default (see its doc comment for why: the client's own '700E' UI toggle was removed, so a non-'RADE' default would leave this bridge permanently idle with no client-side way left to switch it on)"
    );
    bridge.stop();
  }

  // --- arming while variant is (still-supported-internally, but no longer client-reachable) '700E' does nothing at all (no codec for it) ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });

    controlServer.emit('freedv-variant', '700E');
    controlServer.emit('freedv-active', true);

    check(pipelineFactory.created.length === 0, "arming while on the '700E' variant spawns no pipeline at all");
    check(audioBridge.rxMuted === false, "AudioBridge's RX broadcast is left alone for '700E'");
    bridge.stop();
  }

  // --- PTT engaging while armed+RADE tears down RX and attaches TX instead ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });

    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxPipeline = pipelineFactory.created[0];

    controlServer.emit('ptt', true);

    check(rxPipeline.stopped, 'PTT engaging stops the RX pipeline');
    check(audioBridge.rxMuted === false, 'RX unmuting happens when RX detaches');
    check(pipelineFactory.created.length === 2, 'PTT engaging attaches a second (TX) pipeline');
    check(pipelineFactory.created[1].opts.label === 'rade-tx', 'the second pipeline is the TX one');
    check(audioBridge.txMuted === true, "AudioBridge's own TX passthrough is muted while TX is attached");
    bridge.stop();
  }

  // --- PTT releasing tears down TX and re-attaches RX ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });

    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    controlServer.emit('ptt', true);
    const txPipeline = pipelineFactory.created[1];

    controlServer.emit('ptt', false);

    check(txPipeline.stopped, 'PTT releasing stops the TX pipeline');
    check(audioBridge.txMuted === false, 'TX unmuting happens when TX detaches');
    check(pipelineFactory.created.length === 3, 'PTT releasing re-attaches RX (a third pipeline)');
    check(pipelineFactory.created[2].opts.label === 'rade-rx', 'the third pipeline is RX again');
    bridge.stop();
  }

  // --- switching variant away from RADE mid-session tears everything down ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });

    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxPipeline = pipelineFactory.created[0];

    controlServer.emit('freedv-variant', '700E');

    check(rxPipeline.stopped, 'switching to 700E while RX was attached stops it');
    check(audioBridge.rxMuted === false, 'and unmutes RX');
    bridge.stop();
  }

  // --- disarming (freedv-active: false) tears down whatever was attached ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });

    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxPipeline = pipelineFactory.created[0];

    controlServer.emit('freedv-active', false);

    check(rxPipeline.stopped, 'disarming stops the attached RX pipeline');
    check(audioBridge.rxMuted === false, 'and unmutes RX');
    bridge.stop();
  }

  // --- RX: radio audio is resampled and pushed into the RX pipeline ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxPipeline = pipelineFactory.created[0];

    audioBridge.capture.emit('data', samplePcm());

    check(rxPipeline.written.length === 1, 'incoming radio audio is pushed into the RX pipeline');
    check(Buffer.isBuffer(rxPipeline.written[0]) && rxPipeline.written[0].length > 0, 'the pushed chunk is a non-empty buffer (resampled to 8kHz and converted to zero-imaginary complex float32 IQ — see the dedicated format test below)');
    bridge.stop();
  }

  // --- RX pipeline has no real2iq stage: radae_rx is fed complex IQ built directly in JS, not via a real2iq subprocess ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxStages = pipelineFactory.created[0].opts.stages;

    check(
      rxStages.length === 2 && rxStages[0].bin === 'radae_rx',
      'radae_rx is the first RX stage — no real2iq subprocess ahead of it (real2iq is a batch, whole-file tool that never emits anything fed a live, never-closing stream; see rade-bridge.js\'s own doc comment)'
    );
    check(rxStages[1].bin === 'lpcnet_demo', 'lpcnet_demo -fargan-synthesis is the second (final) RX stage');
    bridge.stop();
  }

  // --- RX: radio audio is converted to zero-imaginary complex float32 IQ at RADE's own documented real-input scale, not 16-bit PCM and not a Hilbert-transform conversion ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    audioBridge.sampleRate = 8000; // matches RADE_MODEM_SAMPLE_RATE exactly, so no resampling happens — isolates the format conversion from resample math
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxPipeline = pipelineFactory.created[0];

    const samples = [16384, -8192, 0, 32767];
    const pcmIn = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => pcmIn.writeInt16LE(s, i * 2));
    audioBridge.capture.emit('data', pcmIn);

    const written = rxPipeline.written[0];
    check(
      written.length === samples.length * 8,
      'RX pushes 8 bytes per sample (interleaved complex float32 I,Q — RADE_COMP, radae_rx\'s actual stdin format), not 2 (16-bit PCM) or 4 (real-only float) — this bridge\'s original bug fed radae_rx\'s chain 16-bit PCM via a real2iq subprocess that never even ran on a live stream'
    );
    // RADE's own documented real-input scale (rade_api.h): float = int16 * (2 / RADE_INT16_SCALE) = int16 / 8192.
    const expectedReal = samples.map((s) => s / 8192);
    const decodedReal = [];
    const decodedImag = [];
    for (let i = 0; i < samples.length; i++) {
      decodedReal.push(written.readFloatLE(i * 8));
      decodedImag.push(written.readFloatLE(i * 8 + 4));
    }
    const realClose = decodedReal.every((v, i) => Math.abs(v - expectedReal[i]) < 1e-3);
    check(realClose, "the real (I) component is the int16 sample scaled by RADE's own documented real-input convention (int16 / 8192), not the generic /32768 PCM normalization");
    check(decodedImag.every((v) => v === 0), 'the imaginary (Q) component is always zero — no Hilbert transform, matching rade_c\'s own rade_demod_wav.c reference tool for real-valued input');
    bridge.stop();
  }

  // --- RX: the pipeline's decoded speech is broadcast as a normal tagged AUDIO frame ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxPipeline = pipelineFactory.created[0];

    rxPipeline.emit('data', samplePcm());

    check(controlServer.binaryBroadcasts.length === 1, 'decoded speech from the RX pipeline is broadcast');
    check(controlServer.binaryBroadcasts[0][0] === BINARY_TYPE.AUDIO, 'the broadcast is tagged as an ordinary AUDIO frame — no client-side changes needed to hear it');
    bridge.stop();
  }

  // --- RX: the decoded speech is ALSO emitted as 'decoded-speech', for other server-side consumers ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxPipeline = pipelineFactory.created[0];

    const decodedSpeechEvents = [];
    bridge.on('decoded-speech', (pcm) => decodedSpeechEvents.push(pcm));

    rxPipeline.emit('data', samplePcm());

    check(decodedSpeechEvents.length === 1, "_handleDecodedSpeech() emits 'decoded-speech' once per decoded RX chunk, same as it broadcasts");
    check(
      Buffer.isBuffer(decodedSpeechEvents[0]) && decodedSpeechEvents[0].length > 0,
      "the emitted 'decoded-speech' payload is a non-empty PCM buffer"
    );
    check(
      Buffer.compare(decodedSpeechEvents[0], controlServer.binaryBroadcasts[0].subarray(1)) === 0,
      "the emitted 'decoded-speech' PCM is the exact same resampled audio as what got broadcast (untagged — the broadcast payload is tagAudio()'d, so this compares against the buffer AFTER its 1-byte type tag)"
    );
    bridge.stop();
  }

  // --- TX: a client's tagged AUDIO binary message is resampled and pushed into the TX pipeline ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    controlServer.emit('ptt', true);
    const txPipeline = pipelineFactory.created[1];

    controlServer.emit('binary-message', null, tagAudio(samplePcm()));

    check(txPipeline.written.length === 1, "a client's mic audio is pushed into the TX pipeline");
    bridge.stop();
  }

  // --- TX: a binary message NOT tagged AUDIO is ignored ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    controlServer.emit('ptt', true);
    const txPipeline = pipelineFactory.created[1];

    const notAudio = Buffer.concat([Buffer.from([BINARY_TYPE.SCOPE_LINE]), samplePcm()]);
    controlServer.emit('binary-message', null, notAudio);

    check(txPipeline.written.length === 0, 'a non-AUDIO-tagged binary message is ignored, not fed into the TX pipeline');
    bridge.stop();
  }

  // --- TX: the pipeline's modulated output is written straight to audioBridge.playback ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    controlServer.emit('ptt', true);
    const txPipeline = pipelineFactory.created[1];

    txPipeline.emit('data', sampleComplexFloat32(0.3, 0.9, 64)); // radae_tx's actual output shape — complex float32 IQ, not real PCM

    check(audioBridge.playback.written.length === 1, "the TX pipeline's modulated output is written to audioBridge.playback");
    bridge.stop();
  }

  // --- TX pipeline never runs real2iq — it only converts real audio TO complex IQ, the wrong direction for TX (see rade-bridge.js's own doc comment) ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    controlServer.emit('ptt', true);
    const txStages = pipelineFactory.created[1].opts.stages;

    check(!txStages.some((s) => s.bin === 'real2iq'), 'no real2iq stage anywhere in the TX chain');
    check(txStages[txStages.length - 1].bin === 'radae_tx', 'radae_tx is the last TX stage; its complex IQ stdout is handled in JS (real-part extraction), not by another subprocess');
    bridge.stop();
  }

  // --- TX: only the real (I) part of radae_tx's complex IQ output reaches the radio; the imaginary (Q) part is discarded ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    audioBridge.sampleRate = 8000; // matches RADE_MODEM_SAMPLE_RATE — no resampling, so the extraction math is exact
    const pipelineFactory = makePipelineFactory();
    // txGain: 1 explicitly — this test is about the real/imaginary
    // extraction itself, isolated from the default-gain value (which
    // defaults to 4, not 1, as of the "~20% modulation" fix below; see
    // the dedicated default-gain test further down).
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory, txGain: 1 });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    controlServer.emit('ptt', true);
    const txPipeline = pipelineFactory.created[1];

    const iValues = [0.5, -0.25, 0.1, -0.6];
    const qValues = [0.99, 0.99, -0.99, 0.5]; // deliberately unrelated to I, to prove only I survives
    const iq = Buffer.alloc(iValues.length * 8);
    iValues.forEach((v, i) => {
      iq.writeFloatLE(v, i * 8);
      iq.writeFloatLE(qValues[i], i * 8 + 4);
    });

    txPipeline.emit('data', iq);

    const pcmOut = audioBridge.playback.written[0];
    const decoded = [];
    for (let i = 0; i < iValues.length; i++) decoded.push(pcmOut.readInt16LE(i * 2));
    // Deliberately the generic full-scale (32767) PCM convention, NOT
    // rade_api.h's documented RADE_INT16_SCALE (16384) — an on-air test
    // showed the RADE_INT16_SCALE-scaled level was too quiet on this app's
    // real TX audio chain; see docs/ui-notes.md's "Real bug found:
    // reverting the RADE_INT16_SCALE-based TX scaling" note.
    const expected = iValues.map((v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));
    const allClose = decoded.every((v, i) => Math.abs(v - expected[i]) <= 1);
    check(
      allClose,
      'only the real (I) component reaches the radio, scaled straight to int16 full-scale (not RADE_INT16_SCALE\'s headroom-scaled level — see rade-bridge.js\'s own doc comment for why that was reverted) — the imaginary (Q) component has no effect on the transmitted audio'
    );
    bridge.stop();
  }

  // --- TX: txGain multiplies the extracted real part before it's sent to the radio ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    audioBridge.sampleRate = 8000;
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory, txGain: 2 });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    controlServer.emit('ptt', true);
    const txPipeline = pipelineFactory.created[1];

    const iq = Buffer.alloc(8);
    iq.writeFloatLE(0.3, 0);
    iq.writeFloatLE(0, 4);
    txPipeline.emit('data', iq);

    const pcmOut = audioBridge.playback.written[0];
    const sample = pcmOut.readInt16LE(0);
    const expected = Math.round(Math.min(1, 0.3 * 2) * 32767);
    check(Math.abs(sample - expected) <= 1, "txGain: 2 doubles the real part's amplitude before scaling to int16 (clamped at full scale, same as any other TX audio)");
    bridge.stop();
  }

  // --- TX: txGain defaults to 4, not 1 (real-world-informed correction for a ~20% modulation report — see rade-bridge.js's own doc comment) ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    audioBridge.sampleRate = 8000;
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    controlServer.emit('ptt', true);
    const txPipeline = pipelineFactory.created[1];

    const iq = Buffer.alloc(8);
    iq.writeFloatLE(0.1, 0);
    iq.writeFloatLE(0, 4);
    txPipeline.emit('data', iq);

    const pcmOut = audioBridge.playback.written[0];
    const sample = pcmOut.readInt16LE(0);
    const expected = Math.round(Math.min(1, 0.1 * 4) * 32767);
    check(
      Math.abs(sample - expected) <= 1,
      'txGain defaults to 4 (not 1 / radae_tx\'s own unmodified output level) when not configured — a remote station reported only ~20% modulation at the old default, see docs/ui-notes.md'
    );
    bridge.stop();
  }

  // --- pipeline args omit --v2 by default (V1), and include it only for radeVersion: 'v2' ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxStages = pipelineFactory.created[0].opts.stages;
    const radaeRxStage = rxStages.find((s) => s.bin === 'radae_rx');
    check(!radaeRxStage.args.includes('--v2'), 'defaults to omitting --v2 from radae_rx (RADE V1, the stable waveform per rade_c\'s own README)');
    bridge.stop();
  }
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory, radeVersion: 'v2' });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxStages = pipelineFactory.created[0].opts.stages;
    const radaeRxStage = rxStages.find((s) => s.bin === 'radae_rx');
    check(radaeRxStage.args.includes('--v2'), "radeVersion: 'v2' opts in to the --v2 flag");
    bridge.stop();
  }

  // --- lpcnet_demo stages use the literal '-' stdin/stdout marker, not '/dev/stdin' ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxStages = pipelineFactory.created[0].opts.stages;
    const lpcnetRxStage = rxStages.find((s) => s.args.includes('-fargan-synthesis'));
    check(
      lpcnetRxStage.args[1] === '-' && lpcnetRxStage.args[2] === '-',
      "RX's lpcnet_demo stage uses the literal '-' for both stdin and stdout (the only marker lpcnet_demo.c's own argument parsing special-cases; a real filename like '/dev/stdin' hits its fopen() path instead and can exit(1) if that fails)"
    );
    bridge.stop();

    const controlServer2 = new StubControlServer();
    const audioBridge2 = makeStubAudioBridge();
    const pipelineFactory2 = makePipelineFactory();
    const bridge2 = new RadeBridge({ controlServer: controlServer2, audioBridge: audioBridge2, pipelineFactory: pipelineFactory2 });
    controlServer2.emit('freedv-variant', 'RADE');
    controlServer2.emit('freedv-active', true);
    controlServer2.emit('ptt', true);
    const txStages = pipelineFactory2.created[1].opts.stages;
    const lpcnetTxStage = txStages.find((s) => s.args.includes('-features'));
    check(
      lpcnetTxStage.args[1] === '-' && lpcnetTxStage.args[2] === '-',
      "TX's lpcnet_demo stage uses the literal '-' for both stdin and stdout too"
    );
    bridge2.stop();
  }

  // --- a pipeline error is broadcast as an AUDIO_ERROR event ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxPipeline = pipelineFactory.created[0];

    rxPipeline.emit('error', new Error('radae_rx: ENOENT'));

    const audioErrors = controlServer.broadcasts.filter((b) => b.type === EVENT.AUDIO_ERROR);
    check(audioErrors.length === 1 && /ENOENT/.test(audioErrors[0].data.message), "a pipeline error is broadcast as an AUDIO_ERROR event mentioning the underlying failure");
    bridge.stop();
  }

  // --- stop() detaches everything and stops listening ---
  {
    const controlServer = new StubControlServer();
    const audioBridge = makeStubAudioBridge();
    const pipelineFactory = makePipelineFactory();
    const bridge = new RadeBridge({ controlServer, audioBridge, pipelineFactory });
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('freedv-active', true);
    const rxPipeline = pipelineFactory.created[0];

    bridge.stop();

    check(rxPipeline.stopped, 'stop() tears down any attached pipeline');
    check(audioBridge.rxMuted === false && audioBridge.txMuted === false, 'stop() leaves AudioBridge unmuted in both directions');
    check(controlServer.listenerCount('ptt') === 0, "stop() removes this bridge's 'ptt' listener");
    check(controlServer.listenerCount('freedv-active') === 0, "stop() removes this bridge's 'freedv-active' listener");
    check(controlServer.listenerCount('freedv-variant') === 0, "stop() removes this bridge's 'freedv-variant' listener");
    check(controlServer.listenerCount('binary-message') === 0, "stop() removes this bridge's 'binary-message' listener");

    // Further events are ignored post-stop.
    controlServer.emit('freedv-active', true);
    check(pipelineFactory.created.length === 1, 'events after stop() are ignored (no new pipeline spawned)');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
