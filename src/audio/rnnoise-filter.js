'use strict';

const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Runs the real RNNoise project's example CLI (`rnnoise_demo`, from
 * https://github.com/xiph/rnnoise's `examples/` dir, built via their
 * autotools build) as a single persistent child process, piping raw
 * 16-bit PCM mono audio in and reading RNNoise-filtered 16-bit PCM back
 * out — the same "spawn a native subprocess, pipe audio through it in
 * real time" shape ../audio/rade-pipeline.js already established for the
 * RADE codec chain (see that class's own doc comment), scaled down to a
 * single stage, since RNNoise has no separate feature-extraction/
 * resynthesis stage the way RADE's `lpcnet_demo` does — just one process,
 * PCM in, filtered PCM out.
 *
 * **`rnnoise_demo`'s real interface, and why this class uses named FIFOs
 * (confirmed against a real Raspberry Pi build, 2026-09-30):**
 * `rnnoise_demo` does NOT operate as a plain stdin/stdout filter — its
 * actual usage is `rnnoise_demo <noisy speech> <output denoised>`; it
 * calls `fopen()` on two file-path arguments directly (see its own
 * source, `examples/rnnoise_demo.c`) and exits immediately with a usage
 * message if invoked with none, exactly as this file's own doc comment
 * once flagged as a real risk.
 *
 * The first fix attempted here was passing `/dev/stdin`/`/dev/stdout` as
 * those two arguments, relying on Linux's `/proc/self/fd/N` magic-symlink
 * trick to make `fopen()` transparently reopen the process's own stdio.
 * That works fine when the process's stdin/stdout are genuine POSIX
 * pipes (e.g. spawned from a shell: `cat file | rnnoise_demo /dev/stdin
 * /dev/stdout` — confirmed working, including with real audio and
 * realistic chunked/timed writes). It reliably SEGFAULTS when spawned
 * from Node, however: confirmed via gdb backtrace that the crash is a
 * NULL-pointer deref inside `fread()`, because `fopen("/dev/stdin", ...)`
 * itself returns NULL — confirmed via `strace` to fail with `ENXIO`. The
 * reason: Node's `child_process` "pipe" stdio is NOT a plain POSIX
 * `pipe()` under the hood — libuv implements it with `socketpair()`, so
 * the fd handed to the child is a Unix-domain socket (`S_IFSOCK`), not a
 * pipe (`S_IFIFO`). Linux's `/proc/self/fd/N` reopen trick only works for
 * real pipes/regular files; reopening a socket via its procfs path
 * reliably fails with ENXIO. This was confirmed to reproduce with a
 * trivial standalone C program mimicking rnnoise_demo.c's exact
 * fopen/fread/fwrite loop, both on a real Pi and in a plain Linux
 * sandbox — i.e. this is a general Node-vs-shell distinction, nothing
 * ARM/Pi-specific, and nothing specific to RNNoise's own code.
 *
 * The actual fix: use real named FIFOs (`mkfifo`) on the filesystem
 * instead. A named FIFO is a genuine `S_IFIFO` file that both `fopen()`
 * (in the child) and Node's `fs.createWriteStream`/`fs.createReadStream`
 * (here) can open normally by path — no procfs reopen trick involved, so
 * the socket-vs-pipe mismatch above doesn't apply. Verified end-to-end
 * (byte-exact output, both a single bulk write and realistic
 * misaligned/incrementally-timed real-time chunking) against a trivial
 * stand-in binary with the same fopen/fread/fwrite shape as the real
 * `rnnoise_demo.c`.
 *
 * RNNoise's reference build expects raw S16LE mono PCM at 48kHz (see the
 * RNNoise project's own README/examples). This app's own default
 * `AUDIO_SAMPLE_RATE` also happens to be 48000, so no resampling is
 * implemented here — the sample rate this filter actually runs at is
 * entirely up to whatever PCM the caller writes to it (never hardcoded to
 * 48000 anywhere in this file); it's the caller's job (see
 * audio-bridge.js's `setRnnoiseLevel()`) to only enable this when the
 * configured `AUDIO_SAMPLE_RATE` genuinely matches what RNNoise expects.
 * If that's ever not true, this class has no resampling step and RNNoise
 * output would come out pitched/timed wrong — that's a real gap, not
 * silently handled, since the app's one real deployment target already
 * matches RNNoise's expected rate and adding an unverified resampling
 * step here seemed worse than leaving this documented.
 *
 * This class deliberately imposes no strict framing of its own: it just
 * writes whatever PCM chunk it's handed, whenever it's handed it, to the
 * input FIFO, and re-emits whatever comes back out of the output FIFO as
 * a 'data' chunk, trusting ordinary OS pipe/stdio buffering — the same
 * posture rade-pipeline.js takes toward its own stages. RNNoise's
 * reference algorithm internally processes fixed 480-sample (10ms @
 * 48kHz) frames; `rnnoise_demo.c` handles arbitrary write sizes/timing
 * fine on the input side (glibc's buffered `fread()` blocks and
 * accumulates as needed — this was verified above with deliberately
 * frame-misaligned chunk sizes), so no extra framing layer is added here.
 *
 * Fully defensive, same posture as every other native-subprocess wrapper
 * in this project: a failed spawn, a failed FIFO creation, or an
 * unexpected exit emits 'error' (an `Error`) rather than throwing. This
 * class does no automatic fallback/passthrough itself — only the calling
 * bridge knows what "passthrough" even means in its own pipeline (see
 * audio-bridge.js's setRnnoiseLevel()/_wire(), which is what actually
 * falls back to unfiltered audio when this class reports an error).
 *
 * FIFOs are created per-`start()` call with a unique name (PID + random
 * suffix) under the system temp dir, and removed again in `stop()` — they
 * don't need to survive a restart, and leaving stale ones around after a
 * crash is harmless (just an empty FIFO file; the next `start()` uses a
 * fresh name).
 *
 * Events: 'data' (Buffer, filtered PCM from the output FIFO), 'error'
 * (Error, from a failed spawn, failed FIFO setup, or an unexpected exit —
 * stop() is called first, so a caller's error handler always sees an
 * already-stopped filter), 'stderr' (string, the process's own stderr
 * output, for logging).
 */
class RnnoiseFilter extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.bin='rnnoise_demo'] - path/name of the rnnoise_demo binary (must be on PATH, or an absolute path)
   * @param {Function} [opts.spawnFn] - injectable for testing; defaults to child_process.spawn
   * @param {Function} [opts.mkfifoFn] - injectable for testing; (path) => void, defaults to shelling out to the `mkfifo` command (Node has no built-in FIFO creation syscall wrapper)
   * @param {Function} [opts.createWriteStreamFn] - injectable for testing; defaults to fs.createWriteStream
   * @param {Function} [opts.createReadStreamFn] - injectable for testing; defaults to fs.createReadStream
   * @param {string} [opts.tmpDir] - directory the two per-instance FIFOs are created in; defaults to os.tmpdir()
   */
  constructor({
    bin = 'rnnoise_demo',
    wet,
    spawnFn,
    mkfifoFn,
    createWriteStreamFn,
    createReadStreamFn,
    tmpDir,
  } = {}) {
    super();
    this.bin = bin;
    // Optional 3rd argv for a patched rnnoise_demo build that blends the
    // denoised and original signal at a fixed ratio (see
    // docs/audio-notes.md and the patched examples/rnnoise_demo.c this
    // project ships alongside this file) — undefined/null means "don't
    // pass it", which is what an unpatched stock rnnoise_demo build
    // expects (exactly 2 args). A patched build also treats an omitted
    // 3rd arg as 1.0 (full denoising, no blending), so leaving this
    // unset is safe either way.
    this.wet = wet;
    this._spawn = spawnFn ?? spawn;
    this._mkfifo = mkfifoFn ?? defaultMkfifo;
    this._createWriteStream = createWriteStreamFn ?? fs.createWriteStream;
    this._createReadStream = createReadStreamFn ?? fs.createReadStream;
    this._tmpDir = tmpDir ?? os.tmpdir();
    this._proc = null;
    this._running = false;
    this._inFifoPath = null;
    this._outFifoPath = null;
    this._inStream = null;
    this._outStream = null;
  }

  /** Spawns the filter process (after creating its two FIFOs). Safe to call once; a second call while already running is a no-op. */
  start() {
    if (this._running) return;
    this._running = true;

    const id = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    this._inFifoPath = path.join(this._tmpDir, `rnnoise-in-${id}.fifo`);
    this._outFifoPath = path.join(this._tmpDir, `rnnoise-out-${id}.fifo`);

    try {
      this._mkfifo(this._inFifoPath);
      this._mkfifo(this._outFifoPath);
    } catch (err) {
      // Mirrors the spawn-failure posture below: report and leave this
      // filter fully stopped rather than throwing or half-starting.
      this._running = false;
      this._cleanupFifoFiles();
      this.emit('error', new Error(`rnnoise-filter: failed to create FIFOs (${err.message})`));
      return;
    }

    const args = [this._inFifoPath, this._outFifoPath];
    if (this.wet != null) args.push(String(this.wet));
    const proc = this._spawn(this.bin, args);
    this._proc = proc;

    // Opening these is what actually unblocks the child's own two
    // fopen() calls (fopen() on a FIFO blocks until the other end is
    // opened) -- order between this and the child's own opens doesn't
    // matter, both sides just wait for their counterpart.
    const inStream = this._createWriteStream(this._inFifoPath);
    const outStream = this._createReadStream(this._outFifoPath);
    this._inStream = inStream;
    this._outStream = outStream;

    // Same reasoning as the old stdin-pipe version: a write landing after
    // the child has died surfaces as an async 'error' event, not a
    // synchronous throw, and would otherwise crash the whole process. The
    // child's own 'exit' handler below is what actually reports the
    // failure through this class's 'error' event.
    inStream.on('error', () => {});
    outStream.on('error', () => {});
    outStream.on('data', (chunk) => this.emit('data', chunk));

    proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString().trim()));
    proc.on('error', (err) => {
      // Covers a missing binary (ENOENT) as well as any other failure to
      // start — Node reports this asynchronously via 'error' rather than
      // throwing from spawn() itself, same as every other subprocess in
      // this project's audio pipeline (see rade-pipeline.js).
      this.emit('error', new Error(`rnnoise-filter: "${this.bin}" failed to start (${err.message})`));
      this.stop();
    });
    proc.on('exit', (code, signal) => {
      if (!this._running) return; // expected — we killed it ourselves via stop()
      this.emit('error', new Error(`rnnoise-filter: "${this.bin}" exited unexpectedly (code=${code}, signal=${signal})`));
      this.stop();
    });
  }

  /** Feeds a chunk of raw PCM into the filter's input FIFO. No-op if not running or the stream has already closed. */
  write(buffer) {
    if (!this._running || !this._inStream || !this._inStream.writable) return;
    try {
      this._inStream.write(buffer);
    } catch {
      // The stream can close out from under us if the process has just
      // exited (its own 'exit' handler above already reports that) —
      // nothing further to do here.
    }
  }

  /** Kills the filter process, closes both FIFO streams, and removes the FIFO files. Safe to call even if start() was never called, or stop() already was. */
  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._inStream) {
      try {
        this._inStream.end();
      } catch {
        // stream may already be closed if the process died — nothing to do.
      }
    }
    if (this._outStream) {
      try {
        this._outStream.destroy();
      } catch {
        // already closed — nothing to do.
      }
    }
    if (this._proc) {
      try {
        this._proc.kill('SIGTERM');
      } catch {
        // already exited — nothing to do.
      }
    }
    this._proc = null;
    this._inStream = null;
    this._outStream = null;
    this._cleanupFifoFiles();
  }

  /** Best-effort removal of this instance's two FIFO files, if they exist. A leftover file after an unclean exit is harmless (just an empty FIFO; the next start() uses a fresh unique name), so failures here are swallowed. */
  _cleanupFifoFiles() {
    for (const p of [this._inFifoPath, this._outFifoPath]) {
      if (!p) continue;
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone, or never created — nothing to do.
      }
    }
    this._inFifoPath = null;
    this._outFifoPath = null;
  }
}

/** Default `mkfifoFn`: Node has no built-in FIFO-creation syscall wrapper, so this shells out to the standard `mkfifo` coreutils command (present on every Linux distro this app targets, including Raspberry Pi OS). */
function defaultMkfifo(fifoPath) {
  execFileSync('mkfifo', [fifoPath]);
}

module.exports = { RnnoiseFilter };
