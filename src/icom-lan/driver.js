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
    this.settingsQueue = Promise.resolve();
    this.prepared = false;
    this.rxSaved = [];
    this.txSaved = [];
    this.radioState = {};
    this.stateRevision = { frequency: 0, mode: 0, dataMode: 0 };
    for (const [event, key] of [['frequency', 'frequency'], ['mode', 'mode'], ['data-mode', 'dataMode']]) {
      this.on(event, (value) => {
        this.radioState[key] = value;
        ++this.stateRevision[key];
      });
    }
    this.session.on('status', (status) => this.emit('connection-status', status));
    this.session.on('disconnected', () => {
      this.prepared = false;
      ++this.txRevision;
      this.emit('transport-lost');
    });
    this.session.on('connected', () => {
      const generation = this.session.generation;
      if (!this.initialOpen) this.initialize().catch((err) => {
        if (generation === this.session.generation) this.session.fail(err, false);
      });
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
      await this.session.close();
      throw err;
    } finally { this.initialOpen = false; }
  }

  assertSession(generation) {
    if (generation !== this.session.generation || !this.session.connected) {
      throw new Error('Operation belongs to a disconnected radio session');
    }
  }

  queueSettings(operation) {
    const generation = this.session.generation;
    const result = this.settingsQueue.then(async () => {
      this.assertSession(generation);
      const value = await operation(generation);
      this.assertSession(generation);
      return value;
    });
    this.settingsQueue = result.catch(() => {});
    return result;
  }

  initialize() {
    this.prepared = false;
    return this.queueSettings(async (generation) => {
      let identified = false;
      try {
        this.emit('connection-status', { transport: 'lan', state: 'identifying' });
        // Direct-radio LAN sessions advertise the configured CI-V address.
        // Some physical radios ignore broadcast identity reads; use that
        // address for discovery, then verify the actual model independently.
        // Explicit configuration still wins, including after reconnect.
        const advertised = this.session.advertisedAddress;
        this.radioAddr = this.options.radioAddr
          ?? (Number.isInteger(advertised) && advertised > 0 && advertised < 0xe0 ? advertised : 0);
        const frame = await this._send(0x19, 0);
        if (frame.cmd !== 0x19 || frame.data[0] !== MK2.id) throw new Error('LAN radio did not identify as an IC-7300MK2; model-specific audio settings were not applied');
        identified = true;
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
            this.saveSetting(this.rxSaved, { parameter, value: 0 }, old);
            await this.writeParameter(parameter, 0);
          }
        }
        for (const [key, read] of [['frequency', () => this.getFrequency()],
          ['mode', () => this.getMode()], ['dataMode', () => this.getDataMode()]]) {
          const revision = this.stateRevision[key];
          const value = await read();
          // A transceive notification or confirmed local change received
          // during the read is newer than its reply. Keep that observation.
          if (revision === this.stateRevision[key]) this.radioState[key] = value;
        }
        this.assertSession(generation);
        this.prepared = true;
        this.emit('radio-ready', { ...this.radioState });
        this.session.confirmReady();
        this.emit('connection-status', { transport: 'lan', state: 'connected', model: MK2.name, radioAddr: this.radioAddr });
      } catch (err) {
        this.prepared = false;
        // Initial open and reconnect share rollback. Keep the verified
        // association open until its changed RX settings are restored.
        if (identified && generation === this.session.generation && this.session.connected) {
          await this.restore(this.rxSaved).catch((restoreError) => this.emit('restore-error', restoreError));
        }
        throw err;
      }
    });
  }

  async setDataMode(on, filter) {
    const result = await super.setDataMode(on, filter);
    this.emit('data-mode', on);
    return result;
  }

  async setFrequency(hz) {
    const result = await super.setFrequency(hz);
    this.emit('frequency', hz);
    return result;
  }

  saveSetting(saved, setting, old) {
    const index = saved.findIndex((entry) => entry.parameter[0] === setting.parameter[0]
      && entry.parameter[1] === setting.parameter[1]);
    if (index !== -1) {
      if (old === saved[index].value) return; // Still our previous override.
      saved.splice(index, 1); // The operator chose a new baseline meanwhile.
    }
    saved.push({ ...setting, old });
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
        this.saveSetting(this.txSaved, setting, old);
        await this.writeParameter(setting.parameter, setting.value, setting.level);
      }
    }
    // The same guard applies to voice and every modem, because all PTT goes
    // through this driver rather than individual USB-specific bridges.
    if (revision !== this.txRevision) throw new Error('PTT request was cancelled');
  }

  async restore(saved) {
    if (!this.session.connected) return;
    const generation = this.session.generation;
    const errors = [];
    for (const entry of [...saved].reverse()) {
      const { parameter, value, old, level } = entry;
      try {
        // Preserve front-panel changes; retain failed records for another
        // release/reconnect attempt rather than forgetting their old values.
        this.assertSession(generation);
        if (await this.readParameter(parameter, level) === value) await this.writeParameter(parameter, old, level);
        this.assertSession(generation);
        const index = saved.indexOf(entry);
        if (index !== -1) saved.splice(index, 1);
      } catch (err) { errors.push(err.message); }
    }
    if (errors.length) throw new Error(`Could not restore radio settings: ${errors.join('; ')}`);
  }

  setPtt(on) {
    const revision = ++this.txRevision;
    // Cancel local audio immediately on release; serialize radio routing and
    // restoration so an older release cannot restore MIC after a newer key.
    if (!on) this.playback.setKeyed(false);
    return this.queueSettings(() => this.transitionPtt(on, revision));
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
      await this.queueSettings(() => this.restore(this.rxSaved)).catch((err) => this.emit('restore-error', err));
    }
    return super.close();
  }
}

module.exports = { IcomLanDriver, MK2 };
