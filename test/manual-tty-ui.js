'use strict';
// Manual (not part of `npm test`): needs Playwright + Chromium. Optional CHROMIUM_PATH env.
// Drives the real client in headless Chromium against a real ControlServer + TtyBridge with a stub radio.
const path = require('path');
const { EventEmitter } = require('events');
const PKG = path.join(__dirname, '..');
const { ControlServer } = require(PKG + '/src/server/ws-server');
const { TtyBridge } = require(PKG + '/src/audio/tty-bridge');
const { JttyDecoderBridge } = require(PKG + '/src/server/jtty-decoder-bridge');
const { OliviaDecoderBridge } = require(PKG + '/src/server/olivia-decoder-bridge');
const { encodeOlivia } = require(PKG + '/src/audio/olivia-tx');
const { HellDecoderBridge } = require(PKG + '/src/server/hell-decoder-bridge');
const { encodeFeldHell } = require(PKG + '/src/audio/hell-tx');
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
  const oliviaRx = new OliviaDecoderBridge({ controlServer: server, audioBridge });
  oliviaRx.start();
  const hellRx = new HellDecoderBridge({ controlServer: server, audioBridge });
  hellRx.start();

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

  // click 3 -> Olivia
  const modeCalls = civ.log.filter((e) => e[0] === 'setMode' || e[0] === 'setDataMode').length;
  await page.locator('#modes .chip', { hasText: /^JTTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'Olivia'));
  await sleep(200);
  check((await ttyLabel()).includes('Olivia'), 'third click: button relabelled "Olivia"');
  check(civ.mode === 'USB' && civ.dataMode === true && civ.log.filter((e) => e[0] === 'setMode' || e[0] === 'setDataMode').length === modeCalls, 'JTTY -> Olivia leaves the radio alone (USB, DATA MODE on, no mode commands)');
  check(server.state.jttyActive === false && !jttyRx.attached && server.state.oliviaActive === true && oliviaRx.attached, 'JTTY receiver disarmed, Olivia receiver armed');
  check(civ.log.some((e) => e[0] === 'setFrequency' && e[1] === 14071500), 'entering Olivia on 20m tunes to the 14.0715 MHz calling frequency');
  check(await vis('#olivia-rx') && !(await vis('#jtty-rx')) && await vis('#tty-freq'), 'Olivia: transcript panel shown, JTTY table hidden, frequency box kept');
  check((await page.locator('#tty-freq-label').textContent()).trim().startsWith('Centre') && (await page.locator('#tty-freq').inputValue()) === '1500', 'frequency box is labelled "Centre" and holds 1500 Hz');
  check((await page.locator('#tty-input').inputValue()) === 'cq vk2io cq', 'composer keeps the text the operator typed (moving on from JTTY)');
  check((await page.locator('#ptt-hint').textContent()).includes('Olivia'), 'hint text describes Olivia');
  check((await page.locator('#tty-input').evaluate((e) => getComputedStyle(e).textTransform)) === 'none', 'Olivia: the text box shows the real case (Olivia sends it as typed)');

  // Olivia receive: a signal 31 Hz above the centre, fed through the capture
  // stream. The receiver prints each block about 4 blocks (~8 s) after it
  // arrives (it integrates before deciding, as fldigi does), so keep
  // feeding the band for a while after the signal ends.
  {
    const enc = encodeOlivia('CQ CQ DE K1ABC K1ABC K\r\n', { centreHz: 1531, amplitude: 0.3 });
    const pcm = upsampleFloatToPcm(enc.samples, 8000, 48000);
    const all = Buffer.concat([Buffer.alloc(96000), pcm, Buffer.alloc(48000 * 2 * 12)]);
    for (let i = 0; i < all.length; i += 9600) {
      capture.emit('data', all.subarray(i, i + 9600));
      while ((oliviaRx._sentSamples - oliviaRx._ackedSamples) / 8000 > 3) await sleep(5);
    }
    await page.waitForFunction(() => /CQ CQ DE K1ABC K1ABC K/.test(document.getElementById('olivia-rx-text').textContent), null, { timeout: 20000 });
    check(true, 'received Olivia text appears in the transcript');
    const sig = await page.locator('#olivia-signal').textContent();
    check(/S\/N \d/.test(sig) && /31 Hz above centre/.test(sig), 'signal line shows S/N and the offset: ' + sig);
    check(/ Hz$/.test(await page.locator('#scope-range-hi').textContent()) && !(await vis('#scope-spans')), 'Olivia: the scope shows the audio spectrum, RF spans hidden');
    check(await vis('#olivia-tune-btn'), '"Tune to signal" offered for an off-centre signal');
    await page.locator('#olivia-tune-btn').click();
    await sleep(200);
    check((await page.locator('#tty-freq').inputValue()) === '1531' && server.state.oliviaCentreHz === 1531 && oliviaRx.centreHz === 1531, 'Tune to signal moves the centre onto it (box, server, receiver)');
    check(!(await vis('#olivia-tune-btn')), 'and the button goes away');
  }

  // Send an Olivia message (long: stop it once it is going)
  {
    const w = writes.length;
    await page.locator('#tty-input').fill('VK2IO DE K1ABC TNX');
    await page.locator('#tty-send-btn').click();
    await page.waitForFunction(() => /Sending Olivia/.test(document.getElementById('tty-status').textContent), null, { timeout: 8000 });
    const st = await page.locator('#tty-status').textContent();
    check(/Sending Olivia: "VK2IO DE K1ABC TNX"/.test(st) && /centre 1531 Hz/.test(st) && /\d+\.\d s/.test(st), 'Olivia status line: ' + st);
    check(writes.length === w + 1 && civ.log.some((e) => e[0] === 'setPtt' && e[1] === true), 'Olivia audio written and PTT keyed');
    check(!oliviaRx.attached, 'Olivia receiver pauses while transmitting');
    check(/VK2IO DE K1ABC TNX/.test(await page.locator('#olivia-rx-text .olivia-rx__own').last().textContent()), 'own transmission is shown in the transcript');
    await page.locator('#tty-send-btn').click(); // Stop
    await page.waitForFunction(() => /Stopped Olivia/.test(document.getElementById('tty-status').textContent), null, { timeout: 8000 });
    await sleep(100);
    check(civ.log.filter((e) => e[0] === 'setPtt').at(-1)[1] === false && oliviaRx.attached, 'Stop releases PTT and the receiver resumes');
  }

  // click 4 -> Feld-Hell
  {
    const modeCalls = civ.log.filter((e) => e[0] === 'setMode' || e[0] === 'setDataMode').length;
    await page.locator('#modes .chip', { hasText: /^Olivia$/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'Feld-Hell'));
    await sleep(150);
    check(civ.mode === 'USB' && civ.dataMode === true && civ.log.filter((e) => e[0] === 'setMode' || e[0] === 'setDataMode').length === modeCalls, 'fourth click: Feld-Hell, radio left alone (USB, DATA MODE on)');
    check(server.state.oliviaActive === false && !oliviaRx.attached && server.state.hellActive === true && hellRx.attached, 'Olivia receiver disarmed, Feld-Hell receiver armed');
    check(civ.log.at(-1)[0] === 'setFrequency' && civ.log.at(-1)[1] === 14062000, 'entering Feld-Hell on 20m puts a 1000 Hz tone on 14.063 MHz (dial 14.062)');
    check(!(await vis('#olivia-rx')) && !(await vis('#jtty-rx')) && (await vis('#tty-freq')) && (await page.locator('#tty-freq').inputValue()) === '1000', 'Feld-Hell: no text panel, tone box at 1000 Hz');
    check(/^Tone/.test(await page.locator('#tty-freq-label').textContent()), 'the box is labelled "Tone"');
    check((await page.locator('#ptt-hint').textContent()).includes('Feld-Hell'), 'hint text describes Feld-Hell');
    check((await page.locator('#tty-input').evaluate((e) => getComputedStyle(e).textTransform)) === 'none', 'Feld-Hell: the text box shows the real case');

    // receive: the picture scrolls in from the right of the waterfall area
    const bright = () =>
      page.locator('#scope-waterfall').evaluate((c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let left = 0;
        let right = 0;
        for (let y = 0; y < c.height; y++)
          for (let x = 0; x < c.width; x++) {
            if (d[(y * c.width + x) * 4 + 1] > 128) x < c.width / 2 ? left++ : right++;
          }
        return { left, right };
      });
    const enc = encodeFeldHell('CQ CQ DE K1ABC K1ABC K', { toneHz: 1000, amplitude: 0.3 });
    const pcm = upsampleFloatToPcm(enc.samples, 8000, 48000);
    const half = Math.floor((48000 * 1.2)) * 2; // the first 1.2 s: about 21 columns
    for (let i = 0; i < half; i += 9600) capture.emit('data', pcm.subarray(i, Math.min(half, i + 9600)));
    await sleep(400);
    const b1 = await bright();
    check(b1.right > 200 && b1.left === 0, `received picture starts at the right edge (${b1.right} lit pixels right, ${b1.left} left)`);
    for (let i = half; i < pcm.length; i += 9600) capture.emit('data', pcm.subarray(i, i + 9600));
    await sleep(400);
    const b2 = await bright();
    check(b2.left > 200, `and scrolls left as more arrives (${b2.left} lit pixels left)`);
    check(/ Hz$/.test(await page.locator('#scope-range-hi').textContent()) && !(await vis('#scope-spans')), 'Feld-Hell: the trace shows the audio spectrum, RF spans hidden');
    check(!(await vis('#scope-placeholder')), 'the "scope not enabled" notice does not cover the audio spectrum or the picture');

    // clicking the spectrum sets the tone; clicking the picture does nothing
    const box = await page.locator('#scope-trace').boundingBox();
    const hi = Number((await page.locator('#scope-range-hi').textContent()).replace(/[^\d.]/g, ''));
    await page.mouse.click(box.x + (box.width * 1500) / hi, box.y + box.height / 2);
    await sleep(200);
    const tone = Number(await page.locator('#tty-freq').inputValue());
    check(Math.abs(tone - 1500) <= 10 && tone % 10 === 0 && server.state.hellToneHz === tone && hellRx._receiver.toneHz === tone, `clicking the spectrum sets the tone to the nearest 10 Hz (${tone}), receiver retuned`);
    const wf = await page.locator('#scope-waterfall').boundingBox();
    await page.mouse.click(wf.x + wf.width * 0.2, wf.y + wf.height / 2);
    await sleep(200);
    check(Number(await page.locator('#tty-freq').inputValue()) === tone, 'clicking the picture does not change the tone');

    // send
    const w = writes.length;
    await page.locator('#tty-input').fill('VK2IO de K1ABC');
    await page.locator('#tty-send-btn').click();
    await page.waitForFunction(() => /Sending Feld-Hell/.test(document.getElementById('tty-status').textContent), null, { timeout: 8000 });
    const st = await page.locator('#tty-status').textContent();
    check(/Sending Feld-Hell: "VK2IO de K1ABC"/.test(st) && new RegExp(`tone ${tone} Hz`).test(st), 'Feld-Hell status line: ' + st);
    check(writes.length === w + 1 && !hellRx.attached, 'Feld-Hell audio written, receiver paused while transmitting');
    await page.locator('#tty-send-btn').click(); // Stop
    await page.waitForFunction(() => /Stopped Feld-Hell/.test(document.getElementById('tty-status').textContent), null, { timeout: 8000 });
    await sleep(100);
    check(civ.log.filter((e) => e[0] === 'setPtt').at(-1)[1] === false && hellRx.attached, 'Stop releases PTT and the receiver resumes');
  }

  // Enter key sends too; RTTY text via Enter
  // click 5 -> back to RTTY
  await page.locator('#modes .chip', { hasText: /^Feld-Hell$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'RTTY'));
  await sleep(150);
  check(civ.mode === 'RTTY' && civ.dataMode === false, 'fifth click: back to RTTY, DATA MODE off');
  check(server.state.jttyActive === false && !jttyRx.attached && server.state.oliviaActive === false && !oliviaRx.attached && server.state.hellActive === false && !hellRx.attached, 'leaving Feld-Hell disarms the receiver');
  {
    const lit = await page.locator('#scope-waterfall').evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 1; i < d.length; i += 4) if (d[i] > 128) n++;
      return n;
    });
    check(lit === 0, 'the picture is cleared on leaving Feld-Hell');
  }
  check(!(await vis('#olivia-rx')) && !(await vis('#tty-freq')), 'RTTY: no Olivia panel, no frequency box');
  check(await vis('#scope-placeholder'), 'back on the RF scope, its "not enabled" notice returns');
  check((await page.locator('#tty-input').evaluate((e) => getComputedStyle(e).textTransform)) === 'uppercase', 'RTTY: the text box shows capitals again');
  await page.locator('#tty-input').fill('test 73');
  await page.locator('#tty-input').press('Enter');
  await page.waitForFunction(() => /Sent RTTY/.test(document.getElementById('tty-status').textContent), null, { timeout: 8000 });
  check(true, 'Enter sends; RTTY status "Sent RTTY"');
  check(writes.length === 4, 'RTTY audio written');

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

  // Olivia -> LSB: leaves Olivia, DATA MODE off, PTT back
  await page.locator('#modes .chip', { hasText: /^TTY$/ }).click();
  await page.locator('#modes .chip', { hasText: /^RTTY$/ }).click();
  await page.locator('#modes .chip', { hasText: /^JTTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'Olivia'));
  check((await page.locator('#tty-freq').inputValue()) === '1531', 'Olivia remembers its centre between sessions');
  await chip('LSB').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'TTY'));
  await sleep(200);
  check(civ.mode === 'LSB' && civ.dataMode === false && server.state.oliviaActive === false && (await vis('#ptt-btn')), 'Olivia -> LSB: Olivia off, DATA MODE off, PTT back');

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
  oliviaRx.stop();
  hellRx.stop();
  await server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
