// Run with: node test/audio-codec.test.mjs
// The compressed-audio formats shared by the browser and the server
// (src/client/audio-codec.js), and isLanHost() from src/client/audio.js.

import assert from 'node:assert';
import {
  adpcmEncode,
  adpcmDecode,
  StreamResampler,
  FrameBuffer,
  ADPCM_FRAME_SAMPLES,
} from '../src/client/audio-codec.js';
import { isLanHost } from '../src/client/audio.js';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    failures++;
  }
}

function snrDb(a, b) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * a[i];
    n += (a[i] - b[i]) ** 2;
  }
  return 10 * Math.log10(s / n);
}

// mulberry32: repeatable noise
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('ADPCM: 240 samples make a 124-byte frame (4 header + 4 bits a sample)', () => {
  assert.strictEqual(adpcmEncode(new Int16Array(ADPCM_FRAME_SAMPLES)).length, 124);
});

test('ADPCM: two tones survive with over 20 dB SNR', () => {
  const x = new Int16Array(ADPCM_FRAME_SAMPLES * 10);
  for (let i = 0; i < x.length; i++) x[i] = Math.round(8000 * Math.sin((2 * Math.PI * 700 * i) / 12000) + 3000 * Math.sin((2 * Math.PI * 1900 * i) / 12000));
  const y = new Int16Array(x.length);
  for (let f = 0; f < 10; f++) {
    const s = x.subarray(f * ADPCM_FRAME_SAMPLES, (f + 1) * ADPCM_FRAME_SAMPLES);
    y.set(adpcmDecode(adpcmEncode(s), ADPCM_FRAME_SAMPLES), f * ADPCM_FRAME_SAMPLES);
  }
  const snr = snrDb(x, y);
  assert.ok(snr > 20, `SNR ${snr.toFixed(1)} dB`);
});

test('ADPCM: each frame stands alone (the first sample is exact, any frame decodes without the one before)', () => {
  const r = rng(7);
  const x = Int16Array.from({ length: ADPCM_FRAME_SAMPLES }, () => Math.round((r() - 0.5) * 20000));
  const y = adpcmDecode(adpcmEncode(x));
  assert.strictEqual(y[0], x[0]);
  assert.strictEqual(y.length, ADPCM_FRAME_SAMPLES + 1); // odd count padded: one extra sample, ignored by callers
});

test('ADPCM: full-scale and silence do not overflow', () => {
  const x = Int16Array.from({ length: 240 }, (_, i) => (i % 20 < 10 ? 32767 : -32768));
  const y = adpcmDecode(adpcmEncode(x), 240);
  assert.ok(y.every((v) => v >= -32768 && v <= 32767));
  assert.ok(adpcmDecode(adpcmEncode(new Int16Array(240)), 240).every((v) => v === 0));
});

test('ADPCM: a short or empty frame decodes to nothing', () => {
  assert.strictEqual(adpcmDecode(new Uint8Array(2)).length, 0);
  assert.strictEqual(adpcmEncode(new Int16Array(0)).length, 4);
});

for (const [inRate, outRate] of [
  [48000, 12000],
  [48000, 16000],
  [44100, 12000],
  [12000, 48000],
  [16000, 44100],
]) {
  test(`resampler ${inRate} -> ${outRate}: right sample count and level, fed in odd-sized chunks`, () => {
    const rs = new StreamResampler(inRate, outRate);
    const out = [];
    let n = 0;
    for (let c = 0; c < 60; c++) {
      const chunk = new Float32Array(37 + c * 13);
      for (let i = 0; i < chunk.length; i++, n++) chunk[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * n) / inRate);
      out.push(...rs.process(chunk));
    }
    assert.ok(Math.abs(out.length - (n * outRate) / inRate) <= 6, `${out.length} vs ${(n * outRate) / inRate}`);
    const tail = out.slice(300);
    const rms = Math.sqrt(tail.reduce((s, v) => s + v * v, 0) / tail.length);
    assert.ok(Math.abs(rms - 0.3536) < 0.01, `rms ${rms}`);
  });
}

test('resampler 48 -> 12 kHz removes a 7 kHz tone (it would alias to 5 kHz)', () => {
  const rs = new StreamResampler(48000, 12000);
  const x = Float32Array.from({ length: 48000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 7000 * i) / 48000));
  const y = rs.process(x).slice(200);
  const rms = Math.sqrt(y.reduce((s, v) => s + v * v, 0) / y.length);
  assert.ok(rms < 0.005, `rms ${rms}`);
});

test('resampler at equal rates passes samples through', () => {
  const x = Float32Array.from([0.1, 0.2, 0.3]);
  assert.deepStrictEqual(Array.from(new StreamResampler(12000, 12000).process(x)), Array.from(x));
});

test('FrameBuffer hands out exact frames and keeps the remainder', () => {
  const fb = new FrameBuffer(4);
  assert.strictEqual(fb.push(Int16Array.from([1, 2, 3])).length, 0);
  const frames = fb.push(Int16Array.from([4, 5, 6, 7, 8, 9]));
  assert.deepStrictEqual(frames.map((f) => Array.from(f)), [[1, 2, 3, 4], [5, 6, 7, 8]]);
  assert.deepStrictEqual(Array.from(fb.push(Int16Array.from([10, 11, 12]))[0]), [9, 10, 11, 12]);
});

test('isLanHost: home addresses and names are the LAN; the rest is remote', () => {
  for (const h of ['localhost', '127.0.0.1', '192.168.1.20', '10.0.0.5', '172.20.1.1', 'piro', 'piro.local', 'pi.lan', '[fd12::1]', '[::1]']) {
    assert.strictEqual(isLanHost(h), true, h);
  }
  for (const h of ['piro.example.com', '100.101.102.103', '203.0.113.9', '172.32.0.1', '[2001:db8::1]', 'piro.tail1234.ts.net']) {
    assert.strictEqual(isLanHost(h), false, h);
  }
});

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
