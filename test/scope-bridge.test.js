'use strict';

// Run with: node test/scope-bridge.test.js
// Confirms scope lines are broadcast over the real WebSocket binary
// channel with the correct type tag and header encoding, and that audio
// and scope frames correctly coexist on the same connection now that
// both are tag-prefixed.

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { ControlServer } = require('../src/server/ws-server');
const { ScopeBridge } = require('../src/server/scope-bridge');
const { BINARY_TYPE } = require('../src/server/protocol');
const { SCOPE_MODE } = require('../src/civ/commands');

class StubCivDriver extends EventEmitter {
  constructor() {
    super();
    this.radioAddr = 0x94;
    this.enableCalls = 0;
    this.disableCalls = 0;
    this.setModeCalls = [];
    this.centerScopeCalls = [];
  }
  async enableScopeOutput() {
    this.enableCalls++;
  }
  async disableScopeOutput() {
    this.disableCalls++;
  }
  async setScopeMode(mode) {
    this.setModeCalls.push(mode);
  }
  async centerScope(spanHz) {
    this.centerScopeCalls.push(spanHz);
    return spanHz;
  }
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws._queue = [];
    ws._waiters = [];
    ws.on('message', (raw, isBinary) => {
      const item = isBinary
        ? { isBinary: true, data: raw }
        : { isBinary: false, data: JSON.parse(raw.toString()) };
      if (ws._waiters.length) ws._waiters.shift()(item);
      else ws._queue.push(item);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws) {
  if (ws._queue.length) return Promise.resolve(ws._queue.shift());
  return new Promise((resolve) => ws._waiters.push(resolve));
}

/** Mirrors the decode logic src/client/rpc.js implements for the browser. */
function decodeScopeLine(buf) {
  const mode = buf[1];
  const mainSub = buf[2];
  const freqA = buf.readUInt32LE(3);
  const freqB = buf.readUInt32LE(7);
  const extra = buf[11];
  const points = buf.subarray(12);
  const isCenterLike = mode === SCOPE_MODE.CENTER || mode === SCOPE_MODE.SCROLL_C;
  const line = { mode, mainSub, points };
  if (isCenterLike) {
    line.centerFreq = freqA;
    line.span = freqB;
  } else {
    line.startFreq = freqA;
    line.endFreq = freqB;
    line.inRange = extra === 0x01;
  }
  return line;
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

async function testCenterModeRoundTrip() {
  console.log('\n-- center-mode line: broadcast + client-side decode round-trip --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();
  new ScopeBridge({ civ, controlServer: server });

  const client = await connect(port);
  await nextMessage(client); // hello

  const points = Buffer.from([5, 10, 15, 200, 255, 0]);
  civ.emit('scope-line', { mode: SCOPE_MODE.CENTER, mainSub: 0, centerFreq: 14195000, span: 25000, points });

  const msg = await nextMessage(client);
  check(msg.isBinary === true, 'scope line arrives as a binary frame');
  check(msg.data[0] === BINARY_TYPE.SCOPE_LINE, 'frame is tagged as BINARY_TYPE.SCOPE_LINE');

  const decoded = decodeScopeLine(msg.data);
  check(decoded.mode === SCOPE_MODE.CENTER, 'decoded mode matches');
  check(decoded.centerFreq === 14195000, 'decoded centerFreq matches');
  check(decoded.span === 25000, 'decoded span matches');
  check([...decoded.points].join(',') === [...points].join(','), 'decoded points match byte-for-byte');

  client.close();
  await server.close();
}

async function testFixedModeRoundTrip() {
  console.log('\n-- fixed-mode line: start/end freq + inRange flag --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();
  new ScopeBridge({ civ, controlServer: server });

  const client = await connect(port);
  await nextMessage(client); // hello

  const points = Buffer.from([1, 2, 3]);
  civ.emit('scope-line', {
    mode: SCOPE_MODE.FIXED,
    mainSub: 0,
    startFreq: 14000000,
    endFreq: 14350000,
    inRange: false,
    points,
  });

  const msg = await nextMessage(client);
  const decoded = decodeScopeLine(msg.data);
  check(decoded.mode === SCOPE_MODE.FIXED, 'decoded mode matches');
  check(decoded.startFreq === 14000000 && decoded.endFreq === 14350000, 'decoded start/end freq match');
  check(decoded.inRange === false, 'decoded inRange flag matches');

  client.close();
  await server.close();
}

async function testAudioAndScopeCoexist() {
  console.log('\n-- audio and scope frames coexist correctly on one connection --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();
  new ScopeBridge({ civ, controlServer: server });

  const client = await connect(port);
  await nextMessage(client); // hello

  // Simulate an audio broadcast the way AudioBridge does (tag + payload),
  // interleaved with a scope line, and confirm each is tagged distinctly.
  const audioPayload = Buffer.from([9, 9, 9, 9]);
  server.broadcastBinary(Buffer.concat([Buffer.from([BINARY_TYPE.AUDIO]), audioPayload]));
  const audioMsg = await nextMessage(client);
  check(audioMsg.data[0] === BINARY_TYPE.AUDIO, 'audio frame tagged correctly');

  civ.emit('scope-line', {
    mode: SCOPE_MODE.CENTER,
    mainSub: 0,
    centerFreq: 7150000,
    span: 50000,
    points: Buffer.from([1]),
  });
  const scopeMsg = await nextMessage(client);
  check(scopeMsg.data[0] === BINARY_TYPE.SCOPE_LINE, 'scope frame tagged correctly, distinct from audio');

  client.close();
  await server.close();
}

async function testStartStop() {
  console.log('\n-- start()/stop() call through to the driver --');
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  await server.listen();
  const bridge = new ScopeBridge({ civ, controlServer: server });

  await bridge.start();
  check(civ.enableCalls === 1, 'start() calls civ.enableScopeOutput()');
  check(civ.setModeCalls.length === 1 && civ.setModeCalls[0] === SCOPE_MODE.CENTER, 'start() sets scope mode to Center');
  check(
    civ.centerScopeCalls.length === 0,
    "start() does NOT set a span at all — a real radio rejected (NG) a span-set attempted immediately after " +
      'enable, root cause unconfirmed; span-setting is now deferred entirely to client-triggered requests, ' +
      'which happen naturally later and can never affect server startup — see docs/civ-notes.md'
  );

  await bridge.stop();
  check(civ.disableCalls === 1, 'stop() calls civ.disableScopeOutput()');

  // After stop(), further scope-line events should not be broadcast (no listeners left).
  let gotLine = false;
  const originalBroadcast = server.broadcastBinary.bind(server);
  server.broadcastBinary = (...args) => {
    gotLine = true;
    originalBroadcast(...args);
  };
  civ.emit('scope-line', {
    mode: SCOPE_MODE.CENTER,
    mainSub: 0,
    centerFreq: 1,
    span: 1,
    points: Buffer.from([1]),
  });
  check(gotLine === false, 'no broadcast happens for scope-line events emitted after stop()');

  await server.close();
}

async function run() {
  await testCenterModeRoundTrip();
  await testFixedModeRoundTrip();
  await testAudioAndScopeCoexist();
  await testStartStop();

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
