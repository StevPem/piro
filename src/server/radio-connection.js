'use strict';

const { CivDriver, KNOWN_RADIO_ADDR, parseKeyLine } = require('../civ');
const { IcomLanDriver } = require('../icom-lan/driver');

function integer(env, name, fallback, min, max) {
  if (env[name] === undefined || env[name] === '') return fallback;
  if (!/^\d+$/.test(env[name])) throw new Error(`${name} must be an integer`);
  const n = Number(env[name]);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}-${max}`);
  return n;
}

function createRadio(env = process.env) {
  const connection = (env.CIV_CONNECTION || 'usb').toLowerCase();
  if (!['usb', 'lan'].includes(connection)) throw new Error('CIV_CONNECTION must be usb or lan');
  let radioAddr;
  if (env.CIV_RADIO_ADDR) {
    if (!/^(?:0x)?[0-9a-f]{1,2}$/i.test(env.CIV_RADIO_ADDR)) throw new Error('CIV_RADIO_ADDR must be a hexadecimal CI-V address');
    radioAddr = parseInt(env.CIV_RADIO_ADDR.replace(/^0x/i, ''), 16);
    if (radioAddr < 1 || radioAddr >= 0xe0) throw new Error('CIV_RADIO_ADDR must be 01-DF');
  }
  if (connection === 'usb') return new CivDriver({ path: env.CIV_SERIAL_PATH || '/dev/ttyUSB0',
    radioAddr: radioAddr ?? KNOWN_RADIO_ADDR[env.CIV_RADIO_MODEL],
    baudRate: integer(env, 'CIV_BAUD_RATE', 19200, 300, 921600),
    keyLine: parseKeyLine(env.CW_KEY_LINE).line });
  return new IcomLanDriver({ host: env.ICOM_LAN_HOST, username: env.ICOM_LAN_USERNAME, password: env.ICOM_LAN_PASSWORD,
    radioAddr, bindAddress: env.ICOM_LAN_BIND_ADDRESS,
    controlPort: integer(env, 'ICOM_LAN_CONTROL_PORT', 50001, 1, 65535),
    civPort: integer(env, 'ICOM_LAN_CIV_PORT', 50002, 1, 65535),
    audioPort: integer(env, 'ICOM_LAN_AUDIO_PORT', 50003, 1, 65535),
    reconnectAttempts: integer(env, 'ICOM_LAN_RECONNECT_ATTEMPTS', 5, 0, 20),
    timeoutMs: integer(env, 'ICOM_LAN_TIMEOUT_MS', 15000, 1000, 120000),
    jitterMs: integer(env, 'ICOM_LAN_JITTER_MS', 60, 20, 200),
    modLevel: integer(env, 'ICOM_LAN_MOD_LEVEL', undefined, 0, 255),
    sampleRate: integer(env, 'AUDIO_SAMPLE_RATE', 48000, 8000, 192000),
    channels: integer(env, 'AUDIO_CHANNELS', 1, 1, 2),
  });
}

// Keeps deliberate disconnection separate from an interrupted LAN session.
// The latest requested state wins; a pending open can always be cancelled.
class RadioConnectionManager {
  constructor(civ, controlServer, { idleTimeoutMinutes = 60, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, saveIdleTimeout } = {}) {
    this.civ = civ;
    this.controlServer = controlServer;
    this.manual = false;
    this._task = null;
    this._connecting = false;
    this._closing = false;
    this._intent = 0;
    this._cancelOpen = null;
    this._validateIdleTimeout(idleTimeoutMinutes);
    this.idleTimeoutMinutes = idleTimeoutMinutes;
    this._now = now;
    this._setIdleTimer = setTimer;
    this._clearIdleTimer = clearTimer;
    this._saveIdleTimeout = saveIdleTimeout;
    this._settingsTask = Promise.resolve();
    this._lastActivityAt = now();
    this._idleTimer = null;
    this._idleProbe = null;
    this._idleStopped = false;
    this._wasBusy = false;
    this._transmitting = { ptt: false, cw: false };
    this._disconnectReason = null;
    this._onPttActivity = (active) => this._transmitActivity('ptt', active);
    this._onCwActivity = (active) => this._transmitActivity('cw', active);
    controlServer.on('ptt', this._onPttActivity);
    controlServer.on('cw-keying', this._onCwActivity);
  }

  get ready() {
    return !this.manual && !this._connecting && !this._closing
      && this.civ.session.connected && this.civ.prepared;
  }

  _validateIdleTimeout(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      throw new Error('"minutes" must be an integer from 0 to 1440 (0 disables idle disconnect)');
    }
  }

  get idleDisconnectAt() {
    return this.ready && !this._idleStopped && this.idleTimeoutMinutes > 0
      ? this._lastActivityAt + this.idleTimeoutMinutes * 60000 : null;
  }

  async setIdleTimeout(minutes) {
    this._validateIdleTimeout(minutes);
    // Saving settings is operator intent too. Protect the link while the
    // persistence callback is pending, not only once that write completes.
    this.recordActivity();
    const task = this._settingsTask.then(async () => {
      // Do not publish a setting that could not be saved. Serialize writes so
      // two browsers cannot let an older slow save replace the latest choice.
      if (this._saveIdleTimeout) await this._saveIdleTimeout(minutes);
      this.idleTimeoutMinutes = minutes;
      if (this.ready) this._lastActivityAt = this._now();
      this.publish({ ...this.controlServer.state.radioConnection }, true);
      return this.controlServer.state.radioConnection;
    });
    this._settingsTask = task.catch(() => {});
    return task;
  }

  recordActivity() {
    if (!this.ready || this._idleStopped || this.idleTimeoutMinutes === 0) return this.controlServer.state.radioConnection;
    this._lastActivityAt = this._now();
    this.publish({ ...this.controlServer.state.radioConnection }, true);
    return this.controlServer.state.radioConnection;
  }

  _transmitActivity(kind, active) {
    if (typeof active !== 'boolean' || active === this._transmitting[kind]) return;
    this._transmitting[kind] = active;
    // A repeated synthetic PTT-off notification on reconnect is not usage.
    // Real start/end transitions give operators a fresh idle interval.
    this.recordActivity();
  }

  _busy() {
    const cs = this.controlServer;
    return cs.state.ptt === true || cs.state.ptt === null || cs.state.cwKeying === true
      || Boolean(cs.cwTxBusy?.()) || Boolean(cs.radioTxBusy?.());
  }

  _stopIdleCheck() {
    if (this._idleTimer !== null) this._clearIdleTimer(this._idleTimer);
    this._idleTimer = null;
  }

  _armIdleCheck() {
    this._stopIdleCheck();
    const deadline = this.idleDisconnectAt;
    if (this.controlServer.state.radioConnection) {
      this.controlServer.state.radioConnection.idleDisconnectAt = deadline;
    }
    if (deadline === null || this._idleProbe) return;
    this._idleTimer = this._setIdleTimer(() => {
      this._idleTimer = null;
      this.checkIdle();
    }, Math.max(1, Math.min(1000, deadline - this._now())));
    this._idleTimer?.unref?.();
  }

  checkIdle() {
    this._stopIdleCheck();
    if (this.idleDisconnectAt === null) return false;
    const now = this._now();
    if (this._busy()) {
      this._lastActivityAt = now;
      this._wasBusy = true;
      // Keep fresh-client snapshots accurate without sending status each tick.
      if (this.controlServer.state.radioConnection) {
        this.controlServer.state.radioConnection.idleDisconnectAt = this.idleDisconnectAt;
      }
    } else if (this._wasBusy) {
      this._wasBusy = false;
      this._lastActivityAt = now;
      this.publish({ ...this.controlServer.state.radioConnection }, true);
      return false;
    } else if (now >= this.idleDisconnectAt) {
      // Front-panel/keyer transmission may not have produced a browser PTT
      // event. Confirm receive through the bounded CI-V read before closing.
      if (typeof this.civ.getTransmitting === 'function') {
        this._confirmIdleReceive();
        return false;
      }
      this.setConnected(false, { reason: 'idle' });
      return true;
    }
    this._armIdleCheck();
    return false;
  }

  _confirmIdleReceive() {
    if (this._idleProbe) return;
    const intent = this._intent;
    const generation = this.civ.session.generation;
    const activityAt = this._lastActivityAt;
    const minutes = this.idleTimeoutMinutes;
    const current = () => this.idleDisconnectAt !== null && this._intent === intent
      && this.civ.session.generation === generation && this._lastActivityAt === activityAt
      && this.idleTimeoutMinutes === minutes && this._now() >= this.idleDisconnectAt;
    const defer = () => {
      // No confirmed receive means no idle release. Grant another interval
      // without noisy broadcasts or repeatedly probing an already expired time.
      this._lastActivityAt = this._now();
    };
    this._idleProbe = Promise.resolve().then(() => {
      if (current()) return this.civ.getTransmitting();
      return null;
    }).then((transmitting) => {
      if (!current()) return;
      if (transmitting !== false || this._busy()) {
        defer();
        return;
      }
      this.setConnected(false, { reason: 'idle' });
    }).catch(() => {
      if (current()) defer();
    }).finally(() => {
      this._idleProbe = null;
      this._armIdleCheck();
    });
  }

  stopIdleTimer() {
    this._idleStopped = true;
    this._stopIdleCheck();
    this.controlServer.off('ptt', this._onPttActivity);
    this.controlServer.off('cw-keying', this._onCwActivity);
  }

  publish(data, deliberate = false) {
    if (!deliberate && (this._closing || this.manual)) return;
    const status = { ...data, transport: 'lan', managed: true, manual: this.manual,
      radioAddr: this.civ.radioAddr, ...(this.civ.profile ? { model: this.civ.profile.name } : {}),
      idleTimeoutMinutes: this.idleTimeoutMinutes, idleDisconnectAt: this.idleDisconnectAt,
      disconnectReason: this._disconnectReason };
    if (this._disconnectReason === 'idle' && ['disconnecting', 'disconnected'].includes(status.state)) {
      status.message = 'Disconnected after inactivity.';
    }
    this.controlServer.state.radioConnection = status;
    this.controlServer.broadcastJsonEvent('radio-connection', status);
    this._armIdleCheck();
  }

  setConnected(connected, { reason = 'manual' } = {}) {
    if (typeof connected !== 'boolean') throw new Error('"connected" must be a boolean');
    if (!connected && this.manual && !this._task && this.controlServer.state.radioConnection?.state === 'disconnected') {
      return this.controlServer.state.radioConnection;
    }
    // An already desired automatic connection may be retrying by itself.
    // Do not start a second association beside its pending retry timer.
    if (connected && !this.manual && !this.civ.session.stopped && this.civ.session.state !== 'failed') {
      this.recordActivity();
      return this.controlServer.state.radioConnection;
    }
    this.manual = !connected;
    this._disconnectReason = connected ? null : reason;
    if (connected) this._lastActivityAt = this._now();
    ++this._intent;
    this.civ.manuallyDisconnected = !connected;
    if (!connected) {
      this._stopIdleCheck();
      // Stop retrying immediately, while retaining the association long enough
      // for close() to stop CW/PTT and restore the radio's input settings.
      this.civ.session.stopped = true;
      clearTimeout(this.civ.session.retryTimer);
      this.civ.prepared = false;
      this.controlServer.state.ptt = null;
      this.controlServer._pttOwner = null;
      this.controlServer._armOrClearPttWatchdog?.(false);
      this.controlServer.emit('radio-disconnected');
      this.publish({ state: 'disconnecting' }, true);
      // Authenticated initialization checks the manual flag between complete
      // CI-V transactions, preserving ACK correlation and rolling settings
      // back before close. A handshake has no settings to restore.
      if (this._connecting && !this.civ.session.connected) {
        this._cancelOpen = this.civ.session.close().catch((err) => this.controlServer.broadcastJsonEvent('rig-error', { message: err.message }));
      }
    }
    this._start();
    return this.controlServer.state.radioConnection;
  }

  _start() {
    if (this._task) return;
    this._task = this._reconcile().catch((err) => {
      this.publish({ state: 'failed', message: err.message }, true);
    }).finally(() => {
      this._task = null;
      this._armIdleCheck();
      const state = this.controlServer.state.radioConnection?.state;
      if ((this.manual && !['disconnected', 'failed'].includes(state)) || (!this.manual && state === 'disconnected')) this._start();
    });
  }

  async _reconcile() {
    while (true) {
      if (this._cancelOpen) {
        await this._cancelOpen;
        this._cancelOpen = null;
      }
      if (this.manual) {
        this._closing = true;
        try { await this.civ.close(); }
        finally { this._closing = false; }
        this.civ.prepared = false;
        this.publish({ state: 'disconnected' }, true);
        if (this.manual) return;
      } else {
        if (this.civ.session.connected && this.civ.prepared) {
          this.civ.session.stopped = false;
          this.civ.capture.start();
          this.civ.playback.start();
          this._lastActivityAt = this._now();
          this.publish({ state: 'connected' }, true);
          return;
        }
        this._connecting = true;
        const intent = this._intent;
        this.civ.session.attempts = 0;
        this.publish({ state: 'connecting' }, true);
        try {
          await this.civ.open();
          if (intent !== this._intent) continue;
          if (this.manual) continue;
          this._connecting = false;
          this.civ.capture.start();
          this.civ.playback.start();
          this._lastActivityAt = this._now();
          this.publish({ state: 'connected' }, true);
        } catch (err) {
          if (intent !== this._intent) continue;
          if (!this.manual) { this.publish({ state: 'failed', message: err.message }, true); return; }
        } finally { this._connecting = false; }
        if (!this.manual) return;
      }
    }
  }
}

// Uses the existing rig-error UI plus a structured status event/snapshot.
// No credential or token is ever put in browser state.
function wireRadioConnection(civ, controlServer, options = {}) {
  const manager = civ.session ? new RadioConnectionManager(civ, controlServer, options) : null;
  controlServer.radioConnectionManager = manager;
  const publish = (data) => {
    if (manager) { manager.publish(data); return; }
    controlServer.state.radioConnection = data;
    controlServer.broadcastJsonEvent('radio-connection', data);
  };
  publish({ transport: civ.session ? 'lan' : 'usb', state: 'connected', radioAddr: civ.radioAddr,
    ...(civ.profile ? { model: civ.profile.name } : {}) });
  civ.on('connection-status', publish);
  civ.on('restore-error', (err) => controlServer.broadcastJsonEvent('rig-error', { message: err.message }));
  civ.on('data-mode', (on) => {
    controlServer.state.dataMode = on;
    controlServer.broadcastJsonEvent('data-mode', { on });
  });
  civ.on('transport-lost', () => {
    controlServer.state.ptt = null; // actual state is unknown while unreachable.
    controlServer.emit('radio-disconnected');
    controlServer.broadcastJsonEvent('rig-error', { message: 'Radio LAN connection lost. Transmission state is unknown; reconnect will not replay commands.' });
  });
  const ready = (radioState) => {
    if (manager?.manual) return;
    controlServer.state.radioAddr = civ.radioAddr;
    if (radioState) {
      controlServer.state.frequency = radioState.frequency;
      controlServer.state.mode = radioState.mode;
      controlServer.state.dataMode = radioState.dataMode;
      // Driver events also notify mode-driven decoders and the ordinary
      // ControlServer broadcast paths, not only the reconnecting browser.
      civ.emit('frequency', radioState.frequency);
      civ.emit('mode', radioState.mode);
      controlServer.broadcastJsonEvent('data-mode', { on: radioState.dataMode });
    }
    controlServer.state.ptt = false; // initialize() confirmed PTT off.
    controlServer._pttOwner = null;
    controlServer._armOrClearPttWatchdog?.(false);
    controlServer.broadcastJsonEvent('ptt', { value: false });
    controlServer.emit('ptt', false);
  };
  civ.on('radio-ready', ready);
  if (civ.radioState) ready(civ.radioState);
  return manager;
}

module.exports = { createRadio, wireRadioConnection, RadioConnectionManager };
