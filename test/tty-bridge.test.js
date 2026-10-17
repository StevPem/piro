// Run with: node test/tty-bridge.test.js
'use strict';

const { EventEmitter } = require('events');
const { TtyBridge, DEFAULT_JTTY_TX_FREQ_HZ } = require('../src/audio/tty-bridge');
const { EVENT } = require('../src/server/protocol');
const { encodeJtty } = require('../src/audio/jtty-tx');
const { OLIVIA_MAX_CHARS, HELL_MAX_CHARS } = require('../src/audio/tty-bridge');
const { encodeFeldHell, hellDurationSec } = require('../src/audio/hell-tx');
const { OliviaReceiver, OliviaTextDecoder } = require('../src/audio/olivia-rx');
const { StreamDecimator } = require('../src/audio/decimator');

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
    this.broadcasts = [];
    this.pttCalls = [];
    this.state = { ptt: false, rttyReversed: false };
  }
  broadcastJsonEvent(type, data) {
    this.broadcasts.push({ type, data });
  }
  async setPttFromServer(on) {
    this.pttCalls.push(on);
    this.state.ptt = on;
  }
}
class StubPlayback {
  constructor() {
    this.writes = [];
    this.restarts = 0;
  }
  write(buf) {
    this.writes.push(buf);
  }
  restart() {
    this.restarts++;
  }
}
function setup(opts = {}) {
  const controlServer = new StubControlServer();
  const playback = new StubPlayback();
  const audioBridge = { sampleRate: opts.sampleRate ?? 48000, playback };
  const bridge = new TtyBridge({ controlServer, audioBridge, pttReleaseMarginMs: 20 });
  bridge.start();
  return { controlServer, playback, bridge };
}
const statuses = (cs) => cs.broadcasts.filter((b) => b.type === EVENT.TTY_TX_STATUS).map((b) => b.data);

(async () => {
  // --- RTTY ---
  {
    const { controlServer, playback, bridge } = setup();
    await bridge.send({ mode: 'RTTY', text: 'cq' });
    const st = statuses(controlServer);
    check(st.length === 2 && st[0].status === 'sending' && st[1].status === 'sent', 'RTTY: sending then sent status events');
    check(st[0].mode === 'RTTY' && st[0].message === 'CQ' && st[0].durationSec > 0.5, 'RTTY: status carries the text actually sent and its duration');
    check(controlServer.pttCalls.join() === 'true,false', 'RTTY: PTT keyed on then off');
    check(playback.writes.length === 1 && playback.writes[0].length % 2 === 0 && playback.writes[0].length > 48000, 'RTTY: one PCM buffer written (S16LE, about a second at 48 kHz)');
    check(!bridge.transmitting, 'RTTY: not transmitting afterwards');
  }
  // Reverse setting is honoured
  {
    const a = setup();
    await a.bridge.send({ mode: 'RTTY', text: 'E' });
    const b = setup();
    b.controlServer.state.rttyReversed = true;
    await b.bridge.send({ mode: 'RTTY', text: 'E' });
    check(Buffer.compare(a.playback.writes[0], b.playback.writes[0]) !== 0, 'RTTY: the Reverse setting changes the transmitted tones');
  }
  // Characters RTTY cannot carry are reported
  {
    const { controlServer } = setup();
    await new Promise((r) => {
      const t = new TtyBridge({ controlServer, audioBridge: { sampleRate: 48000, playback: new StubPlayback() }, pttReleaseMarginMs: 5 });
      t.send({ mode: 'RTTY', text: 'A~' }).then(r);
    });
    const st = statuses(controlServer)[0];
    check(st.status === 'sending' && /~/.test(st.note || ''), 'RTTY: dropped characters are reported in a note');
  }

  // --- JTTY ---
  {
    const { controlServer, playback, bridge } = setup();
    controlServer.emit('tty-send', { mode: 'JTTY', text: 'cq vk3tr cq' }); // via the event, as ws-server does
    await sleep(50);
    check(bridge.transmitting, 'JTTY: transmitting while the audio plays');
    await sleep(2100);
    const st = statuses(controlServer);
    check(st[0].status === 'sending' && st[0].nframes === 1 && st[0].message === 'CQ VK3TR CQ', 'JTTY: sending status has canonical text and frame count');
    check(Math.abs(st[0].durationSec - 1.888) < 1e-6 && st[0].freqHz === DEFAULT_JTTY_TX_FREQ_HZ, 'JTTY: 1.888 s at the default frequency');
    check(st.at(-1).status === 'sent', 'JTTY: sent status after the audio has played out');
    check(controlServer.pttCalls.join() === 'true,false', 'JTTY: PTT keyed on then off');
    const expected = encodeJtty('CQ VK3TR CQ', { f0: DEFAULT_JTTY_TX_FREQ_HZ, sampleRate: 48000, amplitude: 1 });
    check(playback.writes[0].length === expected.samples.length * 2, 'JTTY: PCM length is one frame at 48 kHz');
    const mid = 48000; // sample 1 s in
    check(Math.abs(playback.writes[0].readInt16LE(mid * 2) - Math.round(expected.samples[mid] * 32767)) <= 1, 'JTTY: PCM content matches the encoder output');
  }
  // custom frequency + clamping
  {
    const { controlServer, bridge } = setup();
    const p = bridge.send({ mode: 'JTTY', text: 'HI', freqHz: 99999 });
    await sleep(30);
    check(statuses(controlServer)[0].freqHz === 2800, 'JTTY: requested frequency is clamped to the passband');
    bridge.abort();
    await p;
  }
  // non-integer-multiple sample rate falls back to resampling
  {
    const { controlServer, playback, bridge } = setup({ sampleRate: 44100 });
    const p = bridge.send({ mode: 'JTTY', text: 'HI' });
    await sleep(30);
    bridge.abort();
    await p;
    check(playback.writes.length === 1 && playback.writes[0].length > 0, 'JTTY: works at a sample rate that is not a multiple of 12 kHz (resampled)');
  }

  // --- abort ---
  {
    const { controlServer, playback, bridge } = setup();
    const p = bridge.send({ mode: 'JTTY', text: 'THE QUICK BROWN FOX' });
    await sleep(40);
    const t0 = Date.now();
    controlServer.emit('tty-abort');
    await p;
    const st = statuses(controlServer);
    check(Date.now() - t0 < 500, 'abort: the transmission ends promptly');
    check(st.at(-1).status === 'aborted', 'abort: aborted status');
    check(playback.restarts === 1, 'abort: queued audio is discarded (playback restarted)');
    check(controlServer.pttCalls.join() === 'true,false', 'abort: PTT is released');
    check(!bridge.transmitting, 'abort: not transmitting afterwards');
    bridge.abort(); // harmless when idle
    check(playback.restarts === 1, 'abort: no effect when idle');
  }

  // --- refusals ---
  {
    const { controlServer, playback, bridge } = setup();
    const p = bridge.send({ mode: 'JTTY', text: 'HI' });
    await sleep(20);
    let err = null;
    await bridge.send({ mode: 'RTTY', text: 'X' }).catch((e) => (err = e));
    check(err && /already/i.test(err.message), 'a second send while transmitting is refused');
    bridge.abort();
    await p;

    controlServer.state.ptt = true;
    err = null;
    await bridge.send({ mode: 'RTTY', text: 'X' }).catch((e) => (err = e));
    check(err && /already transmitting/i.test(err.message), 'send is refused while PTT is already down');
    controlServer.state.ptt = false;

    for (const bad of [{ mode: 'FT8', text: 'X' }, { mode: 'RTTY', text: '   ' }, { mode: 'RTTY', text: '~~~' }, { mode: 'JTTY', text: 'X'.repeat(0) }]) {
      err = null;
      await bridge.send(bad).catch((e) => (err = e));
      check(err !== null, `refused: ${JSON.stringify(bad)}`);
    }
    const writes = playback.writes.length;
    const st = statuses(controlServer);
    check(st.filter((s) => s.status === 'error').length >= 6, 'refusals are broadcast as error status events');
    check(playback.writes.length === writes, 'refused requests write no audio');
  }

  // --- Olivia ---
  {
    // A one-character message is the shortest Olivia transmission: start
    // tones, one block, stop tones (about 4 s), played out in real time here.
    const { controlServer, playback, bridge } = setup();
    controlServer.emit('tty-send', { mode: 'OLIVIA', text: 'K' });
    await sleep(10);
    check(bridge.transmitting, 'Olivia: transmitting while the audio plays');
    while (bridge.transmitting) await sleep(50);
    const st = statuses(controlServer);
    check(st[0].status === 'sending' && st[0].mode === 'OLIVIA' && st[0].freqHz === 1500, 'Olivia: sending status, at the default 1500 Hz centre');
    check(Math.abs(st[0].durationSec - 4.192) < 0.05, `Olivia: one block plus start/stop tones (${st[0].durationSec.toFixed(2)} s)`);
    check(st.at(-1).status === 'sent' && controlServer.pttCalls.join() === 'true,false', 'Olivia: sent, PTT keyed on then off');
    const i16 = new Int16Array(playback.writes[0].buffer, playback.writes[0].byteOffset, playback.writes[0].length / 2);
    const x8 = new StreamDecimator(48000, 8000, { cutoffHz: 3000 }).process(Int16Array.from(i16));
    const rx = new OliviaReceiver({ centreHz: 1500 });
    const td = new OliviaTextDecoder();
    const text = td.push(rx.process(x8)) + td.push(rx.flush());
    check(text === 'K', `Olivia: the 48 kHz audio written to the radio decodes back to the text (${JSON.stringify(text)})`);
  }
  {
    const { controlServer, playback, bridge } = setup();
    const p = bridge.send({ mode: 'OLIVIA', text: 'CQ CQ DE VK3TR VK3TR K', freqHz: 99999 });
    await sleep(10);
    const st = statuses(controlServer)[0];
    check(st.freqHz === 2600, 'Olivia: requested centre is clamped to the usable range');
    check(Math.abs(st.durationSec - 18.53) < 0.05 && playback.writes[0].length === Math.round(st.durationSec * 48000) * 2, `Olivia: 22 characters take ${st.durationSec.toFixed(1)} s, written as one 48 kHz buffer`);
    bridge.abort();
    await p;
    check(statuses(controlServer).at(-1).status === 'aborted' && playback.restarts === 1, 'Olivia: Stop aborts the transmission and drops the queued audio');
  }
  {
    const { controlServer, bridge } = setup();
    const p = bridge.send({ mode: 'OLIVIA', text: 'Ω OK' });
    await sleep(10);
    check(/Ω/.test(statuses(controlServer)[0].note || ''), 'Olivia: characters it cannot carry are reported in a note');
    bridge.abort();
    await p;
    let err = null;
    await bridge.send({ mode: 'OLIVIA', text: 'X'.repeat(OLIVIA_MAX_CHARS + 1) }).catch((e) => (err = e));
    check(err && /too long/i.test(err.message), `Olivia: more than ${OLIVIA_MAX_CHARS} characters is refused`);
  }
  {
    const { controlServer, playback, bridge } = setup({ sampleRate: 44100 });
    const p = bridge.send({ mode: 'OLIVIA', text: 'HI' });
    await sleep(10);
    check(playback.writes.length === 1 && playback.writes[0].length > 0, 'Olivia: works at 44.1 kHz too (resampled)');
    bridge.abort();
    await p;
    check(controlServer.pttCalls.join() === 'true,false', 'Olivia: PTT released after abort');
  }

  // --- Feld-Hell ---
  {
    const { controlServer, playback, bridge } = setup();
    const p = bridge.send({ mode: 'HELL', text: 'CQ DE VK3TR', freqHz: 1234.4 });
    await sleep(10);
    const st = statuses(controlServer)[0];
    check(st.status === 'sending' && st.mode === 'HELL' && st.freqHz === 1234, 'Feld-Hell: sending status, at the requested (rounded) tone');
    check(Math.abs(st.durationSec - hellDurationSec('CQ DE VK3TR')) < 0.01, `Feld-Hell: duration as estimated (${st.durationSec.toFixed(2)} s)`);
    const i16 = new Int16Array(playback.writes[0].buffer, playback.writes[0].byteOffset, playback.writes[0].length / 2);
    const x8 = new StreamDecimator(48000, 8000, { cutoffHz: 3000 }).process(Int16Array.from(i16));
    const ref = encodeFeldHell('CQ DE VK3TR', { toneHz: 1234 }).samples;
    // the 48 kHz audio, brought back to 8 kHz, is the 8 kHz modulator output (bar the
    // filtering and a fractional-sample delay, which costs a little correlation at 1234 Hz)
    let best = 0;
    for (let lag = 0; lag < 40; lag++) {
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i + lag < x8.length && i < ref.length; i++) {
        const a = x8[i + lag] / 32768;
        sxy += a * ref[i];
        sxx += a * a;
        syy += ref[i] * ref[i];
      }
      best = Math.max(best, sxy / Math.sqrt(sxx * syy));
    }
    check(best > 0.9, `Feld-Hell: the 48 kHz audio written to the radio is the modulator's output (r = ${best.toFixed(4)})`);
    bridge.abort();
    await p;
    check(controlServer.pttCalls.join() === 'true,false', 'Feld-Hell: PTT keyed on then off');
  }
  {
    const { controlServer, bridge } = setup();
    const p = bridge.send({ mode: 'HELL', text: 'Ω OK', freqHz: 50 });
    await sleep(10);
    const st = statuses(controlServer)[0];
    check(/Ω/.test(st.note || '') && st.freqHz === 300, 'Feld-Hell: characters outside the font are reported, tone clamped to 300 Hz');
    bridge.abort();
    await p;
    let err = null;
    await bridge.send({ mode: 'HELL', text: 'X'.repeat(HELL_MAX_CHARS + 1) }).catch((e) => (err = e));
    check(err && /too long/i.test(err.message), `Feld-Hell: more than ${HELL_MAX_CHARS} characters is refused`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll TTY bridge checks passed');
})();
