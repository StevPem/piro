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
const { SstvDecoderBridge } = require(PKG + '/src/server/sstv-decoder-bridge');
const { encodeSstv } = require(PKG + '/src/audio/sstv-tx');
const { SstvTxBridge } = require(PKG + '/src/server/sstv-tx-bridge');
const { CwTxBridge } = require(PKG + '/src/server/cw-tx-bridge');
const { WsprBridge } = require(PKG + '/src/server/wspr-bridge');
const { BandConditions } = require(PKG + '/src/server/band-conditions');
const { FaxDecoderBridge } = require(PKG + '/src/server/fax-decoder-bridge');
const { EasypalDecoderBridge } = require(PKG + '/src/server/easypal-decoder-bridge');
const { EasypalTxBridge } = require(PKG + '/src/server/easypal-tx-bridge');
const { VaraBridge } = require(PKG + '/src/server/vara-bridge');
const easypalFx = require('./fixtures/easypal-audio');
const { encodeFax, FAX_WIDTH } = require(PKG + '/src/audio/fax-tx');
const { EVENT } = require(PKG + '/src/server/protocol');
const { encodePng } = require(PKG + '/src/server/png');
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
  async getSWR() { return this.swr ?? 0; }
  async getAlc() { return this.alc ?? 0; }
  async getPreamp() { return 0; } async getNoiseReduction() { return false; } async getNoiseBlanker() { return false; }
  async getNotch() { return false; } async getTuner() { return 0; } async getFilter() { return 1; }
  async getTxPower() { return this.power ?? 100; } async getRxGain() { return 255; }
  async setTxPower(w) { this.log.push(['setTxPower', w]); this.power = w; return w; }
  // CW keyer (CI-V 17): each piece "takes" 5 s to send
  async getKeySpeed() { return this.keySpeed ?? 15; }
  async setKeySpeed(w) { this.log.push(['setKeySpeed', w]); this.keySpeed = w; return w; }
  async getBreakIn() { return this.breakIn ?? 0; }
  async setBreakIn(v) { this.log.push(['setBreakIn', v]); this.breakIn = v; return true; }
  async sendCw(t) { this.log.push(['sendCw', t]); this.cwUntil = Date.now() + 5000; return true; }
  async stopCw() { this.log.push(['stopCw']); this.cwUntil = 0; return true; }
  async getTransmitting() { return Date.now() < (this.cwUntil || 0); }
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
  const sstvRx = new SstvDecoderBridge({ controlServer: server, audioBridge });
  sstvRx.start();
  const sstvTx = new SstvTxBridge({ controlServer: server, audioBridge, callsign: 'VK2IO', pttReleaseMarginMs: 20 });
  sstvTx.start();
  const cwTx = new CwTxBridge({ controlServer: server });
  cwTx.start();
  // WSPR, with a slot clock the test drives and no decoding (the spots are put in by hand)
  const wsprClock = Object.assign(new EventEmitter(), { currentSlotStart: () => Date.now() - (Date.now() % 120000), start() {}, stop() {} });
  const wspr = new WsprBridge({ controlServer: server, audioBridge, callsign: 'VK2IO', grid: 'QF56', slotClock: wsprClock, decoder: { decode: async () => ({ decodes: [], hashtab: [] }), terminate() {} }, wsprnet: { upload: async () => ({ sent: 1 }) }, random: () => 0 });
  wspr.start();
  const faxRx = new FaxDecoderBridge({ controlServer: server, audioBridge, stateFile: null });
  faxRx.start();
  const easypalRx = new EasypalDecoderBridge({ controlServer: server, audioBridge });
  easypalRx.start();
  const easypalTx = new EasypalTxBridge({ controlServer: server, audioBridge, callsign: 'VK2IO', seconds: 30, pttReleaseMarginMs: 20 });
  easypalTx.start();
  // VARA chat, with stand-in modems the test drives (the real one is tested in vara.test.js)
  const varaWorkers = [];
  const vara = new VaraBridge({
    controlServer: server,
    audioBridge,
    callsign: 'VK2IO',
    dataSettleMs: 0,
    createWorker: () => {
      const w = Object.assign(new EventEmitter(), { sent: [], terminated: false, postMessage(m) { this.sent.push(m); }, terminate() { this.terminated = true; } });
      varaWorkers.push(w);
      return w;
    },
  });
  vara.start();
  // "Current conditions", with wspr.live answered by hand
  const conditions = new BandConditions({ controlServer: server, grid: 'QF56', query: async () => [[1409, 'K1ABC', 16500, ['VK2IO']], [704, 'VK3TR', 700, ['VK2IO']]] });
  conditions.start();
  server.bandConditions = conditions;
  conditions.addSlot({ slotStartMs: Date.now() - 600000, dialHz: 14095600, decodes: [{ callsign: 'JA1XYZ', grid: 'PM95' }] });
  conditions.addSlot({ slotStartMs: Date.now() - 300000, dialHz: 7038600, decodes: [] });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => !document.getElementById('tty-send-btn').disabled, null, { timeout: 8000 });

  // A second browser on the same server (another phone, say): it follows
  // every mode the first one picks, without sending any radio commands itself.
  const pageB = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  pageB.on('pageerror', (e) => errors.push('B: ' + e.message));
  pageB.on('console', (m) => { if (m.type() === 'error') errors.push('B: ' + m.text()); });
  const bRequests = [];
  {
    const known = new Set(server.clients);
    await pageB.goto(`http://localhost:${port}/`);
    await pageB.waitForFunction(() => !document.getElementById('tty-send-btn').disabled, null, { timeout: 8000 });
    const wsB = [...server.clients].find((w) => !known.has(w));
    const orig = server._handleMessage.bind(server);
    server._handleMessage = (ws, raw) => {
      if (ws === wsB) bRequests.push(JSON.parse(raw.toString()));
      return orig(ws, raw);
    };
  }
  const bFollows = (fn, arg) => pageB.waitForFunction(fn, arg, { timeout: 4000 }).then(() => true, () => false);
  const bChips = () => pageB.locator('#modes .chip').allTextContents();

  // How many browsers are connected, in brackets after "Connected"
  {
    const count = (pg) => pg.locator('#led-count').textContent();
    const shows = (pg, text) => pg.waitForFunction((t) => document.getElementById('led-count').textContent === t && !document.getElementById('led-count').hidden, text, { timeout: 4000 }).then(() => true, () => false);
    check((await shows(page, '(2)')) && (await shows(pageB, '(2)')), `two browsers: both show "Connected (2)"`);
    check(/^\s*Connected\s*\(2\)\s*$/.test(await page.locator('.led').textContent()), `it reads "${(await page.locator('.led').textContent()).trim().replace(/\s+/g, ' ')}"`);
    if (process.env.COUNT_SHOT) await page.locator('header').screenshot({ path: process.env.COUNT_SHOT });
    const pageK = await browser.newPage();
    await pageK.goto(`http://localhost:${port}/`);
    check((await shows(pageK, '(3)')) && (await shows(page, '(3)')) && (await shows(pageB, '(3)')), 'a third opens: all three show (3)');
    await pageK.close();
    check((await shows(page, '(2)')) && (await shows(pageB, '(2)')), `it closes: back to (2) (${await count(page)})`);
  }

  const chip = (label) => page.locator('#modes .chip', { hasText: new RegExp(`^${label}$`) });
  const ttyLabel = async () => (await page.locator('#modes .chip').allTextContents());
  const vis = async (sel) => page.locator(sel).isVisible();

  // Mode rows: SSB AM FM CW on top, TTY DIGI FreeDV Image below
  {
    const chips = await page.locator('#modes .chip').evaluateAll((els) => els.map((e) => ({ t: e.textContent, top: e.offsetTop, on: e.classList.contains('chip--active') })));
    check(chips.map((c) => c.t).join(' ') === 'LSB AM FM CW TTY DIGI FreeDV Image', 'mode chips: ' + chips.map((c) => c.t).join(' ') + ' (the SSB chip reads LSB: the radio is on LSB)');
    check(chips.slice(0, 4).every((c) => c.top === chips[0].top) && chips.slice(4).every((c) => c.top === chips[4].top) && chips[4].top > chips[0].top, 'two rows of four');
    check(chips[0].on && chips.slice(1).every((c) => !c.on), 'only the SSB chip is lit');
  }

  // "Current conditions": beside the Band label, above the band buttons; a window with the table
  {
    const label = await page.locator('.row-group[aria-label="Band"] .row-group__label').boundingBox();
    const link = await page.locator('#conditions-btn').boundingBox();
    const bands = await page.locator('#bands').boundingBox();
    const word = await page.locator('.row-group[aria-label="Band"] .row-group__label').evaluate((e) => e.firstChild.textContent.trim());
    check(word === 'Band' && link && link.x > label.x + 20 && Math.abs(link.y - label.y) < 6 && link.y + link.height <= bands.y + 1, '"Current conditions" sits to the right of "Band", above the band buttons');
    await page.locator('#conditions-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('#conditions-body tr').length === 10, null, { timeout: 5000 });
    const table = await page.evaluate(() => ({
      open: document.getElementById('conditions-dialog').open,
      head: [...document.querySelectorAll('.conditions__table th')].map((t) => t.textContent).join('|'),
      rows: [...document.querySelectorAll('#conditions-body tr')].map((r) => [...r.children].map((c) => c.querySelector('.conditions__tag')?.textContent ?? c.textContent).join(' ')),
      note: document.getElementById('conditions-note').textContent,
    }));
    check(table.open && table.head === 'Band|My QTH|Local area', 'clicking it opens a window with Band, My QTH and Local area columns');
    check(table.rows.join(' | ') === '160m N/A N/A | 80m N/A N/A | 40m Dismal Dismal | 30m N/A N/A | 20m Good Great | 17m N/A N/A | 15m N/A N/A | 12m N/A N/A | 10m N/A N/A | 6m N/A N/A', 'one row per band, tagged: ' + table.rows.join(' | '));
    check(table.note.includes('QF47 QF57 QF67 QF46 QF56 QF66 QF45 QF55 QF65') && /wsprnet\.org/.test(table.note), 'the note names the 9 squares of the local area and where the spots come from');
    if (process.env.CONDITIONS_SHOT) await page.locator('#conditions-dialog').screenshot({ path: process.env.CONDITIONS_SHOT });
    await page.locator('#conditions-close').click();
    check(!(await page.locator('#conditions-dialog').evaluate((d) => d.open)), 'Close shuts the window');
    check(await page.locator('#conditions-error').isHidden(), 'no error line when both columns have their data');
    // wspr.live out of reach: the window says so, plainly
    server.bandConditions = new BandConditions({ controlServer: server, grid: 'QF56', query: async () => { throw new Error('could not reach wspr.live (ENETUNREACH)'); } });
    await page.locator('#conditions-btn').click();
    await page.waitForFunction(() => !document.getElementById('conditions-error').hidden, null, { timeout: 5000 });
    const err = await page.locator('#conditions-error').textContent();
    check(/^Local area: could not reach wspr\.live \(ENETUNREACH\)/.test(err), 'when wspr.live can\'t be reached, the window shows why at the top: ' + err);
    await page.locator('#conditions-close').click();
    server.bandConditions = conditions;
  }

  // Operator notes: under the PTT button, shared, the newest three; a new one chimes and flashes the other browsers
  {
    const notesBox = await page.locator('#notes').boundingBox();
    const pttBox = await page.locator('#ptt-btn').boundingBox();
    check(notesBox && pttBox && notesBox.y > pttBox.y + pttBox.height, 'the notes box is below the PTT button');
    const counts = (p) => p.evaluate(() => ({ chimes: Number(document.getElementById('notes').dataset.chimes || 0), flashes: Number(document.getElementById('screen-flash').dataset.flashes || 0) }));
    const pttCalls = civ.log.filter((e) => e[0] === 'setPtt').length;
    await page.locator('#notes-input').fill('VK2IO: testing on 20 m');
    await page.locator('#notes-input').press('Space');
    await page.locator('#notes-input').press('Enter');
    check(await bFollows(() => /^\d\d:\d\dVK2IO: testing on 20 m$/.test(document.querySelector('#notes-list li')?.textContent || '')), 'Enter sends the note; the second browser shows it with its time');
    await sleep(100);
    const cb = await counts(pageB);
    const ca = await counts(page);
    check(cb.chimes === 1 && cb.flashes === 1, `the second browser chimes and flashes (${cb.chimes} chime, ${cb.flashes} flash)`);
    check(ca.chimes === 0 && ca.flashes === 0 && (await page.locator('#notes-input').inputValue()) === '' && (await page.locator('#notes-list li').count()) === 1, 'the sender: the note shown, the box cleared, no chime of its own');
    check(civ.log.filter((e) => e[0] === 'setPtt').length === pttCalls, 'typing a space in the note box does not key PTT');
    await pageB.waitForFunction(() => !document.getElementById('screen-flash').classList.contains('screen-flash--on'), null, { timeout: 3000 }).catch(() => {});
    for (const t of ['two', 'three', 'four']) {
      await pageB.locator('#notes-input').fill(t);
      await pageB.locator('#notes-send').click();
      await page.waitForFunction((x) => document.querySelector('#notes-list li span')?.textContent === x, t, { timeout: 3000 });
    }
    const items = await page.locator('#notes-list li span').allTextContents();
    check(items.join() === 'four,three,two', 'three most recent kept, newest first: ' + items.join(' | '));
    check((await counts(page)).chimes === 3 && (await counts(pageB)).chimes === 1, 'each new note chimes in the other browser only');
    const pageC = await browser.newPage({ viewport: { width: 430, height: 1100 } });
    pageC.on('pageerror', (e) => errors.push('C: ' + e.message));
    await pageC.goto(`http://localhost:${port}/`);
    await pageC.waitForFunction(() => document.querySelectorAll('#notes-list li').length === 3, null, { timeout: 8000 }).catch(() => {});
    await sleep(200);
    const cc = await counts(pageC);
    check((await pageC.locator('#notes-list li span').allTextContents()).join() === 'four,three,two' && cc.chimes === 0 && cc.flashes === 0, 'a browser opened later sees the notes, with no chime');
    check((await counts(page)).chimes === 3 && (await counts(pageB)).chimes === 1, 'and nobody chimes when it connects');
    if (process.env.UI_SHOTS) await page.screenshot({ path: process.env.UI_SHOTS + '/notes.png', fullPage: true, clip: { x: 0, y: Math.max(0, pttBox.y - 20), width: 430, height: pttBox.height + 220 } });
    await pageC.close();
  }

  // RNN is hidden for now (RNNOISE_IN_UI in app.js); HamNoise takes its place after NR.
  {
    const ids = await page.locator('#function-controls > *').evaluateAll((els) => els.map((e) => e.id || e.textContent.trim().split(/\s+/)[0]));
    const nr = ids.findIndex((x) => /^NR/.test(x));
    check(!(await page.locator('#rnnoise-button').count()) && ids[nr + 1] === 'hamnoise-button', 'no RNN button; HamNoise straight after NR: ' + ids.join(' '));
  }

  let labels = await ttyLabel();
  check(labels.includes('TTY') && !labels.includes('RTTY'), 'mode row shows "TTY" (no separate RTTY chip): ' + labels.join(' '));
  check(!(await vis('#tty-composer')) && (await vis('#ptt-btn')), 'initially: PTT button visible, no text entry');

  // click 1 -> RTTY
  await page.locator('#modes .chip', { hasText: /^TTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'RTTY'));
  check(civ.mode === 'RTTY', 'first click puts the radio in RTTY mode');
  await sleep(150);
  {
    const i = civ.log.findIndex((e) => e[0] === 'setFrequency' && e[1] === 14091000);
    check(i > civ.log.findIndex((e) => e[0] === 'setMode' && e[1] === 'RTTY') && i >= 0, 'selecting RTTY on 20m tunes to 14.091 MHz (middle of the WIA digital segment), after the mode change');
  }
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
  check(
    await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'JTTY' && c.classList.contains('chip--active')) && !document.getElementById('tty-composer').hidden && !document.getElementById('jtty-rx').hidden),
    'the second browser follows into JTTY (chip, composer and received-messages table): ' + (await bChips()).join(' ')
  );

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
    check(await bFollows(() => document.getElementById('tty-freq').value === '1300'), 'and the second browser shows the same JTTY transmit frequency (1300 Hz)');
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
    check(
      await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'Olivia') && document.getElementById('tty-freq').value === '1531' && !document.getElementById('olivia-rx').hidden),
      'the second browser is in Olivia too, with the new centre (1531 Hz)'
    );
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

  // click 4 -> VARA
  {
    const modeCalls = civ.log.filter((e) => e[0] === 'setMode' || e[0] === 'setDataMode').length;
    await page.locator('#modes .chip', { hasText: /^Olivia$/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'VARA'));
    await page.waitForFunction(() => /^listening/.test(document.getElementById('vara-status').textContent), null, { timeout: 4000 });
    check(civ.mode === 'USB' && civ.dataMode === true && civ.log.filter((e) => e[0] === 'setMode' || e[0] === 'setDataMode').length === modeCalls, 'fourth click: VARA, radio left alone (USB, DATA MODE on)');
    check(server.state.oliviaActive === false && !oliviaRx.attached && server.state.varaActive === true && vara.active, 'Olivia receiver disarmed, VARA modem started');
    check(civ.log.some((e) => e[0] === 'setFrequency' && e[1] === 14105000), 'entering VARA on 20m tunes to the 14.105 MHz VarAC calling frequency');
    for (const [band, hz] of [['160m', 1995000], ['30m', 10133000], ['17m', 18107000], ['12m', 24927000], ['10m', 28105000], ['20m', 14105000]]) {
      await page.locator('#bands .chip', { hasText: new RegExp(`^${band}$`) }).click();
      await sleep(150);
      check(civ.freq === hz && civ.mode === 'USB' && server.state.varaActive, `in VARA, the ${band} band chip goes to ${hz / 1e6} MHz USB`);
    }
    // QSYD / QSYU: one 750 Hz slot down or up; the status line says how far from the calling frequency.
    await page.waitForFunction(() => !document.getElementById('vara-qsyu-btn').disabled, null, { timeout: 4000 });
    {
      const order = await page.locator('.vara-rx__controls input, .vara-rx__controls button').evaluateAll((els) => els.map((e) => e.id));
      check(order.join(' ') === 'vara-call vara-connect-btn vara-cq-btn vara-qsyd-btn vara-qsyu-btn', 'QSYD and QSYU sit to the right of CQ');
    }
    await page.locator('#vara-qsyu-btn').click();
    await page.waitForFunction(() => /calling freq \+0\.75 kHz$/.test(document.getElementById('vara-status').textContent), null, { timeout: 4000 }).catch(() => {});
    check(civ.freq === 14105750 && /calling freq \+0\.75 kHz$/.test(await page.locator('#vara-status').textContent()), 'QSYU: up 750 Hz to 14.10575 MHz; status: ' + (await page.locator('#vara-status').textContent()));
    await page.locator('#vara-qsyd-btn').click();
    await sleep(150);
    await page.locator('#vara-qsyd-btn').click();
    await page.waitForFunction(() => /calling freq −0\.75 kHz$/.test(document.getElementById('vara-status').textContent), null, { timeout: 4000 }).catch(() => {});
    check(civ.freq === 14104250 && /calling freq −0\.75 kHz$/.test(await page.locator('#vara-status').textContent()), 'QSYD twice: down to 14.10425 MHz, 0.75 kHz below the calling frequency');
    await page.locator('#vara-qsyu-btn').click();
    await page.waitForFunction(() => document.getElementById('vara-status').textContent === 'listening (500 Hz)', null, { timeout: 4000 }).catch(() => {});
    check(civ.freq === 14105000 && (await page.locator('#vara-status').textContent()) === 'listening (500 Hz)', 'back on the calling frequency: no offset shown');
    // PSK Spot (the FT8 setting) is offered in VARA too
    check(await vis('.psk-spot-toggle'), 'the PSK Spot button is shown in VARA');
    await page.locator('#psk-spot-checkbox').click();
    await sleep(150);
    check(server.state.pskSpotEnabled === false, 'PSK Spot can be turned off from VARA');
    await page.locator('#psk-spot-checkbox').click();
    await sleep(150);
    check(server.state.pskSpotEnabled === true, 'and on again');
    check((await vis('#vara-rx')) && !(await vis('#olivia-rx')) && !(await vis('#tty-freq')), 'VARA: its panel shown (not Olivia\'s), no frequency box');
    check((await page.locator('#vara-status').textContent()) === 'listening (500 Hz)', 'status: listening (500 Hz)');
    check(await page.locator('#tty-send-btn').isDisabled(), 'Send is off until there is a QSO');
    check((await page.locator('#ptt-hint').textContent()).includes('VarAC'), 'hint text describes VARA');
    check((await page.locator('#tty-input').evaluate((e) => getComputedStyle(e).textTransform)) === 'none', 'VARA: the text box shows the real case');
    const w = varaWorkers.at(-1);
    const cmds = () => w.sent.filter((m) => m.type === 'command').map((m) => m.line);
    check(cmds().join('|') === 'MYCALL VK2IO|BW500|CHAT ON|P2P SESSION|COMPRESSION TEXT|LISTEN ON', 'the modem is set up as VARA Chat, listening: ' + cmds().join(', '));
    const say = (...lines) => w.emit('message', { type: 'lines', lines });
    say('OK', 'OK', 'OK', 'OK', 'OK', 'OK');
    check(
      await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'VARA') && !document.getElementById('vara-rx').hidden && document.getElementById('vara-status').textContent === 'listening (500 Hz)'),
      'the second browser is in VARA too'
    );

    // A station calls CQ: it is listed; tap it, then Connect.
    say('CQFRAME K1ABC 500');
    await page.waitForFunction(() => document.querySelector('#vara-heard .vara-rx__heard-call')?.textContent === 'K1ABC', null, { timeout: 4000 });
    check(/CQ from K1ABC \(500 Hz\)/.test(await page.locator('#vara-rx-text').textContent()), 'a CQ heard is listed, and noted in the conversation');
    await page.locator('#vara-heard .vara-rx__heard-call').click();
    check((await page.locator('#vara-call').inputValue()) === 'K1ABC', 'tapping a heard call puts it in the callsign box');
    await page.locator('#vara-connect-btn').click();
    await page.waitForFunction(() => document.getElementById('vara-connect-btn').textContent === 'Stop', null, { timeout: 4000 });
    check(cmds().at(-1) === 'CONNECT VK2IO K1ABC' && (await page.locator('#vara-status').textContent()) === 'calling K1ABC…', 'Connect: the modem calls K1ABC; the button becomes Stop');
    say('OK', 'PTT ON');
    await sleep(100);
    check(civ.log.filter((e) => e[0] === 'setPtt').at(-1)[1] === true, "the modem's PTT ON keys the radio");
    check(await page.waitForFunction(() => /transmitting$/.test(document.getElementById('vara-status').textContent), null, { timeout: 3000 }).then(() => true, () => false), 'the status line says it is transmitting');
    say('PTT OFF', 'CONNECTED VK2IO K1ABC 500', 'SN 7.5', 'BITRATE (3)  245 bps RX');
    await page.waitForFunction(() => /^QSO with K1ABC/.test(document.getElementById('vara-status').textContent), null, { timeout: 4000 });
    check(civ.log.filter((e) => e[0] === 'setPtt').at(-1)[1] === false, 'PTT OFF releases it');
    check((await page.locator('#vara-status').textContent()) === 'QSO with K1ABC · S/N 7.5 dB · 245 bps', 'connected: ' + (await page.locator('#vara-status').textContent()));
    check(!(await page.locator('#tty-send-btn').isDisabled()) && (await page.locator('#vara-connect-btn').textContent()) === 'Disconnect', 'Send is on; Connect became Disconnect');
    check((await page.locator('#vara-qsyd-btn').isDisabled()) && (await page.locator('#vara-qsyu-btn').isDisabled()), 'QSYD and QSYU are off in a QSO until the other station says it is ready to QSY');

    // VarAC on the calling frequency: no reports there; the answerer says it is ready (<Q>), the caller asks to QSY.
    const sentText = () => w.sent.filter((m) => m.type === 'send').map((m) => Buffer.from(m.data).toString('utf8'));
    const varacMsg = (t) => { const b = Buffer.from(t, 'utf8'); return Buffer.concat([Buffer.from(`${b.length} `), b]); };
    check(sentText().length === 0, 'calling on the calling frequency: nothing sent yet (no report there, as VarAC)');
    w.emit('message', { type: 'data', data: Uint8Array.from(varacMsg('<Q>')).buffer });
    await page.waitForFunction(() => /ready to QSY$/.test(document.getElementById('vara-status').textContent) && !document.getElementById('vara-qsyu-btn').disabled, null, { timeout: 4000 }).catch(() => {});
    check(!(await page.locator('#vara-qsyu-btn').isDisabled()) && /K1ABC is ready to QSY off the calling frequency/.test(await page.locator('#vara-rx-text').textContent()), "K1ABC's <Q>: ready to QSY; QSYU and QSYD come on");
    await page.locator('#vara-qsyu-btn').click();
    await sleep(150);
    check(sentText()[0] === '25 <QSYF>000014105750</QSYF>' && civ.freq === 14105000, 'QSYU in the QSO asks K1ABC to QSY to 14.10575 (and waits for it to be delivered)');
    w.emit('message', { type: 'buffer', bytes: 25 });
    w.emit('message', { type: 'buffer', bytes: 0 });
    await sleep(150);
    check(civ.freq === 14105750 && sentText()[1] === '4 <TL>', 'delivered: the radio moves, and <TL> says so');
    check(await page.waitForFunction(() => /QSY to 14\.10575 MHz: waiting for K1ABC/.test(document.getElementById('vara-status').textContent), null, { timeout: 3000 }).then(() => true, () => false), 'the status line shows the QSY under way');
    w.emit('message', { type: 'data', data: Uint8Array.from(varacMsg('<QSYR>')).buffer });
    await sleep(150);
    check(sentText()[2] === '15 de VK2IO <R+08>' && /QSY done: on 14\.10575 MHz with K1ABC/.test(await page.locator('#vara-rx-text').textContent()), "K1ABC's <QSYR>: done; the opening report goes out on the new frequency");
    w.emit('message', { type: 'data', data: Uint8Array.from(Buffer.concat([varacMsg('de K1ABC <R-03>'), varacMsg('<NAME:Bob>')])).buffer });
    await page.waitForFunction(() => /K1ABC reports your signal at -3 dB/.test(document.getElementById('vara-rx-text').textContent), null, { timeout: 4000 }).catch(() => {});
    check(/K1ABC reports your signal at -3 dB\nK1ABC name Bob\n/.test(await page.locator('#vara-rx-text').textContent()), 'their opening report and name are shown in words, as notes');
    // Text both ways
    w.emit('message', { type: 'data', data: Uint8Array.from(varacMsg('VK2IO de K1ABC, good morning')).buffer });
    await page.waitForFunction(() => document.getElementById('vara-rx-text').textContent.includes('VK2IO de K1ABC, good morning\n'), null, { timeout: 4000 });
    check(true, 'received text appears in the conversation');
    check(await bFollows(() => document.getElementById('vara-rx-text').textContent.includes('good morning')), 'and in the second browser');
    await page.locator('#tty-input').fill('Good morning, name Ian, QTH Sydney');
    await page.locator('#tty-input').press('Enter');
    await page.waitForFunction(() => document.getElementById('tty-input').value === '', null, { timeout: 4000 });
    check(sentText().at(-1) === '34 Good morning, name Ian, QTH Sydney', 'Enter sends the line as a VarAC message; the box is cleared');
    check((await page.locator('#vara-rx-text .olivia-rx__own').last().textContent()).includes('Good morning, name Ian'), 'own line shown in the conversation, marked as own');
    if (process.env.VARA_SHOT) await page.locator('#vara-rx').screenshot({ path: process.env.VARA_SHOT });

    // A browser that connects now gets the conversation so far
    {
      const pageC = await browser.newPage({ viewport: { width: 430, height: 1100 } });
      await pageC.goto(`http://localhost:${port}/`);
      const ok = await pageC.waitForFunction(() => { const t = document.getElementById('vara-rx-text').textContent; return t.includes('good morning') && t.includes('name Ian') && !document.getElementById('vara-rx').hidden; }, null, { timeout: 6000 }).then(() => true, () => false);
      check(ok, 'a browser that connects mid-QSO is shown VARA with the conversation so far');
      await pageC.close();
      await sleep(200);
    }

    await page.locator('#vara-connect-btn').click();
    await sleep(100);
    check(sentText().at(-1) === '6 <DISC>' && cmds().at(-1) !== 'DISCONNECT', "Disconnect: VarAC's <DISC> goes first");
    w.emit('message', { type: 'buffer', bytes: 8 });
    w.emit('message', { type: 'buffer', bytes: 0 });
    await sleep(50);
    check(cmds().at(-1) === 'DISCONNECT', 'then, once it has gone, the modem ends the QSO');
    say('OK', 'DISCONNECTED');
    await page.waitForFunction(() => document.getElementById('vara-status').textContent === 'listening (500 Hz)', null, { timeout: 4000 });
    check(/Disconnected from K1ABC/.test(await page.locator('#vara-rx-text').textContent()) && (await page.locator('#tty-send-btn').isDisabled()), 'back to listening; noted; Send off');
    check(civ.freq === 14105000 && /Back on the calling frequency \(14\.105 MHz\)/.test(await page.locator('#vara-rx-text').textContent()), 'and back on the calling frequency, as VarAC does after a QSY');

    // A VarAC CQ waiting on slot 11 (750 Hz up): tap it, Connect moves there and calls the plain callsign; back afterwards.
    say('SN 3', 'CQFRAME F6JON-11 500');
    await page.waitForFunction(() => document.querySelector('#vara-heard .vara-rx__heard-call')?.textContent === 'F6JON +750', null, { timeout: 4000 }).catch(() => {});
    check((await page.locator('#vara-heard .vara-rx__heard-call').first().textContent()) === 'F6JON +750', 'a VarAC CQ is listed with its slot: "F6JON +750"');
    check(/CQ from F6JON \(waiting \+750 Hz from the calling frequency \(slot 11\), 500 Hz\)/.test(await page.locator('#vara-rx-text').textContent()), 'and noted with its slot');
    await page.locator('#vara-heard .vara-rx__heard-call').first().click();
    check((await page.locator('#vara-call').inputValue()) === 'F6JON', 'tapping it puts the plain callsign in the box');
    await page.locator('#vara-connect-btn').click();
    await page.waitForFunction(() => document.getElementById('vara-connect-btn').textContent === 'Stop', null, { timeout: 4000 }).catch(() => {});
    check(civ.freq === 14105750 && cmds().at(-1) === 'CONNECT VK2IO F6JON', 'Connect moves 750 Hz up to the slot, then calls F6JON');
    say('OK', 'DISCONNECTED');
    await page.waitForFunction(() => document.getElementById('vara-status').textContent === 'listening (500 Hz)', null, { timeout: 4000 }).catch(() => {});
    check(civ.freq === 14105000 && /No answer from F6JON/.test(await page.locator('#vara-rx-text').textContent()), 'no answer: back to the calling frequency');
    say('CQFRAME N1AMD-9 500');
    await page.waitForFunction(() => [...document.querySelectorAll('#vara-heard .vara-rx__heard-call')].some((b) => b.textContent === 'N1AMD beacon'), null, { timeout: 4000 }).then(() => check(true, 'a -9 is listed as a beacon'), () => check(false, 'a -9 is listed as a beacon'));
    // VarAC's broadcasts (KISS frames, as recorded on air on 2026-10-28): OH8XAT's beacon, and its VMail notice to HB9FIH
    say('SN 5.1', 'KISS 2 32314f4b50313052514f48385841542020202020', 'KISS 1 9084728c929040609e9070b082a8406103f03c534d503e');
    const beaconOk = await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('#vara-heard .vara-rx__heard-call')].find((x) => x.textContent === 'OH8XAT beacon');
      return b && /from KP10RQ \(offers VMail, email, AI, BBS\)/.test(b.title);
    }, null, { timeout: 4000 }).then(() => true, () => false);
    check(beaconOk, "OH8XAT's beacon is listed, its tooltip giving its locator and services");
    check(/Beacon from OH8XAT \(KP10RQ; offers VMail, email, AI, BBS\)\nOH8XAT has VMail waiting for HB9FIH/.test(await page.locator('#vara-rx-text').textContent()), 'the beacon and the VMail notice are noted in the conversation');
    if (process.env.VARA_HEARD_SHOT) await page.locator('#vara-rx').screenshot({ path: process.env.VARA_HEARD_SHOT });
  }

  // click 5 -> Feld-Hell
  {
    const modeCalls = civ.log.filter((e) => e[0] === 'setMode' || e[0] === 'setDataMode').length;
    await page.locator('#modes .chip', { hasText: /^VARA$/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'Feld-Hell'));
    await sleep(150);
    check(civ.mode === 'USB' && civ.dataMode === true && civ.log.filter((e) => e[0] === 'setMode' || e[0] === 'setDataMode').length === modeCalls, 'fifth click: Feld-Hell, radio left alone (USB, DATA MODE on)');
    check(server.state.varaActive === false && !vara.active && varaWorkers.at(-1).terminated && server.state.hellActive === true && hellRx.attached, 'VARA modem stopped, Feld-Hell receiver armed');
    check(!(await page.locator('#tty-send-btn').isDisabled()), 'Send is on again for Feld-Hell');
    check(!(await vis('.psk-spot-toggle')), 'PSK Spot is hidden again outside FT8 and VARA');
    check(civ.log.at(-1)[0] === 'setFrequency' && civ.log.at(-1)[1] === 14062000, 'entering Feld-Hell on 20m puts a 1000 Hz tone on 14.063 MHz (dial 14.062)');
    check(!(await vis('#olivia-rx')) && !(await vis('#vara-rx')) && !(await vis('#jtty-rx')) && (await vis('#hell-rx')) && (await vis('#tty-freq')) && (await page.locator('#tty-freq').inputValue()) === '1000', 'Feld-Hell: its text panel (not Olivia\'s, VARA\'s or JTTY\'s), tone box at 1000 Hz');
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
    // the picture is also read as text, a couple of seconds behind it (more audio lets it catch up)
    {
      const quiet = upsampleFloatToPcm(new Float32Array(8000 * 3), 8000, 48000);
      for (let i = 0; i < quiet.length; i += 9600) capture.emit('data', quiet.subarray(i, i + 9600));
      const want = (p) => p.waitForFunction(() => /CQ CQ DE K1ABC K1ABC K/.test(document.getElementById('hell-rx-text').textContent), null, { timeout: 5000 }).then(() => true, () => false);
      check(await want(page), 'the received picture is read as text in the Feld-Hell text panel: ' + JSON.stringify(await page.locator('#hell-rx-text').textContent()));
      check(await want(pageB), 'and in the second browser too');
    }

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
    check(
      await bFollows((t) => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'Feld-Hell') && document.getElementById('tty-freq').value === String(t), tone),
      `the second browser is in Feld-Hell with the same tone (${tone} Hz)`
    );

    // send
    const w = writes.length;
    await page.locator('#tty-input').fill('VK2IO de K1ABC');
    await page.locator('#tty-send-btn').click();
    await page.waitForFunction(() => /Sending Feld-Hell/.test(document.getElementById('tty-status').textContent), null, { timeout: 8000 });
    const st = await page.locator('#tty-status').textContent();
    check(/Sending Feld-Hell: "VK2IO de K1ABC"/.test(st) && new RegExp(`tone ${tone} Hz`).test(st), 'Feld-Hell status line: ' + st);
    check((await page.locator('#hell-rx-text .olivia-rx__own').last().textContent()).includes('VK2IO de K1ABC'), 'own transmission is shown in the Feld-Hell text, as in Olivia');
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
  await page.locator('#bands .chip', { hasText: /^40m$/ }).click();
  await sleep(200);
  check(civ.freq === 7050000 && civ.mode === 'RTTY', 'in RTTY, the 40m band chip goes to 7.050 MHz (middle of the WIA digital segment) and stays in RTTY');
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
  await page.waitForFunction(() => /Sending RTTY/.test(document.getElementById('tty-status').textContent), null, { timeout: 8000 });
  // the dial moves once DATA mode is confirmed (and has settled: civ/data-mode-guard.js)
  for (let t = Date.now(); civ.freq !== 7052125 && Date.now() - t < 2000; ) await sleep(20);
  {
    const st = await page.locator('#tty-status').textContent();
    check(/AFSK on LSB-D, mark 2125 Hz \/ space 2295 Hz/.test(st), 'RTTY on 40m goes out as AFSK on LSB-D: ' + st);
    check(civ.mode === 'LSB' && civ.dataMode === true && civ.freq === 7052125, 'radio on LSB-D with the dial 2125 Hz above the mark while sending');
    check((await ttyLabel()).includes('RTTY') && (await vis('#tty-composer')), 'the TTY panel stays in RTTY during the AFSK detour');
  }
  await page.waitForFunction(() => /Sent RTTY/.test(document.getElementById('tty-status').textContent), null, { timeout: 8000 });
  await sleep(200);
  check(true, 'Enter sends; RTTY status "Sent RTTY"');
  check(civ.mode === 'RTTY' && civ.dataMode === false && civ.freq === 7050000 && (await ttyLabel()).includes('RTTY'), 'afterwards: back in RTTY on 7.050 MHz, DATA MODE off');
  check(writes.length === 4, 'RTTY audio written');

  // typed text survives mode toggling
  await page.locator('#modes .chip', { hasText: /^RTTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'JTTY'));
  check((await page.locator('#tty-input').inputValue()) === 'test 73', 'operator-typed text is kept when toggling RTTY <-> JTTY');

  // leave TTY by picking SSB -> label returns to TTY, PTT back; SSB picks LSB on 40 m
  await chip('SSB').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'TTY'));
  await sleep(150);
  check(civ.mode === 'LSB' && civ.dataMode === false && (await ttyLabel()).includes('LSB'), 'picking SSB on 40 m leaves JTTY for LSB (DATA MODE off); the chip reads LSB');
  await chip('LSB').click();
  await sleep(150);
  check(civ.mode === 'USB' && (await ttyLabel()).includes('USB'), 'clicking it again flips to USB');
  await chip('USB').click();
  await sleep(150);
  check(civ.mode === 'LSB', 'and back to LSB');
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
  // The CW chip: plain "CW", and only the DeepCW decoder (CW1 and CW2 are hidden for now)
  {
    check((await page.locator('#modes .chip', { hasText: /^CW$/ }).count()) === 1 && server.state.cwDecoderVariant === 'CW3', 'the CW chip reads "CW" and the server decodes with CW3 (DeepCW)');
    await page.locator('#modes .chip', { hasText: /^CW$/ }).click();
    await sleep(200);
    check((await page.locator('#modes .chip', { hasText: /^CW$/ }).count()) === 1 && server.state.cwDecoderVariant === 'CW3', 'a second click on CW changes nothing (no decoder cycling)');
  }
  // CW text: a box and Send above DOT/WPM/DASH, sent by the radio's keyer at the WPM set
  {
    const box = await page.locator('#cw-composer').boundingBox();
    const paddle = await page.locator('#cw-paddle').boundingBox();
    check((await vis('#cw-composer')) && box.y + box.height <= paddle.y + 1, 'CW: a text box and Send above the DOT/WPM/DASH buttons');
    check((await page.locator('#cw-text-input').inputValue()) === 'CQ CQ DE VK2IO VK2IO K', 'pre-filled with a CW CQ');
    check(!(await page.locator('#cw-dot-btn').isDisabled()) && !(await page.locator('#cw-dash-btn').isDisabled()), 'the DOT and DASH buttons can be pressed (they were left disabled before)');
    await page.locator('#cw-wpm-input').fill('25');
    civ.log.length = 0;
    await page.locator('#cw-text-input').fill('cq test de vk2io k');
    await page.locator('#cw-send-btn').click();
    await page.waitForFunction(() => /^Sending CW at 25 WPM: "CQ TEST DE VK2IO K"/.test(document.getElementById('cw-status').textContent), null, { timeout: 5000 });
    check(civ.log.map((e) => e.join(' ')).join(' | ') === 'setKeySpeed 25 | setBreakIn 1 | sendCw CQ TEST DE VK2IO K', 'Send: keyer speed 25 WPM (from the WPM box), semi break-in on, the text to the keyer: ' + civ.log.map((e) => e.join(' ')).join(' | '));
    check((await page.locator('#cw-send-btn').textContent()) === 'Stop' && !civ.log.some((e) => e[0] === 'setPtt'), 'Send became Stop; PTT is not used (the radio keys itself)');
    check(await pageB.waitForFunction(() => /^Sending CW at 25 WPM/.test(document.getElementById('cw-status').textContent), null, { timeout: 3000 }).then(() => true, () => false), 'the second browser shows it being sent');
    await page.locator('#cw-send-btn').click();
    await page.waitForFunction(() => document.getElementById('cw-status').textContent === 'Stopped.', null, { timeout: 5000 });
    check(civ.log.some((e) => e[0] === 'stopCw') && civ.log.slice(-2).map((e) => e.join(' ')).join(' | ') === 'setBreakIn 0 | setKeySpeed 15' && (await page.locator('#cw-send-btn').textContent()) === 'Send', 'Stop: the keyer stopped, break-in and speed put back, Send again');
  }

  // Olivia -> LSB: leaves Olivia, DATA MODE off, PTT back
  await page.locator('#modes .chip', { hasText: /^TTY$/ }).click();
  await page.locator('#modes .chip', { hasText: /^RTTY$/ }).click();
  await page.locator('#modes .chip', { hasText: /^JTTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'Olivia'));
  check((await page.locator('#tty-freq').inputValue()) === '1531', 'Olivia remembers its centre between sessions');
  check((await ttyLabel()).includes('SSB'), 'while Olivia is selected the SSB chip reads SSB (not lit)');
  await chip('SSB').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'TTY'));
  await sleep(200);
  check(civ.mode === 'LSB' && civ.dataMode === false && server.state.oliviaActive === false && (await vis('#ptt-btn')), 'Olivia -> SSB (LSB on 40 m): Olivia off, DATA MODE off, PTT back');

  // JTTY -> FT8 and back
  await page.locator('#modes .chip', { hasText: /^TTY$/ }).click();
  await page.locator('#modes .chip', { hasText: /^RTTY$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'JTTY'));
  await page.locator('#modes .chip', { hasText: /^DIGI$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'TTY'));
  await sleep(200);
  check(civ.dataMode === true, 'JTTY -> FT8 leaves DATA MODE on (FT8 needs it)');
  check(!(await vis('#tty-composer')) && !(await vis('#ptt-btn')), 'FT8: neither PTT nor TTY composer (FT8 panel instead)');
  check((await ttyLabel()).includes('FT8'), 'the DIGI chip reads FT8 while FT8 is selected');
  check(
    await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'FT8' && c.classList.contains('chip--active')) && !document.getElementById('ft8-panel').hidden && document.getElementById('tty-composer').hidden),
    'the second browser leaves JTTY for FT8 too (FT8 panel shown): ' + (await bChips()).join(' ')
  );

  // FT8: a station calling us chimes (once per caller) in every browser, and its row is marked
  {
    const chimes = (p) => p.evaluate(() => Number(document.getElementById('ft8-panel').dataset.callChimes || 0));
    const slot = Date.UTC(2026, 9, 23, 10, 0, 0);
    const send = (t, ...texts) => server.broadcastJsonEvent(EVENT.FT8_DECODES, { slotStartMs: t, messages: texts.map((msg, i) => ({ msg, snr: -10 - i, dt: 0.1, freq: 1200 + 100 * i })) });
    send(slot, 'CQ K1ABC FN42', 'JA1XYZ K1ABC -12');
    await sleep(150);
    check((await chimes(page)) === 0 && (await chimes(pageB)) === 0, 'CQs and other people\'s QSOs: no chime');
    send(slot + 15000, 'VK2IO K1ABC FN42', 'CQ G4ABC IO91');
    await sleep(150);
    check((await chimes(page)) === 1 && (await chimes(pageB)) === 1, 'a station calling us chimes, in both browsers');
    const marked = await page.locator('#ft8-table-body .ft8-table__row--to-me').allTextContents();
    check(marked.length === 1 && /VK2IO K1ABC FN42/.test(marked[0]), 'and its row is marked');
    send(slot + 45000, 'VK2IO K1ABC R-10');
    await sleep(150);
    check((await chimes(page)) === 1, 'the same caller carrying on: no second chime');
    send(slot + 60000, 'VK2IO/P JA1XYZ PM95');
    await sleep(150);
    check((await chimes(page)) === 2, 'a new caller chimes again (also to a portable form of our call)');
  }

  // DIGI: FT8 -> FT4 -> WSPR -> FT8
  {
    const powerMenu = (p) => p.locator('#tx-power-select option').allTextContents();
    const powerShown = (p) => p.locator('#tx-power-select').evaluate((e) => e.selectedOptions[0]?.textContent ?? '');
    await page.locator('#modes .chip', { hasText: /^FT8$/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'FT4'));
    await page.locator('#modes .chip', { hasText: /^FT4$/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'WSPR'));
    await sleep(400);
    check(server.state.wsprActive && !server.state.ft8Active && civ.mode === 'USB' && civ.dataMode === true && civ.freq === 7038600, `third DIGI choice is WSPR: on 7.0386 MHz USB, DATA on, FT8 off (${civ.freq} ${civ.mode})`);
    check((await vis('#wspr-panel')) && !(await vis('#ft8-panel')) && !(await vis('#ptt-btn')), 'the WSPR panel replaces the FT8 one; no PTT button');
    check((await powerMenu(page)).join(' ') === '5W 4W 3W 2W 1W' && civ.power === 5 && (await powerShown(page)) === '5W', `the power menu is 1-5 W and the radio is held at 5 W (${await powerShown(page)})`);
    check(
      await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'WSPR' && c.classList.contains('chip--active')) && !document.getElementById('wspr-panel').hidden && document.getElementById('ft8-panel').hidden),
      'the second browser follows into WSPR: ' + (await bChips()).join(' ')
    );
    check(await bFollows(() => [...document.querySelectorAll('#tx-power-select option')].map((o) => o.textContent).join(' ') === '5W 4W 3W 2W 1W'), 'with the 1-5 W power menu');
    check((await page.locator('#wspr-tx-msg').textContent()) === 'VK2IO QF56' && !(await page.locator('#wspr-tx-enabled').isChecked()), 'it shows what it would send; transmit starts off');
    await page.locator('#wspr-tx-enabled').check();
    await sleep(200);
    check(server.state.wspr.txEnabled === true && server.state.wspr.nextTx != null, 'ticking Transmit turns it on in the server, and a slot is planned');
    check(await bFollows(() => document.getElementById('wspr-tx-enabled').checked && /Transmits next at \d\d:\d\d UTC/.test(document.getElementById('wspr-status').textContent)), 'the second browser shows transmit on, and when');
    await pageB.locator('#wspr-tx-hz').fill('1530');
    await pageB.locator('#wspr-tx-hz').press('Enter');
    await sleep(200);
    check(server.state.wspr.txHz === 1530 && (await page.locator('#wspr-tx-hz').inputValue()) === '1530', 'the transmit frequency set in one browser shows in the other');
    server.broadcastJsonEvent(EVENT.WSPR_DECODES, {
      slotStartMs: Date.UTC(2026, 9, 22, 9, 10),
      dialHz: 7038600,
      decodes: [
        { snr: -24, dt: 0.3, audioHz: 1480.4, drift: 0, message: 'K1ABC FN42 37', callsign: 'K1ABC', grid: 'FN42', dbm: 37, type: 1 },
        { snr: -12, dt: -0.6, audioHz: 1551.2, drift: 1, message: 'VK3TR QF22 30', callsign: 'VK3TR', grid: 'QF22', dbm: 30, type: 1 },
      ],
    });
    await sleep(200);
    const rows = await page.locator('#wspr-table-body .ft8-table__row').evaluateAll((rs) => rs.map((r) => [...r.children].map((c) => c.textContent).join(' ')));
    check(rows.join(' | ') === '09:10 -12 -0.6 7.040151 VK3TR QF22 30 | 09:10 -24 0.3 7.040080 K1ABC FN42 37', 'spots are listed, strongest first: ' + rows.join(' | '));
    check((await pageB.locator('#wspr-table-body .ft8-table__row').count()) === 2, 'in both browsers');
    if (process.env.WSPR_SHOT) await page.locator('#wspr-panel').screenshot({ path: process.env.WSPR_SHOT });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(wide, 'the spot table fits the phone width');
    await page.locator('#modes .chip', { hasText: /^WSPR$/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'FT8'));
    await sleep(400);
    check(!server.state.wsprActive && server.state.ft8Active && server.state.ft8Variant === 'FT8' && civ.dataMode === true && civ.freq === 7074000, `then back to FT8 (7.074 MHz, DATA still on; ${civ.freq})`);
    check(civ.power === 100 && (await powerMenu(page)).join(' ') === '100W 75W 50W 25W 5W' && (await powerShown(page)) === '100W', 'leaving WSPR puts the power back (100 W) and the usual power menu');
    check(await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'FT8' && c.classList.contains('chip--active')) && document.getElementById('wspr-panel').hidden), 'the second browser follows back to FT8');
  }

  // SSTV: FT8 -> SSTV (the Image button) on 40 m, a picture comes in, band change, then SSB
  await chip('Image').click();
  await sleep(300);
  check(civ.freq === 7171000 && civ.mode === 'LSB' && server.state.sstvActive && sstvRx.attached && !server.state.ft8Active, 'SSTV on 40 m: 7.171 MHz LSB, receiver armed, FT8 off');
  check((await vis('#sstv-rx')) && (await vis('#ptt-btn')) && !(await vis('#ft8-panel')), 'SSTV panel shown, voice PTT back, FT8 panel gone');
  check((await ttyLabel()).includes('DIGI') && (await ttyLabel()).includes('SSB') && (await page.locator('#modes .chip', { hasText: /^SSTV$/ }).evaluate((e) => e.classList.contains('chip--active'))), 'SSTV chip lit; DIGI and SSB back to their plain labels');
  check(
    await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'SSTV' && c.classList.contains('chip--active')) && !document.getElementById('sstv-rx').hidden && document.getElementById('ft8-panel').hidden),
    'the second browser follows into SSTV (its picture panel shown, FT8 panel gone): ' + (await bChips()).join(' ')
  );
  {
    const w = 320;
    const h = 120;
    const img = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) img.fill(Math.floor(i / w) < 60 ? 255 : 30, i * 3, i * 3 + 3);
    const enc = encodeSstv(img, w, h, 'R8BW', { amplitude: 0.4 });
    const pcm = upsampleFloatToPcm(Float32Array.from([...new Float32Array(6000), ...enc.samples, ...new Float32Array(12000)]), 12000, 48000);
    const half = Math.floor(pcm.length / 4) * 2;
    for (let i = 0; i < half; i += 9600) capture.emit('data', pcm.subarray(i, Math.min(half, i + 9600)));
    await page.waitForFunction(() => /Receiving Robot 8 B\/W · line \d+ of 120/.test(document.getElementById('sstv-status').textContent), null, { timeout: 10000 });
    check(await vis('#sstv-stop-btn'), 'receiving: status shows the mode and line; Stop offered: ' + (await page.locator('#sstv-status').textContent()));
    for (let i = half; i < pcm.length; i += 9600) capture.emit('data', pcm.subarray(i, i + 9600));
    await page.waitForFunction(() => document.querySelectorAll('#sstv-strip .sstv-rx__thumb').length === 1, null, { timeout: 10000 });
    await sleep(300);
    const st = await page.locator('#sstv-status').textContent();
    check(/^Robot 8 B\/W · 320 × 120 · \d\d:\d\d UTC$/.test(st) && (await vis('#sstv-save-btn')) && !(await vis('#sstv-stop-btn')), 'picture done: in the strip, status ' + st + ', Save offered');
    const px = await page.locator('#sstv-canvas').evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      return { w: c.width, h: c.height, top: d[(10 * c.width + 100) * 4], bottom: d[(200 * c.width + 100) * 4] };
    });
    check(px.w === 320 && px.h === 240 && px.top > 200 && px.bottom < 80, `canvas shows the picture at 320 x 240 (lines drawn twice): top ${px.top}, bottom ${px.bottom}`);
    await page.locator('#sstv-canvas').click();
    check(await vis('.sstv-viewer'), 'tapping the picture opens it full size');
    await page.locator('.sstv-viewer').click();
    check(!(await vis('.sstv-viewer')), 'and tapping again closes it');
  }
  await page.locator('#bands .chip', { hasText: /^20m$/ }).click();
  await sleep(300);
  check(civ.freq === 14230000 && civ.mode === 'USB' && server.state.sstvActive, 'in SSTV, the 20m band chip goes to 14.230 MHz USB');
  // SSTV transmit: choose an image, crop and tag, send, stop
  {
    check((await vis('#sstv-tx')) && !(await vis('#sstv-tx-editor')), 'SSTV: "Send a picture" offers Camera and Choose image');
    check((await page.locator('#sstv-camera-input').getAttribute('capture')) === 'environment' && (await page.locator('#sstv-camera-input').getAttribute('accept')) === 'image/*', 'the Camera button opens the camera (capture=environment)');
    // a white 1200 x 900 "photo" with a red square in the middle
    const pw = 1200;
    const ph = 900;
    const photo = new Uint8Array(pw * ph * 3).fill(255);
    for (let y = 400; y < 500; y++) for (let x = 550; x < 650; x++) photo.set([255, 0, 0], (y * pw + x) * 3);
    await page.locator('#sstv-file-input').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: encodePng(photo, pw, ph) });
    await page.waitForFunction(() => !document.getElementById('sstv-tx-editor').hidden, null, { timeout: 5000 });
    await sleep(200);
    const label = await page.locator('#sstv-tx-send').textContent();
    check(/^Send \(Scottie S1, 1:5\d\)$/.test(label), 'Scottie S1 by default: ' + label);
    check((await page.locator('#sstv-tx-call').inputValue()) === 'VK2IO', 'the tag starts with the station callsign');
    await page.locator('#sstv-tx-line2').fill('UR 595');
    const tag = await page.locator('#sstv-tx-canvas').evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      // the tag: pixels that are no longer white (outside the red square)
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          // grey (the box, the outline) rather than the red square or its pink edges
          const grey = Math.abs(d[o] - d[o + 1]) < 30 && Math.abs(d[o + 1] - d[o + 2]) < 30;
          if (grey && d[o] < 245) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          }
        }
      const mid = (y) => (y * c.width + c.width / 2) * 4;
      return { w: c.width, h: c.height, x0, y0, tw: x1 - x0 + 1, th: y1 - y0 + 1, centreRed: d[mid(c.height / 2)] > 200 && d[mid(c.height / 2) + 1] < 80 };
    });
    check(tag.w === 320 && tag.h === 256 && tag.centreRed, `photo cropped and scaled to 320 x 256 (the red square in the middle)`);
    check(tag.tw <= 160 && tag.th <= 128 && tag.tw > 140 && tag.x0 < 10 && tag.y0 < 10, `callsign tag in the top left, ${tag.tw} x ${tag.th}: twice the old size, within half the width (160) and height (128)`);
    await page.locator('#sstv-tx-corner').selectOption('br');
    const br = await page.locator('#sstv-tx-canvas').evaluate((c) => {
      const d = c.getContext('2d').getImageData(c.width - 5, c.height - 5, 1, 1).data;
      const e = c.getContext('2d').getImageData(4, 4, 1, 1).data;
      return { corner: d[0] < 245, topLeft: e[0] > 245 };
    });
    check(br.corner && br.topLeft, 'the tag moves to the corner chosen');
    const w0 = writes.length;
    await page.locator('#sstv-tx-send').click();
    await page.waitForFunction(() => !document.getElementById('sstv-tx-progress').hidden && document.getElementById('sstv-tx-progress-label').textContent === 'Sending Scottie S1', null, { timeout: 20000 });
    check((await page.locator('#sstv-tx-send').textContent()) === 'Stop' && writes.length === w0 + 1 && civ.dataMode === true && civ.log.filter((e) => e[0] === 'setPtt').at(-1)[1] === true, 'sending: DATA MODE on, PTT keyed, audio written, Send became Stop');
    // progress: elapsed / total, what is going out, time left, the bar; the picture fills in on the SSTV screen
    await sleep(3000);
    const prog = async (p) =>
      p.evaluate(() => ({
        shown: !document.getElementById('sstv-tx-progress').hidden,
        label: document.getElementById('sstv-tx-progress-label').textContent,
        time: document.getElementById('sstv-tx-progress-time').textContent,
        detail: document.getElementById('sstv-tx-progress-detail').textContent,
        pct: Number(document.getElementById('sstv-tx-bar').getAttribute('aria-valuenow')),
        width: parseFloat(document.getElementById('sstv-tx-bar-fill').style.width),
        marks: document.querySelectorAll('#sstv-tx-bar .sstv-tx__bar-mark').length,
        status: document.getElementById('sstv-status').textContent,
      }));
    const pa = await prog(page);
    check(pa.shown && /^0:0[2-4] \/ 1:5\d$/.test(pa.time) && /^Picture · line \d+ of 256 · 1:5\d left$/.test(pa.detail) && pa.width > 0.5 && pa.width < 4 && pa.marks === 2, `progress shown: "${pa.label}", ${pa.time}, "${pa.detail}", bar ${pa.width}% with the picture's start and end marked`);
    check(/^Sending Scottie S1 · \d+%$/.test(pa.status), 'the SSTV screen says it is sending: ' + pa.status);
    const shot = await page.locator('#sstv-canvas').evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const at = (x, y) => d[(y * c.width + x) * 4];
      return { w: c.width, h: c.height, top: at(40, 1), bottom: at(40, 250) };
    });
    check(shot.w === 320 && shot.h === 256 && shot.top > 200 && shot.bottom < 100, `the outgoing picture fills in on the SSTV screen: sent rows bright (${shot.top}), the rest dimmed (${shot.bottom})`);
    const pb = await prog(pageB);
    check(pb.shown && pb.label === 'Sending Scottie S1' && /^Picture · line \d+ of 256/.test(pb.detail), `the second browser shows the same progress: ${pb.time}, "${pb.detail}"`);
    // a page opened part-way through is told how far in it is
    const pageC = await browser.newPage({ viewport: { width: 430, height: 1100 } });
    pageC.on('pageerror', (e) => errors.push('C: ' + e.message));
    await pageC.goto(`http://localhost:${port}/`);
    await pageC.waitForFunction(() => !document.getElementById('sstv-tx-progress').hidden && document.getElementById('sstv-tx-progress-label').textContent === 'Sending Scottie S1', null, { timeout: 8000 }).catch(() => {});
    const pc = await prog(pageC);
    check(pc.shown && /^0:0[3-9] \/ 1:5\d$/.test(pc.time) && pc.width > 1, `a browser opened during the transmission joins SSTV and picks up the progress part-way (${pc.time}, bar ${pc.width}%)`);
    await pageC.close();
    check(Math.abs(writes.at(-1).length / 2 / 48000 - server.state.sstvTx.durationSec) < 0.2, `the audio is the whole transmission (${(writes.at(-1).length / 96000).toFixed(1)} s with FSK ID and CW ID)`);
    await page.locator('#sstv-tx-send').click();
    await page.waitForFunction(() => document.getElementById('sstv-tx-status').textContent === 'Stopped.', null, { timeout: 5000 });
    await sleep(200);
    check(civ.dataMode === false && civ.log.filter((e) => e[0] === 'setPtt').at(-1)[1] === false && (await page.locator('#sstv-tx-send').textContent()).startsWith('Send ('), 'Stop: PTT released, DATA MODE off, Send back');
    check(!(await vis('#sstv-tx-progress')) && !(await pageB.locator('#sstv-tx-progress').isVisible()), 'the progress goes away in both browsers');
    {
      const st = await page.locator('#sstv-status').textContent();
      check(/^Robot 8 B\/W · 320 × 120/.test(st), 'and the SSTV screen goes back to the last picture: ' + st);
    }
    // Cancel while sending stops the transmission too, and closes the editor
    await page.locator('#sstv-tx-send').click();
    await page.waitForFunction(() => !document.getElementById('sstv-tx-progress').hidden && document.getElementById('sstv-tx-progress-label').textContent === 'Sending Scottie S1', null, { timeout: 20000 });
    check(civ.log.filter((e) => e[0] === 'setPtt').at(-1)[1] === true, 'sending again');
    await page.locator('#sstv-tx-cancel').click();
    await page.waitForFunction(() => document.getElementById('sstv-tx-editor').hidden, null, { timeout: 5000 });
    await sleep(200);
    check(civ.dataMode === false && civ.log.filter((e) => e[0] === 'setPtt').at(-1)[1] === false, 'Cancel while sending: transmission stopped (PTT off, DATA MODE off), editor closed');
  }
  // EasyPal: the Image button's second press; USB, the audio spectrum, a panel with the picture
  {
    await chip('SSTV').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'EasyPal'));
    await sleep(400);
    check(server.state.easypalActive && !server.state.sstvActive && easypalRx.attached && civ.mode === 'USB' && civ.freq === 14233000, `Image again: EasyPal, tuned to the 20 m EasyPal frequency on USB (${civ.freq} ${civ.mode})`);
    await page.locator('#bands .chip', { hasText: /^40m$/ }).click();
    await sleep(400);
    check(civ.freq === 7173000 && civ.mode === 'USB' && server.state.easypalActive, `in EasyPal the 40m button goes to 7.173 MHz, still USB (${civ.freq} ${civ.mode})`);
    await page.locator('#bands .chip', { hasText: /^20m$/ }).click();
    await sleep(400);
    check((await vis('#easypal-rx')) && !(await vis('#sstv-rx')) && (await vis('#scope-waterfall')) && /Listening for an EasyPal signal/.test(await page.locator('#easypal-status').textContent()), 'the EasyPal panel replaces the SSTV one; the spectrum stays; "Listening"');
    check(await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'EasyPal' && c.classList.contains('chip--active')) && !document.getElementById('easypal-rx').hidden), 'the second browser follows into EasyPal');
    // a real transmission (QSSTV's transmitter): a JPEG, mode A 64-QAM
    const { audio, file } = easypalFx.loadFixture('a64');
    const pcm = upsampleFloatToPcm(audio, 12000, 48000);
    const seenStatus = [];
    const watch = setInterval(() => page.locator('#easypal-status').textContent().then((t) => seenStatus.push(t), () => {}), 150);
    for (let i = 0; i < pcm.length; i += 9600) {
      capture.emit('data', pcm.subarray(i, i + 9600));
      await sleep(15);
    }
    await page.waitForFunction(() => document.querySelectorAll('#easypal-strip .sstv-rx__thumb').length === 1, null, { timeout: 10000 }).catch(() => {});
    clearInterval(watch);
    const shown = await page.evaluate(() => {
      const img = document.getElementById('easypal-picture');
      return { hidden: img.hidden, w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 30), status: document.getElementById('easypal-status').textContent, save: !document.getElementById('easypal-save-btn').hidden };
    });
    check(seenStatus.some((t) => /Mode A · 2.5 kHz · 64-QAM · S\/N \d+ dB/.test(t)), `while it comes in the status shows the mode and S/N ("${seenStatus.find((t) => /Mode A/.test(t))}")`);
    check(!shown.hidden && shown.w === 160 && shown.h === 120 && shown.src.startsWith('data:image/jpeg;base64,') && shown.save, `the picture is shown (${shown.w}x${shown.h}), with Save`);
    check(/^tiny\.jpg · de VK2XYZ · \d\d:\d\d UTC · Mode A/.test(shown.status), 'and described: ' + shown.status);
    check(server.easypalPictures.length === 1 && Buffer.from(server.easypalPictures[0].data, 'base64').equals(file), 'the server has the file exactly as sent');
    check(await bFollows(() => document.querySelectorAll('#easypal-strip .sstv-rx__thumb').length === 1 && !document.getElementById('easypal-picture').hidden), 'the second browser shows it too');
    if (process.env.EASYPAL_SHOT) await page.locator('#easypal-rx').screenshot({ path: process.env.EASYPAL_SHOT });
    await page.locator('#easypal-picture').click();
    check(await page.locator('.sstv-viewer').isVisible(), 'tap: full size');
    await page.locator('.sstv-viewer').click();
    // a page opened afterwards gets it too
    const pageC = await browser.newPage({ viewport: { width: 430, height: 1100 } });
    pageC.on('pageerror', (e) => errors.push('C: ' + e.message));
    await pageC.goto(`http://localhost:${port}/`);
    check(await pageC.waitForFunction(() => document.querySelectorAll('#easypal-strip .sstv-rx__thumb').length === 1 && !document.getElementById('easypal-rx').hidden, null, { timeout: 8000 }).then(() => true, () => false), 'a browser opened later joins EasyPal and has the picture');
    await pageC.close();
  }
  // EasyPal transmit: choose an image, tag it, send; progress in both browsers; Stop from the other one
  {
    check((await vis('#easypal-tx')) && !(await vis('#easypal-tx-editor')), 'EasyPal: "Send a picture" offers Camera and Choose image');
    const pw = 1600;
    const ph = 1200;
    const photo = new Uint8Array(pw * ph * 3);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) photo.set([(x * 255) / pw, (y * 255) / ph, 128], (y * pw + x) * 3);
    await page.locator('#easypal-file-input').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: encodePng(photo, pw, ph) });
    await page.waitForFunction(() => !document.getElementById('easypal-tx-editor').hidden, null, { timeout: 5000 });
    await sleep(200);
    const label = await page.locator('#easypal-tx-send').textContent();
    check(label === 'Send (mode B, 16-QAM, up to 0:30)', 'the Send button shows the settings: ' + label);
    const size = await page.locator('#easypal-tx-canvas').evaluate((c) => [c.width, c.height]);
    check(size[0] === 800 && size[1] === 600 && (await page.locator('#easypal-tx-call').inputValue()) === 'VK2IO', `the whole picture, fitted to ${size.join(' x ')}, tagged VK2IO`);
    const pttBefore = civ.log.filter((l) => l[0] === 'setPtt').length;
    const writesBefore = writes.length;
    await page.locator('#easypal-tx-send').click();
    check(await page.waitForFunction(() => /^Sending /.test(document.getElementById('easypal-tx-progress-label').textContent), null, { timeout: 15000 }).then(() => true, () => false), 'Send: "Preparing", then "Sending" with a progress bar');
    check(server.state.ptt === true && writes.length === writesBefore + 1, 'PTT on and the audio written');
    const detail = await page.locator('#easypal-tx-progress-detail').textContent();
    check(/x \d+ · quality \d+ · [\d.]+ kB · mode B · 16-QAM · RS2 · \d:\d\d left/.test(detail), 'the details: ' + detail);
    check(Math.abs(writes.at(-1).length / 96000 - 30) < 2, `the audio fits the 30 s allowed (${(writes.at(-1).length / 96000).toFixed(1)} s)`);
    check(await bFollows(() => !document.getElementById('easypal-tx-progress').hidden && /^Sending /.test(document.getElementById('easypal-status').textContent) && /^data:image\/jpeg/.test(document.getElementById('easypal-picture').src)), 'the second browser shows the progress and the picture going out');
    if (process.env.EASYPAL_TX_SHOT) await page.locator('#easypal-rx').screenshot({ path: process.env.EASYPAL_TX_SHOT });
    await pageB.locator('#easypal-tx-progress-stop').click();
    check(await page.waitForFunction(() => document.getElementById('easypal-tx-status').textContent === 'Stopped.' && document.getElementById('easypal-tx-progress').hidden, null, { timeout: 5000 }).then(() => true, () => false), 'Stop in the other browser stops it: "Stopped."');
    check(server.state.ptt === false && !easypalTx.transmitting && civ.log.filter((l) => l[0] === 'setPtt').length >= pttBefore, 'PTT off');
    check((await page.locator('#easypal-tx-send').textContent()) === label && (await page.locator('#easypal-strip .sstv-rx__thumb').count()) === 1, 'Send is back, and nothing was added to the pictures');
    await page.locator('#easypal-tx-cancel').click();
    check(!(await vis('#easypal-tx-editor')), 'Cancel closes the editor');
  }
  // Radiofax: the Image button's third press; the chart replaces the spectrum; VMC/VMW buttons below the S-meter
  {
    await chip('EasyPal').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'Fax'));
    await sleep(400);
    check(server.state.faxActive && !server.state.sstvActive && !server.state.easypalActive && !easypalRx.attached && faxRx.attached && civ.mode === 'USB' && civ.freq === 5098100, `Image again: Radiofax, on USB, tuned to VMC 5100 (dial ${civ.freq})`);
    check((await vis('#fax-view')) && !(await vis('#scope-waterfall')) && !(await vis('#scope-trace')) && (await vis('#fax-rx')) && !(await vis('#sstv-rx')), 'the chart view replaces the spectrum; the fax panel replaces the SSTV one');
    const meter = await page.locator('.meter').boundingBox();
    const list = await page.locator('#fax-stations').boundingBox();
    const labels = await page.locator('#fax-stations-list .fax-station').evaluateAll((bs) => bs.map((b) => b.textContent));
    check(meter && list && list.y >= meter.y + meter.height - 1, 'the station buttons are below the S-meter');
    check(
      labels.join(' | ') === 'VMC 510024 h | VMW 753524 h | VMW 1055524 h | VMC 1103024 h | VMC 1392024 h | VMW 1561524 h | VMC 262809–19Z | VMW 575511–21Z | VMC 2046919–09Z | VMW 1806021–11Z',
      'VMC and VMW, in order of their broadcast hours: ' + labels.join(' | ')
    );
    check(await page.locator('#fax-stations-list .fax-station.chip--active').evaluate((b) => b.textContent === 'VMC 510024 h'), 'the one tuned is lit');
    check(
      await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'Fax' && c.classList.contains('chip--active')) && !document.getElementById('fax-view').hidden && !document.getElementById('fax-stations').hidden),
      'the second browser follows into Radiofax'
    );
    // a short chart, with start signal, phasing and stop signal
    const W = FAX_WIDTH;
    const H = 40;
    const grey = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grey[y * W + x] = x < W / 2 ? 20 : 235;
    const pcm = upsampleFloatToPcm(encodeFax({ grey, width: W, lines: H, phasingSec: 5, leadSec: 1 }), 12000, 48000);
    for (let i = 0; i < pcm.length; i += 96000) capture.emit('data', pcm.subarray(i, i + 96000));
    await faxRx.settled();
    await page.waitForFunction(() => document.querySelectorAll('#fax-strip .sstv-rx__thumb').length === 1, null, { timeout: 8000 });
    const shot = await page.evaluate(() => {
      const c = document.getElementById('fax-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const at = (x, y) => d[(y * c.width + x) * 4];
      return { w: c.width, h: c.height, left: at(400, 10), right: at(1400, 10), status: document.getElementById('fax-status').textContent, save: !document.getElementById('fax-save-btn').hidden };
    });
    if (process.env.FAX_SHOT) await page.locator('#scope-section').screenshot({ path: process.env.FAX_SHOT });
    if (process.env.FAX_SHOT2) await page.locator('.meter').evaluate((m) => m.scrollIntoView());
    if (process.env.FAX_SHOT2) await page.screenshot({ path: process.env.FAX_SHOT2, clip: await page.locator('#fax-stations').boundingBox() });
    check(shot.w === 1810 && Math.abs(shot.h - H) <= 3 && shot.left < 60 && shot.right > 200, `the chart is drawn in the view: ${shot.w} x ${shot.h}, dark left (${shot.left}) and light right (${shot.right})`);
    check(/^Chart · \d\d:\d\d UTC · (3[7-9]|40) lines/.test(shot.status) && shot.save, 'then kept in the strip with Save: ' + shot.status);
    check(await bFollows(() => document.querySelectorAll('#fax-strip .sstv-rx__thumb').length === 1), 'the second browser has it too');
    // Start now, then Stop: a chart started by hand
    await page.locator('#fax-start-btn').click();
    await sleep(200);
    check(server.state.fax.state === 'receiving', 'Start now begins a chart without a start signal');
    const tone = upsampleFloatToPcm(encodeFax({ grey: new Uint8Array(W * 6).fill(128), width: W, lines: 6, apt: false, phasingSec: 0 }), 12000, 48000);
    capture.emit('data', tone);
    await page.locator('#fax-stop-btn').click();
    await sleep(200);
    await faxRx.settled();
    await page.waitForFunction(() => document.querySelectorAll('#fax-strip .sstv-rx__thumb').length === 2, null, { timeout: 5000 }).catch(() => {});
    check((await page.locator('#fax-strip .sstv-rx__thumb').count()) === 2 && /started by hand/.test(await page.locator('#fax-status').textContent()), 'Stop ends it and keeps it: ' + (await page.locator('#fax-status').textContent()));
    // a station button tunes it
    await page.locator('#fax-stations-list .fax-station', { hasText: 'VMW 10555' }).click();
    await sleep(300);
    check(civ.freq === 10553100 && civ.mode === 'USB', `VMW 10555 tunes 10.5531 MHz USB (${civ.freq})`);
    // and Image once more: back to SSTV
    await chip('Fax').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'SSTV'));
    await sleep(300);
    check(server.state.sstvActive && !server.state.faxActive && !faxRx.attached && (await vis('#scope-waterfall')) && !(await vis('#fax-view')) && !(await vis('#fax-stations')), 'Image again: SSTV, the spectrum back');
    await page.locator('#bands .chip', { hasText: /^20m$/ }).click();
    await sleep(300);
  }
  await chip('SSB').click();
  await sleep(300);
  check(!server.state.sstvActive && !sstvRx.attached && !(await vis('#sstv-rx')) && civ.mode === 'USB' && (await ttyLabel()).includes('USB'), 'SSB leaves SSTV (USB on 20 m), panel hidden');
  check(
    await bFollows(() => [...document.querySelectorAll('#modes .chip')].some((c) => c.textContent === 'USB' && c.classList.contains('chip--active')) && document.getElementById('sstv-rx').hidden),
    'the second browser leaves SSTV for USB too: ' + (await bChips()).join(' ')
  );
  // In plain SSB, the 80m band chip goes to 3.600 MHz on LSB
  await page.locator('#bands .chip', { hasText: /^80m$/ }).click();
  await sleep(300);
  check(civ.freq === 3600000 && civ.mode === 'LSB', `the 80m band chip tunes to 3.600 MHz LSB (${civ.freq} ${civ.mode})`);

  // The meter: tap its title for S-meter -> SWR -> ALC; the legend follows. And the Mic menu.
  {
    const title = () => page.locator('#meter-mode').textContent();
    const value = () => page.locator('#meter-value').textContent();
    const legend = () => page.locator('#meter-bar .meter__segment-label').allTextContents();
    const lit = (colour) => page.locator(`#meter-bar .meter__segment--${colour}`).count();
    await page.waitForFunction(() => document.getElementById('meter-value').textContent === 'S7', null, { timeout: 3000 }).catch(() => {});
    check((await title()) === 'S-meter' && (await value()) === 'S7' && (await legend()).join(' ') === 'S0 S1 S2 S3 S4 S5 S6 S7 S8 S9 +10 +20 +30 +40 +50 +60' && (await lit('green')) === 8, `S-meter: "${await value()}", legend S0 ... +60, 8 segments lit`);
    const hold = async (fn) => {
      await page.locator('#ptt-btn').scrollIntoViewIfNeeded();
      const box = await page.locator('#ptt-btn').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await sleep(900);
      const r = await fn();
      await page.mouse.up();
      await sleep(300);
      return r;
    };
    civ.swr = 80;
    civ.alc = 60;
    const sTx = await hold(async () => [await title(), await value(), (await legend())[3]]);
    check(sTx[0] === 'S-meter' && sTx[1] === 'SWR 2.0' && sTx[2] === '2', `S-meter mode while transmitting shows SWR, as before (${sTx.join(', ')})`);
    await page.locator('#meter-mode').click();
    // The release reaches this page as a PTT event; on a busy machine that can take more than the 300 ms above.
    await page.waitForFunction(() => document.getElementById('meter-value').textContent === 'on transmit', null, { timeout: 3000 }).catch(() => {});
    check((await title()) === 'SWR' && (await legend()).filter(Boolean).join(' ') === '1.5 2 2.5 3 4 5' && (await value()) === 'on transmit', `tap: SWR, legend ${(await legend()).filter(Boolean).join(' ')}, "${await value()}" on receive`);
    const swrTx = await hold(async () => {
      if (process.env.METER_SWR_SHOT) await page.locator('.meter').screenshot({ path: process.env.METER_SWR_SHOT });
      return [await value(), await lit('amber')];
    });
    check(swrTx[0] === 'SWR 2.0' && swrTx[1] === 4, `transmitting: ${swrTx[0]}, 4 amber segments`);
    await sleep(700);
    check((await value()) === 'on transmit' && (await lit('amber')) === 0, `released: back to "${await value()}", the bar cleared`);
    await page.locator('#meter-mode').click();
    await sleep(100);
    check((await title()) === 'ALC' && (await legend()).filter(Boolean).join(' ') === '25% 50% 75% 100%', `tap: ALC, legend ${(await legend()).filter(Boolean).join(' ')}`);
    const alcTx = await hold(async () => {
      if (process.env.METER_ALC_SHOT) await page.locator('.meter').screenshot({ path: process.env.METER_ALC_SHOT });
      return [await value(), await lit('green')];
    });
    check(alcTx[0] === 'ALC 50%' && alcTx[1] === 8, `transmitting: ${alcTx[0]}, 8 green segments`);
    check(await bFollows(() => document.getElementById('meter-mode').textContent === 'S-meter'), 'the other browser keeps its own choice (S-meter)');
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('tty-send-btn').disabled, null, { timeout: 8000 });
    check((await title()) === 'ALC', 'the choice is remembered after a reload');
    await page.locator('#meter-mode').click();
    await sleep(100);
    check((await title()) === 'S-meter', 'tap again: back to the S-meter');
    await page.waitForFunction(() => document.getElementById('meter-value').textContent === 'S7', null, { timeout: 3000 }).catch(() => {});
    check((await legend())[0] === 'S0' && (await value()) === 'S7', 'with its legend and reading');

    // Mic: shown with the PTT button, not in the text modes or FT8
    const micShown = () => page.locator('#mic-gain').isVisible();
    check((await micShown()) && (await page.locator('#ptt-btn').isVisible()), 'SSB: the Mic menu shows, left of Power');
    const boxes = await Promise.all(['#mic-gain', '.tx-power:not(#mic-gain)'].map((sel) => page.locator(sel).boundingBox()));
    check(boxes[0].x < boxes[1].x && Math.abs(boxes[0].y - boxes[1].y) < 10, 'Mic sits just left of Power, on the same row');
    // Speaker, Audio, Tuner, Tune, Mic and Power all on one line, at this phone width and narrower ones
    for (const width of [430, 390, 360]) {
      await page.setViewportSize({ width, height: 1100 });
      await sleep(100);
      const row = await page.evaluate(() => {
        const kids = [...document.querySelector('.controls-row').children].filter((e) => !e.hidden);
        return { n: kids.length, lines: new Set(kids.map((e) => Math.round(e.getBoundingClientRect().top))).size, text: kids.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ') };
      });
      check(row.n === 6 && row.lines === 1, `${width} px wide: the six controls on one line (${row.text})`);
    }
    await page.setViewportSize({ width: 430, height: 1100 });
    if (process.env.MIC_SHOT) await page.locator('.controls-row').screenshot({ path: process.env.MIC_SHOT });
    if (process.env.METER_SHOT) await page.locator('.meter').screenshot({ path: process.env.METER_SHOT });
    await chip('TTY').click();
    await sleep(400);
    check(!(await micShown()) && !(await page.locator('#ptt-btn').isVisible()), 'RTTY: no PTT button, no Mic menu');
    await chip('SSB').click();
    await sleep(400);
    check(await micShown(), 'back to SSB: the Mic menu is back');
    await chip('CW').click();
    await sleep(400);
    check(!(await micShown()), 'CW (the paddle replaces PTT): no Mic menu');
    await page.locator('#modes .chip').first().click();
    await sleep(400);
  }
  {
    // Following must never drive the radio. (Seeing the radio leave a TTY
    // mode's sideband, it may repeat a "leave" the first browser also sent.)
    // (abortEasypal: the EasyPal transmit test presses Stop in this browser on purpose)
    const bad = bRequests.filter((r) => r.type !== 'abortEasypal').filter((r) => /^(set(Mode|Frequency|Ptt|Ft8Variant|CwDecoderVariant)|send|abort)/.test(r.type) || (r.type === 'setDataMode' && r.on) || (/Active$/.test(r.type) && r.active));
    check(bad.length === 0, 'the second browser sent no radio or mode commands of its own' + (bad.length ? ': ' + bad.map((r) => JSON.stringify(r)).join(' ') : ''));
  }

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await pageB.close();
  await browser.close();
  tty.stop();
  jttyRx.stop();
  oliviaRx.stop();
  hellRx.stop();
  sstvRx.stop();
  sstvTx.stop();
  cwTx.stop();
  wspr.stop();
  conditions.stop();
  faxRx.stop();
  easypalTx.stop();
  easypalRx.stop();
  await server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
