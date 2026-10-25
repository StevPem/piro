'use strict';

// Regenerates test/fixtures/easypal-*.ulaw and easypal-fixtures.json: HamDRM
// (EasyPal) transmissions made by QSSTV's own transmitter, for
// test/easypal.test.js. Build the transmitter first (harness/build.sh), then:
//
//   node third_party/qsstv-drm/make-fixtures.js /tmp/drm/drmtx
//
// Each transmission is cut to 12 kHz, kept only until PiRO's receiver has
// the whole file (plus half a second), and stored as 8-bit mu-law to keep
// the fixtures small (mu-law's own noise is about 38 dB down, far below
// what these modes need).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { StreamDecimator } = require('../../src/audio/decimator');
const { HamDrmReceiver } = require('../../src/audio/drm/receiver');
const rs = require('../../src/audio/drm/rs');
const { encodeMuLaw } = require('../../test/fixtures/easypal-audio');

const FIX = path.join(__dirname, '..', '..', 'test', 'fixtures');
const drmtx = process.argv[2];
if (!drmtx) {
  console.error('usage: node make-fixtures.js <path to drmtx>');
  process.exit(2);
}

const FIXTURES = [
  // name, file sent, name/extension it is sent as, mode, bandwidth, interleave, qam, protection, callsign
  { name: 'b16-rs2', source: 'easypal-tiny.jp2', rsType: 'rs2', sendName: 'tiny', mode: 1, bw: 1, il: 1, qam: 1, prot: 0, call: 'VK3ABC' },
  { name: 'a64', source: 'easypal-tiny.jpg', sendName: 'tiny', ext: 'jpg', mode: 0, bw: 1, il: 1, qam: 2, prot: 1, call: 'VK2XYZ' },
  { name: 'e4', source: 'easypal-tiny.jp2', sendName: 'tiny', ext: 'jp2', mode: 2, bw: 0, il: 0, qam: 0, prot: 0, call: 'VK4QRS' },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easypal-'));
const meta = {};
for (const f of FIXTURES) {
  const src = fs.readFileSync(path.join(FIX, f.source));
  let send = src;
  let ext = f.ext;
  if (f.rsType) {
    send = rs.encodeFile(src, path.extname(f.source).slice(1), f.rsType);
    ext = f.rsType;
  }
  const inFile = path.join(tmp, `${f.name}.bin`);
  const wav = path.join(tmp, `${f.name}.wav`);
  fs.writeFileSync(inFile, send);
  execFileSync(drmtx, [inFile, f.sendName, ext, f.mode, f.bw, f.il, f.qam, f.prot, f.call, wav, '4242'].map(String), { stdio: 'ignore' });
  const buf = fs.readFileSync(wav);
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));
  // half a second of silence first, as a receiver would hear before the signal
  const audio = Float32Array.from([...new Float32Array(24000), ...Array.from(pcm, (v) => v / 32768)]);
  const x = new StreamDecimator(48000, 12000, { cutoffHz: 4500 }).process(audio);
  let doneAt = -1;
  const rx = new HamDrmReceiver({
    sampleRate: 12000,
    onEvent: (ev) => {
      if (ev.type === 'file' && doneAt < 0) doneAt = pos;
    },
  });
  let pos = 0;
  for (; pos < x.length && doneAt < 0; pos += 1200) rx.process(x.subarray(pos, pos + 1200));
  if (doneAt < 0) throw new Error(`${f.name}: PiRO's receiver didn't get the file`);
  const keep = x.subarray(0, Math.min(x.length, doneAt + 1200 + 6000));
  fs.writeFileSync(path.join(FIX, `easypal-${f.name}.ulaw`), encodeMuLaw(keep));
  meta[f.name] = {
    fileName: `${f.sendName}.${f.rsType ? path.extname(f.source).slice(1) : ext}`,
    sentAs: `${f.sendName}.${ext}`,
    source: f.source,
    callsign: f.call,
    mode: ['A', 'B', 'E'][f.mode],
    bandwidth: f.bw ? 2.5 : 2.3,
    qam: [4, 16, 64][f.qam],
    protection: f.prot ? 'normal' : 'high',
    interleave: f.il ? 'short' : 'long',
    seconds: +(keep.length / 12000).toFixed(1),
  };
  console.log(f.name, meta[f.name]);
}
// keep the entries not made here (the off-air recording, easypal-onair.ulaw)
const old = fs.existsSync(path.join(FIX, 'easypal-fixtures.json')) ? JSON.parse(fs.readFileSync(path.join(FIX, 'easypal-fixtures.json'), 'utf8')) : {};
for (const [k, v] of Object.entries(old)) if (!(k in meta)) meta[k] = v;
fs.writeFileSync(path.join(FIX, 'easypal-fixtures.json'), JSON.stringify(meta, null, 2) + '\n');
fs.rmSync(tmp, { recursive: true });
