// Run with: node test/vara.test.js
// VARA chat: the Xara modem in WebAssembly (audio/xara/xara.js), and two
// VaraBridges (server/vara-bridge.js, each with its real worker) joined by a
// simulated channel: CQ, call, text both ways, disconnect. The modems run
// faster than real time (their clock is the audio fed to them).
'use strict';

const { EventEmitter } = require('events');
const { XaraModem, BLOCK } = require('../src/audio/xara/xara');
const { VaraBridge, varaConfig, encodeText, cleanText } = require('../src/server/vara-bridge');
const { EVENT } = require('../src/server/protocol');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (err) {
    return re.test(err.message);
  }
};

class StubCiv {
  constructor({ dataModeWorks = true } = {}) {
    this.dataMode = false;
    this.dataModeWorks = dataModeWorks;
  }
  async setDataMode(on) {
    if (this.dataModeWorks) this.dataMode = on;
  }
  async getDataMode() {
    return this.dataMode;
  }
}

class StubControlServer extends EventEmitter {
  constructor(civ) {
    super();
    this.civ = civ;
    this.state = { ptt: false, varaActive: false };
    this.events = [];
    this.pttLog = [];
    this.direct = [];
  }
  broadcastJsonEvent(type, data) {
    this.events.push({ type, data: JSON.parse(JSON.stringify(data)) });
  }
  sendJsonEvent(ws, type, data) {
    this.direct.push({ ws, type, data });
  }
  async setPttFromServer(on) {
    this.state.ptt = on;
    this.pttLog.push(on);
  }
  text() {
    return this.events
      .filter((e) => e.type === EVENT.VARA_TEXT)
      .map((e) => e.data.text)
      .join('');
  }
  errors() {
    return this.events.filter((e) => e.type === EVENT.AUDIO_ERROR).map((e) => e.data.message);
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
  commands() {
    return this.sent.filter((m) => m.type === 'command').map((m) => m.line);
  }
}

function station(call, opts = {}) {
  const civ = opts.civ === undefined ? new StubCiv() : opts.civ;
  const controlServer = new StubControlServer(civ);
  const capture = new EventEmitter();
  const playback = {
    queue: [],
    queued: 0,
    played: 0,
    restarts: 0,
    write(buf) {
      this.queue.push(buf);
      this.queued += buf.length / 2;
      this.played += buf.length / 2;
    },
    restart() {
      this.restarts++;
    },
    take(n) {
      // The next n samples written (silence if there aren't that many yet).
      const out = Buffer.alloc(n * 2);
      let at = 0;
      while (at < out.length && this.queue.length) {
        const b = this.queue[0];
        const k = Math.min(b.length, out.length - at);
        b.copy(out, at, 0, k);
        at += k;
        if (k === b.length) this.queue.shift();
        else this.queue[0] = b.subarray(k);
      }
      this.queued -= at / 2;
      return out;
    },
  };
  const bridge = new VaraBridge({
    controlServer,
    audioBridge: { capture, playback, sampleRate: opts.rate ?? 48000 },
    callsign: call,
    latencyMs: 100,
    leadMs: 0,
    dataSettleMs: 0,
    dataWatchMs: 60000,
    ...opts.bridge,
  });
  bridge.start();
  return { call, civ, controlServer, capture, playback, bridge, fed: 0 };
}

async function main() {
  // --- Small pieces ---
  check(encodeText('Hi é€\nthere').equals(Buffer.from([0x48, 0x69, 0x20, 0xe9, 0x3f, 0x20, 0x74, 0x68, 0x65, 0x72, 0x65, 0x0d])), 'encodeText: Latin-1, ? for the rest, one line ending in CR');
  check(cleanText('a\rb\r\nc\x07\x1b[d') === 'a\nb\nc[d', 'cleanText: CR as a line break, control characters dropped');
  {
    const d = varaConfig({});
    const c = varaConfig({ VARA_BW: '2300', VARA_AUDIO_LATENCY_MS: '250' });
    const bad = varaConfig({ VARA_BW: '1000', VARA_AUDIO_LATENCY_MS: 'x' });
    check(d.bw === 500 && d.latencyMs === 500 && d.warnings.length === 0, 'varaConfig defaults: 500 Hz, 500 ms');
    check(c.bw === 2300 && c.latencyMs === 250, 'varaConfig reads VARA_BW and VARA_AUDIO_LATENCY_MS');
    check(bad.bw === 500 && bad.latencyMs === 500 && bad.warnings.length === 2, 'varaConfig reports bad values and uses the defaults');
  }

  // --- The modem itself ---
  {
    check(throws(() => new XaraModem({ call: 'VK3TR', bw: 1000 }), /bandwidth/), 'XaraModem refuses a bandwidth VARA does not have');
    const m = new XaraModem({ call: 'VK3TR' });
    m.command('VERSION');
    m.command('BW2300');
    m.command('NONSENSE');
    m.process(new Float32Array(BLOCK));
    const lines = m.takeLines();
    check(lines[0] === 'VERSION VARA HF v4.9.0', 'the modem answers VERSION as VARA HF 4.9.0 does');
    check(lines[1] === 'OK' && lines[2] === 'WRONG', 'it accepts BW2300 and refuses an unknown command');
    check(m.ptt === false && m.buffered === 0, 'idle: not keyed, nothing to send');
  }

  // --- Without a callsign, or 48 kHz audio ---
  {
    const s = station('', { bridge: { callsign: '' } });
    check(s.controlServer.state.vara.available === false && /STATION_CALLSIGN/.test(s.controlServer.state.vara.reason), 'no callsign: VARA unavailable, and the snapshot says why');
    await s.bridge.activate();
    check(!s.bridge.active && /STATION_CALLSIGN/.test(s.controlServer.errors()[0] || ''), 'activating it anyway reports why');
    check(throws(() => s.bridge.request({ action: 'cq' }), /STATION_CALLSIGN/), 'and requests fail with the reason');
    const r = station('VK3TR', { rate: 8000 });
    check(/48000 Hz/.test(r.controlServer.state.vara.reason), 'audio not at 48 kHz: VARA unavailable');
  }

  // --- Two stations on a simulated channel ---
  const a = station('VK3TR');
  const b = station('VK3ABC');
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const CHUNK = 4800; // 100 ms, as arecord delivers it
  let simSec = 0;
  async function step() {
    for (const [to, from] of [
      [a, b],
      [b, a],
    ]) {
      const audio = from.playback.take(CHUNK);
      for (let i = 0; i < CHUNK; i++) audio.writeInt16LE(Math.max(-32767, Math.min(32767, audio.readInt16LE(i * 2) + Math.round((rnd() - 0.5) * 300))), i * 2);
      to.capture.emit('data', audio);
      to.fed += CHUNK;
    }
    // Lockstep: wait for each modem's transmit audio for what it was given.
    const t0 = Date.now();
    while ((a.playback.played < a.fed || b.playback.played < b.fed) && Date.now() - t0 < 5000) await sleep(1);
    simSec += CHUNK / 48000;
  }
  async function until(fn, sec) {
    const end = simSec + sec;
    while (!fn() && simSec < end) await step();
    return fn();
  }

  await a.bridge.activate();
  await b.bridge.activate();
  check(a.bridge.active && a.controlServer.state.vara.state === 'listening', 'activated: listening');
  check(a.civ.dataMode === true, 'DATA mode is turned on (and read back) on activation');
  check(throws(() => a.bridge.request({ action: 'send', text: 'hi' }), /Connect to a station first/), "'send' before a QSO is refused");
  check(throws(() => a.bridge.request({ action: 'connect', call: 'not a call' }), /not a callsign/), "'connect' needs a callsign");
  check(throws(() => a.bridge.request({ action: 'connect', call: 'vk3tr' }), /own callsign/), "'connect' to this station's own callsign is refused");
  await until(() => false, 1);

  a.bridge.request({ action: 'cq' });
  const heard = await until(() => b.controlServer.state.vara.heard.some((h) => h.call === 'VK3TR'), 20);
  check(heard, 'B hears A calling CQ (in its heard list)');
  check(/CQ from VK3TR \(500 Hz\)/.test(b.controlServer.text()), "and the CQ is noted in B's conversation");
  check(a.controlServer.pttLog[0] === true && a.controlServer.pttLog.includes(false), 'A keyed PTT for its CQ frame, and released it');
  await until(() => false, 2);

  a.bridge.request({ action: 'connect', call: 'vk3abc' });
  check(a.controlServer.state.vara.state === 'calling' && a.controlServer.state.vara.peer === 'VK3ABC', 'A is calling VK3ABC');
  check(throws(() => a.bridge.request({ action: 'cq' }), /free/), 'no CQ while calling');
  const linked = await until(() => a.controlServer.state.vara.state === 'connected' && b.controlServer.state.vara.state === 'connected', 90);
  check(linked, 'the stations connect');
  check(a.controlServer.state.vara.peer === 'VK3ABC' && b.controlServer.state.vara.peer === 'VK3TR' && a.controlServer.state.vara.linkBw === 500, 'each shows the other as its peer, at 500 Hz');
  check(/Connected to VK3TR \(500 Hz\)/.test(b.controlServer.text()), 'B notes the connection');

  a.bridge.request({ action: 'send', text: 'Hello from VK3TR via PiRO' });
  check(a.controlServer.events.some((e) => e.type === EVENT.VARA_TEXT && e.data.own && e.data.text === 'Hello from VK3TR via PiRO\n'), "A's own line is shown at once, marked own");
  const got1 = await until(() => b.controlServer.text().includes('Hello from VK3TR via PiRO\n'), 90);
  check(got1, 'B receives the line (CR shown as a line break)');
  b.bridge.request({ action: 'send', text: 'VK3ABC here, 73' });
  const got2 = await until(() => a.controlServer.text().includes('VK3ABC here, 73\n'), 90);
  check(got2, 'A receives the reply');
  check(Number.isFinite(a.controlServer.state.vara.sn) && a.controlServer.state.vara.bitrate > 0, 'the link reports S/N and speed');
  check(a.controlServer.state.vara.ptt === false || a.controlServer.state.ptt === a.controlServer.state.vara.ptt, 'PTT state and the radio agree');

  // A browser that connects now is sent the conversation so far.
  b.controlServer.emit('client-connected', 'ws1');
  const replay = b.controlServer.direct.find((d) => d.type === EVENT.VARA_TEXT);
  check(replay?.data.replace === true && replay.data.segments.some((s) => s.text.includes('Hello from VK3TR')) && replay.data.segments.some((s) => s.own && s.text.includes('73')), 'a browser that connects is sent the conversation, with own text marked');

  a.bridge.request({ action: 'disconnect' });
  check(a.controlServer.state.vara.state === 'disconnecting', 'A is disconnecting');
  const down = await until(() => a.controlServer.state.vara.state === 'listening' && b.controlServer.state.vara.state === 'listening', 60);
  check(down, 'both are back to listening');
  check(/Disconnected from VK3ABC/.test(a.controlServer.text()) && /Disconnected from VK3TR/.test(b.controlServer.text()), 'both note the disconnection');
  check(a.controlServer.state.ptt === false && b.controlServer.state.ptt === false, 'neither is left transmitting');
  console.log(`  (${simSec.toFixed(1)} s of simulated audio)`);

  await a.bridge.stop();
  await b.bridge.stop();
  check(a.controlServer.state.vara.state === 'off' && a.playback.restarts === 1, 'stopping: off, and the queued transmit audio is thrown away');
  check(a.capture.listenerCount('data') === 0, 'and the receive audio is no longer listened to');

  // --- Safety, with a stub worker ---
  {
    const w = new StubWorker();
    const s = station('VK3TR', { bridge: { createWorker: () => w, maxKeyMs: 40, idleMs: 60 } });
    await s.bridge.activate();
    check(w.sent[0].type === 'init' && w.sent[0].call === 'VK3TR' && w.sent[0].latencyMs === 100, 'the worker is started with the callsign and audio latency');
    const cmds = w.commands();
    check(['MYCALL VK3TR', 'BW500', 'CHAT ON', 'P2P SESSION', 'COMPRESSION TEXT', 'LISTEN ON'].every((c) => cmds.includes(c)), 'VARA Chat settings are sent, and LISTEN ON');
    w.emit('message', { type: 'lines', lines: cmds.map(() => 'OK') });
    w.emit('message', { type: 'lines', lines: ['PTT ON'] });
    await sleep(5);
    check(s.controlServer.state.ptt === true && s.controlServer.state.vara.ptt === true, "the modem's PTT ON keys the radio");
    await sleep(80);
    check(s.controlServer.state.ptt === false && w.commands().at(-1) === 'ABORT', 'a transmission longer than the limit is cut off (PTT off, ABORT)');
    check(s.controlServer.errors().some((e) => /ran past/.test(e)), 'and the operator is told');
    w.emit('message', { type: 'lines', lines: ['CONNECTED VK3ABC VK3TR 500'] });
    check(s.controlServer.state.vara.state === 'connected' && s.controlServer.state.vara.peer === 'VK3ABC', 'an incoming call: connected, with the caller as peer');
    await sleep(100);
    check(w.commands().at(-1) === 'DISCONNECT' && /Nothing sent or received/.test(s.controlServer.text()), 'an idle link is disconnected');
    w.emit('message', { type: 'lines', lines: ['OK', 'OK', 'DISCONNECTED'] }); // for the ABORT and DISCONNECT
    s.bridge.request({ action: 'connect', call: 'VK3XYZ' });
    w.emit('message', { type: 'lines', lines: ['WRONG'] });
    check(s.controlServer.state.vara.state === 'listening' && s.controlServer.errors().some((e) => /would not call/.test(e)), 'a refused CONNECT goes back to listening, with a message');
    s.bridge.request({ action: 'connect', call: 'VK3XYZ' });
    w.emit('message', { type: 'lines', lines: ['OK', 'DISCONNECTED'] });
    check(/No answer from VK3XYZ/.test(s.controlServer.text()), 'a call that fails: "No answer"');
    s.controlServer.emit('vara-active', false);
    await sleep(5);
    check(w.terminated && w.commands().at(-1) === 'ABORT' && s.controlServer.state.vara.state === 'off', "'vara-active' false: ABORT and the worker ended");
  }
  {
    // DATA mode can't be confirmed: receive, but never key.
    const w = new StubWorker();
    const s = station('VK3TR', { civ: new StubCiv({ dataModeWorks: false }), bridge: { createWorker: () => w } });
    await s.bridge.activate();
    check(s.controlServer.errors().some((e) => /DATA mode/.test(e) && /not transmit/.test(e)), 'DATA mode not confirmed: the operator is told');
    w.emit('message', { type: 'lines', lines: ['PTT ON'] });
    await sleep(5);
    check(s.controlServer.state.ptt === false && s.controlServer.pttLog.length === 0, 'and the radio is never keyed');
    await s.bridge.stop();
  }

  if (failures) {
    console.error(`${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log('All tests passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
