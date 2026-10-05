// Run with: node test/rade-pipeline.test.js
'use strict';

const { EventEmitter } = require('events');
const { RadePipeline } = require('../src/audio/rade-pipeline');

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
 * return value: stdin/stdout/stderr are plain streams-ish EventEmitters
 * with the handful of methods/fields RadePipeline actually touches
 * (stdin.write/end/writable, stdout.on/pipe, stderr.on, proc.on/kill).
 * There are no real binaries to spawn from this environment (rade_c only
 * exists on the operator's own server — see docs/ui-notes.md), so this
 * test is entirely about RadePipeline's own subprocess-orchestration
 * logic (piping stages together, propagating errors, start/stop
 * lifecycle) — not about the real tools' actual DSP behavior.
 */
class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeWritable();
    this.stdout = new FakeReadable();
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
}

class FakeReadable extends EventEmitter {
  /** Mimics stream.pipe(dest): forwards every 'data' chunk to dest.write(). */
  pipe(dest) {
    this.on('data', (chunk) => dest.write(chunk));
    return dest;
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

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  // --- start() spawns every stage with the right argv, in order ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({
      label: 'test',
      spawnFn,
      unbuffered: false,
      stages: [
        { bin: 'stage-a', args: ['--foo'] },
        { bin: 'stage-b' },
      ],
    });
    pipeline.start();
    check(spawnFn.spawned.length === 2, 'start() spawns one process per stage');
    check(spawnFn.spawned[0].bin === 'stage-a' && spawnFn.spawned[0].args[0] === '--foo', 'first stage spawned with its own bin/args');
    check(spawnFn.spawned[1].bin === 'stage-b' && spawnFn.spawned[1].args.length === 0, 'second stage spawned with its own bin/args (args defaults to [])');
    pipeline.stop();
  }

  // --- by default, every stage is wrapped in `stdbuf -o0 -e0` to defeat libc's full-buffering of non-tty stdout ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({
      label: 'test',
      spawnFn,
      stages: [
        { bin: 'stage-a', args: ['--foo'] },
        { bin: 'stage-b' },
      ],
    });
    pipeline.start();
    check(spawnFn.spawned[0].bin === 'stdbuf', 'defaults to spawning stdbuf, not the stage binary directly');
    check(
      spawnFn.spawned[0].args[0] === '-o0' && spawnFn.spawned[0].args[1] === '-e0' && spawnFn.spawned[0].args[2] === 'stage-a' && spawnFn.spawned[0].args[3] === '--foo',
      'stdbuf is invoked with -o0 -e0 then the real stage binary and its own args, in order'
    );
    check(spawnFn.spawned[1].bin === 'stdbuf' && spawnFn.spawned[1].args[2] === 'stage-b', 'the second stage is wrapped the same way');
    pipeline.stop();
  }

  // --- unbuffered: false spawns the stage binary directly, no stdbuf wrapper ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, unbuffered: false, stages: [{ bin: 'stage-a' }] });
    pipeline.start();
    check(spawnFn.spawned[0].bin === 'stage-a', 'unbuffered: false skips the stdbuf wrapper entirely');
    pipeline.stop();
  }

  // --- stages are piped together: stage A's stdout reaches stage B's stdin ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, unbuffered: false, stages: [{ bin: 'a' }, { bin: 'b' }] });
    pipeline.start();
    const [a, b] = spawnFn.spawned;
    a.stdout.emit('data', Buffer.from([1, 2, 3]));
    check(b.stdin.written.length === 1 && b.stdin.written[0].equals(Buffer.from([1, 2, 3])), "stage A's stdout is piped into stage B's stdin");
    pipeline.stop();
  }

  // --- the last stage's stdout is re-emitted as this pipeline's own 'data' event ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, stages: [{ bin: 'a' }, { bin: 'b' }] });
    const received = [];
    pipeline.on('data', (chunk) => received.push(chunk));
    pipeline.start();
    const [, b] = spawnFn.spawned;
    b.stdout.emit('data', Buffer.from('decoded'));
    check(received.length === 1 && received[0].toString() === 'decoded', "the final stage's stdout becomes the pipeline's own 'data' event");
    pipeline.stop();
  }

  // --- write() feeds the first stage's stdin ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, stages: [{ bin: 'a' }, { bin: 'b' }] });
    pipeline.start();
    pipeline.write(Buffer.from('input audio'));
    check(spawnFn.spawned[0].stdin.written[0].toString() === 'input audio', "write() feeds the first stage's stdin, not any other stage's");
    check(spawnFn.spawned[1].stdin.written.length === 0, "write() doesn't touch downstream stages directly (only via piping)");
    pipeline.stop();
  }

  // --- write() before start(), or after stop(), is a safe no-op ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, stages: [{ bin: 'a' }] });
    pipeline.write(Buffer.from('too early'));
    check(spawnFn.spawned.length === 0, 'write() before start() does not spawn anything or throw');
    pipeline.start();
    pipeline.stop();
    pipeline.write(Buffer.from('too late'));
    check(true, 'write() after stop() does not throw');
  }

  // --- stop() ends stdin and kills every stage ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, stages: [{ bin: 'a' }, { bin: 'b' }] });
    pipeline.start();
    const [a, b] = spawnFn.spawned;
    pipeline.stop();
    check(a.stdin.ended && b.stdin.ended, "stop() ends every stage's stdin");
    check(a.killed === 'SIGTERM' && b.killed === 'SIGTERM', 'stop() sends SIGTERM to every stage');
  }

  // --- stop() is idempotent / safe before start() ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, stages: [{ bin: 'a' }] });
    pipeline.stop();
    check(true, 'stop() before start() does not throw');
    pipeline.start();
    pipeline.stop();
    pipeline.stop();
    check(true, 'calling stop() twice does not throw or double-kill');
  }

  // --- a stage exiting unexpectedly emits 'error' and tears the whole pipeline down ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test-label', spawnFn, stages: [{ bin: 'a' }, { bin: 'crashy' }] });
    const errors = [];
    pipeline.on('error', (err) => errors.push(err));
    pipeline.start();
    const [a, crashy] = spawnFn.spawned;
    crashy.emit('exit', 1, null);
    check(errors.length === 1 && /test-label/.test(errors[0].message) && /crashy/.test(errors[0].message), 'an unexpected stage exit reports an error naming the pipeline and the stage');
    check(a.stdin.ended, 'the other stage is torn down too once one stage crashes');
  }

  // --- a stage failing to spawn at all emits 'error' too ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, stages: [{ bin: 'nonexistent-binary' }] });
    const errors = [];
    pipeline.on('error', (err) => errors.push(err));
    pipeline.start();
    spawnFn.spawned[0].emit('error', new Error('ENOENT'));
    check(errors.length === 1 && /nonexistent-binary/.test(errors[0].message), "a stage's spawn error is reported with the binary name");
  }

  // --- stderr from any stage is surfaced with its stage name ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, stages: [{ bin: 'noisy-stage' }] });
    const stderrMsgs = [];
    pipeline.on('stderr', (msg) => stderrMsgs.push(msg));
    pipeline.start();
    spawnFn.spawned[0].stderr.emit('data', Buffer.from('warning: something\n'));
    check(stderrMsgs.length === 1 && stderrMsgs[0].includes('noisy-stage') && stderrMsgs[0].includes('warning: something'), 'stderr output is prefixed with which stage it came from');
    pipeline.stop();
  }

  // --- an exit after stop() was already called is NOT reported as an error (expected shutdown) ---
  {
    const spawnFn = makeSpawnFn();
    const pipeline = new RadePipeline({ label: 'test', spawnFn, stages: [{ bin: 'a' }] });
    const errors = [];
    pipeline.on('error', (err) => errors.push(err));
    pipeline.start();
    pipeline.stop();
    spawnFn.spawned[0].emit('exit', 0, 'SIGTERM'); // the kill() this test's stop() call above triggered, arriving asynchronously
    await flush();
    check(errors.length === 0, "a stage exiting after stop() was called (our own kill taking effect) doesn't report a spurious error");
  }

  // --- constructor validates opts.stages ---
  {
    let threw = false;
    try {
      // eslint-disable-next-line no-new
      new RadePipeline({ stages: [] });
    } catch {
      threw = true;
    }
    check(threw, 'constructor throws on an empty stages array');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
