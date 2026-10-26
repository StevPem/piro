// Run with: node test/meter-modes.test.mjs
//
// The meter's three displays (src/client/meter-modes.js: S-meter, SWR,
// ALC, their legends and readings) and the Mic gain (applyMicGain in
// src/client/audio.js), run in Node. The client files are ES modules in a
// "type": "commonjs" package, so they are copied into a temporary folder
// marked as ES modules first (as test/smeter.test.mjs does for one file).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = path.join(__dirname, '..', 'src', 'client');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'piro-meter-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
for (const f of ['meter-modes.js', 'smeter.js', 'vswr.js', 'audio.js', 'audio-codec.js']) fs.copyFileSync(path.join(client, f), path.join(tmp, f));

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

try {
  const m = await import(`file://${path.join(tmp, 'meter-modes.js')}`);
  const { applyMicGain } = await import(`file://${path.join(tmp, 'audio.js')}`);

  // cycling
  check(m.nextMeterMode('S') === 'SWR' && m.nextMeterMode('SWR') === 'ALC' && m.nextMeterMode('ALC') === 'S', 'tapping cycles S-meter -> SWR -> ALC -> S-meter');
  check(m.METER_TITLES.S === 'S-meter' && m.METER_TITLES.SWR === 'SWR' && m.METER_TITLES.ALC === 'ALC', 'titles');
  check(m.shownMeter('S', false) === 'S' && m.shownMeter('S', true) === 'SWR', 'S-meter mode shows SWR while transmitting');
  check(m.shownMeter('SWR', false) === 'SWR' && m.shownMeter('ALC', true) === 'ALC' && m.shownMeter('junk', false) === 'S', 'SWR and ALC stay as chosen; anything else is the S-meter');

  // legends
  const s = m.meterLegend('S');
  check(s.length === 16 && s[0] === 'S0' && s[9] === 'S9' && s[15] === '+60', `S-meter legend: ${s.join(' ')}`);
  const w = m.meterLegend('SWR');
  check(w.length === 16 && w[1] === '1.5' && w[3] === '2' && w[7] === '3' && w[15] === '5' && w[0] === '', `SWR legend: ${w.map((x) => x || '.').join(' ')}`);
  const a = m.meterLegend('ALC');
  check(a.length === 16 && a[7] === '50%' && a[15] === '100%' && a[0] === '', `ALC legend: ${a.map((x) => x || '.').join(' ')}`);

  // readings
  const lit = (r) => r.segments.filter(Boolean).length;
  const s9 = m.meterReading('S', 126);
  check(s9.text === 'S9' && lit(s9) === 10 && s9.segments.slice(0, 10).every((c) => c === 'green'), 'S9: ten green segments');
  const s40 = m.meterReading('S', 211);
  check(s40.text === 'S9 + 40dB' && lit(s40) === 14 && s40.segments[13] === 'red' && s40.segments[9] === 'green', 'S9+40: red over S9');
  const swr15 = m.meterReading('SWR', 48);
  check(swr15.text === 'SWR 1.5' && lit(swr15) === 2 && swr15.segments[0] === 'green', `SWR 1.5: two green segments, up to the "1.5" label`);
  const swr2 = m.meterReading('SWR', 80);
  check(swr2.text === 'SWR 2.0' && lit(swr2) === 4 && swr2.segments[0] === 'amber', 'SWR 2.0: four amber segments, up to "2"');
  const swr5 = m.meterReading('SWR', 255);
  check(swr5.text === 'SWR 5.0' && lit(swr5) === 16 && swr5.segments[15] === 'red', 'SWR 5.0: all red');
  check(m.alcPercent(0) === 0 && m.alcPercent(60) === 50 && m.alcPercent(120) === 100 && m.alcPercent(180) === 150, 'ALC percent of the 0-120 scale');
  const alc50 = m.meterReading('ALC', 60);
  check(alc50.text === 'ALC 50%' && lit(alc50) === 8 && alc50.segments[7] === 'green', 'ALC 50%: eight green segments, up to the "50%" label');
  const alc0 = m.meterReading('ALC', 0);
  check(alc0.text === 'ALC 0%' && lit(alc0) === 0, 'ALC 0%: nothing lit');
  const alcOver = m.meterReading('ALC', 200);
  check(lit(alcOver) === 16 && alcOver.segments[0] === 'red', 'ALC over the scale: all red');

  // Mic gain
  const x = new Int16Array([1000, -1000, 10000, 20000, -30000, 32767, 0]);
  const same = applyMicGain(x, 1);
  check([...same].slice(0, 3).join() === '1000,-1000,10000', '0 dB leaves quiet audio unchanged');
  const up6 = applyMicGain(x, 10 ** (6 / 20));
  check(Math.abs(up6[0] - 1995) <= 1 && Math.abs(up6[2] - 19953) <= 1, `+6 dB doubles quiet audio (${up6[0]}, ${up6[2]})`);
  check(up6[3] > 26214 && up6[3] < 32768 && up6[4] >= -32768 && up6[4] < -32000, `+6 dB rounds off peaks instead of wrapping (${up6[3]}, ${up6[4]})`);
  const up20 = applyMicGain(x, 10);
  check([...up20].every((v, i) => Math.abs(v) <= 32767 || v === -32768) && up20[3] > 32000 && up20[6] === 0, '+20 dB: stays within full scale, silence stays silent');
  const down10 = applyMicGain(x, 10 ** (-10 / 20));
  check(Math.abs(down10[2] - 3162) <= 1 && Math.abs(down10[5] - 10362) <= 1, `-10 dB scales down (${down10[2]}, ${down10[5]})`);
  let monotonic = true;
  let prev = -Infinity;
  for (let v = -32768; v <= 32767; v += 64) {
    const y = applyMicGain(new Int16Array([v]), 10)[0];
    if (y < prev) monotonic = false;
    prev = y;
  }
  check(monotonic, 'the gain curve never folds back, even at +20 dB');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll meter and mic gain checks passed.');
process.exit(failures ? 1 : 0);
