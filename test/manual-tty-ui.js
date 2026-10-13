'use strict';
// Manual (not part of `npm test`): needs Playwright + Chromium. Optional CHROMIUM_PATH env.
// Drives the real client in headless Chromium against a real ControlServer + TtyBridge with a stub radio.
const path = require('path');
const { EventEmitter } = require('events');
const PKG = path.join(__dirname, '..');
const { ControlServer } = require(PKG + '/src/server/ws-server');
const { TtyBridge } = require(PKG + '/src/audio/tty-bridge');
const { JttyDecoderBridge } = require(PKG + '/src/server/jtty-decoder-bridge');
const { encodeJtty } = require(PKG + '/src/audio/jtty-tx');
const { upsampleFloatToPcm } = require(PKG + '/src/audio/resample');
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
  constructor() { super(); this.radioAddr = 0x94; this.mode = 'LSB'; this.dataMode = false; this.log = []; }
  async getFrequency() { return this.freq ?? 14080000; }
  async setFrequency(hz) { this.log.push(['setFrequency', hz]); this.freq = hz; return true; }
  async getMode() { return { mode: this.mode, filter: 1 }; }
  async setMode(mode) { this.log.push(['setMode', mode]); this.mode = mode; this.emit('mode', { mode, filter: 1 }); return true; }
  async setDataMode(on) { this.log.push(['setDataMode', on]); this.dataMode = on; return true; }
  async getDataMode() { return this.dataMode; }
  async setPtt(on) { this.log.push(['setPtt', on]); return true; }
  async getSMeter() { return 100; }
  async getSWR() { return 0; }
  async getPreamp() { return 0; } async getNoiseReduction() { return false; } async getNoiseBlanker() { return false; }
  async getNotch() { return false; } async getTuner() { return 0; } async getFilter() { return 1; }
  async getTxPower() { return 100; } async getRxGain() { return 255; }
}

(async () => {
  const civ = new Civ();
  const server = new ControlServer({ civ, port: 0, staticDir: PKG + '/src/client', stationCallsign: 'VK2IO', stationGrid: 'QF56' });
  const port = await server.listen();
  const writes = [];
  const capture = new EventEmitter();
  const audioBridge = { sampleRate: 48000, capture, playback: { write: (b) => writes.push(b), restart() { this.restarted = (this.restarted || 0) + 1; } } };
  const tty = new TtyBridge({ controlServer: server, audioBridge, pttReleaseMarginMs: 20 });
  tty.start();
  const jttyRx = new JttyDecoderBridge({ controlServer: server, audioBridge });
  jttyRx.start();

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => !document.getElementById('tty-send-btn').disabled, null, { timeout: 8000 });

  const chip = (label) => page.locator('#modes .chip', { hasText: new RegExp(`^${label}$`) });
  const ttyLabel = async () => (await page.locator('#modes .chip').allTextContents());
  const vis = async (sel) => page.locator(sel).isVisible();

  let labels = await ttyLabel();
  check(labels.includes('TTY') && !labels.includes('RTTY'), 'mode row shows "TTY" (no separate RTTY chip): ' + labels.join(' '));
  check(!(await vis('#tty-composer')) && (await vis('#ptt-btn')), 'initially: PTT button visible, no text entry');

  // click 1 -> RTTY
  await page.locator('#modes .chip', { hasText: /^TTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'RTTY'));
  check(civ.mode === 'RTTY', 'first click puts the radio in RTTY mode');
  check((await ttyLabel()).includes('RTTY'), 'button relabelled "RTTY"');
  check(await vis('#tty-composer') && !(await vis('#ptt-btn')), 'RTTY: text entry + Send replace the PTT button');
  check((await page.locator('#tty-send-btn').textContent()) === 'Send', 'Send button present');
  check(await vis('#rtty-ticker-section'), 'RTTY decode ticker visible');
  check((await page.locator('#tty-input').inputValue()) === 'CQ CQ DE VK2IO VK2IO K', 'composer pre-filled with an RTTY CQ');
  check(await page.locator('#modes .chip', { hasText: /^RTTY$/ }).evaluate((e) => e.classList.contains('chip--active')), 'TTY chip highlighted');

  // click 2 -> JTTY
  await page.locator('#modes .chip', { hasText: /^RTTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'JTTY'));
  await sleep(150);
  check(civ.mode === 'USB' && civ.dataMode === true, 'second click: radio on USB with DATA MODE on (JTTY)');
  check((await ttyLabel()).includes('JTTY'), 'button relabelled "JTTY"');
  check(civ.log.some((e) => e[0] === 'setFrequency' && e[1] === 14090000), 'entering JTTY on 20m tunes to 14.090 MHz');
  check(await vis('#tty-composer') && !(await vis('#ptt-btn')), 'JTTY: text entry + Send, no PTT');
  check(!(await vis('#rtty-ticker-section')), 'RTTY ticker hidden in JTTY');
  check((await page.locator('#tty-input').inputValue()) === 'CQ VK2IO CQ', 'composer text switched to a JTTY CQ (it was untouched)');
  check((await page.locator('#ptt-hint').textContent()).includes('JTTY'), 'hint text describes JTTY');

  // Space must not key PTT in TTY modes
  const before = civ.log.filter((e) => e[0] === 'setPtt').length;
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('Space');
  await sleep(200);
  check(civ.log.filter((e) => e[0] === 'setPtt').length === before, 'Space bar does not key PTT in JTTY');

  // JTTY receive: server armed, decoded messages appear and a tap sets the TX frequency
  check(server.state.jttyActive === true && jttyRx.attached, 'entering JTTY arms the server-side receiver');
  check(await vis('#jtty-rx') && await vis('#tty-freq'), 'JTTY: received-messages table and TX frequency box shown');
  {
    const enc = encodeJtty('CQ K1ABC CQ', { f0: 1300, amplitude: 0.3 });
    const sig = new Float32Array(6000 + enc.samples.length + 12000 * 4);
    sig.set(enc.samples, 3000);
    const pcm = upsampleFloatToPcm(sig, 12000, 48000);
    for (let i = 0; i < pcm.length; i += 1920) capture.emit('data', pcm.subarray(i, i + 1920));
    await page.waitForFunction(() => /CQ K1ABC CQ/.test(document.getElementById('jtty-table-body').textContent), null, { timeout: 15000 });
    const cells = await page.locator('#jtty-table-body .ft8-table__row').first().locator('span').allTextContents();
    check(cells[1] === '1300' && cells[3] === 'CQ K1ABC CQ', 'received row shows frequency and text: ' + cells.join(' | '));
    check(/^\d\d:\d\d:\d\d$/.test(cells[0]), 'received row has a UTC time: ' + cells[0]);
    await page.locator('#jtty-table-body .ft8-table__row').first().click();
    check((await page.locator('#tty-freq').inputValue()) === '1300', 'tapping a received line sets the TX frequency');
    check(/ Hz$/.test(await page.locator('#scope-range-hi').textContent()), 'JTTY: the scope shows the audio spectrum (Hz axis): ' + (await page.locator('#scope-range-hi').textContent()));
    check(!(await vis('#scope-spans')), 'JTTY: RF span buttons hidden');
  }

  // Send a JTTY message
  await page.locator('#tty-input').fill('cq vk2io cq');
  await page.locator('#tty-send-btn').click();
  await page.waitForFunction(() => document.getElementById('tty-send-btn').textContent === 'Stop', null, { timeout: 4000 });
  check(true, 'Send turned into Stop while transmitting');
  const st = await page.locator('#tty-status').textContent();
  check(/Sending JTTY: "CQ VK2IO CQ"/.test(st) && /1 frame/.test(st), 'status line: ' + st);
  check(/1300.1394 Hz/.test(st), 'transmit used the tapped frequency (1300 Hz)');
  check(civ.log.some((e) => e[0] === 'setPtt' && e[1] === true), 'server keyed PTT');
  check(writes.length === 1, 'audio was written to the transmit path');
  // Stop it
  await page.locator('#tty-send-btn').click();
  await page.waitForFunction(() => document.getElementById('tty-send-btn').textContent === 'Send', null, { timeout: 4000 });
  check(/Stopped JTTY/.test(await page.locator('#tty-status').textContent()), 'Stop aborts: status says stopped');
  check(audioBridge.playback.restarted === 1, 'abort flushed the audio');
  check(civ.log.filter((e) => e[0] === 'setPtt').at(-1)[1] === false, 'PTT released after stop');

  // Enter key sends too; RTTY text via Enter
  // click -> back to RTTY
  await page.locator('#modes .chip', { hasText: /^JTTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'RTTY'));
  await sleep(150);
  check(civ.mode === 'RTTY' && civ.dataMode === false, 'third click: back to RTTY, DATA MODE off');
  check(server.state.jttyActive === false && !jttyRx.attached, 'leaving JTTY disarms the receiver');
  await page.locator('#tty-input').fill('test 73');
  await page.locator('#tty-input').press('Enter');
  await page.waitForFunction(() => /Sent RTTY/.test(document.getElementById('tty-status').textContent), null, { timeout: 8000 });
  check(true, 'Enter sends; RTTY status "Sent RTTY"');
  check(writes.length === 2, 'RTTY audio written');

  // typed text survives mode toggling
  await page.locator('#modes .chip', { hasText: /^RTTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'JTTY'));
  check((await page.locator('#tty-input').inputValue()) === 'test 73', 'operator-typed text is kept when toggling RTTY <-> JTTY');

  // leave TTY by picking a normal mode -> label returns to TTY, PTT back
  await chip('USB').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'TTY'));
  await sleep(150);
  check(civ.mode === 'USB' && civ.dataMode === false, 'picking USB leaves JTTY (DATA MODE off)');
  check((await ttyLabel()).includes('TTY') && !(await ttyLabel()).includes('JTTY'), 'button back to "TTY"');
  check((await vis('#ptt-btn')) && !(await vis('#tty-composer')), 'PTT button restored, text entry gone');
  check((await page.locator('#ptt-hint').textContent()).startsWith('Hold to transmit'), 'PTT hint restored');

  // RTTY -> CW -> PTT hidden for CW paddle, label TTY
  await page.locator('#modes .chip', { hasText: /^TTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'RTTY'));
  await chip('FM').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'TTY'));
  check(civ.mode === 'FM' && (await vis('#ptt-btn')), 'RTTY -> FM: label TTY, PTT back');
  await page.locator('#modes .chip', { hasText: /^TTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'RTTY'));
  await page.locator('#modes .chip', { hasText: /^CW/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'TTY'));
  check(!(await vis('#tty-composer')) && !(await vis('#ptt-btn')) && (await vis('#cw-paddle')), 'RTTY -> CW: composer gone, CW paddle shown, PTT hidden');

  // JTTY -> FT8 and back
  await page.locator('#modes .chip', { hasText: /^TTY$/ }).click();
  await page.locator('#modes .chip', { hasText: /^RTTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'JTTY'));
  await page.locator('#modes .chip', { hasText: /^FT8/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'TTY'));
  await sleep(200);
  check(civ.dataMode === true, 'JTTY -> FT8 leaves DATA MODE on (FT8 needs it)');
  check(!(await vis('#tty-composer')) && !(await vis('#ptt-btn')), 'FT8: neither PTT nor TTY composer (FT8 panel instead)');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  tty.stop();
  jttyRx.stop();
  await server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
