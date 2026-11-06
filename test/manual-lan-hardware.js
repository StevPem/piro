'use strict';

// Explicit hardware test; never part of npm test. No credentials are needed:
// connect to the already configured PiRO server through its browser protocol.
// node test/manual-lan-hardware.js [--controls] [--tx-dummy-load]
// PIRO_TEST_URL, PIRO_TEST_OUTPUT; PIRO_TEST_SELF_SIGNED=1 for a local test cert.
// TX defaults to 1 W and 200 ms PCM; PIRO_TEST_TX_WATTS (1..5),
// PIRO_TEST_TX_MS (100..600, multiples of 20) may override those limits.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const report = { startedAt: new Date().toISOString(), tests: [], restoration: [] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const controls = process.argv.includes('--controls');
const tx = process.argv.includes('--tx-dummy-load');
const txWatts = Number(process.env.PIRO_TEST_TX_WATTS || 1);
const txMs = Number(process.env.PIRO_TEST_TX_MS || 200);
if (tx) {
  assert.ok(Number.isInteger(txWatts) && txWatts >= 1 && txWatts <= 5, 'TX test power must be 1..5 W');
  assert.ok(Number.isInteger(txMs) && txMs >= 100 && txMs <= 600 && txMs % 20 === 0, 'TX test PCM duration must be 100..600 ms in 20 ms frames');
}
const pending = new Map();
const events = [];
const stats = { audioFrames: 0, samples: 0, squares: 0, peak: 0, clipped: 0, scopeFrames: 0, pointCounts: {} };
let ws, id = 0, scope, original;

function request(type, data = {}) {
  const key = String(++id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`${type}: timeout`)); }, 8000);
    pending.set(key, (message) => {
      clearTimeout(timer);
      if (message.ok) resolve(message.data);
      else reject(new Error(`${type}: ${message.error?.message || message.error}`));
    });
    ws.send(JSON.stringify({ id: key, type, ...data }));
  });
}

async function check(name, operation) {
  try {
    const detail = await operation();
    report.tests.push({ name, passed: true, detail });
    console.log(`PASS ${name}`, JSON.stringify(detail ?? null));
  } catch (error) {
    report.tests.push({ name, passed: false, error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

async function restore(name, operation) {
  try { await operation(); report.restoration.push({ name, passed: true }); }
  catch (error) { report.restoration.push({ name, passed: false, error: error.message }); }
}

async function main() {
  ws = new WebSocket(process.env.PIRO_TEST_URL || 'wss://127.0.0.1:8080', {
    rejectUnauthorized: process.env.PIRO_TEST_SELF_SIGNED !== '1',
  });
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect snapshot timed out')), 10000);
    ws.once('error', reject);
    ws.on('message', (bytes, binary) => {
      if (binary) {
        if (bytes[0] === 1) {
          ++stats.audioFrames;
          for (let i = 1; i + 1 < bytes.length; i += 2) {
            const sample = bytes.readInt16LE(i);
            ++stats.samples; stats.squares += sample * sample;
            stats.peak = Math.max(stats.peak, Math.abs(sample));
            if (Math.abs(sample) >= 32767) ++stats.clipped;
          }
        } else if (bytes[0] === 2) {
          ++stats.scopeFrames;
          const count = bytes.length - 12;
          stats.pointCounts[count] = (stats.pointCounts[count] || 0) + 1;
          scope = { mode: bytes[1], frequency: bytes.readUInt32LE(3), span: bytes.readUInt32LE(7) };
        }
        return;
      }
      const message = JSON.parse(bytes);
      events.push(message);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message); pending.delete(message.id);
      }
      if (message.type === 'connected') { clearTimeout(timer); resolve(message.data); }
    });
  });
  report.radio = snapshot.radioConnection;
  report.appVersion = snapshot.appVersion;
  assert.equal(snapshot.radioConnection?.transport, 'lan', 'Expected native LAN transport');
  assert.equal(snapshot.radioConnection?.model, 'IC-7300MK2', 'Expected verified IC-7300MK2');
  assert.equal(snapshot.ptt, false, 'Radio must start in receive');
  const names = ['Frequency', 'Mode', 'DataMode', 'Filter', 'SMeter', 'SWR', 'Alc', 'TxPower', 'RxGain', 'Preamp', 'NoiseReduction', 'NoiseBlanker', 'Notch', 'Tuner'];
  original = {};
  for (const name of names) await check(`read ${name}`, async () => (original[name] = await request(`get${name}`)));
  report.original = original;
  await check('receive PCM and 475-point scope', async () => {
    await delay(3000);
    assert.ok(stats.audioFrames > 50, 'No sustained PCM stream');
    assert.ok(stats.peak > 0, 'PCM contains only silence');
    assert.ok(stats.scopeFrames > 10, 'No sustained scope stream');
    assert.ok(stats.pointCounts[475] > 10, 'No 475-point scope lines');
    report.originalScope = { ...scope };
    return { ...stats, rms: Math.sqrt(stats.squares / stats.samples), scope };
  });
  // Never change settings if a restoration baseline could not be read.
  if (controls || tx) {
    assert.ok(names.every((name) => original[name]), 'Incomplete restoration baseline');
    await check('frequency set/read and second-client broadcast', async () => {
      const other = new WebSocket(process.env.PIRO_TEST_URL || 'wss://127.0.0.1:8080', {
        rejectUnauthorized: process.env.PIRO_TEST_SELF_SIGNED !== '1',
      });
      try {
        await new Promise((resolve, reject) => { other.once('open', resolve); other.once('error', reject); });
        const changed = original.Frequency.value + 1000;
        const observed = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Second browser missed frequency event')), 5000);
          other.on('message', (p, b) => { if (!b) { const e = JSON.parse(p); if (e.type === 'frequency' && e.data.value === changed) { clearTimeout(timer); resolve(); } } });
        });
        await request('setFrequency', { value: changed });
        assert.equal((await request('getFrequency')).value, changed);
        await observed;
        return { changed };
      } finally { other.terminate(); await request('setFrequency', original.Frequency); }
    });
    for (const mode of ['LSB', 'USB', 'AM', 'FM', 'RTTY', 'RTTY_R', 'CW', 'CW_R']) await check(`mode ${mode}`, async () => {
      await request('setMode', { mode, filter: 1 });
      const actual = (await request('getMode')).value;
      assert.equal(actual.mode, mode); return actual;
    });
    await request('setMode', { mode: 'USB', filter: 1 });
    for (const value of [1, 2, 3]) await check(`filter ${value}`, async () => {
      await request('setFilter', { value }); assert.equal((await request('getFilter')).value, value);
    });
    await check('DATA mode on/off', async () => {
      for (const on of [true, false]) { await request('setDataMode', { on }); assert.equal((await request('getDataMode')).on, on); }
    });
    for (const name of ['NoiseReduction', 'NoiseBlanker', 'Notch']) await check(`toggle ${name}`, async () => {
      try { for (const on of [true, false]) { await request(`set${name}`, { on }); assert.equal((await request(`get${name}`)).on, on); } }
      finally { await request(`set${name}`, original[name]); }
    });
    await check('preamp 0/1/2', async () => {
      try { for (const value of [0, 1, 2]) { await request('setPreamp', { value }); assert.equal((await request('getPreamp')).value, value); } }
      finally { await request('setPreamp', original.Preamp); }
    });
    await check('RX gain set/read', async () => {
      try { await request('setRxGain', { value: 200 }); assert.equal((await request('getRxGain')).value, 200); }
      finally { await request('setRxGain', original.RxGain); }
    });
    if (report.originalScope?.mode === 0) await check('scope spans', async () => {
      try { for (const spanHz of [25000, 50000, 100000]) {
        await request('setScopeSpan', { spanHz }); await delay(500);
        assert.equal(scope.span, spanHz); assert.equal(scope.mode, 0);
      } } finally { await request('setScopeSpan', { spanHz: report.originalScope.span }); }
    });
  }
  if (tx) {
    report.txAuthorization = 'Operator confirmed dummy load and brief low-power transmission';
    await check(`${txWatts} W power setting`, async () => {
      await request('setTxPower', { watts: txWatts });
      const watts = (await request('getTxPower')).watts;
      assert.ok(watts <= Math.min(5, txWatts + 1) && watts > 0); return { requestedWatts: txWatts, readWatts: watts };
    });
    assert.ok((await request('getTxPower')).watts <= Math.min(5, txWatts + 1), 'Refusing TX above the test power limit');
    await request('setMode', { mode: 'USB', filter: 1 });
    await request('setDataMode', { on: false });
    for (const dataMode of [false, true]) await check(`brief ${dataMode ? 'DATA' : 'voice'} PTT with PCM tone`, async () => {
      await request('setDataMode', { on: dataMode });
      const watchdog = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ id: 'watchdog-off', type: 'setPtt', value: false })); }
          catch (error) { report.watchdogError = error.message; }
        }
      }, 1500);
      const started = Date.now();
      try {
        await request('setPtt', { value: true });
        for (let frame = 0; frame < txMs / 20; ++frame) {
          const pcm = Buffer.alloc(1921); pcm[0] = 1;
          for (let n = 0; n < 960; n++) pcm.writeInt16LE(Math.round(2000 * Math.sin((frame * 960 + n) * 2 * Math.PI * 700 / 48000)), 1 + n * 2);
          ws.send(pcm); await delay(20);
        }
        return { pcmMilliseconds: txMs, elapsedBeforeReleaseMs: Date.now() - started, toneHz: 700,
          swrRaw: (await request('getSWR')).value, alcRaw: (await request('getAlc')).value };
      } finally {
        try { await request('setPtt', { value: false }); }
        finally { clearTimeout(watchdog); }
      }
    });
    await check('reverse RTTY rejects audio PTT', async () => {
      await request('setMode', { mode: 'RTTY_R', filter: 1 });
      try { await assert.rejects(request('setPtt', { value: true }), /FSK RTTY/); }
      finally { await request('setPtt', { value: false }); }
    });
    for (const mode of ['CW', 'CW_R']) await check(`brief typed ${mode} completion`, async () => {
      await request('setMode', { mode, filter: 1 });
      const since = events.length;
      try {
        await request('sendCw', { text: 'E', wpm: 20 });
        const deadline = Date.now() + 5000;
        while (!events.slice(since).some((e) => e.type === 'cw-tx-status' && ['sent', 'error', 'aborted'].includes(e.data.status))) {
          assert.ok(Date.now() < deadline, 'CW completion status timed out');
          await delay(50);
        }
        const terminal = events.slice(since).find((e) => e.type === 'cw-tx-status' && ['sent', 'error', 'aborted'].includes(e.data.status));
        assert.equal(terminal.data.status, 'sent', JSON.stringify(terminal.data));
      }
      finally { await request('abortCw'); await request('setPtt', { value: false }); }
      return events.slice(since).filter((e) => e.type === 'cw-tx-status').map((e) => e.data);
    });
    await check('active CW abort', async () => {
      const since = events.length;
      try {
        await request('sendCw', { text: 'EEEE', wpm: 20 });
        await delay(100);
        await request('abortCw');
        const deadline = Date.now() + 5000;
        while (!events.slice(since).some((e) => e.type === 'cw-tx-status' && e.data.status === 'aborted')) {
          assert.ok(Date.now() < deadline, 'Active CW abort was not confirmed');
          await delay(50);
        }
        return events.slice(since).filter((e) => e.type === 'cw-tx-status').map((e) => e.data);
      } finally { await request('abortCw'); await request('setPtt', { value: false }); }
    });
    await check('reverse CW paddle element', async () => {
      const since = events.length;
      try {
        await request('cwKey', { session: `audit-${Date.now()}`, t: 0, d: 60 });
        const deadline = Date.now() + 1500;
        while (!events.slice(since).some((e) => e.type === 'ptt' && e.data.value === false)) {
          assert.ok(Date.now() < deadline, 'Paddle release was not confirmed');
          await delay(20);
        }
        const edges = events.slice(since).filter((e) => e.type === 'ptt').map((e) => e.data.value);
        assert.ok(edges.includes(true));
        assert.equal(edges.at(-1), false);
        return { mode: 'CW_R', requestedKeyDownMs: 60, edges };
      } finally { await request('setPtt', { value: false }); }
    });
  }
}

main().catch((error) => { report.error = error.message; console.error(error); }).finally(async () => {
  if (original && (controls || tx) && ws?.readyState !== WebSocket.OPEN) {
    report.restoration.push({ name: 'radio restoration', passed: false, error: 'Connection unavailable; restoration could not be verified' });
  }
  if (original && ws?.readyState === WebSocket.OPEN && (controls || tx)) {
    if (tx) { await restore('CW stop', () => request('abortCw')); await restore('PTT off', () => request('setPtt', { value: false })); }
    await restore('mode/filter', async () => {
      await request('setMode', original.Mode.value); await request('setDataMode', original.DataMode);
      assert.deepEqual((await request('getMode')).value, original.Mode.value);
      assert.equal((await request('getDataMode')).on, original.DataMode.on);
    });
    await restore('frequency', async () => { await request('setFrequency', original.Frequency); assert.deepEqual(await request('getFrequency'), original.Frequency); });
    for (const name of ['NoiseReduction', 'NoiseBlanker', 'Notch', 'Preamp', 'RxGain']) {
      if (original[name]) await restore(name, async () => {
        await request(`set${name}`, original[name]);
        assert.deepEqual(await request(`get${name}`), original[name]);
      });
    }
    if (report.originalScope?.mode === 0) await restore('scope span', async () => {
      await request('setScopeSpan', { spanHz: report.originalScope.span }); await delay(500);
      assert.equal(scope.span, report.originalScope.span);
    });
    if (tx) await restore('TX power', async () => { await request('setTxPower', original.TxPower); assert.deepEqual(await request('getTxPower'), original.TxPower); });
  }
  report.finishedAt = new Date().toISOString();
  report.passed = !report.error && report.tests.every((t) => t.passed) && report.restoration.every((t) => t.passed);
  if (process.env.PIRO_TEST_OUTPUT) fs.writeFileSync(process.env.PIRO_TEST_OUTPUT, JSON.stringify(report, null, 2) + '\n');
  console.log('RESTORATION', JSON.stringify(report.restoration));
  ws?.terminate();
  process.exitCode = report.passed ? 0 : 1;
});
