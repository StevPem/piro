'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AudioBridge } = require('../src/server/audio-bridge');

function fixture(channels = 1) {
  const errors = [], written = [], observed = [];
  const controlServer = Object.assign(new EventEmitter(), {
    state: {}, broadcastJsonEvent(type, data) { errors.push({ type, ...data }); },
  });
  const playback = Object.assign(new EventEmitter(), { write(pcm) { written.push(pcm); } });
  const bridge = new AudioBridge({ controlServer, capture: new EventEmitter(), playback, channels });
  bridge.on('tx-pcm', (pcm) => observed.push(pcm));
  const send = (pcm) => controlServer.emit('binary-message', {}, Buffer.concat([Buffer.from([1]), pcm]));
  return { bridge, playback, errors, written, observed, send };
}

test('microphone validation runs before observers and honors stereo frame alignment', () => {
  const f = fixture(2);
  f.send(Buffer.alloc(2)); // One complete int16 is only half a stereo frame.
  f.send(Buffer.alloc(96004)); // 500 ms of stereo PCM plus one frame.
  assert.equal(f.errors.length, 2);
  assert.deepEqual(f.observed, []);
  assert.deepEqual(f.written, []);
  const valid = Buffer.alloc(3840, 42);
  f.send(valid);
  assert.deepEqual(f.observed, [valid]);
  assert.deepEqual(f.written, [valid]);
});

test('microphone playback and observer failures are reported without escaping the event handler', () => {
  for (const source of ['playback', 'observer']) {
    const f = fixture();
    const fail = () => { throw new Error(`simulated ${source} failure`); };
    if (source === 'playback') f.playback.write = fail;
    else f.bridge.on('tx-pcm', fail);
    assert.doesNotThrow(() => f.send(Buffer.alloc(1920)));
    assert.deepEqual(f.errors, [{ type: 'audio-error', context: 'mic', message: `simulated ${source} failure` }]);
    if (source === 'playback') f.playback.write = (pcm) => f.written.push(pcm);
    else f.bridge.off('tx-pcm', fail);
    f.send(Buffer.alloc(1920));
    assert.equal(f.written.length, 1, 'later microphone packets still reach playback');
  }
});
