'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const DEFAULT_IDLE_MINUTES = 60;

function validIdleMinutes(minutes) {
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440;
}

function radioIdleSettingsPath(env = process.env) {
  if (env.RADIO_IDLE_SETTINGS_PATH === '') return null;
  return env.RADIO_IDLE_SETTINGS_PATH
    || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'piro', 'radio-connection.json');
}

function loadRadioIdleTimeout(file, warn = console.warn) {
  if (!file) return DEFAULT_IDLE_MINUTES;
  try {
    const { idleTimeoutMinutes } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validIdleMinutes(idleTimeoutMinutes)) throw new Error('Invalid idle timeout');
    return idleTimeoutMinutes;
  } catch (error) {
    if (error.code !== 'ENOENT') warn('Could not read radio idle settings; using the default 60 minutes.');
    return DEFAULT_IDLE_MINUTES;
  }
}

async function saveRadioIdleTimeout(file, minutes) {
  if (!validIdleMinutes(minutes)) throw new Error('Idle timeout must be an integer from 0 to 1440 minutes');
  if (!file) return;
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.promises.writeFile(temp, JSON.stringify({ idleTimeoutMinutes: minutes }, null, 2) + '\n', { mode: 0o600 });
    await fs.promises.rename(temp, file);
  } catch (error) {
    await fs.promises.unlink(temp).catch(() => {});
    throw error;
  }
}

module.exports = { DEFAULT_IDLE_MINUTES, validIdleMinutes, radioIdleSettingsPath, loadRadioIdleTimeout, saveRadioIdleTimeout };
