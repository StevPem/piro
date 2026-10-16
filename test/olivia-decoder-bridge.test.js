// Run with: node test/olivia-decoder-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { OliviaDecoderBridge, SPECTRUM_FFT_SIZE } = require('../src/server/olivia-decoder-bridge');
const { EVENT, BINARY_TYPE } = require('../src/server/protocol');
const { encodeOlivia } = require('../src/audio/olivia-tx');
const { upsampleFloatToPcm } = require('../src/audio/resample');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StubControlServer extends EventEmitter {
  constructor() {
    super();
    this.state = { oliviaActive: false, oliviaCentreHz: 1500 };
    this.broadcasts = [];
    this.binary = [];
  }
  broadcastBinary(buf) {
    this.binary.push(buf);
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
}

class StubWorker extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.terminated = false;
  }
  postMessage(m) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
}

function tone(n, hz = 1500, rate = 48000) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return b;
}

function setup({ rate = 48000, squelch } = {}) {
  const controlServer = new StubControlServer();
  const capture = new EventEmitter();
  const worker = new StubWorker();
  const bridge = new OliviaDecoderBridge({ controlServer, audioBridge: { capture, sampleRate: rate }, squelch, worker, now: () => 1_234_000 });
  bridge.start();
  return { controlServer, capture, worker, bridge };
}

(async () => {
  {
    const { controlServer, capture, worker, bridge } = setup();
    check(!bridge.attached && capture.listenerCount('data') === 0 && worker.sent.length === 0, 'idle until Olivia is selected');

    controlServer.emit('olivia-active', { active: true, centreHz: 1500 });
    check(bridge.attached && capture.listenerCount('data') === 1, 'attaches to capture when Olivia is armed');
    check(worker.sent[0]?.type === 'config' && worker.sent[0].centreHz === 1500 && worker.sent[0].squelch === true, 'worker gets a fresh receiver at the centre, with PiRO\'s squelch on');

    capture.emit('data', tone(4800));
    const samples = worker.sent.filter((m) => m.type === 'samples');
    const total = samples.reduce((n, m) => n + m.samples.byteLength / 4, 0);
    check(samples.length > 0 && total >= 780 && total <= 800, `48 kHz audio is decimated to 8 kHz (${total} samples from 4800)`);

    capture.emit('data', tone(48000, 1500));
    await sleep(600);
    const frame = controlServer.binary[0];
    check(frame && frame[0] === BINARY_TYPE.FT8_SPECTRUM, 'a 0-3 kHz audio spectrum frame is broadcast while Olivia is armed');
    if (frame) {
      const bins = frame.subarray(5);
      const binHz = 8000 / SPECTRUM_FFT_SIZE;
      const at = (hz) => bins[Math.round(hz / binHz)];
      check(bins.length === Math.round(3000 / binHz) && at(1500) > 200 && at(700) < 100, `the spectrum covers 0-3 kHz and shows the 1500 Hz tone (${at(1500)} there, ${at(700)} at 700 Hz)`);
    }

    const before = worker.sent.length;
    controlServer.emit('olivia-active', { active: true, centreHz: 1820 });
    check(bridge.centreHz === 1820 && worker.sent.slice(before).some((m) => m.type === 'config' && m.centreHz === 1820), 'a new centre retunes the receiver');

    controlServer.emit('ptt', true);
    check(!bridge.attached && capture.listenerCount('data') === 0, 'detaches while transmitting');
    check(worker.sent.at(-1).type === 'flush', 'flushes the worker on detach');
    controlServer.emit('ptt', false);
    check(bridge.attached && worker.sent.at(-1).type === 'config', 're-attaches after PTT with a fresh receiver');

    worker.emit('message', { type: 'text', text: 'CQ ', snr: 8.9, freqOffsetHz: 15.625, centreHz: 1820 });
    const ev = controlServer.broadcasts.find((b) => b.type === EVENT.OLIVIA_TEXT);
    check(ev && ev.data.text === 'CQ ' && ev.data.snr === 8.9 && ev.data.freqOffsetHz === 15.625 && ev.data.centreHz === 1820 && ev.data.time === 1_234_000, 'decoded text is broadcast as olivia-text');

    controlServer.emit('olivia-active', { active: false });
    check(!bridge.attached, 'detaches when Olivia is disarmed');
    bridge.stop();
    check(worker.terminated, 'stop() terminates the worker');
  }
  {
    const { worker, controlServer } = setup({ squelch: false });
    controlServer.emit('olivia-active', { active: true });
    check(worker.sent[0].squelch === false, 'OLIVIA_SQUELCH=off is passed to the worker (fldigi behaviour)');
  }
  {
    const { controlServer, capture, worker } = setup();
    controlServer.emit('olivia-active', { active: true });
    let sent = 0;
    for (let i = 0; i < 40; i++) {
      capture.emit('data', tone(48000));
      sent = worker.sent.filter((m) => m.type === 'samples').length;
    }
    check(sent >= 18 && sent <= 22, `unacknowledged audio stops being queued after ~20 s (${sent} seconds sent of 40)`);
    check(controlServer.broadcasts.some((b) => b.type === EVENT.AUDIO_ERROR && /falling behind/.test(b.data.message)), 'overload is reported');
  }
  {
    const { controlServer, capture, bridge } = setup({ rate: 44100 });
    controlServer.emit('olivia-active', { active: true });
    check(!bridge.attached && capture.listenerCount('data') === 0, 'unsupported sample rate: does not attach');
    check(controlServer.broadcasts.some((b) => b.type === EVENT.AUDIO_ERROR && /multiple of 8000/.test(b.data.message)), 'unsupported sample rate is reported');
  }
  {
    const controlServer = new StubControlServer();
    controlServer.state.oliviaActive = true;
    controlServer.state.oliviaCentreHz = 1250;
    const bridge = new OliviaDecoderBridge({ controlServer, audioBridge: { capture: new EventEmitter(), sampleRate: 48000 }, worker: new StubWorker() });
    bridge.start();
    check(bridge.attached && bridge.centreHz === 1250, 'arms at start-up, at the saved centre, if a client already has Olivia selected');
  }

  // End to end with the real worker thread: an Olivia signal 30 Hz off the
  // receiver's centre, fed as 48 kHz capture chunks.
  {
    const controlServer = new StubControlServer();
    const capture = new EventEmitter();
    const bridge = new OliviaDecoderBridge({ controlServer, audioBridge: { capture, sampleRate: 48000 } });
    bridge.start();
    controlServer.emit('olivia-active', { active: true, centreHz: 1200 });
    const enc = encodeOlivia('CQ CQ DE VK3TR VK3TR K\r\n', { centreHz: 1230, amplitude: 0.3 });
    const pcm = upsampleFloatToPcm(enc.samples, 8000, 48000);
    const silence = Buffer.alloc(48000 * 2);
    const all = Buffer.concat([silence, pcm, silence]);
    // Faster than real time, but never more than a few seconds ahead of the worker.
    for (let i = 0; i < all.length; i += 9600) {
      capture.emit('data', all.subarray(i, i + 9600));
      while ((bridge._sentSamples - bridge._ackedSamples) / 8000 > 3) await sleep(5);
    }
    check(!controlServer.broadcasts.some((b) => b.type === EVENT.AUDIO_ERROR), 'the real worker keeps up (no overload reported)');
    controlServer.emit('ptt', true); // detach -> flush, as when the operator starts to transmit
    const deadline = Date.now() + 15000;
    const text = () => controlServer.broadcasts.filter((b) => b.type === EVENT.OLIVIA_TEXT).map((b) => b.data.text).join('');
    while (Date.now() < deadline && !text().endsWith('\r\n')) await sleep(100);
    const evs = controlServer.broadcasts.filter((b) => b.type === EVENT.OLIVIA_TEXT);
    check(text() === 'CQ CQ DE VK3TR VK3TR K\r\n', `real worker decodes the transmission exactly (${JSON.stringify(text())})`);
    check(evs.length > 0 && evs.every((e) => e.data.centreHz === 1200 && Math.abs(e.data.freqOffsetHz - 30) < 16 && e.data.snr > 3), 'and reports the centre, a ~30 Hz offset and the S/N with each block');
    bridge.stop();
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll Olivia decoder bridge checks passed');
})();
