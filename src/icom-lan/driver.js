'use strict';

const { CivDriver } = require('../civ/driver');
const { IcomSession, CivLanTransport } = require('./session');

// Packed-decimal menu numbers from the IC-7300MK2 CI-V reference, pp.7/9.
const MK2 = Object.freeze({ id: 0xb6, name: 'IC-7300MK2', timeout: [0, 0x32],
  afSelect: [0, 0x79], afSql: [0, 0x80], modLevel: [0, 0x83],
  modOff: [0, 0x84], modData: [0, 0x85], lanSource: 5 });
const TIMEOUT_MINUTES = [0, 3, 5, 10, 20, 30];

// CW paddle keying (issue #83). Each paddle element is a PTT key-down and
// key-up. Reading 0032 and the mode before every key-down made key-down
// late but not key-up, so dots came out short and uneven. Within a burst
// of CW keying, a key-down skips those reads when:
// - the last key-down found CW mode, and its key-up was less than
//   CW_BURST_MS ago,
// - no mode change has been seen since (our own or the radio's),
// - 0032 was read and found on less than TIMEOUT_RECHECK_MS ago.
// USB keying never reads the mode before PTT, so this is no weaker than USB.
const CW_BURST_MS = 2000;
const TIMEOUT_RECHECK_MS = 30000;

class IcomLanDriver extends CivDriver {
  constructor(options) {
    const session = new IcomSession({ ...options, deferReady: true });
    super({ path: `Icom LAN ${options.host}`, transport: new CivLanTransport(session),
      radioAddr: options.radioAddr ?? 0, requestTimeoutMs: options.requestTimeoutMs ?? 2000 });
    this.session = session;
    this.options = options;
    this.capture = session.capture;
    this.playback = session.playback;
    this.txRevision = 0;
    this.cwRevision = 0;
    this.tunerRevision = 0;
    this.settingsQueue = Promise.resolve();
    this.rxSaved = [];
    this.txSaved = [];
    this.prepared = false;
    this.timeoutMinutes = null;
    this.timeoutWarning = null;
    this.timeoutCheckedAt = -Infinity; // when 0032 was last read and found on
    this.lastTxCw = false; // the last key-down found CW mode
    this.cwBurstUntil = -Infinity; // key-downs before this may skip the reads
    this.on('mode', () => this.endCwBurst());
    if (options.modLevel !== undefined && (!Number.isInteger(options.modLevel) || options.modLevel < 0 || options.modLevel > 255)) {
      throw new Error('ICOM_LAN_MOD_LEVEL must be an integer from 0 to 255');
    }
  }

  async open() {
    try {
      await this.session.open();
      await super.open();
      await this.initialize();
    } catch (err) {
      await this.session.close();
      throw err;
    }
  }

  _wirePortEvents() {
    this.port.on('data', (chunk) => this._handleData(chunk));
    this.port.on('error', (err) => this.emit('error', err));
    this.port.on('close', () => {
      this.prepared = false;
      this.endCwBurst();
      ++this.txRevision;
      ++this.cwRevision;
      ++this.tunerRevision;
      this._cancelPending(this.session.failure || new Error('Icom LAN connection closed'));
      this._parser.reset();
      this._scope.reset();
      this.emit('close'); // Existing USB-style shutdown; systemd restarts.
    });
  }

  _cancelPending(error) {
    clearTimeout(this._guardTimer);
    this._guardTimer = null;
    if (this._current) {
      clearTimeout(this._current.timer);
      this._current.reject(error);
      this._current = null;
    }
    for (const job of this._queue.splice(0)) job.reject(error);
  }

  _send(...args) {
    if (!this.port?.isOpen) return Promise.reject(new Error('Icom LAN connection is not open'));
    return super._send(...args).catch((err) => {
      // No CI-V transaction IDs: end the association before a late ACK can
      // confirm another command. The process, not this driver, is restarted.
      if (/CI-V request timed out/.test(err.message)) this.session.fail(err);
      throw err;
    });
  }

  _handleData(chunk) {
    super._handleData(chunk);
    if (this._parser._buf.length > 4096) this.session.fail(new Error('Oversized Icom LAN CI-V frame'));
  }

  _handleFrame(frame) {
    if (frame.to !== this.controllerAddr && frame.to !== 0) return;
    if (this.radioAddr && frame.from !== this.radioAddr) return;
    super._handleFrame(frame);
  }

  assertSession(generation) {
    if (generation !== this.session.generation || !this.session.connected) throw new Error('Icom LAN connection closed');
  }

  queueSettings(operation) {
    const generation = this.session.generation;
    const result = this.settingsQueue.then(async () => {
      this.assertSession(generation);
      const value = await operation();
      this.assertSession(generation);
      return value;
    });
    this.settingsQueue = result.catch(() => {});
    return result;
  }

  async initialize() {
    this.radioAddr = this.options.radioAddr ?? this.session.advertisedAddress ?? 0;
    const identity = await this._send(0x19, 0);
    if (identity.cmd !== 0x19 || identity.data[0] !== MK2.id) throw new Error('LAN radio did not identify as an IC-7300MK2');
    this.radioAddr = identity.from;
    this.profile = MK2;
    await super.setPtt(false);
    const { mode } = await this.getMode();
    if (typeof mode !== 'string') throw new Error('Unknown radio mode during LAN initialization');
    if (mode === 'CW' || mode === 'CW_R') await super.stopCw();
    if (await this.getTransmitting()) throw new Error('Radio did not confirm receive during LAN initialization');
    try {
      for (const parameter of [MK2.afSelect, MK2.afSql]) {
        const old = await this.readParameter(parameter);
        if (old !== 0) {
          this.saveSetting(this.rxSaved, { parameter, value: 0 }, old);
          await this.writeParameter(parameter, 0);
        }
      }
      await this.refreshTimeout();
      this.prepared = true;
      this.session.confirmReady();
    } catch (err) {
      if (this.session.connected) await this.restore(this.rxSaved).catch(() => {});
      throw err;
    }
  }

  endCwBurst() {
    this.cwBurstUntil = -Infinity;
    this.lastTxCw = false;
  }

  async refreshTimeout() {
    let warning;
    this.timeoutCheckedAt = -Infinity;
    try {
      const value = await this.readParameter(MK2.timeout);
      if (!Number.isInteger(value) || value < 0 || value >= TIMEOUT_MINUTES.length) throw new Error('invalid value');
      this.timeoutMinutes = TIMEOUT_MINUTES[value];
      warning = value === 0 ? 'Radio CI-V time-out (0032) is OFF. LAN transmission is disabled; enable the radio time-out before transmitting.' : null;
      if (!warning) this.timeoutCheckedAt = performance.now();
    } catch (err) {
      if (!this.session.connected) throw err;
      this.timeoutMinutes = null;
      warning = 'Radio CI-V time-out (0032) could not be verified. LAN transmission is disabled; check the radio setting.';
    }
    if (warning !== this.timeoutWarning) {
      this.timeoutWarning = warning;
      this.emit('timeout-warning', warning);
    }
    return warning;
  }

  async requireTimeout() {
    if (!this.prepared || !this.session.connected) throw new Error('LAN radio is not ready');
    if (await this.refreshTimeout()) throw new Error(this.timeoutWarning);
  }

  async readParameter(parameter, level = false) {
    const frame = await this._send(0x1a, 5, Buffer.from(parameter));
    this._throwIfNG(frame, 'read LAN setting');
    if (frame.data.length !== (level ? 4 : 3) || frame.data[0] !== parameter[0] || frame.data[1] !== parameter[1]) {
      throw new Error('Unexpected IC-7300MK2 setting reply');
    }
    return level ? this._decodeMeterReply({ data: frame.data.subarray(2) }, 'LAN modulation level') : frame.data[2];
  }

  async writeParameter(parameter, value, level = false) {
    const bytes = level ? this._encodeMeterValue(value) : Buffer.from([value]);
    const frame = await this._send(0x1a, 5, Buffer.concat([Buffer.from(parameter), bytes]));
    this._throwIfNG(frame, 'set LAN audio setting');
    if (await this.readParameter(parameter, level) !== value) throw new Error('Radio did not confirm LAN audio setting');
  }

  saveSetting(saved, setting, old) {
    const i = saved.findIndex((entry) => entry.parameter[0] === setting.parameter[0] && entry.parameter[1] === setting.parameter[1]);
    if (i !== -1) {
      if (old === saved[i].value) return;
      saved.splice(i, 1);
    }
    saved.push({ ...setting, old });
  }

  async restore(saved) {
    const generation = this.session.generation;
    for (const entry of [...saved].reverse()) {
      this.assertSession(generation);
      const { parameter, value, old, level } = entry;
      if (await this.readParameter(parameter, level) === value) await this.writeParameter(parameter, old, level);
      this.assertSession(generation);
      saved.splice(saved.indexOf(entry), 1);
    }
  }

  /** True when a key-down can skip the 0032 and mode reads (see CW_BURST_MS). */
  inCwBurst() {
    const now = performance.now();
    return this.lastTxCw && now < this.cwBurstUntil && !this.timeoutWarning
      && now - this.timeoutCheckedAt < TIMEOUT_RECHECK_MS && this.prepared && this.session.connected;
  }

  async prepareTx(revision) {
    if (this.inCwBurst()) return;
    this.endCwBurst();
    await this.requireTimeout();
    if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
    const mode = (await this.getMode()).mode;
    if (mode === 'CW' || mode === 'CW_R') {
      this.lastTxCw = true;
      return;
    }
    if (mode === 'RTTY' || mode === 'RTTY_R') throw new Error('LAN audio TX requires an audio mode, not FSK RTTY');
    const parameter = await this.getDataMode() ? MK2.modData : MK2.modOff;
    const settings = [{ parameter, value: MK2.lanSource }];
    if (this.options.modLevel !== undefined) settings.push({ parameter: MK2.modLevel, value: this.options.modLevel, level: true });
    for (const setting of settings) {
      const old = await this.readParameter(setting.parameter, setting.level);
      if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
      if (old !== setting.value) {
        this.saveSetting(this.txSaved, setting, old);
        await this.writeParameter(setting.parameter, setting.value, setting.level);
      }
    }
  }

  setPtt(on, options = {}) {
    const revision = ++this.txRevision;
    return this.queueSettings(async () => {
      if (!on) {
        // Existing bridges keep their ALSA interface. Finish the already queued
        // tail, not future modem silence. restart()/abort flushes it promptly.
        // In CW the LAN audio is never keyed (below), so this returns at once.
        const epoch = this.playback.epoch;
        const drained = await this.playback.drain({ maxMs: this.options.drainTimeoutMs ?? 2000 });
        if (!drained && this.playback.epoch === epoch && this.playback.keyed && this.session.connected) {
          this.emit('error', new Error('LAN audio release deadline reached; remaining audio discarded to release PTT'));
        }
        this.playback.setKeyed(false);
        const result = await super.setPtt(false, options);
        if (this.lastTxCw) this.cwBurstUntil = performance.now() + CW_BURST_MS;
        await this.restore(this.txSaved).catch((err) => this.emit('error', err));
        return result;
      }
      try {
        if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
        this.playback.arm();
        await this.prepareTx(revision);
        if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
        await super.setPtt(true, options);
        if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
        // CW sends no audio. Keying the LAN audio would only make key-up
        // wait for the audio buffer to empty.
        this.playback.setKeyed(!this.lastTxCw);
        return true;
      } catch (err) {
        if (revision === this.txRevision && this.session.connected) {
          this.playback.setKeyed(false);
          try { await super.setPtt(false); await this.restore(this.txSaved); }
          catch (releaseError) { this.emit('error', releaseError); }
        }
        throw err;
      }
    });
  }

  async sendCw(text) {
    const revision = this.cwRevision;
    const generation = this.session.generation;
    await this.requireTimeout();
    this.assertSession(generation);
    if (revision !== this.cwRevision) throw new Error('CW request was cancelled');
    return super.sendCw(text);
  }

  stopCw() {
    ++this.cwRevision;
    this.session.serial?.invalidate('cw');
    return super.stopCw();
  }

  forcePttOff(...args) {
    this.endCwBurst();
    ++this.txRevision;
    ++this.cwRevision;
    ++this.tunerRevision;
    this.session.serial?.invalidate('cw');
    this.session.serial?.invalidate('tuner');
    this.playback.setKeyed(false);
    return super.forcePttOff(...args);
  }

  async setTuner(value) {
    if (value === 0 || value === 1) {
      ++this.tunerRevision;
      this.session.serial?.invalidate('tuner');
    }
    if (value === 2) {
      const revision = this.tunerRevision;
      const generation = this.session.generation;
      await this.requireTimeout();
      this.assertSession(generation);
      if (revision !== this.tunerRevision) throw new Error('Tuner request was cancelled');
    }
    return super.setTuner(value);
  }

  async getTransmitting() {
    const value = await this._readSingleByteSetting(0x1c, 0, 'transmit state');
    if (value !== 0 && value !== 1) throw new Error('Unknown IC-7300MK2 transmit state');
    if (value === 0) this.session.serial?.invalidate('cw');
    return value === 1;
  }

  _emitUnsolicited(frame) {
    if (frame.cmd === 0x27 && frame.subCmd === 0 && frame.data[1] === 1
      && (frame.data[3] === 0 || frame.data[3] === 2) && frame.data.length >= 15) {
      // MK2 LAN includes the out-of-range byte in Center mode too.
      frame = { ...frame, data: Buffer.concat([frame.data.subarray(0, 14), frame.data.subarray(15)]) };
    }
    super._emitUnsolicited(frame);
  }

  async close() {
    this.prepared = false;
    this.endCwBurst();
    ++this.txRevision;
    ++this.cwRevision;
    ++this.tunerRevision;
    this.session.serial?.invalidate('cw');
    this.session.serial?.invalidate('tuner');
    if (this.session.connected) {
      const { mode } = await this.getMode().catch(() => ({}));
      if (mode === 'CW' || mode === 'CW_R') await super.stopCw().catch(() => {});
      try { await this.setPtt(false); await this.restore(this.rxSaved); }
      catch (err) { this.emit('error', err); }
    }
    this._cancelPending(new Error('Icom LAN driver closing'));
    await this.session.close();
  }
}

module.exports = { IcomLanDriver, MK2, TIMEOUT_MINUTES, CW_BURST_MS, TIMEOUT_RECHECK_MS };
