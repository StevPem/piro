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
const varac = require('../src/server/varac');

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
  async setFrequency(hz) {
    this.freq = hz;
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

  // --- VarAC's formats (server/varac.js, from hfmodem) ---
  {
    const d = (c) => varac.decodeCqCall(c);
    check(d('F6JON-11').offsetHz === 750 && d('F6JON-15').offsetHz === 3750 && d('F6JON-1').offsetHz === -750 && d('F6JON-5').offsetHz === -3750, 'CQ suffixes: -1..-5 are 750-3750 Hz down, -11..-15 up');
    check(d('N1AMD-9').beacon && d('N1AMD-9').call === 'N1AMD', '-9 is a beacon');
    check(d('VK3ABC-7').call === 'VK3ABC-7' && d('VK3ABC-7').slot === null && d('VK3ABC').slot === null, 'any other suffix is a real SSID, kept; no suffix, no slot');
    check(varac.frameMessage('héllo').toString('latin1') === '6 h\xc3\xa9llo', 'a message is its UTF-8 length, a space, the text');
    check(varac.qsyRequest(750) === '<Q:75>' && varac.qsyRequest(-3750) === '<Q:-375>' && varac.qsyRequest(2250) === '<Q:225>', 'QSY request as stock VarAC sends it: <Q:n>, n in tens of Hz');
    check(varac.qsyTarget('<Q:-375>', 14105000) === 14101250 && varac.qsyTarget('<QSYF>000014105750</QSYF>', 14105000) === 14105750, 'and both forms are followed');
    check(varac.openingMessage('VK3TR', 7.6) === 'de VK3TR <R+08>' && varac.openingMessage('VK3TR', -120) === 'de VK3TR <R-99>', 'opening report: "de CALL <R+08>", -99..+99');
    const p = new varac.MessageParser();
    const a = p.feed(Buffer.from('5 hel'));
    const b = p.feed(Buffer.from('lo3 abc'));
    check(a.messages.length === 0 && b.messages.join('|') === 'hello|abc', 'messages are put back together across chunks');
    const q = new varac.MessageParser();
    check(q.feed(Buffer.from('Hello\r')).plain === 'Hello\r' && q.feed(Buffer.from('12 more')).plain === '12 more', 'a stream that is not framed is plain text from then on');
    const r = varac.renderMessage('de F6JON <R-05>', 'F6JON');
    check(r.note && r.text === 'F6JON reports your signal at -5 dB\n', 'the opening report reads as a note');
    const t = varac.renderMessage('Name here <NAME:Jean> ok', 'F6JON');
    check(!t.note && t.text === 'Name here  ok\n(name Jean)\n', 'tags inside text are put into words after it');
    check(varac.renderMessage('<FOO:bar>', 'X').text === '<FOO:bar>\n', 'unknown tags are shown as they are');
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
    const started = s.controlServer.events.filter((e) => e.type === EVENT.VARA_STATUS);
    check(started.length === 1 && started[0].data.available === false, 'starting the bridge broadcasts its state (for a browser that connected before it existed)');
    await s.bridge.activate();
    check(!s.bridge.active && /STATION_CALLSIGN/.test(s.controlServer.errors()[0] || ''), 'activating it anyway reports why');
    check(s.controlServer.events.filter((e) => e.type === EVENT.VARA_STATUS).length === 2, 'and broadcasts the state again, so the panel shows the reason');
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
  check(/VK3TR reports your signal at \d+ dB/.test(b.controlServer.text()) && /VK3ABC reports your signal at \d+ dB/.test(a.controlServer.text()), 'each sent VarAC\'s opening report, and the other shows it');
  check(/VK3TR is closing the QSO/.test(b.controlServer.text()), "A's <DISC> reached B before the link closed");
  check(a.controlServer.state.ptt === false && b.controlServer.state.ptt === false, 'neither is left transmitting');

  // On the calling frequency, as VarAC does: the answerer says it is ready (<Q>),
  // the caller asks to QSY 750 Hz up (<Q:75>), both move, <TL>, <QSYR>, then the reports.
  a.controlServer.state.frequency = 14105000;
  b.controlServer.state.frequency = 14105000;
  const aText0 = a.controlServer.text().length;
  const bText0 = b.controlServer.text().length;
  a.bridge.request({ action: 'connect', call: 'VK3ABC' });
  const relinked = await until(() => a.controlServer.state.vara.state === 'connected' && b.controlServer.state.vara.state === 'connected', 90);
  check(relinked, 'connected again, on the calling frequency');
  const ready = await until(() => a.controlServer.state.vara.qsyReady, 60);
  check(ready && /VK3ABC is ready to QSY off the calling frequency/.test(a.controlServer.text().slice(aText0)), "on the calling frequency the answerer sends VarAC's <Q>, and the caller sees it is ready to QSY");
  check(!/reports your signal/.test(a.controlServer.text().slice(aText0)) && !/reports your signal/.test(b.controlServer.text().slice(bText0)), 'no opening reports on the calling frequency');
  a.bridge.request({ action: 'qsy', offsetHz: 750 });
  check(a.controlServer.state.vara.qsy?.phase === 'sending' && a.controlServer.state.vara.qsy.target === 14105750, 'QSYU in the QSO: the request goes out');
  const moved = await until(() => !a.controlServer.state.vara.qsy && !b.controlServer.state.vara.qsy && a.controlServer.state.frequency === 14105750 && b.controlServer.state.frequency === 14105750, 120);
  check(moved, 'both stations move to 14.10575 MHz and finish the handshake: ' + JSON.stringify([a.controlServer.state.vara.qsy, b.controlServer.state.vara.qsy, a.controlServer.state.frequency, b.controlServer.state.frequency]));
  check(/QSY done: on 14\.10575 MHz with VK3ABC/.test(a.controlServer.text()) && /QSY done: on 14\.10575 MHz with VK3TR/.test(b.controlServer.text()), 'both note it');
  const reports = await until(() => /VK3ABC reports your signal/.test(a.controlServer.text().slice(aText0)) && /VK3TR reports your signal/.test(b.controlServer.text().slice(bText0)), 60);
  check(reports, 'then each sends its opening report on the new frequency');
  check(a.controlServer.state.vara.state === 'connected' && b.controlServer.state.vara.state === 'connected', 'still connected after the move');
  a.bridge.request({ action: 'disconnect' });
  await until(() => a.controlServer.state.vara.state === 'listening' && b.controlServer.state.vara.state === 'listening', 60);
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
    const sends = () => w.sent.filter((m) => m.type === 'send').map((m) => Buffer.from(m.data).toString('utf8'));
    check(sends().at(-1) === '6 <DISC>' && w.commands().at(-1) === 'ABORT' && /Nothing sent or received/.test(s.controlServer.text()), "an idle link is closed: VarAC's <DISC> goes first");
    w.emit('message', { type: 'buffer', bytes: 8 });
    w.emit('message', { type: 'buffer', bytes: 0 });
    check(w.commands().at(-1) === 'DISCONNECT', 'then DISCONNECT, once it has gone');
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
    // VarAC: framed messages, the opening report and profile, plain-text stations, slot CQs.
    const w = new StubWorker();
    const spots = [];
    const s = station('VK3TR', { bridge: { createWorker: () => w, pskReporter: { addSpot: (x) => spots.push(x) }, profile: { name: 'Steve', qth: 'Melbourne <home>', loc: 'QF22' } } });
    s.controlServer.state.frequency = 14105000;
    s.controlServer.state.pskSpotEnabled = true;
    await s.bridge.activate();
    const sends = () => w.sent.filter((m) => m.type === 'send').map((m) => Buffer.from(m.data).toString('latin1'));
    const say = (...lines) => w.emit('message', { type: 'lines', lines });
    const data = (text) => w.emit('message', { type: 'data', data: Uint8Array.from(Buffer.from(text, 'utf8')).buffer });

    say('SN 4.2', 'CQFRAME F6JON-11 500');
    const h = s.controlServer.state.vara.heard[0];
    check(h.call === 'F6JON' && h.raw === 'F6JON-11' && h.slot === 11 && h.offsetHz === 750 && !h.beacon && h.sn === 4.2, 'a VarAC CQ "F6JON-11": F6JON, waiting on slot 11, 750 Hz up');
    check(/CQ from F6JON \(waiting \+750 Hz from the calling frequency \(slot 11\), 500 Hz\)/.test(s.controlServer.text()), 'noted with its slot');
    check(spots[0]?.call === 'F6JON', 'spotted without the slot suffix');
    say('CQFRAME K1ABC-3 500', 'CQFRAME N1AMD-9 500');
    check(s.controlServer.state.vara.heard[1].offsetHz === -2250 && s.controlServer.state.vara.heard[0].beacon === true && s.controlServer.state.vara.heard[0].call === 'N1AMD', '-3 is 2250 Hz down; -9 is a beacon');

    // Connected on a slot (answering F6JON's CQ there): the reports go at once.
    s.controlServer.state.frequency = 14105750;
    say('SN -3.4', 'CONNECTED VK3TR F6JON 500');
    check(sends()[0] === '15 de VK3TR <R-03>', 'connected on a slot: the opening report goes as a VarAC message: "15 de VK3TR <R-03>"');
    check(sends()[1] === '47 <NAME:Steve>\r\n<QTH:Melbourne  home>\r\n<LOC:QF22>', 'then the profile tags (with < and > taken out of values)');
    data('15 de F6JON <R');
    data('-12>18 Bonjour, Steve. ');
    data('73');
    const text = s.controlServer.text();
    check(/F6JON reports your signal at -12 dB\n/.test(text) && /Bonjour, Steve\. 73\n/.test(text), 'their messages arrive whole, across modem frames; the report is put into words: ' + JSON.stringify(text.slice(-60)));
    data('10 <NAME:Jé>');
    check(/F6JON name Jé\n/.test(s.controlServer.text()), 'lengths count UTF-8 bytes');
    s.bridge.request({ action: 'send', text: 'Merci, 73 de VK3TR' });
    check(sends().at(-1) === '18 Merci, 73 de VK3TR', 'own lines go as VarAC messages');
    data('6 <DISC>');
    check(/F6JON is closing the QSO/.test(s.controlServer.text()), 'their <DISC> is noted');
    say('DISCONNECTED');

    // A station sending plain text (VARA Chat): shown as it comes, and answered the same way.
    say('SN 1', 'CONNECTED VK3ABC VK3TR 500');
    data('Hello there\r');
    check(/Hello there\n/.test(s.controlServer.text()), 'unframed text from the other station is shown as plain text');
    s.bridge.request({ action: 'send', text: 'Hi' });
    check(sends().at(-1) === 'Hi\r', 'and replies to it go as plain text, ending in CR');
    s.bridge.request({ action: 'disconnect' });
    check(w.commands().at(-1) === 'DISCONNECT' && !sends().includes('6 <DISC>'), 'no <DISC> to a plain-text station: straight to DISCONNECT');
    say('DISCONNECTED');

    // Called on the calling frequency: say we are ready to QSY (<Q>), no reports; then follow their QSY.
    s.controlServer.state.frequency = 14105000;
    const n0 = sends().length;
    say('SN 2', 'CONNECTED F6JON VK3TR 500');
    check(sends().slice(n0).join('|') === '3 <Q>', 'answering on the calling frequency: only "3 <Q>" (no report there, as VarAC)');
    check(throws(() => s.bridge.request({ action: 'qsy', offsetHz: 750 }), /hasn't said it is ready/), "QSYU in a QSO needs the other station's <Q> or <AWQ> first");
    data('7 <Q:225>');
    check(s.controlServer.state.vara.qsy?.phase === 'ack' && s.controlServer.state.vara.qsy.target === 14107250, '<Q:225>: a QSY 2250 Hz up; first our modem acknowledges it');
    check(/Moving to 14\.10725 MHz with F6JON/.test(s.controlServer.text()), 'noted');
    say('PTT ON', 'PTT OFF');
    await sleep(20);
    check(s.civ.freq === 14107250 && s.controlServer.state.frequency === 14107250 && s.controlServer.state.vara.qsy?.phase === 'tl', 'once the acknowledgement has gone: the radio moves, and waits for <TL>');
    check(s.controlServer.events.some((e) => e.type === EVENT.FREQUENCY && e.data.value === 14107250), 'the browsers are told the new frequency');
    data('4 <TL>');
    check(sends().at(-1) === '6 <QSYR>' && s.controlServer.state.vara.qsy?.phase === 'opening', '<TL> (they have arrived): reply <QSYR>, then wait for their report');
    data('15 de F6JON <R-08>');
    check(!s.controlServer.state.vara.qsy && sends().at(-2) === '15 de VK3TR <R+02>' && /QSY done: on 14\.10725 MHz with F6JON/.test(s.controlServer.text()), 'their report: the QSY is done, and ours goes out on the new frequency');
    say('DISCONNECTED');

    // Asking to QSY: <Q:-75>, move once delivered, <TL>, then their <QSYR>.
    s.controlServer.state.frequency = 14105000;
    say('SN 1', 'CONNECTED VK3TR F6JON 500');
    data('3 <Q>');
    check(s.controlServer.state.vara.qsyReady && /F6JON is ready to QSY off the calling frequency/.test(s.controlServer.text()), "calling on the calling frequency: their <Q> says they're ready");
    s.bridge.request({ action: 'qsy', offsetHz: -750 });
    check(sends().at(-1) === '7 <Q:-75>' && s.controlServer.state.vara.qsy?.phase === 'sending' && s.controlServer.state.vara.qsy.target === 14104250, 'QSYD: "<Q:-75>" (750 Hz down, as stock VarAC sends it) goes out');
    w.emit('message', { type: 'buffer', bytes: 25 });
    w.emit('message', { type: 'buffer', bytes: 0 });
    await sleep(20);
    check(s.civ.freq === 14104250 && sends().at(-1) === '4 <TL>' && s.controlServer.state.vara.qsy?.phase === 'qsyr', 'delivered: move, and say so (<TL>)');
    data('6 <QSYR>');
    check(!s.controlServer.state.vara.qsy && sends().at(-2) === '15 de VK3TR <R+01>', 'their <QSYR>: done, and our report goes out');
    say('DISCONNECTED');
    await sleep(20);
    check(s.civ.freq === 14105000 && /Back on the calling frequency \(14\.105 MHz\)/.test(s.controlServer.text()), 'when that QSO ends: back to the calling frequency');

    // VarAC's broadcasts, heard as KISS frames: beacons and VMail notices (from KiwiSDR recordings, 2026-10-28).
    say('SN 5.1', 'KISS 2 32314f4b50313052514f48385841542020202020');
    const bh = s.controlServer.state.vara.heard[0];
    check(bh.call === 'OH8XAT' && bh.beacon && bh.grid === 'KP10RQ' && bh.services.join(',') === 'VMail,email,AI,BBS' && bh.sn === 5.1, "OH8XAT's beacon: KP10RQ, VMail, email, AI, BBS");
    check(/Beacon from OH8XAT \(KP10RQ; offers VMail, email, AI, BBS\)/.test(s.controlServer.text()), 'noted');
    say('KISS 1 9084728c929040609e9070b082a8406103f03c534d503e');
    check(/OH8XAT has VMail waiting for HB9FIH/.test(s.controlServer.text()), 'a VMail notice: "OH8XAT has VMail waiting for HB9FIH"');
    await s.bridge.stop();
  }
  {
    // PSK Spot: stations heard (a CQ, the station connected to) go to PSK Reporter, with the S/N reported just before.
    const w = new StubWorker();
    const spots = [];
    const s = station('VK3TR', { bridge: { createWorker: () => w, pskReporter: { addSpot: (x) => spots.push(x) } } });
    s.controlServer.state.frequency = 14105000;
    s.controlServer.state.pskSpotEnabled = true;
    await s.bridge.activate();
    w.emit('message', { type: 'lines', lines: ['SN 6.4', 'CQFRAME VK3ABC 500'] });
    check(spots.length === 1 && spots[0].call === 'VK3ABC' && spots[0].freqHz === 14106500 && spots[0].snr === 6.4 && spots[0].mode === 'VARA', 'PSK Spot: a CQ heard is spotted at dial + 1500 Hz with its S/N, mode VARA');
    check(s.controlServer.state.vara.heard[0].sn === 6.4 && s.controlServer.state.vara.sn === null, "the heard list keeps the CQ's S/N (the link S/N stays empty outside a QSO)");
    w.emit('message', { type: 'lines', lines: ['CQFRAME VK3XYZ 500'] });
    check(spots.length === 1, 'no spot without an S/N for the frame');
    s.controlServer.state.pskSpotEnabled = false;
    w.emit('message', { type: 'lines', lines: ['SN 3', 'CQFRAME VK4ZZZ 500'] });
    check(spots.length === 1, 'no spots with PSK Spot off');
    s.controlServer.state.pskSpotEnabled = true;
    w.emit('message', { type: 'lines', lines: ['SN -2.5', 'CONNECTED VK2ABC-7 VK3TR 500'] });
    check(spots.length === 2 && spots[1].call === 'VK2ABC' && spots[1].snr === -2.5, 'the station connected to is spotted (without its SSID)');
    check(s.controlServer.state.vara.sn === -2.5, 'and its S/N shows as the link S/N');
    await s.bridge.stop();
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
