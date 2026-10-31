// Run with: node test/stt.test.js
// Speech-to-text copy aid: what is kept from whisper.cpp's answer, the
// callsigns found in it, and SttBridge with a stand-in whisper-server (the
// real one needs a model; see the README): overs cut by the voice squelch's
// detector, posted as WAV, the text broadcast; PTT and non-voice modes
// pause it; the local server is started and stopped with the checkbox.
'use strict';

const { EventEmitter } = require('events');
const { keepSegments, phoneticCallsigns, isInvented, collapseRepeats } = require('../src/server/stt-text');
const { SttBridge, sttConfig, encodeWav, multipart, audioCtxFor } = require('../src/server/stt-bridge');
const { EVENT } = require('../src/server/protocol');
const { R, bandNoise, voice, toPcm } = require('./fixtures/radio-audio');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  for (let t = 0; t < ms && !fn(); t += 20) await sleep(20);
  return fn();
};

(async () => {
  // --- callsigns ---
  const calls = (s) => phoneticCallsigns(s).join(',');
  check(calls('CQ CQ this is Victor Kilo Three Tango Romeo, Victor Kilo Three Tango Romeo calling') === 'VK3TR', 'phonetics become a callsign (said twice, found once)');
  check(calls('Victor Kilo 2 Papa Kilo Hotel') === 'VK2PKH', 'digits written as figures join the phonetics');
  check(calls('Zulu Lima Two Tango November Bravo') === 'ZL2TNB' && calls('Whiskey One Alpha Whiskey') === 'W1AW', 'number words too (ZL2TNB, W1AW)');
  check(calls('VK2PKH this is VK3TR, you are five nine') === 'VK2PKH,VK3TR', 'callsigns written as such are found');
  check(calls('thanks, VK 3 TR over') === 'VK3TR', 'a callsign written in pieces is joined');
  check(calls('I had one of those, the mike is fine') === '' && calls('Kilo Kilo Kilo') === '', 'ordinary words and stray phonetics are not callsigns');

  // --- what is kept ---
  check(isInvented('Thank you for watching!') && isInvented('[BLANK_AUDIO]') && isInvented('(static)') && isInvented('...') && !isInvented('Thank you'), 'text Whisper makes up from noise is recognised');
  check(collapseRepeats('over over over over to you') === 'over to you', "Whisper's repetition loop is cut to one");
  const kept = keepSegments({
    segments: [
      {
        text: ' Hello there, five nine.',
        no_speech_prob: 0.1,
        avg_logprob: -0.3,
        words: [
          { word: ' Hello', probability: 0.9 },
          { word: ' there', probability: 0.3 },
          { word: ',', probability: 0.9 },
          { word: ' five', probability: 0.8 },
          { word: ' nine', probability: 0.95 },
          { word: '.', probability: 0.9 },
        ],
      },
      { text: ' Thanks for watching!', no_speech_prob: 0.1, avg_logprob: -0.2 },
      { text: ' static words', no_speech_prob: 0.9, avg_logprob: -1.3 },
    ],
  });
  check(kept.text === 'Hello there, five nine.' && kept.dropped === 2, 'invented text, and silence by Whisper\'s rule (no_speech over 0.6 and avg_logprob under -1), are dropped');
  check(kept.why.length === 2 && /invented/.test(kept.why[0]) && /silence \(no_speech 0\.90, avg_logprob -1\.30\)/.test(kept.why[1]), 'what was dropped, and why, is given for the log');
  const either = keepSegments({ segments: [{ text: ' five nine', no_speech_prob: 0.9, avg_logprob: -0.4 }, { text: ' over', no_speech_prob: 0.1, avg_logprob: -1.6 }] });
  check(either.text === 'five nine over' && either.dropped === 0, 'one of the two signs alone does not drop a segment (common on real SSB speech)');
  check(kept.words.map((w) => w.w).join(' ') === 'Hello there, five nine.' && kept.words[1].low && !kept.words[0].low && kept.words[3].p === 0.9, "words keep Whisper's probability; doubtful ones are marked low");

  // --- WAV and form ---
  {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
    check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 16000 && wav.readUInt16LE(34) === 16 && wav.readUInt32LE(40) === 10 && wav.readInt16LE(46) === 16384 && wav.readInt16LE(50) === 32767, '16-bit mono WAV at 16 kHz');
    const { body, type } = multipart({ response_format: 'verbose_json', language: 'en' }, wav);
    const b = body.toString('latin1');
    const boundary = type.split('boundary=')[1];
    check(type.startsWith('multipart/form-data') && b.includes('name="response_format"\r\n\r\nverbose_json') && b.includes('filename="over.wav"') && b.endsWith(`--${boundary}--\r\n`), 'the form carries the fields and the WAV, as whisper-server reads it');
  }

  // --- audio_ctx ---
  check(audioCtxFor(1) === 512 && audioCtxFor(5) === 512 && audioCtxFor(12) === 700 && audioCtxFor(28) === 1500, "Whisper's encoder is told the over's length (at least 512 frames, at most the full 1500)");

  // --- config ---
  {
    const c = sttConfig({ STT_WHISPER_SERVER: '/opt/whisper.cpp/build/bin/whisper-server', STT_MODEL: '/opt/models/ggml-base.en-q5_1.bin', STT_THREADS: '3' });
    check(c.serverBin.endsWith('whisper-server') && c.threads === 3 && c.port === 8178 && !c.url && c.warnings.length === 0, 'STT_WHISPER_SERVER, STT_MODEL and STT_THREADS are read');
    check(sttConfig({ STT_MODEL: 'x' }).warnings.length === 1 && sttConfig({ STT_URL: 'ftp://x' }).warnings.length === 1, 'half a setup, or a bad URL, is reported');
  }

  // --- the bridge, with a stand-in whisper-server ---
  {
    const capture = new EventEmitter();
    const audioBridge = { sampleRate: R, capture };
    const events = [];
    const cs = new EventEmitter();
    let modes = {};
    Object.assign(cs, {
      state: { mode: { mode: 'LSB' }, dataMode: false, sttEnabled: false },
      appModes: () => modes,
      broadcastJsonEvent: (type, data) => events.push({ type, data: JSON.parse(JSON.stringify(data)) }),
      sendJsonEvent: (ws, type, data) => ws.push({ type, data }),
    });
    const posts = [];
    let up = false;
    let answer = () => ({
      segments: [
        { text: ' CQ CQ this is Victor Kilo Three Tango Romeo', no_speech_prob: 0.05, avg_logprob: -0.4, words: [{ word: ' CQ', probability: 0.9 }, { word: ' CQ', probability: 0.9 }, { word: ' this', probability: 0.8 }, { word: ' is', probability: 0.8 }, { word: ' Victor', probability: 0.7 }, { word: ' Kilo', probability: 0.6 }, { word: ' Three', probability: 0.3 }, { word: ' Tango', probability: 0.8 }, { word: ' Romeo', probability: 0.8 }] },
      ],
    });
    const request = async (url, opts = {}) => {
      if (!up) throw new Error('connect ECONNREFUSED');
      if (opts.method === 'POST') {
        posts.push({ url, body: opts.body, type: opts.type });
        return { status: 200, text: JSON.stringify(answer()) };
      }
      return { status: 200, text: '<html>' };
    };
    const spawned = [];
    const spawnFn = (bin, args) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = (sig) => {
        child.killed = sig;
        child.exitCode = 0;
        setImmediate(() => child.emit('exit', null, sig));
      };
      spawned.push({ bin, args, child });
      setTimeout(() => (up = true), 60); // the model loads
      return child;
    };
    const bridge = new SttBridge({ controlServer: cs, audioBridge, config: { serverBin: '/opt/wb/whisper-server', model: '/opt/m/ggml-base.en.bin', threads: 3, port: 8178 }, request, spawnFn, pollMs: 20 });
    bridge.start();
    check(cs.state.stt.available && !cs.state.stt.enabled && cs.state.stt.phase === 'off' && cs.state.stt.engine === 'local', 'STT starts available and off');
    check(spawned.length === 0, 'no speech engine runs until STT is ticked');

    cs.emit('stt-enabled', true);
    check(await until(() => cs.state.stt.phase === 'listening'), 'ticked: the local whisper-server is started, and once it answers STT listens');
    const sp = spawned[0];
    check(sp && sp.bin === '/opt/wb/whisper-server' && sp.args.join(' ') === '-m /opt/m/ggml-base.en.bin --host 127.0.0.1 --port 8178 -t 3 -l en -nlp', 'whisper-server is started with the model, on 127.0.0.1, English: ' + (sp && sp.args.join(' ')));

    // An over: noise, 3 s of voice, noise.
    const feed = (sig) => {
      const pcm = toPcm(sig);
      for (let i = 0; i < pcm.length; i += 4800) capture.emit('data', pcm.subarray(i, Math.min(pcm.length, i + 4800)));
    };
    const over = () => {
      const n = bandNoise(8, 0.05);
      const v = voice(3, 0.05);
      for (let i = 0; i < v.length; i++) n[2 * R + i] += v[i];
      return n;
    };
    feed(over());
    check(await until(() => posts.length === 1), 'an over is posted to /inference once it ends');
    const post = posts[0];
    const body = post?.body.toString('latin1') || '';
    const wavAt = body.indexOf('RIFF');
    const wavLen = wavAt >= 0 ? post.body.readUInt32LE(wavAt + 40) / 2 / 16000 : 0;
    check(post && post.url === 'http://127.0.0.1:8178/inference' && body.includes('verbose_json') && body.includes('name="language"\r\n\r\nen') && body.includes('Victor Kilo'), 'sent as verbose_json, English, with the ham prompt');
    check(body.includes('name="audio_ctx"\r\n\r\n512'), 'a short over is sent with audio_ctx 512, a third of the full encoder work');
    check(wavLen > 3 && wavLen < 5.5, `the WAV is the over, from just before the voice to the squelch's hang after it (${wavLen.toFixed(2)} s)`);
    const text = await until(() => events.find((e) => e.type === EVENT.STT_TEXT));
    const t = events.find((e) => e.type === EVENT.STT_TEXT)?.data;
    check(cs.state.stt.last && cs.state.stt.last.kept && cs.state.stt.last.durationSec > 3, 'the status shows the last over');
    check(text && t.text === 'CQ CQ this is Victor Kilo Three Tango Romeo' && t.callsigns.join() === 'VK3TR' && t.words[6].low && t.durationSec > 3, 'the text is broadcast with its callsign and doubtful words');
    const joined = [];
    cs.emit('client-connected', joined);
    check(joined[0]?.type === EVENT.STT_TEXT && joined[0].data.replace && joined[0].data.overs.length === 1, 'a browser that connects gets the recent text');

    // Noise only: nothing is sent.
    feed(bandNoise(6, 0.05));
    await sleep(200);
    check(posts.length === 1, 'noise alone is not sent');

    // Transmitting: paused.
    cs.emit('ptt', true);
    check(cs.state.stt.phase === 'paused' && cs.state.stt.note === 'transmitting', 'PTT pauses STT');
    feed(over());
    await sleep(200);
    check(posts.length === 1, 'nothing is transcribed while transmitting');
    cs.emit('ptt', false);
    check(cs.state.stt.phase === 'listening', 'and it listens again after');

    // Not a voice mode.
    cs.state.dataMode = true;
    bridge._syncAudio();
    check(cs.state.stt.phase === 'paused' && /voice modes/.test(cs.state.stt.note), 'DATA mode pauses it (not a voice mode)');
    cs.state.dataMode = false;
    modes = { js8Active: true };
    bridge._syncAudio();
    check(cs.state.stt.phase === 'paused', 'an app mode (JS8) pauses it');
    modes = {};
    cs.state.mode = { mode: 'CW' };
    bridge._syncAudio();
    check(cs.state.stt.phase === 'paused', 'CW pauses it');
    cs.state.mode = { mode: 'USB' };
    bridge._syncAudio();
    check(cs.state.stt.phase === 'listening', 'USB: listening again');

    // An answer with only invented text: nothing shown.
    answer = () => ({ segments: [{ text: ' Thank you for watching!', no_speech_prob: 0.2, avg_logprob: -0.3 }] });
    const before = events.filter((e) => e.type === EVENT.STT_TEXT).length;
    feed(over());
    await until(() => posts.length === 2);
    await sleep(100);
    check(posts.length === 2 && events.filter((e) => e.type === EVENT.STT_TEXT).length === before && cs.state.stt.last.kept === false, 'an over Whisper only invents text for shows nothing (the status says nothing was kept)');

    // Unticked: the engine stops.
    cs.emit('stt-enabled', false);
    await sleep(20);
    check(sp.child.killed === 'SIGTERM' && cs.state.stt.phase === 'off' && !bridge._attached, 'unticked: whisper-server is stopped and the audio let go');

    // The engine dies while in use.
    up = false;
    cs.emit('stt-enabled', true);
    await until(() => cs.state.stt.phase === 'listening');
    spawned.at(-1).child.stderr.emit('data', Buffer.from('error: failed to load model\n'));
    spawned.at(-1).child.exitCode = 1;
    spawned.at(-1).child.emit('exit', 1, null);
    check(cs.state.stt.phase === 'error' && /exit 1.*failed to load model/.test(cs.state.stt.note), 'if whisper-server stops, the panel says so: ' + cs.state.stt.note);
    await bridge.stop();
  }

  // Not set up: ticking shows why.
  {
    const cs = new EventEmitter();
    Object.assign(cs, { state: {}, broadcastJsonEvent() {} });
    const b = new SttBridge({ controlServer: cs, audioBridge: { sampleRate: R, capture: new EventEmitter() } });
    check(!cs.state.stt.available && /STT_WHISPER_SERVER/.test(cs.state.stt.reason), 'without a speech engine set up, STT is unavailable and says why');
    await b.setEnabled(true);
    check(cs.state.stt.enabled && cs.state.stt.phase === 'error' && /STT_WHISPER_SERVER/.test(cs.state.stt.note), 'ticking it anyway shows the reason in the panel');
    const remote = new SttBridge({ controlServer: cs, audioBridge: { sampleRate: R, capture: new EventEmitter() }, config: { url: 'http://192.168.1.20:8178' } });
    check(remote.state.available && remote.state.engine === 'remote' && remote.baseUrl === 'http://192.168.1.20:8178', 'STT_URL uses a whisper-server already running elsewhere');
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall STT checks passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
