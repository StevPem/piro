// Run with: node test/js8.test.js
// JS8 (JS8Call's Normal speed): the FFT, the frame code (CRC-12, LDPC,
// tones), the word compression, the message layer, the receiver on
// simulated slots (several signals, noise, overlap), and Js8Bridge with its
// real worker: a slot of audio in, decodes out; a message typed, frames
// sent one a slot, and what was played decoded again.
'use strict';

const { EventEmitter } = require('events');
const { FftPlan } = require('../src/audio/js8/js8-fft');
const codec = require('../src/audio/js8/js8-codec');
const jsc = require('../src/audio/js8/js8-jsc');
const v = require('../src/audio/js8/js8-varicode');
const { Js8Decoder } = require('../src/audio/js8/js8-decoder');
const { synthesize } = require('../src/audio/js8/js8-modulator');
const { Js8Bridge, cleanText, MAX_FRAMES } = require('../src/server/js8-bridge');
const { EVENT } = require('../src/server/protocol');
const { upsampleFloatToPcm, downsamplePcmToFloat } = require('../src/audio/resample');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A seeded random source, so the noise is the same every run.
let seed = 12345;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
}
function gauss() {
  let u = 0;
  while (!u) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** A 15 s slot at 12 kHz: white noise (rms 1000) and JS8 signals at S/N (dB in 2500 Hz). */
function slot(signals, noiseRms = 1000) {
  const buf = new Float64Array(180000);
  for (let i = 0; i < buf.length; i++) buf[i] = noiseRms * gauss();
  for (const sig of signals) {
    const pn = (noiseRms * noiseRms * 2500) / 6000;
    const amp = Math.sqrt(2 * pn * Math.pow(10, sig.snr / 10));
    const audio = synthesize(codec.encodeTones(sig.frame, sig.type), sig.f0, { amplitude: amp });
    const start = Math.round((0.5 + (sig.dt || 0)) * 12000);
    for (let i = 0; i < audio.length && start + i < buf.length; i++) buf[start + i] += audio[i];
  }
  return buf;
}

(async () => {
  // --- FFT ---
  for (const n of [12, 60, 100, 3200]) {
    const re = Float64Array.from({ length: n }, () => rand() - 0.5);
    const im = Float64Array.from({ length: n }, () => rand() - 0.5);
    const r0 = re.slice();
    const i0 = im.slice();
    new FftPlan(n).forward(re, im);
    let err = 0;
    for (let k = 0; k < n; k += Math.max(1, n >> 4)) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += r0[t] * Math.cos(a) - i0[t] * Math.sin(a);
        si += r0[t] * Math.sin(a) + i0[t] * Math.cos(a);
      }
      err = Math.max(err, Math.abs(sr - re[k]), Math.abs(si - im[k]));
    }
    new FftPlan(n).inverse(re, im);
    let back = 0;
    for (let t = 0; t < n; t++) back = Math.max(back, Math.abs(re[t] / n - r0[t]), Math.abs(im[t] / n - i0[t]));
    check(err < 1e-9 && back < 1e-12, `mixed-radix FFT of ${n} points matches the DFT, and inverts`);
  }

  // --- frame code ---
  {
    const bits = codec.frameBits('HELLOWORLD12', 3);
    check(bits.length === 87 && codec.checkCrc12(bits), 'a frame carries 87 bits with a good CRC-12');
    const bad = bits.slice();
    bad[5] ^= 1;
    check(!codec.checkCrc12(bad), 'one wrong bit fails the CRC');
    const cw = codec.encodeCodeword(bits);
    let badChecks = 0;
    for (const row of codec.Nm) if (row.reduce((a, b) => a + cw[b], 0) & 1) badChecks++;
    check(badChecks === 0, 'the generator makes codewords the parity checks accept');
    check(
      codec.Nm[0].join(',') === '0,29,59,88,117,146' && codec.Nm.every((r) => r.length >= 5 && r.length <= 7) && codec.Nm.reduce((a, r) => a + r.length, 0) === 522,
      "the check-node lists match JS8Call's Nm table (87 checks, 522 edges)"
    );
    const tones = codec.encodeTones('HELLOWORLD12', 3);
    const costas = [0, 36, 72].map((s) => tones.slice(s, s + 7).join(''));
    check(tones.length === 79 && costas.every((c) => c === '4256130'), 'Normal speed puts the original Costas array at symbols 0, 36 and 72');
    const llr = Array.from(cw, (b) => (b ? 4 : -4));
    const r = codec.bpDecode(llr);
    check(r.hardErrors === 0 && codec.extractFrame(r.decoded) === 'HELLOWORLD12' && codec.frameType(r.decoded) === 3, 'BP decodes a clean codeword back to the frame and its type');
    let ok = 0;
    for (let t = 0; t < 40; t++) {
      const noisy = Array.from(cw, (b) => (2 * ((b ? 1 : -1) + 0.6 * gauss())) / 0.36);
      const d = codec.bpDecode(noisy);
      if (d.hardErrors >= 0 && codec.checkCrc12(d.decoded)) ok++;
    }
    check(ok >= 38, `BP corrects noisy codewords (${ok}/40 at sigma 0.6)`);
  }

  // --- word compression ---
  {
    check(jsc.lookup('HELLO') >= 0 && jsc.lookup('HELLOQQ') === jsc.lookup('HELLO'), 'the word lookup takes the longest listed word');
    check(jsc.lookup('@ALLCALL') !== 81, '@ALLCALL is not found by the word search (as in JS8Call)');
    check(jsc.codeword(0, false).join('') === '00000' && jsc.codeword(7, true).join('') === '011100001', 'word codes are (7,9)-dense, 4 bits a piece, with a space flag');
    const text = 'HELLO WORLD THIS IS A TEST';
    const bits = jsc.compress(text).flatMap((p) => p.bits);
    check(jsc.decompress(bits) === text, 'JSC compresses and decompresses a sentence');
  }

  // --- message layer ---
  {
    for (const c of ['VK3ABC', 'K1ABC', 'AB1CD', 'VK2IO', '3DA0XY', '@ALLCALL']) {
      const p = v.packCallsign(c);
      check(p.packed > 0 && v.unpackCallsign(p.packed, p.portable) === c, `callsign ${c} packs into 28 bits and back`);
    }
    check(v.unpackGrid(v.packGrid('QF22')) === 'QF22' && v.unpackGrid(v.packGrid('FN42')) === 'FN42', 'grids pack and unpack');
    check(v.unpackAlphaNumeric50(v.packAlphaNumeric50('VK3ABC/P')) === 'VK3ABC/P', 'a compound callsign packs into 50 bits and back');
    const shown = (text, mycall = 'VK3ABC') =>
      v
        .buildMessageFrames(mycall, 'QF22', '', text)
        .map((f) => v.decodeFrame(f.frame, f.type).message)
        .join('');
    check(shown('CQ CQ CQ QF22') === 'VK3ABC: @ALLCALL CQ CQ CQ QF22 ', 'a CQ is one heartbeat frame, shown as JS8Call shows it');
    check(shown('HB QF22') === 'VK3ABC: @HB HEARTBEAT QF22 ', 'a heartbeat is one frame');
    check(shown('VK2XYZ SNR?') === 'VK3ABC: VK2XYZ SNR? ', 'a directed query is one frame');
    check(shown('VK2XYZ SNR -12') === 'VK3ABC: VK2XYZ SNR -12 ', 'a directed S/N report carries the number');
    check(shown('VK2XYZ/P SNR?') === 'VK3ABC: VK2XYZ/P SNR? ', 'a portable callsign keeps its /P');
    check(shown('VK2XYZ HELLO THERE HOW ARE YOU') === 'VK3ABC: VK2XYZ  HELLO THERE HOW ARE YOU', 'free text to a station: a directed frame, then data frames');
    check(shown('HELLO WORLD') === 'VK3ABC: HELLO WORLD', 'plain text is sent as "MYCALL: text"');
    const msg = v.buildMessageFrames('VK3ABC', 'QF22', '', 'VK2XYZ MSG HI THERE');
    check(v.decodeFrame(msg[1].frame, msg[1].type).message === `HI THERE ${v.checksum16('HI THERE')}`, 'a MSG gets its 16-bit checksum, as in JS8Call');
    const frames = v.buildMessageFrames('VK3ABC', 'QF22', '', 'VK2XYZ HELLO THERE HOW ARE YOU');
    check(frames[0].type === 1 && frames.at(-1).type === 2 && frames.slice(1, -1).every((f) => f.type === 0), 'the first frame is flagged first, the last last');
    check(v.buildMessageFrames('VK3ABC', 'QF22', '', 'VK2XYZ SNR?')[0].type === 3, 'a one-frame message is both first and last');
    const d = v.decodeFrame(v.buildMessageFrames('VK3ABC', 'QF22', '', 'VK2XYZ SNR -12')[0].frame, 3);
    check(d.from === 'VK3ABC' && d.to === 'VK2XYZ' && d.cmd === ' SNR' && d.num === '-12', 'a directed frame decodes to from, to, command and number');
    let threw = false;
    try {
      v.buildMessageFrames('VK3ABC', 'QF22', '', 'VK2XYZ ü');
    } catch {
      threw = true;
    }
    check(threw, 'text JS8 has no code for is refused, not sent half');
    check(v.isCommandAutoreply(' SNR?') && !v.isCommandAutoreply(' SNR'), "JS8Call's automatic-reply commands are known (PiRO never answers them)");
  }

  // --- receiver ---
  {
    const dec = new Js8Decoder();
    const sigs = [
      { frame: 'HELLOWORLD12', type: 3, f0: 1500, snr: -10 },
      { frame: 'ABCDEFGHIJKL', type: 1, f0: 1000.3, snr: -16, dt: 0.3 },
      { frame: 'zyxwvuTSRQ+-', type: 0, f0: 2100, snr: 0, dt: -0.2 },
      { frame: 'OVERLAPxxxxx', type: 2, f0: 1520, snr: -12, dt: 0.1 },
    ];
    const started = Date.now();
    const found = dec.decodeSlot(slot(sigs), { nfqso: 1500 });
    const ms = Date.now() - started;
    for (const s of sigs) {
      const d = found.find((x) => x.frame === s.frame);
      check(!!d && d.type === s.type && Math.abs(d.freq - s.f0) <= 1 && Math.abs(d.dt - (s.dt || 0)) <= 0.05, `decodes ${s.frame} at ${s.f0} Hz, ${s.snr} dB, dt ${s.dt || 0}${s.frame === 'OVERLAPxxxxx' ? ' (overlapping another signal)' : ''}`);
    }
    check(found.length === sigs.length, `nothing else is decoded (${found.length} frames, ${ms} ms)`);
    const strong = found.find((x) => x.frame === 'zyxwvuTSRQ+-');
    check(strong.snr >= -12 && strong.snr <= -4, `S/N is reported on JS8Call's scale (0 dB in 2500 Hz shows as ${strong.snr})`);
    check(dec.decodeSlot(slot([])).length === 0, 'a slot of noise decodes nothing');

    // The whole chain: text -> frames -> audio, a frame a slot -> decode -> text.
    const frames = v.buildMessageFrames('VK3ABC', 'QF22', '', 'VK2XYZ HELLO FROM MELBOURNE');
    let text = '';
    for (const f of frames) {
      const got = dec.decodeSlot(slot([{ frame: f.frame, type: f.type, f0: 1234, snr: -12 }]));
      const one = got[0];
      text += one ? v.decodeFrame(one.frame, one.type).message : '??';
    }
    check(text === 'VK3ABC: VK2XYZ  HELLO FROM MELBOURNE', `a message sent over ${frames.length} slots reads back whole`);
  }

  // --- Js8Bridge with its worker ---
  {
    const RATE = 48000;
    const capture = new EventEmitter();
    const played = [];
    let restarts = 0;
    const audioBridge = { sampleRate: RATE, capture, playback: { write: (b) => played.push(b), restart: () => restarts++ } };
    const events = [];
    const ptt = [];
    const spots = [];
    const cs = new EventEmitter();
    Object.assign(cs, {
      state: { frequency: 14078000, pskSpotEnabled: true, js8TxHz: 1500 },
      civ: null,
      broadcastJsonEvent: (type, data) => events.push({ type, data: JSON.parse(JSON.stringify(data)) }),
      broadcastBinary: () => {},
      sendJsonEvent: (ws, type, data) => ws.push({ type, data }),
      setPttFromServer: async (on) => {
        ptt.push(on);
        cs.emit('ptt', on);
      },
    });
    const clock = new EventEmitter();
    Object.assign(clock, { start() {}, stop() {}, nextSlotStart: () => 30000 });
    const holds = [];
    const bridge = new Js8Bridge({
      controlServer: cs,
      audioBridge,
      callsign: 'VK3ABC',
      grid: 'QF22LA',
      latencyMs: 0,
      pskReporter: { addSpot: (s) => spots.push(s) },
      slotClock: clock,
      setTimer: (fn, ms) => {
        holds.push(ms);
        setImmediate(fn);
        return 1;
      },
      clearTimer: () => {},
    });
    bridge.start();
    check(cs.state.js8.available && cs.state.js8.canTransmit && cs.state.js8.grid === 'QF22', 'the bridge starts available, with the 4-character grid');
    await bridge.setActive(true, 1200);
    check(bridge.active && cs.state.js8.txHz === 1200, 'setActive turns JS8 on with the offset');

    // A slot: a CQ from VK2XYZ at 1600 Hz, fed as 48 kHz audio in chunks.
    const cq = v.buildMessageFrames('VK2XYZ', 'QF56', '', 'CQ CQ CQ QF56')[0];
    const x = slot([{ frame: cq.frame, type: cq.type, f0: 1600, snr: -8 }], 300);
    const pcm = upsampleFloatToPcm(Float32Array.from(x, (s) => s / 32768), 12000, RATE);
    clock.emit('boundary', { slotStartMs: 15000, slotMs: 15000 }); // listening from the start of this slot
    for (let i = 0; i < pcm.length; i += 9600) capture.emit('data', pcm.subarray(i, Math.min(pcm.length, i + 9600)));
    clock.emit('boundary', { slotStartMs: 30000, slotMs: 15000 });
    for (let i = 0; i < 200 && !events.some((e) => e.type === EVENT.JS8_DECODES); i++) await sleep(50);
    const got = events.find((e) => e.type === EVENT.JS8_DECODES);
    const e = got?.data.decodes[0];
    check(!!e && e.text === 'VK2XYZ: @ALLCALL CQ CQ CQ QF56 ' && e.cq && e.from === 'VK2XYZ' && e.grid === 'QF56' && Math.abs(e.freq - 1600) <= 1 && got.data.slotStartMs === 15000, 'a slot of audio is decoded in the worker and broadcast');
    check(spots.length === 1 && spots[0].call === 'VK2XYZ' && spots[0].grid === 'QF56' && spots[0].mode === 'JS8' && spots[0].freqHz === 14078000 + e.freq, 'PSK Spot reports the station, its grid, and dial + offset');
    const joined = [];
    cs.emit('client-connected', joined);
    check(joined[0]?.type === EVENT.JS8_DECODES && joined[0].data.replace && joined[0].data.decodes.length === 1, 'a browser that connects gets the recent decodes');

    // Transmit: a two-frame message, one frame a slot.
    let refused = '';
    try {
      await bridge.request({ action: 'send', text: 'x'.repeat(301) });
    } catch (err) {
      refused = err.message;
    }
    check(/Too long/.test(refused), 'a message over 300 characters is refused');
    refused = '';
    try {
      await bridge.request({ action: 'send', text: '#$%&'.repeat(70) }); // only the word list carries these: 41 frames
    } catch (err) {
      refused = err.message;
    }
    check(new RegExp(`${MAX_FRAMES} \\(10 minutes\\)`).test(refused), 'a message needing more than 40 frames (10 minutes) is refused');
    check(cleanText(' vk2xyz hello\nthere ') === 'VK2XYZ HELLO THERE', 'typed text is sent in capitals, on one line');
    const res = await bridge.request({ action: 'send', text: 'vk2xyz hello there how are you' });
    check(res.frames >= 2 && cs.state.js8.sending?.total === res.frames && cs.state.js8.sending.sent === 0, `send queues the message (${res.frames} frames)`);
    let busy = '';
    try {
      await bridge.request({ action: 'cq' });
    } catch (err) {
      busy = err.message;
    }
    check(/still being sent/.test(busy), 'a second message waits for the first');
    clock.emit('boundary', { slotStartMs: 45000, slotMs: 15000 });
    for (let i = 0; i < 100 && ptt.length < 2; i++) await sleep(10);
    check(ptt.join() === 'true,false' && played.length === 1, 'the first frame keys PTT, plays, and unkeys');
    check(cs.state.js8.sending?.sent === 1, 'the status counts the frame sent');
    const own = events.filter((ev) => ev.type === EVENT.JS8_DECODES && ev.data.decodes[0]?.own);
    check(own.length === 1 && own[0].data.decodes[0].first && own[0].data.decodes[0].freq === 1200, 'the frame sent is broadcast as an own line at the offset');
    // What was played decodes as the first frame (0.5 s of silence first: latency 0).
    const playedPcm = Buffer.concat(played);
    const int16 = new Int16Array(playedPcm.length / 2);
    for (let i = 0; i < int16.length; i++) int16[i] = playedPcm.readInt16LE(i * 2);
    const back = downsamplePcmToFloat(int16, RATE, 12000);
    const rx = new Js8Decoder().decodeSlot(Float64Array.from(back, (s) => s * 32768));
    const first = v.buildMessageFrames('VK3ABC', 'QF22', '', 'VK2XYZ HELLO THERE HOW ARE YOU')[0];
    check(rx.length === 1 && rx[0].frame === first.frame && Math.abs(rx[0].freq - 1200) <= 1 && Math.abs(rx[0].dt) < 0.1, 'the audio played decodes as the first frame, at the offset, on time');
    check(holds[0] > 12640 && holds[0] < 13500, `PTT is held for the frame and a short tail (${Math.round(holds[0])} ms)`);
    // Stop part-way.
    await bridge.request({ action: 'stop' });
    check(cs.state.js8.sending === null && !bridge._queue.length, 'Stop drops the rest of the message');
    clock.emit('boundary', { slotStartMs: 60000, slotMs: 15000 });
    await sleep(50);
    check(ptt.length === 2, 'nothing more is sent after Stop');

    // CQ, stopped while on the air.
    const cqRes = await bridge.request({ action: 'cq' });
    check(cqRes.frames === 1 && cs.state.js8.sending.frames[0] === 'VK3ABC: @ALLCALL CQ CQ CQ QF22 ', 'CQ sends "CQ CQ CQ" and the 4-character grid');
    bridge.setTimer = () => 2; // hold PTT until stopped
    clock.emit('boundary', { slotStartMs: 75000, slotMs: 15000 });
    for (let i = 0; i < 100 && ptt.length < 3; i++) await sleep(10);
    await bridge.request({ action: 'stop' });
    check(ptt.join() === 'true,false,true,false' && restarts >= 1 && cs.state.js8.keyed === false, 'Stop on the air unkeys at once and drops the audio');

    await bridge.setActive(false);
    check(!bridge.active && cs.state.js8.sending === null && bridge._worker === null, 'turning JS8 off stops everything, and ends the worker (its memory is freed)');
    let off = '';
    try {
      await bridge.request({ action: 'cq' });
    } catch (err) {
      off = err.message;
    }
    check(/not on/.test(off), 'nothing is sent while JS8 is off');
    await bridge.stop();
  }

  // Receive only without a callsign; and an audio rate JS8 can't use.
  {
    const cs = new EventEmitter();
    Object.assign(cs, { state: {}, broadcastJsonEvent() {} });
    const b = new Js8Bridge({ controlServer: cs, audioBridge: { sampleRate: 48000, capture: new EventEmitter(), playback: {} }, createWorker: () => new EventEmitter() });
    check(cs.state.js8.available && !cs.state.js8.canTransmit, 'without STATION_CALLSIGN JS8 is receive only');
    const b2 = new Js8Bridge({ controlServer: cs, audioBridge: { sampleRate: 44100, capture: new EventEmitter(), playback: {} }, createWorker: () => new EventEmitter() });
    check(!cs.state.js8.available && /12000/.test(cs.state.js8.reason), 'JS8 is unavailable at an audio rate that is not a multiple of 12 kHz');
    void b;
    void b2;
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall JS8 checks passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
