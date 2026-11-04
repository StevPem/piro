'use strict';

// Run with: node test/key-line.test.js
// CW_KEY_LINE parsing, and the scripts run by hand finding it (src/civ/key-line.js).

const fs = require('fs');
const path = require('path');
const { parseKeyLine, envFileValue, scriptKeyLine } = require('../src/civ/key-line');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

// parseKeyLine
for (const [v, line, valid] of [
  ['dtr', 'dtr', true],
  ['RTS', 'rts', true],
  [' "dtr" ', 'dtr', true],
  ['off', null, true],
  ['none', null, true],
  ['', null, true],
  [undefined, null, true],
  ['cts', null, false],
  ['yes', null, false],
]) {
  const r = parseKeyLine(v);
  check(r.line === line && r.valid === valid, `parseKeyLine(${JSON.stringify(v)}) -> ${line} (${valid ? 'valid' : 'not valid'})`);
}

// envFileValue
const file = `# PiRO settings
CIV_SERIAL_PATH=/dev/ttyUSB0
#CW_KEY_LINE=rts
export CW_PADDLE_DELAY_MS=200
CW_KEY_LINE="dtr"
`;
check(envFileValue(file, 'CW_KEY_LINE') === '"dtr"', 'reads a setting from an env file, skipping a commented-out one');
check(envFileValue(file, 'CW_PADDLE_DELAY_MS') === '200', 'an "export" line is read too');
check(envFileValue(file, 'SOURCE_CODE_URL') === undefined, 'a setting not in the file is undefined');
check(envFileValue('CW_KEY_LINE=rts\nCW_KEY_LINE=dtr\n', 'CW_KEY_LINE') === 'dtr', 'the last one wins, as systemd does');

// scriptKeyLine: where a script run by hand finds it
const readFrom = (text) => () => text;
const noFile = () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};
let r = scriptKeyLine({ env: {}, readFile: readFrom(file) });
check(r.line === 'dtr' && /DTR \(from \/etc\/piro\/piro.env\), dropped/.test(r.message), `not in the shell's environment: read from /etc/piro/piro.env (${r.message})`);
r = scriptKeyLine({ env: { CW_KEY_LINE: 'rts' }, readFile: readFrom(file) });
check(r.line === 'rts' && /from CW_KEY_LINE/.test(r.message), 'CW_KEY_LINE in the environment wins over the file');
r = scriptKeyLine({ env: { CW_KEY_LINE: 'off' }, readFile: readFrom(file) });
check(r.line === null && /none \(from CW_KEY_LINE\)/.test(r.message), 'CW_KEY_LINE=off in the environment wins too');
r = scriptKeyLine({ env: {}, readFile: noFile });
check(r.line === null && /not set/.test(r.message), `no env file: no key line, the serial lines left alone (${r.message})`);
r = scriptKeyLine({ env: {}, readFile: readFrom('CIV_BAUD_RATE=19200\n') });
check(r.line === null, 'an env file without CW_KEY_LINE: no key line');
r = scriptKeyLine({ env: { CW_KEY_LINE: 'cts' } });
check(r.line === null && /not dtr, rts or off/.test(r.message), 'a bad value is reported, and no line is touched');

// Every program that opens the radio's real serial port drops the key line.
// (Tests that pass a fake `transport` don't open a port.)
const root = path.join(__dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.js')).map((f) => path.join('test', f)),
  'src/server/index.js',
];
const opening = files.filter((f) => {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  return /new CivDriver\(\{[^}]*\bpath\b/.test(text) && !/new CivDriver\(\{[^}]*\btransport\b/.test(text);
});
check(opening.length >= 7, `found the programs that open the port (${opening.length}: ${opening.map((f) => path.basename(f)).join(', ')})`);
for (const f of opening) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  const passes = /new CivDriver\(\{[^}]*\bkeyLine\b/.test(text);
  const finds = f.startsWith('test/') ? /scriptKeyLine\(\)/.test(text) : /CW_KEY_LINE/.test(text);
  check(passes && finds, `${f} finds the key line and passes it to CivDriver`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('\nAll key line tests passed.');
