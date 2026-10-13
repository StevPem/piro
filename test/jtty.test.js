// Run with: node test/jtty.test.js
//
// Checks the JTTY transmit port (src/audio/jtty-codec.js, src/audio/jtty-tx.js)
// against the WSJT-X reference implementation:
//   - the representative 34-bit source vectors from the canonical spec
//     (lib/jtty/jtty_source_encoding.txt),
//   - 400+ messages (all three exchange profiles) whose frame counts,
//     canonical text and complete channel-symbol sequences were generated
//     by the reference encoder `sjtty` (see test/fixtures/README-jtty.md),
//   - one reference waveform from the same tool.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const codec = require('../src/audio/jtty-codec');
const tx = require('../src/audio/jtty-tx');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
// Quiet variant for the bulk comparisons: prints only failures, plus one summary line.
function bulk(name, items, fn) {
  let bad = 0;
  for (const item of items) {
    const why = fn(item);
    if (why) {
      bad++;
      if (bad <= 5) console.error(`FAIL - ${name}: ${why}`);
    }
  }
  check(bad === 0, `${name} (${items.length} cases, ${bad} failing)`);
}

const FIX = path.join(__dirname, 'fixtures');

// --- spec vectors: lib/jtty/jtty_source_encoding.txt, "Representative 34-bit vectors" ---

{
  const hex = (frame) => BigInt('0b' + frame).toString(16).padStart(9, '0');
  const vectors = [
    ['CQ K1ABC CQ', codec.callAtom(codec.CALL_ACTION.CQ, 'K1ABC'), true, '026f78d41'],
    ['EXCH_NUM full SERIAL 123, more', codec.exchNumAtom(1, codec.NUM_KIND.SERIAL, 123), false, '20007b008'],
    ['EXCH_NUM full SERIAL 123, EOM', codec.exchNumAtom(1, codec.NUM_KIND.SERIAL, 123), true, '20007b009'],
    ['EXCH_LOC full STATE CA', codec.exchLocAtom(1, codec.LOC_KIND.STATE_PROVINCE, 'CA'), true, '2001ba019'],
    ['ZONE_LOC3 05 NWT', codec.zoneLocAtom(5, 'NWT'), true, '00b790d29'],
    ['CLASS_SECTION 1D EMA', codec.classSectionAtom(1, 'D', codec.ARRL_SECTIONS.indexOf('EMA') + 1), true, '082c58029'],
    ['EXCH_NUM_TIME full 156 1749', codec.exchNumTimeAtom(1, 156, 17 * 60 + 49), true, '204e42d39'],
    ['CONTROL AGN?', codec.controlAtom(0), true, '000000049'],
    ['GRID4 field-only FN42', codec.grid4Atom(0, 'FN42'), true, '04a198049'],
    ['TEXT5 HELLO', codec.text5Atom('HELLO'), true, '11395558d'],
  ];
  for (const [name, atom, eom, want] of vectors) {
    const frame = codec.packAtom(atom, eom);
    check(frame !== null && frame.length === 34 && hex(frame) === want, `spec vector: ${name} -> 0x${want}`);
    const un = codec.unpackAtom(frame);
    check(un.valid && un.eom === eom, `spec vector: ${name} unpacks valid with eom=${eom}`);
  }
}

// --- spec examples for the automatic packer ---

{
  const frames = (t, profile) => codec.packText(t, { profile }).nframes;
  check(frames('CQ K1ABC CQ') === 1, 'packer: "CQ K1ABC CQ" is one frame');
  check(frames('599 123') === 1, 'packer: "599 123" is one frame');
  check(frames('599 MA') === 1, 'packer: "599 MA" is one frame');
  check(frames('599 FN42') === 1, 'packer: "599 FN42" is one frame');
  check(frames('1D EMA') === 1, 'packer: "1D EMA" is one frame');
  check(frames('599 001', 'unknown') === 2, 'packer: "599 001" needs two frames under Unknown');
  check(frames('599 05', 'field-day') === 2, 'packer: "599 05" needs two frames under Field Day');
  check(frames('599 001', 'rtty-roundup') === 1, 'packer: "599 001" is one SERIAL frame under RTTY Roundup');
  check(frames('K1ABC 599 001', 'rtty-roundup') === 2, 'packer: "K1ABC 599 001" is two frames under RTTY Roundup');
  check(codec.packText('599 05', { profile: 'rtty-roundup' }).message === '599 005', 'packer: RTTY Roundup canonicalizes "599 05" to "599 005"');
  check(codec.packText('599 0123', { profile: 'rtty-roundup' }).message === '599 123', 'packer: RTTY Roundup canonicalizes "599 0123" to "599 123"');
  check(frames('599 BRUCE') === 2, 'packer: "599 BRUCE" needs two frames');
  check(frames('') === 0 && frames('   ') === 0, 'packer: empty / blank text is zero frames');
  check(frames('X'.repeat(80)) === 16, 'packer: 80 free-text characters is the 16-frame maximum');
  check(frames('X'.repeat(200)) === 16, 'packer: input beyond 80 characters is truncated, not rejected');
  check(codec.packText('hello').message === 'HELLO', 'packer: lowercase is folded to uppercase');
  check(codec.packText('a  b').message === 'A B', 'packer: repeated spaces collapse');
  check(codec.packText('café ☃').message === 'CAF# #', 'packer: unsupported characters become #');
  check(codec.packText('x', { profile: 'bogus' }).nframes === -1, 'packer: an unknown exchange profile is rejected');
  const p = codec.packText('CQ K1ABC CQ HELLO');
  check(p.frames.length === p.nframes && p.frames.slice(0, -1).every((f) => f[33] === '0') && p.frames.at(-1)[33] === '1', 'packer: EOM is set on the last frame only');
  check(p.frames.every((f) => f[32] === '0'), 'packer: reserved bit 33 is zero in every frame');
  check(codec.packText('HI', { isFinal: false }).frames[0][33] === '0', 'packer: isFinal=false clears EOM on the last frame');
}

// --- atom validation ---

{
  check(codec.packAtom(codec.controlAtom(18), true) === null, 'atoms: unassigned CONTROL phrase 18 is rejected');
  check(codec.packAtom(codec.grid4Atom(0, 'SS00'), true) === null, 'atoms: GRID4 outside AA00-RR99 is rejected');
  check(codec.packAtom(codec.callAtom(0, 'Q1ABC'), true) === null, 'atoms: Q-prefixed call is rejected');
  check(codec.packAtom(codec.callAtom(0, 'VK3TR/P'), true) === null, 'atoms: compound call is rejected');
  check(codec.packAtom(codec.callAtom(0, 'AB'), true) === null, 'atoms: too-short call is rejected');
  check(codec.packAtom(codec.callAtom(6, 'K1ABC'), true) === null, 'atoms: call action 6 is rejected');
  check(codec.packAtom(codec.exchNumAtom(1, codec.NUM_KIND.CQ_ZONE, 41), true) === null, 'atoms: CQ zone 41 is rejected');
  check(codec.packAtom(codec.exchNumAtom(1, codec.NUM_KIND.SERIAL, 131072), true) === null, 'atoms: serial above 17 bits is rejected');
  check(codec.packAtom(codec.exchLocAtom(1, 3, '0AB'), true) === null, 'atoms: 3-char token with leading zero is rejected (canonical form is 2 chars)');
  check(codec.packAtom(codec.classSectionAtom(33, 'A', 11), true) === null, 'atoms: class count 33 is rejected');
  check(codec.packAtom(codec.classSectionAtom(1, 'G', 11), true) === null, 'atoms: class G is rejected');
  check(codec.packAtom(codec.exchNumTimeAtom(1, 1, 1440), true) === null, 'atoms: minute-of-day 1440 is rejected');
  check(codec.standardCall('VK3TR') && codec.standardCall('K1ABC') && codec.standardCall('3Q9REW'), 'atoms: ordinary calls are standard');

  const zeros = '0'.repeat(34);
  check(!codec.unpackAtom(zeros).valid, 'unpack: all-zero grammar word is the invalid sentinel');
  const good = codec.packAtom(codec.callAtom(0, 'K1ABC'), true);
  check(codec.unpackAtom(good).valid, 'unpack: a good frame is valid');
  check(!codec.unpackAtom(good.slice(0, 32) + '1' + good[33]).valid, 'unpack: reserved bit 33 set is invalid');
  // family 5/6/7 STRUCT30 are reserved/invalid in version 1
  const fam = (f) => (4 * (8 * 12345 + f) + 2).toString(2).padStart(32, '0') + '0' + '1';
  check([5, 6, 7].every((f) => !codec.unpackAtom(fam(f)).valid), 'unpack: STRUCT30 families 5-7 are invalid');
  check(codec.unpackAtom(fam(0)).valid === false, 'unpack: EXCH_NUM with non-zero trailing field is invalid');
  // i2=1 with n2>1 is reserved
  const reserved = (parseInt(good.slice(0, 28), 2) * 16 + 4 * 2 + 1).toString(2).padStart(32, '0') + '01';
  check(!codec.unpackAtom(reserved).valid, 'unpack: i2=1 n2=2 (reserved call action) is invalid');
}

// --- bulk comparison with the WSJT-X reference encoder (sjtty) ---

{
  const rows = JSON.parse(fs.readFileSync(path.join(FIX, 'jtty-vectors.json'), 'utf8'));
  bulk('reference vectors: frame count, canonical text and all channel symbols match sjtty', rows, ([text, profile, nframes, unpacked, tones]) => {
    const p = codec.packText(text, { profile });
    if (p.nframes !== nframes) return `${JSON.stringify(text)} [${profile}] frames ${p.nframes} != ${nframes}`;
    if (nframes <= 0) return null;
    const shown = codec.unpackFrames(p.frames).message.replace(/~/g, ' ').replace(/ +$/, '');
    if (shown !== unpacked.trim()) return `${JSON.stringify(text)} [${profile}] text ${JSON.stringify(shown)} != ${JSON.stringify(unpacked)}`;
    const got = tx.framesToTones(p.frames).join('');
    if (got !== tones) return `${JSON.stringify(text)} [${profile}] tones differ`;
    return null;
  });
  check(rows.some((r) => r[2] >= 9) && rows.some((r) => r[1] === 'rtty-roundup') && rows.some((r) => r[1] === 'field-day'), 'reference vectors cover long messages and all profiles');
}

// --- FEC building blocks ---

{
  const payload = codec.packText('CQ K1ABC CQ').frames[0].slice(0, 34);
  const sym = tx.tbccEncode(payload);
  check(sym.length === 46 && sym.every((s) => s >= 0 && s <= 3), 'tbcc: one frame encodes to 46 symbols in 0-3');
  const info = tx.appendCrc12(Array.from(payload, (c) => +c));
  check(info.length === 46, 'crc: 34 payload bits + 12 CRC bits');
  // CRC of an all-zero payload is zero; a single flipped bit must change it.
  const z = tx.appendCrc12(new Array(34).fill(0));
  check(z.every((b) => b === 0), 'crc: all-zero payload has all-zero CRC');
  const one = new Array(34).fill(0);
  one[33] = 1;
  check(tx.appendCrc12(one).slice(34).some((b) => b === 1), 'crc: a single set bit produces a non-zero CRC');
  check(tx.IS13.length === 13 && tx.FRAME_SYMBOLS === 59, 'frame: 13 sync + 46 coded = 59 symbols');
  const t = tx.framesToTones(codec.packText('HELLO').frames);
  check(t.slice(0, 13).join('') === '0223003213120', 'frame: tones start with the 13-symbol sync sequence');
}

// --- erf / pulse ---

{
  const close = (a, b, tol) => Math.abs(a - b) <= tol;
  check(close(tx.erf(0.5), 0.5204998778130465, 1e-14), 'erf(0.5)');
  check(close(tx.erf(1), 0.8427007929497149, 1e-14), 'erf(1)');
  check(close(tx.erf(2), 0.9953222650189527, 1e-14), 'erf(2)');
  check(close(tx.erf(2.5), 0.9995930479825550, 1e-14), 'erf(2.5) (series/continued-fraction boundary)');
  check(close(tx.erf(3), 0.9999779095030014, 1e-14), 'erf(3)');
  check(close(tx.erf(4), 0.9999999845827421, 1e-14), 'erf(4)');
  check(tx.erf(-1) === -tx.erf(1) && tx.erf(0) === 0, 'erf is odd');
  check(close(tx.gfskPulse(2.0, 0) + 2 * tx.gfskPulse(2.0, 1) + 2 * tx.gfskPulse(2.0, 2), 1, 1e-6), 'gfsk pulse integrates to one symbol of phase');
}

// --- waveform ---

{
  // Against the reference waveform: "CQ K1ABC CQ", f0 = 1500 Hz, 12 kHz, peak-normalized to 32766.9 by sjtty.
  const refBuf = fs.readFileSync(path.join(FIX, 'jtty-cq-k1abc-cq-1500hz.i16'));
  const ref = new Int16Array(refBuf.buffer, refBuf.byteOffset, refBuf.length / 2);
  const r = tx.encodeJtty('CQ K1ABC CQ', { f0: 1500, amplitude: 1 });
  check(r.samples.length === ref.length && ref.length === 59 * 384, 'waveform: one frame is 22656 samples at 12 kHz (1.888 s)');
  let peak = 0;
  for (const v of r.samples) peak = Math.max(peak, Math.abs(v));
  let maxErr = 0;
  let se = 0;
  let sr = 0;
  for (let i = 0; i < ref.length; i++) {
    const v = (r.samples[i] * 32766.9) / peak;
    maxErr = Math.max(maxErr, Math.abs(v - ref[i]));
    se += (v - ref[i]) ** 2;
    sr += ref[i] ** 2;
  }
  const rel = Math.sqrt(se / sr);
  // The reference accumulates phase in single precision and uses a 65536-entry sine table; this port uses doubles and Math.sin.
  check(rel < 1e-3 && maxErr < 40, `waveform matches the sjtty reference (relative rms ${rel.toExponential(2)}, max error ${maxErr.toFixed(1)} LSB of 32767)`);
  check(Math.abs(r.durationSec - 1.888) < 1e-9, 'waveform: reported duration is 1.888 s per frame');
  check(Math.abs(r.samples[0]) < 1e-3 && Math.abs(r.samples.at(-1)) < 0.05, 'waveform: starts and ends on the amplitude ramp');
}

{
  // Tone placement: a constant tone-2 sequence must sit at f0 + 2 * 31.25 Hz.
  const f0 = 1400;
  const w = tx.genJttyWave(new Array(40).fill(2), { f0 });
  const lo = 384 * 10;
  const hi = 384 * 30;
  let crossings = 0;
  for (let i = lo + 1; i < hi; i++) if (w[i - 1] < 0 && w[i] >= 0) crossings++;
  const f = (crossings * 12000) / (hi - lo);
  check(Math.abs(f - (f0 + 62.5)) < 1.0, `waveform: constant tone 2 measures ${f.toFixed(1)} Hz, expected ${f0 + 62.5}`);

  // 48 kHz generation agrees with 12 kHz generation (same continuous waveform).
  const t = tx.framesToTones(codec.packText('TEST 73').frames);
  const a = tx.genJttyWave(t, { sampleRate: 12000, f0: 1500 });
  const b = tx.genJttyWave(t, { sampleRate: 48000, f0: 1500 });
  let maxd = 0;
  for (let i = 0; i < a.length; i++) maxd = Math.max(maxd, Math.abs(a[i] - b[i * 4]));
  check(b.length === a.length * 4 && maxd < 0.02, `waveform: 48 kHz output matches 12 kHz output (max difference ${maxd.toExponential(1)})`);
  check(tx.sampleRateSupported(48000) && tx.sampleRateSupported(12000) && !tx.sampleRateSupported(44100), 'sample rates: multiples of 12 kHz are supported, 44.1 kHz is not');
  let threw = false;
  try {
    tx.genJttyWave([0, 1], { sampleRate: 44100, f0: 1000 });
  } catch {
    threw = true;
  }
  check(threw, 'waveform: an unsupported sample rate throws');
}

{
  const e = tx.encodeJtty('', {});
  check(e.nframes === 0 && e.samples.length === 0, 'encodeJtty: empty text produces no audio');
  const m = tx.encodeJtty('CQ DX KA1ABC', { amplitude: 0.5 });
  let pk = 0;
  for (const v of m.samples) pk = Math.max(pk, Math.abs(v));
  check(m.nframes === 3 && m.samples.length === 3 * 59 * 384 && pk <= 0.5 + 1e-6 && pk > 0.45, 'encodeJtty: 3-frame message, amplitude honoured');
  check(tx.encodeJtty('x'.repeat(10), { profile: 'bogus' }).nframes === -1, 'encodeJtty: invalid profile is reported as nframes -1');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll JTTY transmit checks passed');
