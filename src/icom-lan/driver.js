'use strict';

const { CivDriver } = require('../civ/driver');
const { IcomSession, CivLanTransport } = require('./session');

// IC-7300MK2 CI-V Reference Guide, printed page 9. Numbers are packed
// decimal menu identifiers, not offsets shared with the original IC-7300.
const MK2 = Object.freeze({ id: 0xb6, name: 'IC-7300MK2', afSelect: [0, 0x79], afSql: [0, 0x80],
  modLevel: [0, 0x83], modOff: [0, 0x84], modData: [0, 0x85], lanSource: 5 });

class IcomLanDriver extends CivDriver {
  constructor(options) {
    const session = new IcomSession({ ...options, deferReady: true });
    super({ transport: new CivLanTransport(session), radioAddr: options.radioAddr ?? 0,
      requestTimeoutMs: options.requestTimeoutMs ?? 2000 });
    this.session = session;
    this.options = options;
    this.capture = session.capture;
    this.playback = session.playback;
    this.txRevision = 0;
    this.pttQueue = Promise.resolve();
    this.prepared = false;
    this.rxSaved = [];
    this.txSaved = [];
    this.session.on('status', (status) => this.emit('connection-status', status));
    this.session.on('disconnected', () => {
      this.prepared = false;
      ++this.txRevision;
      this.emit('transport-lost');
    });
    this.session.on('connected', () => {
      if (!this.initialOpen) this.initialize().catch((err) => this.session.fail(err, false));
    });
    if (options.modLevel !== undefined && (!Number.isInteger(options.modLevel) || options.modLevel < 0 || options.modLevel > 255)) {
      throw new Error('ICOM_LAN_MOD_LEVEL must be an integer from 0 to 255');
    }
  }

  async open() {
    this.initialOpen = true;
    try {
      await super.open();
      await this.initialize();
    } catch (err) {
      // Roll back settings while this association is still reachable. Closing
      // first makes even a recoverable later initialization NG irreversible.
      await this.restore(this.rxSaved).catch((restoreError) => this.emit('restore-error', restoreError));
      await this.session.close();
      throw err;
    } finally { this.initialOpen = false; }
  }

  async initialize() {
    const generation = this.session.generation;
    this.prepared = false;
    this.emit('connection-status', { transport: 'lan', state: 'identifying' });
    this.radioAddr = this.options.radioAddr ?? 0;
    const frame = await this._send(0x19, 0);
    if (frame.cmd !== 0x19 || frame.data[0] !== MK2.id) throw new Error('LAN radio did not identify as an IC-7300MK2; model-specific audio settings were not applied');
    this.radioAddr = frame.from;
    this.profile = MK2;
    // Reconnection never resumes a transmission. Confirm the old keyer/PTT
    // state is stopped before accepting a new operator command.
    await super.stopCw();
    await super.setPtt(false);
    await this.restore(this.txSaved).catch((err) => this.emit('restore-error', err));
    // AF, not the 12 kHz IF stream; open squelch preserves decoder input.
    for (const parameter of [MK2.afSelect, MK2.afSql]) {
      const old = await this.readParameter(parameter);
      if (old !== 0) {
        if (!this.rxSaved.some((s) => s.parameter[1] === parameter[1])) this.rxSaved.push({ parameter, old, value: 0 });
        await this.writeParameter(parameter, 0);
      }
    }
    const radioState = { frequency: await this.getFrequency(), mode: await this.getMode(), dataMode: await this.getDataMode() };
    if (generation !== this.session.generation || !this.session.connected) throw new Error('Radio disconnected during initialization');
    this.radioState = radioState;
    this.prepared = true;
    this.emit('radio-ready', radioState);
    this.session.confirmReady();
    this.emit('connection-status', { transport: 'lan', state: 'connected', model: MK2.name, radioAddr: this.radioAddr });
  }

  async readParameter(parameter, level = false) {
    const frame = await this._send(0x1a, 5, Buffer.from(parameter));
    this._throwIfNG(frame, 'read LAN audio setting');
    const expected = level ? 4 : 3;
    if (frame.data.length !== expected || frame.data[0] !== parameter[0] || frame.data[1] !== parameter[1]) {
      throw new Error('Unexpected IC-7300MK2 LAN audio setting reply');
    }
    return level ? this._decodeMeterReply({ data: frame.data.subarray(2) }, 'LAN modulation level') : frame.data[2];
  }

  async writeParameter(parameter, value, level = false) {
    const bytes = level ? this._encodeMeterValue(value) : Buffer.from([value]);
    const frame = await this._send(0x1a, 5, Buffer.concat([Buffer.from(parameter), bytes]));
    this._throwIfNG(frame, 'set LAN audio setting');
    if (await this.readParameter(parameter, level) !== value) throw new Error('IC-7300MK2 did not confirm LAN audio setting');
  }

  async prepareTx(revision) {
    if (!this.prepared) throw new Error('LAN radio is not ready');
    const mode = (await this.getMode()).mode;
    // CW paddle/PTT has no modulation source. Typed CW uses sendCw instead.
    if (mode === 'CW' || mode === 'CW-R') return;
    if (mode === 'RTTY' || mode === 'RTTY-R') throw new Error('LAN audio TX requires an audio modulation mode, not FSK RTTY');
    const parameter = await this.getDataMode() ? MK2.modData : MK2.modOff;
    const settings = [{ parameter, value: MK2.lanSource, level: false }];
    if (this.options.modLevel !== undefined) settings.push({ parameter: MK2.modLevel, value: this.options.modLevel, level: true });
    for (const setting of settings) {
      if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
      const old = await this.readParameter(setting.parameter, setting.level);
      if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
      if (old !== setting.value) {
        if (!this.txSaved.some((entry) => entry.parameter[1] === setting.parameter[1])) this.txSaved.push({ ...setting, old });
        await this.writeParameter(setting.parameter, setting.value, setting.level);
      }
    }
    // The same guard applies to voice and every modem, because all PTT goes
    // through this driver rather than individual USB-specific bridges.
    if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
  }

  async restore(saved) {
    if (!this.session.connected) return;
    const errors = [];
    for (const entry of [...saved].reverse()) {
      const { parameter, value, old, level } = entry;
      try {
        // Preserve front-panel changes; retain failed records for another
        // release/reconnect attempt rather than forgetting their old values.
        if (await this.readParameter(parameter, level) === value) await this.writeParameter(parameter, old, level);
        saved.splice(saved.indexOf(entry), 1);
      } catch (err) { errors.push(err.message); }
    }
    if (errors.length) throw new Error(`Could not restore radio settings: ${errors.join('; ')}`);
  }

  setPtt(on) {
    const revision = ++this.txRevision;
    const generation = this.session.generation;
    // Cancel local audio immediately on release; serialize radio routing and
    // restoration so an older release cannot restore MIC after a newer key.
    if (!on) this.playback.setKeyed(false);
    const result = this.pttQueue.then(() => {
      if (generation !== this.session.generation) throw new Error('PTT belongs to a disconnected radio session');
      return this.transitionPtt(on, revision);
    });
    this.pttQueue = result.catch(() => {});
    return result;
  }

  async transitionPtt(on, revision) {
    if (!on) {
      this.playback.setKeyed(false);
      const result = await super.setPtt(false);
      // PTT was confirmed off independently of settings restoration. Report
      // restoration failure without leaving the server's TX state falsely on.
      await this.restore(this.txSaved).catch((err) => this.emit('restore-error', err));
      return result;
    }
    try {
      if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
      this.playback.arm();
      await this.prepareTx(revision);
      if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
      await super.setPtt(true);
      if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
      this.playback.setKeyed(true);
      return true;
    } catch (err) {
      if (revision === this.txRevision && this.session.connected) {
        this.playback.setKeyed(false);
        await super.setPtt(false).catch(() => {});
        await this.restore(this.txSaved).catch((restoreError) => this.emit('restore-error', restoreError));
      }
      throw err;
    }
  }

  async sendCw(text) {
    if (!this.prepared) throw new Error('LAN radio is not ready for CW');
    return super.sendCw(text);
  }

  finishCw() { this.session.serial?.invalidate('cw'); }

  _emitUnsolicited(frame) {
    if (frame.cmd === 0x27 && frame.subCmd === 0 && frame.data[1] === 1
      && (frame.data[3] === 0 || frame.data[3] === 2) && frame.data.length >= 15) {
      // MK2 LAN first division always includes the out-of-range byte, even
      // in Center mode. The legacy USB parser consumes it only in Fixed
      // mode. Normalize only this verified model/transport at the seam.
      frame = { ...frame, data: Buffer.concat([frame.data.subarray(0, 14), frame.data.subarray(15)]) };
    }
    super._emitUnsolicited(frame);
  }

  async close() {
    ++this.txRevision;
    this.playback.setKeyed(false);
    if (this.session.connected) {
      await this.stopCw().catch(() => {});
      await this.setPtt(false).catch(() => {});
      await this.restore(this.rxSaved).catch((err) => this.emit('restore-error', err));
    }
    return super.close();
  }
}

module.exports = { IcomLanDriver, MK2 };
