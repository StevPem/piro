'use strict';

// Run with: node test/mixer.test.js
// Tests src/audio/mixer.js entirely against an injected fake execFile —
// no real ALSA hardware or `amixer` binary needed, so this runs the same
// in CI/sandbox as on the Pi.

const assert = require('assert');
const { maximizeVolume, alsaDeviceToCardId, listSimpleControls, setControlMax } = require('../src/audio/mixer');

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

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    failures++;
  }
}

// Realistic amixer scontrols output for a typical class-compliant USB codec.
const SAMPLE_SCONTROLS_OUTPUT = `Simple mixer control 'Speaker',0
Simple mixer control 'Mic',0
Simple mixer control 'Auto Gain Control',0
`;

function fakeExecFile({ scontrolsOutput = SAMPLE_SCONTROLS_OUTPUT, failOnControls = [] } = {}) {
  return (cmd, args, cb) => {
    assert.strictEqual(cmd, 'amixer');
    assert.strictEqual(args[0], '-c');
    if (args[2] === 'scontrols') {
      cb(null, scontrolsOutput);
      return;
    }
    if (args[2] === 'sset') {
      const controlName = args[3];
      if (failOnControls.includes(controlName)) {
        cb(new Error(`simulated amixer failure for ${controlName}`));
      } else {
        cb(null, 'ok');
      }
      return;
    }
    cb(new Error(`unexpected amixer args: ${args.join(' ')}`));
  };
}

test('alsaDeviceToCardId extracts the card id from plughw device strings', () => {
  assert.strictEqual(alsaDeviceToCardId('plughw:CODEC,0'), 'CODEC');
  assert.strictEqual(alsaDeviceToCardId('hw:1,0'), '1');
  assert.strictEqual(alsaDeviceToCardId('plug:Headphones,0'), 'Headphones');
});

test('alsaDeviceToCardId returns null for unrecognized strings', () => {
  assert.strictEqual(alsaDeviceToCardId('not-an-alsa-device'), null);
  assert.strictEqual(alsaDeviceToCardId(''), null);
  assert.strictEqual(alsaDeviceToCardId(undefined), null);
});

async function run() {
  await asyncTest('listSimpleControls parses control names out of amixer scontrols output', async () => {
    const names = await listSimpleControls('CODEC', fakeExecFile());
    assert.deepStrictEqual(names, ['Speaker', 'Mic', 'Auto Gain Control']);
  });

  await asyncTest('listSimpleControls resolves to an empty array (not a throw) if amixer fails', async () => {
    const exec = (cmd, args, cb) => cb(new Error('amixer: no such card'));
    const names = await listSimpleControls('NOPE', exec);
    assert.deepStrictEqual(names, []);
  });

  await asyncTest('setControlMax resolves true on success, false on failure (never rejects)', async () => {
    const exec = fakeExecFile({ failOnControls: ['Auto Gain Control'] });
    assert.strictEqual(await setControlMax('CODEC', 'Speaker', exec), true);
    assert.strictEqual(await setControlMax('CODEC', 'Auto Gain Control', exec), false);
  });

  await asyncTest('maximizeVolume sets every listed control and reports per-control success', async () => {
    const exec = fakeExecFile({ failOnControls: ['Auto Gain Control'] });
    const results = await maximizeVolume('CODEC', exec);
    assert.deepStrictEqual(
      results,
      [
        { name: 'Speaker', ok: true },
        { name: 'Mic', ok: true },
        { name: 'Auto Gain Control', ok: false },
      ],
      'each control gets its own success/failure result; one failure does not abort the rest'
    );
  });

  await asyncTest('maximizeVolume returns an empty array for a falsy cardId rather than erroring', async () => {
    const exec = fakeExecFile();
    assert.deepStrictEqual(await maximizeVolume(null, exec), []);
    assert.deepStrictEqual(await maximizeVolume(undefined, exec), []);
  });

  await asyncTest('maximizeVolume returns an empty array when the card has no controls', async () => {
    const exec = fakeExecFile({ scontrolsOutput: '' });
    assert.deepStrictEqual(await maximizeVolume('CODEC', exec), []);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
