'use strict';

const { CivDriver, KNOWN_RADIO_ADDR } = require('../civ');
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
    baudRate: integer(env, 'CIV_BAUD_RATE', 19200, 300, 921600) });
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

// Uses the existing rig-error UI plus a structured status event/snapshot.
// No credential or token is ever put in browser state.
function wireRadioConnection(civ, controlServer) {
  const publish = (data) => {
    controlServer.state.radioConnection = data;
    controlServer.broadcastJsonEvent('radio-connection', data);
  };
  publish({ transport: civ.session ? 'lan' : 'usb', state: 'connected', radioAddr: civ.radioAddr,
    ...(civ.profile ? { model: civ.profile.name } : {}) });
  civ.on('connection-status', publish);
  civ.on('restore-error', (err) => controlServer.broadcastJsonEvent('rig-error', { message: err.message }));
  civ.on('transport-lost', () => {
    controlServer.state.ptt = null; // actual state is unknown while unreachable.
    controlServer.emit('radio-disconnected');
    controlServer.broadcastJsonEvent('rig-error', { message: 'Radio LAN connection lost. Transmission state is unknown; reconnect will not replay commands.' });
  });
  const ready = (radioState) => {
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
    controlServer.broadcastJsonEvent('ptt', { value: false });
    controlServer.emit('ptt', false);
  };
  civ.on('radio-ready', ready);
  if (civ.radioState) ready(civ.radioState);
}

module.exports = { createRadio, wireRadioConnection };
