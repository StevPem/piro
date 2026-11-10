'use strict';

const { IcomLanDriver } = require('../icom-lan/driver');

function integer(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function createLanRadio(env = process.env) {
  let radioAddr;
  if (env.CIV_RADIO_ADDR) {
    if (!/^(?:0x)?[0-9a-f]{1,2}$/i.test(env.CIV_RADIO_ADDR)) throw new Error('CIV_RADIO_ADDR must be a hexadecimal CI-V address');
    radioAddr = parseInt(env.CIV_RADIO_ADDR.replace(/^0x/i, ''), 16);
    if (radioAddr < 1 || radioAddr >= 0xe0) throw new Error('CIV_RADIO_ADDR must be 01-DF');
  }
  return new IcomLanDriver({
    host: env.ICOM_LAN_HOST, username: env.ICOM_LAN_USERNAME, password: env.ICOM_LAN_PASSWORD,
    radioAddr, bindAddress: env.ICOM_LAN_BIND_ADDRESS,
    controlPort: integer(env, 'ICOM_LAN_CONTROL_PORT', 50001, 1, 65535),
    civPort: integer(env, 'ICOM_LAN_CIV_PORT', 50002, 1, 65535),
    audioPort: integer(env, 'ICOM_LAN_AUDIO_PORT', 50003, 1, 65535),
    timeoutMs: integer(env, 'ICOM_LAN_TIMEOUT_MS', 15000, 1000, 120000),
    jitterMs: integer(env, 'ICOM_LAN_JITTER_MS', 60, 20, 200),
    modLevel: integer(env, 'ICOM_LAN_MOD_LEVEL', undefined, 0, 255),
    sampleRate: integer(env, 'AUDIO_SAMPLE_RATE', 48000, 8000, 192000),
    channels: integer(env, 'AUDIO_CHANNELS', 1, 1, 2),
  });
}

module.exports = { createLanRadio };
