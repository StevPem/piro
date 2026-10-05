// Run with: node test/rnnoise-filter.test.js
'use strict';

const { EventEmitter } = require('events');
const { RnnoiseFilter } = require('../src/audio/rnnoise-filter');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

/**
 * A fake child process good enough to stand in for child_process.spawn's
 * return value — same shape as rade-pipeline.test.js's own FakeChildProcess.
 * Unlike the old stdin/stdout-pipe version of RnnoiseFilter, the real PCM
 * data no longer flows through proc.stdin/proc.stdout at all (see
 * rnnoise-filter.js's own doc comment for why: Node's pipe-type stdio is
 * actually a socketpair, which the real rnnoise_demo binary's fopen() on
 * /dev/stdin/stdout can't reopen — confirmed via gdb+strace against a
 * real Pi). Data now flows through two named-FIFO streams created via the
 * injectable createWriteStreamFn/createReadStreamFn. This fake process
 * only needs stderr and its own lifecycle (error/exit) to still be
 * realistic.
 */
class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stderr = new FakeReadable();
    this.killed = false;
  }
  kill(signal) {
    this.killed = signal;
  }
}

class FakeWritable extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.written = [];
    this.ended = false;
    this.destroyed = false;
  }
  write(chunk) {
    if (!this.writable) throw new Error('write after end');
    this.written.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
    this.writable = false;
  }
  destroy() {
    this.destroyed = true;
  }
}

class FakeReadable extends EventEmitter {
  destroy() {
    this.destroyed = true;
  }
}

function makeSpawnFn() {
  const spawned = [];
  const spawnFn = (bin, args) => {
    const proc = new FakeChildProcess();
    proc.bin = bin;
    proc.args = args;
    spawned.push(proc);
    return proc;
  };
  spawnFn.spawned = spawned;
  return spawnFn;
}

function makeHarness() {
  const spawnFn = makeSpawnFn();
  const mkfifoCalls = [];
  const mkfifoFn = (p) => mkfifoCalls.push(p);
  const writeStreams = [];
  const createWriteStreamFn = (p) => {
    const s = new FakeWritable();
    s.path = p;
    writeStreams.push(s);
    return s;
  };
  const readStreams = [];
  const createReadStreamFn = (p) => {
    const s = new FakeReadable();
    s.path = p;
    readStreams.push(s);
    return s;
  };
  return { spawnFn, mkfifoFn, mkfifoCalls, createWriteStreamFn, writeStreams, createReadStreamFn, readStreams };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  // --- start() creates two FIFOs before spawning ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ bin: 'rnnoise_demo', ...h });
    filter.start();
    check(h.mkfifoCalls.length === 2, 'start() creates exactly two FIFOs');
    check(h.mkfifoCalls[0] !== h.mkfifoCalls[1], 'the two FIFO paths are distinct');
    filter.stop();
  }

  // --- start() spawns the binary with the two FIFO paths as argv, matching rnnoise_demo's real usage: `rnnoise_demo <in> <out>` ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ bin: 'rnnoise_demo', ...h });
    filter.start();
    const proc = h.spawnFn.spawned[0];
    check(proc.bin === 'rnnoise_demo', 'spawned with the configured binary name');
    check(proc.args.length === 2, 'spawned with exactly two argv entries');
    check(proc.args[0] === h.mkfifoCalls[0] && proc.args[1] === h.mkfifoCalls[1], 'spawned with the same two FIFO paths that were just created, in order (in, out)');
    filter.stop();
  }

  // --- wet, when set, is appended as a 3rd argv (for a patched
  // rnnoise_demo build that blends denoised/original signal at a fixed
  // ratio); when left unset, argv stays at exactly the 2 FIFO paths,
  // matching what an UNPATCHED rnnoise_demo build requires. ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ wet: 0.6, ...h });
    filter.start();
    const proc = h.spawnFn.spawned[0];
    check(proc.args.length === 3 && proc.args[2] === '0.6', 'wet is appended as a 3rd argv string when set');
    filter.stop();
  }
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h }); // no wet
    filter.start();
    const proc = h.spawnFn.spawned[0];
    check(proc.args.length === 2, 'no 3rd argv is appended when wet is left unset (unpatched-binary-safe)');
    filter.stop();
  }

  // --- defaults to the 'rnnoise_demo' binary name when not configured ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    check(h.spawnFn.spawned[0].bin === 'rnnoise_demo', "defaults to 'rnnoise_demo' when no bin is configured");
    filter.stop();
  }

  // --- write() pipes PCM to the input FIFO's write stream (not proc.stdin — see this file's own doc comment on why the old stdin/stdout-pipe approach was replaced) ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    const chunk = Buffer.from([1, 2, 3, 4]);
    filter.write(chunk);
    const inStream = h.writeStreams[0];
    check(inStream.written.length === 1 && inStream.written[0] === chunk, "write() writes the exact buffer to the input FIFO's write stream");
    filter.stop();
  }

  // --- write() before start() (or after stop()) is a safe no-op, never throws ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    let threw = false;
    try {
      filter.write(Buffer.from([1]));
    } catch {
      threw = true;
    }
    check(!threw, 'write() before start() does not throw');
    check(h.spawnFn.spawned.length === 0, 'write() before start() does not spawn anything');
  }

  // --- filtered PCM from the output FIFO's read stream is re-emitted as 'data' ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    const received = [];
    filter.on('data', (chunk) => received.push(chunk));
    const outChunk = Buffer.from([9, 8, 7]);
    h.readStreams[0].emit('data', outChunk);
    check(received.length === 1 && received[0] === outChunk, "output FIFO 'data' is re-emitted as this filter's own 'data' event");
    filter.stop();
  }

  // --- stderr output is re-emitted as 'stderr' (trimmed string) ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    const stderrLines = [];
    filter.on('stderr', (msg) => stderrLines.push(msg));
    h.spawnFn.spawned[0].stderr.emit('data', Buffer.from('  some warning\n'));
    check(stderrLines.length === 1 && stderrLines[0] === 'some warning', 'stderr output is trimmed and re-emitted');
    filter.stop();
  }

  // --- a failed FIFO creation emits 'error' rather than throwing, and never spawns the binary ---
  {
    const h = makeHarness();
    h.mkfifoFn = () => {
      throw new Error('mkfifo: permission denied');
    };
    const filter = new RnnoiseFilter({ ...h });
    const errors = [];
    filter.on('error', (err) => errors.push(err));
    let threw = false;
    try {
      filter.start();
    } catch {
      threw = true;
    }
    check(!threw, 'a failed FIFO creation does not throw');
    check(errors.length === 1, "a failed FIFO creation emits 'error'");
    check(/permission denied/.test(errors[0].message), 'the error message includes the underlying failure');
    check(h.spawnFn.spawned.length === 0, 'the binary is never spawned if FIFO creation fails');
  }

  // --- a spawn/start failure (binary not found) emits 'error', not a throw, and the filter is left stopped ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ bin: 'does-not-exist', ...h });
    const errors = [];
    filter.on('error', (err) => errors.push(err));
    filter.start();
    const proc = h.spawnFn.spawned[0];
    proc.emit('error', Object.assign(new Error('spawn does-not-exist ENOENT'), { code: 'ENOENT' }));
    check(errors.length === 1, "a failed spawn emits 'error' rather than throwing");
    check(/does-not-exist/.test(errors[0].message), 'the error message names the binary that failed');
    check(filter._running === false, 'the filter is left stopped after a spawn failure');
  }

  // --- an unexpected exit mid-stream emits 'error' and stops the filter (passthrough fallback is the caller's job — see audio-bridge.js) ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    const errors = [];
    filter.on('error', (err) => errors.push(err));
    h.spawnFn.spawned[0].emit('exit', null, 'SIGSEGV');
    check(errors.length === 1, "an unexpected exit emits 'error'");
    check(/SIGSEGV/.test(errors[0].message), 'the error message includes the signal that killed it');
    check(filter._running === false, 'the filter is stopped after an unexpected exit');
  }

  // --- a clean stop() does NOT emit 'error' for the resulting exit ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    const errors = [];
    filter.on('error', (err) => errors.push(err));
    filter.stop();
    h.spawnFn.spawned[0].emit('exit', 0, 'SIGTERM'); // simulates the real process actually dying after being kill()ed
    check(errors.length === 0, "an exit caused by our own stop() does not emit 'error'");
  }

  // --- an error event on the input FIFO's write stream (e.g. EPIPE, if the
  // child dies between one write and the next) doesn't crash the process.
  // Node reports stream write failures asynchronously via an 'error' event,
  // not a synchronous throw from write(); with no listener, that's fatal to
  // the whole Node process. This was a real bug found via a live Raspberry
  // Pi repro on 2026-09-30, in the previous (stdin-pipe-based) version of
  // this class -- still just as real here since the FIFO write stream can
  // fail the same way. ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    const inStream = h.writeStreams[0];
    let threw = false;
    try {
      inStream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    } catch {
      threw = true;
    }
    check(!threw, "an 'error' event on the input FIFO's write stream does not throw/crash the process");
    filter.stop();
  }

  // --- same, for the output FIFO's read stream ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    const outStream = h.readStreams[0];
    let threw = false;
    try {
      outStream.emit('error', new Error('read error'));
    } catch {
      threw = true;
    }
    check(!threw, "an 'error' event on the output FIFO's read stream does not throw/crash the process");
    filter.stop();
  }

  // --- stop() ends the input stream, destroys the output stream, kills the process, and removes both FIFO files; safe to call when never started ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    const proc = h.spawnFn.spawned[0];
    const inStream = h.writeStreams[0];
    const outStream = h.readStreams[0];
    const [inFifo, outFifo] = h.mkfifoCalls;
    const unlinked = [];
    const realUnlinkSync = require('fs').unlinkSync;
    require('fs').unlinkSync = (p) => unlinked.push(p);
    try {
      filter.stop();
    } finally {
      require('fs').unlinkSync = realUnlinkSync;
    }
    check(inStream.ended, "stop() ends the input FIFO's write stream");
    check(outStream.destroyed, "stop() destroys the output FIFO's read stream");
    check(proc.killed === 'SIGTERM', 'stop() kills the process with SIGTERM');
    check(unlinked.includes(inFifo) && unlinked.includes(outFifo), 'stop() removes both FIFO files');

    const h2 = makeHarness();
    const neverStarted = new RnnoiseFilter({ ...h2 });
    let threw = false;
    try {
      neverStarted.stop();
    } catch {
      threw = true;
    }
    check(!threw, 'stop() is safe to call even if start() was never called');
  }

  // --- a second start() call while already running does not spawn again, and does not create more FIFOs ---
  {
    const h = makeHarness();
    const filter = new RnnoiseFilter({ ...h });
    filter.start();
    filter.start();
    check(h.spawnFn.spawned.length === 1, 'a second start() call while already running is a no-op');
    check(h.mkfifoCalls.length === 2, 'a second start() call does not create additional FIFOs');
    filter.stop();
  }

  await flush();

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
