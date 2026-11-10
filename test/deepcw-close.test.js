// Run with: node test/deepcw-close.test.js
'use strict';

// Closing CW3 (DeepCW) while its model was loading, or during an
// inference, aborted the whole Node process: Worker.terminate() stopped
// onnxruntime mid-call ("terminate called after throwing an instance of
// 'Napi::Error'", SIGABRT; issue #81). Each case runs in its own Node
// process, because the abort would take this test with it. A child that
// closes cleanly exits with code 3.

const { spawnSync } = require('child_process');
const path = require('path');

const DECODER = path.join(__dirname, '..', 'src', 'audio', 'deepcw-decoder.js');
const BRIDGE = path.join(__dirname, '..', 'src', 'server', 'cw-decoder-bridge.js');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

function runChild(script) {
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  return { code: r.status, signal: r.signal, out: `${r.stdout}${r.stderr}`.trim() };
}

function describe(r) {
  return r.signal ? `signal ${r.signal}` : `exit code ${r.code}`;
}

const tone = 'new Int16Array(48000 * 9).map((_, i) => Math.round(8000 * Math.sin((i * 2 * Math.PI * 700) / 48000)))';

console.log('close() while the model loads:');
for (const delay of [0, 25, 50, 75, 100, 125, 150, 200, 300, 500]) {
  const r = runChild(`
    const { DeepCwDecoder } = require(${JSON.stringify(DECODER)});
    const d = new DeepCwDecoder({ sampleRate: 48000 });
    d.on('error', (e) => console.error(e.message));
    setTimeout(() => d.close().then(() => process.exit(3)), ${delay});
  `);
  check(r.code === 3, `closed after ${delay} ms: ${describe(r)}${r.code === 3 ? '' : ` ${r.out}`}`);
}

console.log('close() during an inference:');
for (const delay of [0, 25, 50, 100, 150, 250]) {
  const r = runChild(`
    const { DeepCwDecoder } = require(${JSON.stringify(DECODER)});
    const d = new DeepCwDecoder({ sampleRate: 48000 });
    d.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
    d._ready.then(() => {
      d.pushSamples(${tone});
      setTimeout(() => d.close().then(() => process.exit(process.exitCode || 3)), ${delay});
    });
  `);
  check(r.code === 3, `closed ${delay} ms into a decode, with no 'error': ${describe(r)}${r.code === 3 ? '' : ` ${r.out}`}`);
}

console.log('close() without waiting:');
{
  // The process ends by itself once the worker has gone, and not before.
  const r = runChild(`
    const { DeepCwDecoder } = require(${JSON.stringify(DECODER)});
    const d = new DeepCwDecoder({ sampleRate: 48000 });
    setTimeout(() => d.close(), 100);
  `);
  check(r.code === 0 && !r.signal, `the process exits normally: ${describe(r)}`);
}
{
  const r = runChild(`
    const { DeepCwDecoder } = require(${JSON.stringify(DECODER)});
    const d = new DeepCwDecoder({ sampleRate: 48000 });
    const a = d.close();
    const b = d.close();
    a.then(() => process.exit(a === b ? 3 : 1));
  `);
  check(r.code === 3, `a second close() returns the same promise: ${describe(r)}`);
}

console.log('CwDecoderBridge.stop() waits for CW3:');
{
  const r = runChild(`
    const { EventEmitter } = require('events');
    const { CwDecoderBridge } = require(${JSON.stringify(BRIDGE)});
    const civ = new EventEmitter();
    civ.getMode = async () => ({ mode: 'USB' });
    const controlServer = new EventEmitter();
    const audioBridge = new EventEmitter();
    audioBridge.sampleRate = 48000;
    const bridge = new CwDecoderBridge({ civ, controlServer, audioBridge });
    const w = bridge.decoders.CW3._engine._worker;
    let exited = false;
    w.once('exit', () => (exited = true));
    setTimeout(() => {
      const p = bridge.stop();
      if (!p || typeof p.then !== 'function') process.exit(1);
      p.then(() => process.exit(exited ? 3 : 2));
    }, 120);
  `);
  check(r.code === 3, `stop() resolves after the worker has exited: ${describe(r)}${r.code === 3 ? '' : ` ${r.out}`}`);
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
