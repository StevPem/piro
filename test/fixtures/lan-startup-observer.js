'use strict';

// Test-only readiness telemetry for the real optional decoder. Transport-loss
// tests start from steady state; upstream issue #81 covers close-during-load.
// No decoder work or cleanup is replaced, and production never loads this file.
const decoder = require('../../src/audio/deepcw-decoder');
const Original = decoder.DeepCwDecoder;
decoder.DeepCwDecoder = class extends Original {
  constructor(...args) {
    super(...args);
    const report = () => {
      if (process.connected) process.send({ type: 'test-cw-startup-settled' }, () => {});
    };
    Promise.resolve(this._ready).then(report, report);
  }
};
