'use strict';

// Builds the receive-test audio described by one test/fixtures/olivia-vectors.json
// rxCases entry: the Olivia signal from the JS encoder (which matches the
// reference transmitter sample for sample) at 0.3 of full scale, after
// `leadSec` of silence, plus Gaussian noise from a seeded generator. Shared by
// third_party/olivia/make-fixtures.js and test/olivia.test.js so both see
// exactly the same samples.

const { encodeOlivia, makeTestRand } = require('../src/audio/olivia-tx');

function gauss(r) {
  const u = (r() + 1) / 32769;
  const v = r() / 32768;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function rxInput({ text, txHz, seed, noise, noiseSeed, leadSec }) {
  const enc = encodeOlivia([...Buffer.from(text, 'latin1')], { centreHz: txHz, rand: makeTestRand(seed) });
  const lead = Math.round(leadSec * 8000);
  const x = new Float32Array(lead + enc.samples.length + 8000);
  for (let i = 0; i < enc.samples.length; i++) x[lead + i] = enc.samples[i] * 0.3;
  if (noise > 0) {
    const r = makeTestRand(noiseSeed);
    for (let i = 0; i < x.length; i++) x[i] += 0.03 * noise * gauss(r);
  }
  return x;
}

module.exports = { rxInput, gauss };
