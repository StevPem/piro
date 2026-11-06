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
  constructor(civ, controlServer) {
    this.civ = civ;
    this.controlServer = controlServer;
    this.manual = false;
    this._task = null;
    this._connecting = false;
    this._closing = false;
    this._intent = 0;
    this._cancelOpen = null;
  }

  get ready() {
    return !this.manual && !this._connecting && !this._closing
      && this.civ.session.connected && this.civ.prepared;
  }

  publish(data, deliberate = false) {
    if (!deliberate && (this._closing || this.manual)) return;
    const status = { transport: 'lan', managed: true, manual: this.manual,
      radioAddr: this.civ.radioAddr, ...(this.civ.profile ? { model: this.civ.profile.name } : {}), ...data };
    this.controlServer.state.radioConnection = status;
    this.controlServer.broadcastJsonEvent('radio-connection', status);
  }

  setConnected(connected) {
    if (typeof connected !== 'boolean') throw new Error('"connected" must be a boolean');
    if (!connected && this.manual && !this._task && this.controlServer.state.radioConnection?.state === 'disconnected') {
      return this.controlServer.state.radioConnection;
    }
    // An already desired automatic connection may be retrying by itself.
    // Do not start a second association beside its pending retry timer.
    if (connected && !this.manual && !this.civ.session.stopped && this.civ.session.state !== 'failed') {
      return this.controlServer.state.radioConnection;
    }
    this.manual = !connected;
    ++this._intent;
    this.civ.manuallyDisconnected = !connected;
    if (!connected) {
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
          this.civ.capture.start();
          this.civ.playback.start();
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
function wireRadioConnection(civ, controlServer) {
  const manager = civ.session ? new RadioConnectionManager(civ, controlServer) : null;
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
