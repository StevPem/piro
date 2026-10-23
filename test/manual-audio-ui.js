'use strict';
// Manual (not part of `npm test`): needs Playwright + Chromium. Optional CHROMIUM_PATH env.
// Drives the real client in headless Chromium against a real ControlServer
// and AudioBridge (fake ALSA capture/playback, stub radio), with three
// browsers at once: one on full audio, one on Opus (WebCodecs), one on
// ADPCM (WebCodecs hidden). Checks RX playback, mic audio (Chromium's fake
// microphone) and the Audio button.
const path = require('path');
const { EventEmitter } = require('events');
const PKG = path.join(__dirname, '..');
const { ControlServer } = require(PKG + '/src/server/ws-server');
const { AudioBridge } = require(PKG + '/src/server/audio-bridge');
const { BINARY_TYPE } = require(PKG + '/src/server/protocol');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('This manual test needs Playwright: npm install --no-save playwright (and a Chromium it can launch).');
  process.exit(2);
}

let failures = 0;
const check = (c, m) => { if (c) console.log('ok -', m); else { console.error('FAIL -', m); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Civ extends EventEmitter {
  constructor() { super(); this.radioAddr = 0x94; this.ptt = []; }
  async getFrequency() { return 14200000; }
  async getMode() { return { mode: 'USB', filter: 1 }; }
  async getDataMode() { return false; }
  async setPtt(on) { this.ptt.push(on); return true; }
  async getSMeter() { return 100; }
  async getSWR() { return 0; }
  async getPreamp() { return 0; } async getNoiseReduction() { return false; } async getNoiseBlanker() { return false; }
  async getNotch() { return false; } async getTuner() { return 0; } async getFilter() { return 1; }
  async getTxPower() { return 100; } async getRxGain() { return 255; }
}

// Counts the AudioBuffers each page makes, by sample rate (48000: raw PCM or
// Opus decoded by WebCodecs; 12000: ADPCM).
const COUNT_BUFFERS = () => {
  window.__buffers = {};
  const orig = AudioContext.prototype.createBuffer;
  AudioContext.prototype.createBuffer = function (ch, n, rate) {
    window.__buffers[rate] = (window.__buffers[rate] || 0) + 1;
    return orig.call(this, ch, n, rate);
  };
};

(async () => {
  const civ = new Civ();
  const server = new ControlServer({ civ, port: 0, staticDir: PKG + '/src/client' });
  const port = await server.listen();
  const capture = Object.assign(new EventEmitter(), { start() {}, stop() {} });
  const written = [];
  const playback = Object.assign(new EventEmitter(), { start() {}, stop() {}, write: (b) => written.push(b) });
  const bridge = new AudioBridge({ controlServer: server, capture, playback, maximizeVolumeOnStart: false });
  await bridge.start();
  server.setAudioInfo({ enabled: true, sampleRate: 48000, channels: 1, codecs: ['pcm', ...bridge.compressedCodecs], opusBitrate: 24000 });
  const txTypes = new Map(); // ws -> [frame types]
  server.on('binary-message', (ws, data) => {
    if (!txTypes.has(ws)) txTypes.set(ws, []);
    txTypes.get(ws).push(data[0]);
  });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  async function open(name, { format, hideWebCodecs = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 1000 } });
    await ctx.grantPermissions(['microphone']);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.addInitScript(COUNT_BUFFERS);
    if (format) await page.addInitScript((f) => localStorage.setItem('piro.audioFormat', f), format);
    if (hideWebCodecs) await page.addInitScript(() => { delete window.AudioDecoder; delete window.AudioEncoder; });
    const known = new Set(server.clients);
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => !document.getElementById('speaker-btn').disabled, null, { timeout: 8000 });
    await page.waitForFunction(() => !document.getElementById('audio-format-btn').disabled, null, { timeout: 8000 });
    await sleep(300);
    const ws = [...server.clients].find((w) => !known.has(w));
    return { page, ws };
  }
  const chipText = (p) => p.locator('#audio-format-btn').textContent();

  const full = await open('full');
  const opus = await open('opus', { format: 'compressed' });
  const adpcm = await open('adpcm', { format: 'compressed', hideWebCodecs: true });

  check((await chipText(full.page)) === 'Audio: full', 'a page opened on the LAN (localhost) starts on full audio');
  check(!bridge._clientCodec.has(full.ws), 'and the server sends it raw PCM');
  check((await chipText(opus.page)) === 'Audio: Opus', 'compressed audio in a browser with WebCodecs: Opus');
  check(bridge._clientCodec.get(opus.ws) === 'opus', 'and the server sends that browser Opus');
  check((await chipText(adpcm.page)) === 'Audio: ADPCM', 'compressed audio without WebCodecs: ADPCM');
  check(bridge._clientCodec.get(adpcm.ws) === 'adpcm', 'and the server sends that browser ADPCM');
  const title = await opus.page.locator('#audio-format-btn').getAttribute('title');
  check(/Opus, about 24 kbit\/s each way/.test(title), `the button's title says what is in use ("${title}")`);

  // RX: one second of a tone, heard on all three
  for (const p of [full, opus, adpcm]) await p.page.click('#speaker-btn');
  const tone = Buffer.alloc(96000);
  for (let i = 0; i < 48000; i++) tone.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 700 * i) / 48000)), 2 * i);
  for (let i = 0; i < tone.length; i += 4096) {
    capture.emit('data', tone.subarray(i, i + 4096));
    await sleep(40);
  }
  await sleep(500);
  const counts = {};
  for (const [name, p] of Object.entries({ full, opus, adpcm })) counts[name] = await p.page.evaluate(() => window.__buffers);
  check(counts.full[48000] >= 20, `full: raw PCM played (${JSON.stringify(counts.full)})`);
  check(counts.opus[48000] >= 45 && !counts.opus[12000], `Opus: decoded by WebCodecs and played, about 50 packets (${JSON.stringify(counts.opus)})`);
  check(counts.adpcm[12000] >= 45 && !counts.adpcm[48000], `ADPCM: decoded and played at 12 kHz, about 50 frames (${JSON.stringify(counts.adpcm)})`);

  // TX: Chromium's fake microphone, sent in each browser's format
  async function talk(p) {
    const box = await p.page.locator('#ptt-btn').boundingBox();
    await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.page.mouse.down();
    await sleep(1200);
    await p.page.mouse.up();
    await sleep(300);
  }
  for (const p of [opus, adpcm, full]) {
    written.length = 0;
    await talk(p);
    const types = txTypes.get(p.ws) || [];
    const samples = written.reduce((n, b) => n + b.length / 2, 0);
    const want = p === opus ? BINARY_TYPE.AUDIO_OPUS : p === adpcm ? BINARY_TYPE.AUDIO_ADPCM : BINARY_TYPE.AUDIO;
    check(types.length > 20 && types.every((t) => t === want), `${p === opus ? 'Opus' : p === adpcm ? 'ADPCM' : 'full'} page: mic audio sent as type ${want} (${types.length} frames)`);
    check(samples > 48000 * 0.6, `and the radio gets 48 kHz PCM from it (${(samples / 48000).toFixed(2)} s)`);
    txTypes.delete(p.ws);
  }
  check(civ.ptt.filter((v) => v).length === 3 && civ.ptt.at(-1) === false, 'PTT went on and off for each');

  // The button switches, and the choice is remembered on that device
  await opus.page.click('#audio-format-btn');
  await sleep(300);
  check((await chipText(opus.page)) === 'Audio: full' && !bridge._clientCodec.has(opus.ws), 'tapping Audio: Opus switches that browser to full audio');
  check(bridge._clientCodec.get(adpcm.ws) === 'adpcm', 'without changing the other browsers');
  await full.page.click('#audio-format-btn');
  await sleep(300);
  check((await chipText(full.page)) === 'Audio: Opus' && bridge._clientCodec.get(full.ws) === 'opus', 'tapping Audio: full switches to compressed (Opus)');
  {
    const known = new Set(server.clients);
    await full.page.reload();
    await full.page.waitForFunction(() => document.getElementById('audio-format-btn').textContent !== 'Audio: full', null, { timeout: 8000 }).catch(() => {});
    await sleep(300);
    const ws = [...server.clients].find((w) => !known.has(w));
    check((await chipText(full.page)) === 'Audio: Opus' && bridge._clientCodec.get(ws) === 'opus', 'after a reload the choice is remembered (and sent to the server again)');
  }
  check(bridge._clientCodec.size === 2, "a closed page's format is forgotten by the server");

  await opus.page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR || require('os').tmpdir(), 'piro-audio-ui.png') });
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  bridge.stop();
  await server.close();
  console.log(failures ? `\n${failures} UI check(s) failed` : '\nAll audio UI checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
