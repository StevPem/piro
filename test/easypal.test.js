'use strict';

// Run with: node test/easypal.test.js
// The EasyPal (HamDRM) receiver, src/audio/drm/, a port of QSSTV's: real
// transmissions from QSSTV's own transmitter (test/fixtures/easypal-*.ulaw,
// made by third_party/qsstv-drm/make-fixtures.js), clean and with noise, a
// mistuning and a gap; and its parts (Reed-Solomon, CRCs, interleavers).

const fs = require('fs');
const path = require('path');
const { HamDrmReceiver } = require('../src/audio/drm/receiver');
const rs = require('../src/audio/drm/rs');
const { crc16 } = require('../src/audio/drm/source-decoder');
const { crc8, deinterleaver, mkmscmap } = require('../src/audio/drm/channel-decoder');
const { Dft } = require('../src/audio/drm/dsp');
const { toDisplay, sniff, jpegSize } = require('../src/audio/drm/picture');
const fx = require('./fixtures/easypal-audio');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

/** Runs 12 kHz audio through a receiver in 0.1 s pieces. */
function receive(x) {
  const events = [];
  const rx = new HamDrmReceiver({ sampleRate: 12000, onEvent: (e) => events.push(e) });
  for (let i = 0; i < x.length; i += 1200) rx.process(x.subarray(i, i + 1200));
  const files = events.filter((e) => e.type === 'file');
  const receiving = events.filter((e) => e.type === 'status' && e.stage === 'receiving');
  return { events, files, receiving, rx };
}

const describe = (m) => (m ? `${m.mode} ${m.bandwidth} kHz ${m.qam}-QAM ${m.protection} ${m.interleave}` : 'none');

// --- the parts ---
{
  const dft = new Dft(160);
  const x = new Float64Array(320);
  x[2 * 7] = 1; // a single sample at n = 7
  const X = dft.forward(x, new Float64Array(320));
  const k = 3;
  check(Math.abs(X[2 * k] - Math.cos((2 * Math.PI * k * 7) / 160)) < 1e-12 && Math.abs(X[2 * k + 1] + Math.sin((2 * Math.PI * k * 7) / 160)) < 1e-12, 'DFT (any length): forward transform');
  const d2 = new Dft(64);
  const y = Float64Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.37) + (i % 5));
  const Y = d2.forward(y, new Float64Array(128));
  let re = 0;
  let im = 0;
  for (let m = 0; m < 64; m++) {
    re += y[2 * m] * Math.cos((2 * Math.PI * 5 * m) / 64) + y[2 * m + 1] * Math.sin((2 * Math.PI * 5 * m) / 64);
    im += y[2 * m + 1] * Math.cos((2 * Math.PI * 5 * m) / 64) - y[2 * m] * Math.sin((2 * Math.PI * 5 * m) / 64);
  }
  check(Math.abs(Y[10] - re) < 1e-9 && Math.abs(Y[11] - im) < 1e-9, 'DFT (power of two, radix 2) agrees with the sum');

  const ok = (d) => d.length && [...d].sort((a, b) => a - b).every((v, i) => v === i);
  check(ok(deinterleaver(0, 21, 90, 21)) && ok(deinterleaver(0, 13, 1046, 13)) && ok(deinterleaver(0, 5, 523, 5)), 'bit and cell deinterleavers are permutations');
  const m = mkmscmap(1, 1, 0, 128, 256);
  const all = new Set();
  for (const row of m.demapper) for (const v of row) all.add(v);
  check(m.N_MUX > 500 && all.size === 6 * m.N_MUX && [...all].every((v) => v >= 0 && v < 6 * 15 * 256), `MSC cell map (mode B, 2.5 kHz, long interleave): ${m.N_MUX} cells a frame, every cell once`);

  // CRC-16 as DRM sends it: the CRC inverted at the end
  const data = Buffer.from('HamDRM test packet');
  let c = 0xffff;
  for (const byte of data) {
    for (let j = 7; j >= 0; j--) {
      const bit = ((c >> 15) ^ (byte >> j)) & 1;
      c = ((c << 1) & 0xffff) ^ (bit ? 0x1021 : 0);
    }
  }
  const pkt = Buffer.concat([data, Buffer.from([(~c >> 8) & 0xff, ~c & 0xff])]);
  check(crc16(pkt) === 0, 'CRC-16: a good packet checks');
  pkt[3] ^= 0x10;
  check(crc16(pkt) !== 0, 'CRC-16: one bit wrong is caught');
  const fac = Uint8Array.from({ length: 48 }, (_, i) => (i * 7) % 3 === 0);
  let b = 0xff;
  for (let i = 0; i < 40; i++) b = (((b << 1) ^ (((b >> 7) ^ fac[i]) & 1 ? 0x1d : 0)) & 0xff) >>> 0;
  for (let i = 0; i < 8; i++) fac[40 + i] = (b >> (7 - i)) & 1;
  check(crc8(fac, 48) === 0, 'CRC-8 (the FAC): good block checks');

  // Reed-Solomon files, as QSSTV makes them
  const file = fs.readFileSync(path.join(__dirname, 'fixtures', 'easypal-tiny.jpg'));
  for (const type of ['rs1', 'rs2', 'rs3', 'rs4']) {
    const enc = rs.encodeFile(file, 'jpg', type);
    const seg = 100;
    const total = Math.ceil(enc.length / seg);
    const parity = 255 - rs.DSIZE[type];
    // lose as many whole segments as the code can stand: each costs every code word about seg / chunks bytes
    const chunks = enc.length / 255;
    const canLose = Math.floor(parity / Math.ceil(seg / chunks)) - 1;
    const missing = Array.from({ length: canLose }, (_, i) => Math.floor((i * total) / canLose));
    const damaged = Buffer.from(enc);
    for (const s of missing) damaged.fill(0, s * seg, (s + 1) * seg);
    const r = rs.decodeFile(damaged, type, { totalSegments: total, segmentLength: seg, missing });
    check(r && r.ext === 'jpg' && r.data.equals(file), `${type}: ${missing.length} of ${total} segments lost, the file is recovered exactly`);
  }
  {
    const enc = rs.encodeFile(file, 'jpg', 'rs1');
    const seg = 100;
    const total = Math.ceil(enc.length / seg);
    const missing = Array.from({ length: Math.ceil(total / 3) }, (_, i) => i * 3);
    const r = rs.decodeFile(enc, 'rs1', { totalSegments: total, segmentLength: seg, missing });
    check(r === null, 'rs1: a third of the segments lost is too many (and is reported, not guessed)');
    const bad = Buffer.from(enc);
    for (let i = 0; i < bad.length; i += 37) bad[i] ^= 0x5a; // scattered errors, not marked
    const r2 = rs.decodeFile(bad, 'rs1', { totalSegments: total, segmentLength: seg, missing: [] });
    check(r2 && r2.data.equals(file) && r2.corrected > 0, `rs1: scattered byte errors are corrected too (${r2 && r2.corrected})`);
  }

  // what the browser is sent
  const jpg = toDisplay(file, 'x.jpg');
  check(jpg.mime === 'image/jpeg' && jpg.data === file && jpg.width === 160 && jpg.height === 120, 'a JPEG is passed on as it is, with its size');
  const jp2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'easypal-tiny.jp2'));
  check(sniff(jp2) === 'image/jp2', 'a JPEG 2000 file is recognised');
  const shown = toDisplay(jp2, 'x.jp2');
  check(shown.mime === 'image/png' && shown.width === 160 && shown.height === 120 && shown.data.subarray(1, 4).toString() === 'PNG', 'a JPEG 2000 picture is decoded and sent as a PNG');
  check(toDisplay(Buffer.from('hello there, this is text'), 'note.txt').text.startsWith('hello'), 'a text file is shown as text');
  check(toDisplay(Buffer.alloc(40, 7), 'x.bin') === null && jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])) === null, 'anything else is not shown');
}

// --- real transmissions ---
for (const name of ['b16-rs2', 'a64', 'e4']) {
  const { meta, audio, file } = fx.loadFixture(name);
  const t0 = Date.now();
  const { files, receiving, events } = receive(audio);
  const ms = Date.now() - t0;
  const f = files[0];
  const label = `${meta.mode} ${meta.bandwidth} kHz ${meta.qam}-QAM ${meta.protection} ${meta.interleave}, ${meta.sentAs}`;
  check(files.length === 1 && f.fileName === meta.fileName && f.data.equals(file), `${label}: the file arrives exactly (${ms} ms for ${meta.seconds} s)`);
  check(f && f.callsign === meta.callsign, `${label}: callsign ${f && f.callsign}`);
  const last = receiving.at(-1);
  check(last && describe(last.mode) === `${meta.mode} ${meta.bandwidth} kHz ${meta.qam}-QAM ${meta.protection} ${meta.interleave}`, `${label}: mode read from the FAC (${describe(last && last.mode)})`);
  check(last && last.snr > 25 && Math.abs(last.tuningHz) < 3, `${label}: S/N ${last && last.snr.toFixed(1)} dB, tuning ${last && last.tuningHz.toFixed(1)} Hz`);
  check(events.some((e) => e.type === 'header' && e.fileName === meta.sentAs), `${label}: the MOT header names the file (${meta.sentAs})`);
}

// --- radio trouble ---
{
  const { meta, audio, file } = fx.loadFixture('b16-rs2');
  for (const [snr, seed] of [
    [16, 3],
    [13, 4],
  ]) {
    const { files } = receive(fx.addNoise(audio, snr, seed));
    check(files.length === 1 && files[0].data.equals(file), `mode B 16-QAM with noise, ${snr} dB S/N in 2.5 kHz: received`);
  }
  for (const hz of [-200, 90]) {
    const { files, receiving } = receive(fx.shiftFrequency(audio, hz));
    const t = receiving.at(-1)?.tuningHz;
    check(files.length === 1 && files[0].data.equals(file) && Math.abs(t - hz) < 3, `mistuned by ${hz > 0 ? '+' : ''}${hz} Hz: received, and the mistuning is reported (${t?.toFixed(1)} Hz)`);
  }
  // half a second of static in the middle: the Reed-Solomon code puts the lost segments back
  const x = fx.addNoise(audio, 25, 5);
  const r = fx.rng(9);
  const from = Math.round(x.length * 0.45);
  for (let i = from; i < from + 6000; i++) x[i] = (r() - 0.5) * 1.5;
  const { files } = receive(x);
  check(files.length === 1 && files[0].data.equals(file) && files[0].recovered > 0, `half a second of static mid-way: ${meta.sentAs} still arrives, ${files[0]?.recovered} lost segments recovered by Reed-Solomon`);
}
{
  const { audio, file } = fx.loadFixture('e4');
  const { files } = receive(fx.addNoise(audio, 6, 11));
  check(files.length === 1 && files[0].data.equals(file), 'mode E 4-QAM (the most robust) at 6 dB S/N: received');
}
{
  // noise (and a whistle) only: nothing is found
  const r = fx.rng(21);
  const x = new Float32Array(12000 * 60);
  let a = 0;
  for (let i = 0; i < x.length; i++) {
    a = 0.9 * a + (r() - 0.5);
    x[i] = 0.05 * a + ((i / 12000) % 10 > 7 ? 0.2 * Math.sin((2 * Math.PI * 1000 * i) / 12000) : 0);
  }
  const { events } = receive(x);
  check(!events.some((e) => e.type === 'file' || e.type === 'header' || (e.type === 'status' && e.stage === 'receiving')), 'a minute of noise and a whistle: nothing is received');
}
{
  // two transmissions in a row, then quiet: both files, and the receiver says when the signal goes
  const a = fx.loadFixture('a64');
  const b = fx.loadFixture('b16-rs2');
  const quiet = fx.addNoise(new Float32Array(12000 * 6).fill(0), 0, 1).map(() => 0);
  const x = fx.addNoise(Float32Array.from([...a.audio, ...new Float32Array(6000), ...b.audio, ...quiet]), 30, 2);
  const { files, events } = receive(x);
  check(files.length === 2 && files[0].data.equals(a.file) && files[1].data.equals(b.file), 'two transmissions back to back: both files');
  check(files[0].callsign === a.meta.callsign && files[1].callsign === b.meta.callsign, `each with its own callsign (${files.map((f) => f.callsign).join(', ')})`);
  check(events.at(-1)?.type === 'lost' || events.some((e, i) => e.type === 'lost' && i > events.indexOf(files[1])), 'when the signal stops, the receiver says so');
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
