'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { IcomLanDriver } = require('../src/icom-lan/driver');
const { ControlServer } = require('../src/server/ws-server');
const { EventEmitter } = require('node:events');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f) { const end = Date.now() + 5000; while (!f()) { assert.ok(Date.now() < end, 'timed out'); await sleep(5); } }
async function rig(t) {
  const peer = await new IcomPeer().start();
  const driver = new IcomLanDriver(peer.config()); driver.on('error', () => {});
  await driver.open();
  const cs = new ControlServer({ civ: driver, port: 0 }); await cs.listen();
  t.after(async () => { await cs.close(); await driver.close(); await peer.close(); });
  return { peer, driver, cs };
}

const { VaraBridge } = require('../src/server/vara-bridge');
function bridge(cs) {
  const b = new VaraBridge({ controlServer: cs, audioBridge: { sampleRate: 48000 }, callsign: 'S53ZO' });
  b._active = b._dataReady = true;
  b._link = { qsy: { phase: 'ack', role: 'receiver', target: 14075750 } };
  return b;
}
test('native VARA waits for queued PCM and confirmed PTT-off before QSY', async t => {
  const { peer, driver, cs } = await rig(t); const b = bridge(cs);
  const commands = []; peer.on('command', p => { if (p[4] === 5) commands.push({ kind: 'tune', ptt: peer.ptt }); if (p[4] === 0x1c && p.length === 8 && p[6] === 0) commands.push({ kind: 'off' }); });
  try {
    await b._key(); driver.playback.start(); driver.playback.write(Buffer.alloc(19200, 1));
    b._handleLine('PTT OFF');
    await until(() => commands.some(c => c.kind === 'tune'));
    assert.deepEqual(commands.map(c => c.kind), ['off', 'tune']);
    assert.equal(commands[1].ptt, false);
    assert.equal(peer.txAudio.reduce((n,p) => n + p.bytes.length, 0), 19200);
  } finally { clearTimeout(b._link?.qsy?.timer); clearTimeout(b._keyTimer); }
});
test('failed VARA release retains TX indication and blocks both ACK and buffer-driven QSY', async t => {
  const { peer, driver, cs } = await rig(t); const b = bridge(cs);
  await b._key();
  const original = peer.civ.bind(peer);
  peer.civ = (p,a) => { if (p[4] === 0x1c && p.length === 8 && p[6] === 0) peer.replyCiv([0xfa],a); else original(p,a); };
  try {
    assert.equal(await b._unkey(), false);
    assert.equal(peer.ptt, true); assert.equal(b._keyed, true); assert.equal(b.state.ptt, true);
    await b._qsyMove();
    b._link.qsy.phase = 'sending'; b._link.qsy.queued = true; b._update({ buffer: 0 }); b._drained();
    await sleep(20);
    assert.equal(peer.commands.some(p => p[4] === 5), false);
  } finally { peer.civ = original; clearTimeout(b._keyTimer); }
});
test("a new link cannot inherit the previous link's pending QSY after release", async () => {
  const cs = new EventEmitter(); let ack;
  cs.state = { ptt: true, frequency: 14074000 };
  cs.broadcastJsonEvent = () => {};
  cs.setPttFromServer = async () => { await new Promise(r => { ack = r; }); cs.state.ptt = false; };
  const b = bridge(cs); b._keyed = true;
  let tuned = false; b._tune = async () => { tuned = true; };
  b._handleLine('PTT OFF'); b._link = { qsy: { phase: 'ack', target: 14200000 } };
  ack(); await sleep(10);
  assert.equal(tuned, false);
});
