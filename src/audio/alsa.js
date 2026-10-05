'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * Wraps `arecord` to continuously capture raw PCM audio from an ALSA
 * device (the radio's USB audio codec, presenting the rig's RX audio) and
 * emit it as a stream of 'data' chunks. Chunk boundaries are arbitrary —
 * consumers needing fixed-size frames (e.g. for Opus encoding) should run
 * the output through PcmFramer.
 *
 * Events: 'data' (Buffer), 'error' (Error), 'stderr' (string), 'exit' ({code, signal})
 */
class AlsaCapture extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.device - ALSA device, e.g. "plughw:1,0"
   * @param {number} [opts.sampleRate=48000]
   * @param {number} [opts.channels=1]
   * @param {string} [opts.format='S16_LE']
   */
  constructor({ device, sampleRate = 48000, channels = 1, format = 'S16_LE' }) {
    super();
    if (!device) throw new Error('AlsaCapture requires opts.device');
    this.device = device;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.format = format;
    this.proc = null;
  }

  start() {
    if (this.proc) return;
    const args = [
      '-D', this.device,
      '-f', this.format,
      '-r', String(this.sampleRate),
      '-c', String(this.channels),
      '-t', 'raw',
      '-q',
      '-',
    ];
    this.proc = spawn('arecord', args);
    this.proc.stdout.on('data', (chunk) => this.emit('data', chunk));
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()));
    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      this.emit('exit', { code, signal });
    });
  }

  stop() {
    if (!this.proc) return;
    this.proc.kill('SIGTERM');
    this.proc = null;
  }
}

/**
 * Wraps `aplay` to continuously play raw PCM audio out to an ALSA device
 * (the radio's USB audio codec, feeding the rig's mic input). Feed audio
 * via write(); the underlying process stays open across many writes.
 *
 * Events: 'error' (Error), 'stderr' (string), 'exit' ({code, signal})
 */
class AlsaPlayback extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.device - ALSA device, e.g. "plughw:1,0"
   * @param {number} [opts.sampleRate=48000]
   * @param {number} [opts.channels=1]
   * @param {string} [opts.format='S16_LE']
   */
  constructor({ device, sampleRate = 48000, channels = 1, format = 'S16_LE' }) {
    super();
    if (!device) throw new Error('AlsaPlayback requires opts.device');
    this.device = device;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.format = format;
    this.proc = null;
  }

  start() {
    if (this.proc) return;
    const args = [
      '-D', this.device,
      '-f', this.format,
      '-r', String(this.sampleRate),
      '-c', String(this.channels),
      '-t', 'raw',
      '-q',
      '-',
    ];
    this.proc = spawn('aplay', args);
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()));
    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      this.emit('exit', { code, signal });
    });
  }

  /** Write a raw PCM buffer to be played out. */
  write(buffer) {
    if (this.proc && this.proc.stdin.writable) {
      this.proc.stdin.write(buffer);
    }
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {
      // stdin may already be closed if the process died; nothing to do.
    }
    this.proc.kill('SIGTERM');
    this.proc = null;
  }
}

module.exports = { AlsaCapture, AlsaPlayback };
