// Run with: node test/jtty-decoder-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { JttyDecoderBridge } = require('../src/server/jtty-decoder-bridge');
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
    this.state = { jttyActive: false };
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

function pcm(n, rate = 48000) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 1500 * i) / rate)), i * 2);
  return b;
}

function setup(rate = 48000) {
  const controlServer = new StubControlServer();
  const capture = new EventEmitter();
  const worker = new StubWorker();
  let t = 1_000_000;
  const bridge = new JttyDecoderBridge({
    controlServer,
    audioBridge: { capture, sampleRate: rate },
    worker,
    now: () => t,
  });
  bridge.start();
  return { controlServer, capture, worker, bridge };
}

(async () => {
  const { controlServer, capture, worker, bridge } = setup();
  check(worker.sent[0]?.type === 'config' && worker.sent[0].lowHz === 200 && worker.sent[0].highHz === 2900 && worker.sent[0].quality === 'economy', 'worker is configured with the default search band and economy effort');
  check(!bridge.attached && capture.listenerCount('data') === 0, 'idle until JTTY is selected');

  controlServer.emit('jtty-active', true);
  check(bridge.attached && capture.listenerCount('data') === 1, 'attaches to capture when JTTY is armed');
  check(worker.sent.some((m) => m.type === 'reset'), 'worker is reset on attach');

  capture.emit('data', pcm(4800));
  const samples = worker.sent.filter((m) => m.type === 'samples');
  const total = samples.reduce((n, m) => n + m.samples.byteLength / 4, 0);
  check(samples.length > 0 && total > 1000 && total <= 1200, `48 kHz audio is decimated to 12 kHz (${total} samples from 4800)`);

  capture.emit('data', pcm(48000));
  await new Promise((r) => setTimeout(r, 600));
  const frame = controlServer.binary[0];
  check(frame && frame[0] === BINARY_TYPE.FT8_SPECTRUM, 'a 0-3 kHz audio spectrum frame is broadcast while JTTY is armed');
  if (frame) {
    const bins = frame.subarray(5);
    const binHz = 12000 / 4096;
    const at = (hz) => bins[Math.round(hz / binHz)];
    check(at(1500) > 200 && at(700) < 100 && at(2600) < 100, `the spectrum shows the 1500 Hz test tone (${at(1500)} there, ${at(700)} at 700 Hz)`);
  }
  controlServer.emit('ptt', true);
  check(!bridge.attached && capture.listenerCount('data') === 0, 'detaches while transmitting');
  {
    const n = controlServer.binary.length;
    await new Promise((r) => setTimeout(r, 700));
    check(controlServer.binary.length === n, 'no spectrum frames are sent while detached (the timer is stopped)');
  }
  check(worker.sent[worker.sent.length - 1].type === 'flush', 'flushes the worker on detach');
  controlServer.emit('ptt', false);
  check(bridge.attached, 're-attaches after PTT release');

  worker.emit('message', {
    type: 'update',
    update: { id: 3, freqHz: 1506.94, snr: -7, text: 'RAN ALL', status: 'growing', startTime: 1.5, latestTime: 3.4 },
  });
  const ev = controlServer.broadcasts.find((b) => b.type === EVENT.JTTY_TEXT);
  check(
    ev && ev.data.id === 3 && ev.data.freqHz === 1506.9 && ev.data.text === 'RAN ALL' && ev.data.status === 'growing' &&
      ev.data.time === 1_003_400 && ev.data.startTime === 1_001_500,
    'worker updates are broadcast as jtty-text with epoch-ms times'
  );

  controlServer.emit('jtty-active', false);
  check(!bridge.attached, 'detaches when JTTY is disarmed');
  bridge.stop();
  check(worker.terminated, 'stop() terminates the worker');
})().then(() => {

{
  const { controlServer, capture, worker } = setup();
  controlServer.emit('jtty-active', true);
  // Never acknowledge: the backlog should hit the cap and further audio be dropped.
  let sent = 0;
  for (let i = 0; i < 40; i++) {
    capture.emit('data', pcm(48000));
    sent = worker.sent.filter((m) => m.type === 'samples').length;
  }
  check(sent >= 18 && sent <= 22, `unacknowledged audio stops being queued after ~20 s (${sent} seconds sent of 40)`);
  check(controlServer.broadcasts.some((b) => b.type === EVENT.AUDIO_ERROR && /falling behind/.test(b.data.message)), 'overload is reported');
  for (let i = 0; i < 20; i++) worker.emit('message', { type: 'ack', samples: 12000 });
  const before = worker.sent.filter((m) => m.type === 'samples').length;
  capture.emit('data', pcm(48000));
  check(worker.sent.filter((m) => m.type === 'samples').length > before, 'queuing resumes once the worker catches up');
}

{
  const { controlServer, capture, bridge } = setup(44100);
  controlServer.emit('jtty-active', true);
  check(!bridge.attached && capture.listenerCount('data') === 0, 'unsupported sample rate: does not attach');
  check(controlServer.broadcasts.some((b) => b.type === EVENT.AUDIO_ERROR && /multiple of 12000/.test(b.data.message)), 'unsupported sample rate is reported once');
}

{
  const controlServer = new StubControlServer();
  controlServer.state.jttyActive = true;
  const capture = new EventEmitter();
  const bridge = new JttyDecoderBridge({ controlServer, audioBridge: { capture, sampleRate: 48000 }, worker: new StubWorker() });
  bridge.start();
  check(bridge.attached, 'arms at start-up if a client already has JTTY selected');
}


if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll JTTY decoder bridge checks passed');
});
