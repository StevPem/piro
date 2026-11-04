'use strict';

const fs = require('fs');

/**
 * Which serial line keys CW (CW_KEY_LINE): 'dtr', 'rts' or null (none).
 * See CivDriver's keyLine option and docs/civ-notes.md.
 */

const ENV_FILE = '/etc/piro/piro.env';

/** "dtr" / "RTS" / "off" / "" -> {line, valid}. Anything else is not valid (line null). */
function parseKeyLine(value) {
  const v = String(value ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase();
  if (v === '' || v === 'off' || v === 'none') return { line: null, valid: true };
  if (v === 'dtr' || v === 'rts') return { line: v, valid: true };
  return { line: null, valid: false };
}

/** NAME's value in an env file (NAME=value lines, # comments), or undefined if it isn't set there. */
function envFileValue(text, name) {
  let found;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === name) found = m[2]; // the last one wins, as systemd does
  }
  return found;
}

/**
 * The key line for a script run by hand (test/manual-*.js), which isn't
 * started by systemd and so doesn't see /etc/piro/piro.env. Without this,
 * opening the port would leave the line Linux raised on open high for the
 * whole run: with the radio's USB Keying (CW) on that line, in CW with
 * break-in on, a steady carrier. CW_KEY_LINE from the environment wins;
 * otherwise it is read from the env file. Returns {line, message}.
 */
function scriptKeyLine({ env = process.env, envFile = ENV_FILE, readFile = fs.readFileSync } = {}) {
  let value;
  let source;
  if (env.CW_KEY_LINE !== undefined) {
    value = env.CW_KEY_LINE;
    source = 'CW_KEY_LINE';
  } else {
    try {
      value = envFileValue(readFile(envFile, 'utf8'), 'CW_KEY_LINE');
      source = envFile;
    } catch {
      value = undefined; // no env file (not installed as a service, or not readable)
    }
  }
  const { line, valid } = parseKeyLine(value);
  let message;
  if (!valid) message = `CW key line: "${value}" (from ${source}) is not dtr, rts or off; leaving the serial lines alone.`;
  else if (line) message = `CW key line: ${line.toUpperCase()} (from ${source}), dropped as soon as the port opens.`;
  else if (value !== undefined) message = `CW key line: none (from ${source}).`;
  else message = `CW key line: none (CW_KEY_LINE not set${readFile ? `, nor in ${envFile}` : ''}).`;
  return { line, message };
}

module.exports = { parseKeyLine, envFileValue, scriptKeyLine, ENV_FILE };
