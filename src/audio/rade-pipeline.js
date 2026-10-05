'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * Runs a fixed chain of native subprocesses piped stdout->stdin into each
 * other, streaming audio through the whole chain in real time — the
 * generic plumbing underneath both directions of the RADE codec bridge
 * (see src/server/rade-bridge.js), since neither `radae_tx` nor
 * `radae_rx` does its own feature extraction/speech synthesis (that's
 * `lpcnet_demo`'s job) or, for TX, its own complex-IQ-to-real-waveform
 * conversion (that's `real2iq`'s job) — see docs/ui-notes.md for the full
 * pipeline reasoning and where these binaries come from
 * (github.com/freedv/rade_c). Each stage is an ordinary Node child
 * process; write() feeds the first stage's stdin, and the last stage's
 * stdout is re-emitted here as 'data' chunks — everything in between is
 * just `child.stdout.pipe(nextChild.stdin)`.
 *
 * Deliberately dumb about audio format: like AlsaCapture/AlsaPlayback,
 * this class has no idea what sample rate or encoding is flowing through
 * it — that's entirely the calling bridge's responsibility (resampling
 * before write(), interpreting 'data' chunks after). It only knows how to
 * keep N processes alive, piped together, and to surface failure from any
 * of them.
 *
 * **Every stage is run through `stdbuf -o0 -e0`** (opts.unbuffered,
 * default true) unless disabled. rade_c's tools were written and
 * documented as batch converters over complete files (see its own README
 * examples), not as continuous real-time streams — by default, C's stdio
 * fully-buffers stdout whenever it isn't a terminal (i.e. exactly the
 * case here, since every stage's stdout is a pipe to the next stage or to
 * this class), typically holding several KB before actually writing
 * anything out. For a live, low-latency audio stream that's fatal: a
 * stage can sit on already-processed audio for a long time (worst case,
 * until the pipe closes) instead of handing it downstream as it's
 * produced, which looks from here exactly like "no audio" even though
 * the stage is running and not erroring. `stdbuf -o0 -e0` (a standard
 * coreutils wrapper, expected to already be installed on any Debian/
 * Raspberry Pi OS system) forces unbuffered stdout/stderr on each stage
 * without needing to touch/rebuild rade_c itself. See docs/ui-notes.md
 * for the user-reported symptom this was written to fix and the
 * un-verified status of this diagnosis (no access to the real binaries
 * from this environment).
 *
 * Started fresh (start()) each time it's needed and fully torn down
 * (stop()) once PTT/mode state moves on, rather than kept running
 * indefinitely — these are real per-session native processes (including,
 * on the RX/TX speech ends, an LPCNet neural-vocoder model load), so
 * there's a real startup latency cost to this each time; see
 * docs/ui-notes.md's "Known limitations" for RADE for the tradeoff this
 * accepts (never verified against the real binaries or hardware from
 * this environment — see that same section).
 *
 * Events: 'data' (Buffer, from the last stage's stdout), 'error' (Error,
 * from any stage failing to start or exiting unexpectedly — stop() is
 * called automatically first so a caller's error handler sees a clean,
 * already-stopped pipeline), 'stderr' (string, prefixed with which stage
 * it came from, for logging).
 */
class RadePipeline extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{bin: string, args?: string[]}[]} opts.stages - the chain, in order; each needs an
   *   executable on PATH (or an absolute path) plus its argv.
   * @param {Function} [opts.spawnFn] - injectable for testing; defaults to child_process.spawn
   * @param {string} [opts.label] - used only to make error/stderr messages identifiable when more
   *   than one RadePipeline is running at once (this bridge runs up to two: TX and RX)
   * @param {boolean} [opts.unbuffered] - wrap each stage in `stdbuf -o0 -e0` so its stdout/stderr
   *   isn't fully-buffered by libc just because it's writing to a pipe rather than a terminal
   *   (default true — see this class's own doc comment for why a real-time pipeline needs this).
   *   Set false only for testing, or if `stdbuf` genuinely isn't available on the target system.
   */
  constructor({ stages, spawnFn, label = 'rade-pipeline', unbuffered = true }) {
    super();
    if (!Array.isArray(stages) || stages.length === 0) {
      throw new Error('RadePipeline requires a non-empty opts.stages array');
    }
    this.stages = stages;
    this._spawn = spawnFn ?? spawn;
    this.label = label;
    this._unbuffered = unbuffered;
    this.procs = [];
    this._running = false;
  }

  /** Spawns every stage and pipes them together. Safe to call once; a second call while already running is a no-op. */
  start() {
    if (this._running) return;
    this._running = true;

    this.procs = this.stages.map(({ bin, args = [] }) =>
      this._unbuffered ? this._spawn('stdbuf', ['-o0', '-e0', bin, ...args]) : this._spawn(bin, args)
    );

    for (let i = 0; i < this.procs.length - 1; i++) {
      this.procs[i].stdout.pipe(this.procs[i + 1].stdin);
    }

    const last = this.procs[this.procs.length - 1];
    last.stdout.on('data', (chunk) => this.emit('data', chunk));

    this.procs.forEach((proc, i) => {
      const { bin } = this.stages[i];
      proc.stderr.on('data', (chunk) => this.emit('stderr', `[${bin}] ${chunk.toString().trim()}`));
      proc.on('error', (err) => {
        this.emit('error', new Error(`${this.label}: stage "${bin}" failed to start (${err.message})`));
        this.stop();
      });
      proc.on('exit', (code, signal) => {
        if (!this._running) return; // expected — we're the ones who killed it, via stop()
        this.emit('error', new Error(`${this.label}: stage "${bin}" exited unexpectedly (code=${code}, signal=${signal})`));
        this.stop();
      });
    });
  }

  /** Feeds a chunk of audio into the first stage's stdin. No-ops if not running or the pipe has already closed. */
  write(buffer) {
    if (!this._running || this.procs.length === 0) return;
    const first = this.procs[0];
    if (first.stdin && first.stdin.writable) {
      try {
        first.stdin.write(buffer);
      } catch {
        // The pipe can close out from under us if the first stage has
        // just exited (its 'exit' handler above already reports that) —
        // nothing further to do here.
      }
    }
  }

  /** Kills every stage. Safe to call even if start() was never called, or stop() already was. */
  stop() {
    if (!this._running) return;
    this._running = false;
    for (const proc of this.procs) {
      try {
        proc.stdin.end();
      } catch {
        // stdin may already be closed if the process died — nothing to do.
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        // already exited — nothing to do.
      }
    }
    this.procs = [];
  }
}

module.exports = { RadePipeline };
