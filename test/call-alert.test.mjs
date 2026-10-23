// Run with: node test/call-alert.test.mjs
//
// Tests src/client/call-alert.js (the FT8 "someone is calling you" chime
// rules). The client files are plain ESM; they are copied to a temporary
// folder marked "type": "module" so Node loads them as the browser does.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-alert-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
for (const f of ['call-alert.js', 'ft8-qso.js']) fs.copyFileSync(path.join(here, '..', 'src', 'client', f), path.join(dir, f));
let CallAlert;
let baseCall;
try {
  ({ CallAlert, baseCall } = await import(`file://${path.join(dir, 'call-alert.js')}`));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const m = (...texts) => texts.map((msg) => ({ msg }));
const SLOT = 15000;

check(baseCall('<VK3TR>') === 'VK3TR' && baseCall('VK3TR/P') === 'VK3TR' && baseCall('VK/G4ABC') === 'G4ABC' && baseCall('vk3tr') === 'VK3TR', 'callsigns are compared without <>, prefixes or suffixes, any case');
{
  const a = new CallAlert();
  check(a.check(m('CQ K1ABC FN42', 'JA1XYZ K1ABC -12', 'VK3TR VK3TR -01', 'hello there'), 0, 'VK3TR').length === 0, 'CQs, other QSOs, our own call and free text do not alert');
  check(a.check(m('VK3TR K1ABC FN42'), SLOT, 'VK3TR').join() === 'K1ABC', 'a station answering us alerts');
  check(a.check(m('VK3TR K1ABC R-10'), 3 * SLOT, 'VK3TR').length === 0, 'the same station carrying on does not alert again');
  check(a.check(m('<VK3TR> JA1XYZ PM95', 'VK3TR/P G4ABC IO91'), 4 * SLOT, 'VK3TR').join() === 'JA1XYZ,G4ABC', 'new callers alert, also to a hashed or portable form of our call');
  check(a.check(m('VK3TR K1ABC 73'), 4 * SLOT + 100000, 'VK3TR').length === 0, 'inside 2 minutes of their last message: still quiet');
  check(a.check(m('VK3TR K1ABC FN42'), 4 * SLOT + 100000 + 125000, 'VK3TR').join() === 'K1ABC', 'after more than 2 minutes without them, a new call alerts');
  check(a.check(m('VK3TR JA1XYZ PM95'), 4 * SLOT, 'VK3TR').length === 0, 'an old or repeated slot never re-arms a caller');
  check(a.check(m('VK3TR K1ABC FN42'), 50 * SLOT, '').length === 0, 'no callsign set: nothing alerts');
  a.reset();
  check(a.check(m('VK3TR K1ABC FN42'), 51 * SLOT, 'VK3TR').join() === 'K1ABC', 'reset() forgets everyone');
  check(a.check(m('VK3TR ... FN42', 'VK3TR <...> FN42'), 52 * SLOT, 'VK3TR').length === 0, 'an unresolved hashed sender does not alert');
  for (let i = 0; i < 500; i++) a.check(m(`VK3TR K${i}AA FN42`), (100 + i) * SLOT, 'VK3TR');
  check(a._last.size <= 20, `callers long gone are forgotten (${a._last.size} kept)`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall call alert tests passed');
