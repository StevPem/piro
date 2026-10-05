'use strict';

// Run with: node test/ws-server.test.js
// Spins up a real ControlServer + real WebSocket client connections, but
// against a stub CivDriver so it needs no serial hardware.

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { ControlServer } = require('../src/server/ws-server');

class StubCivDriver extends EventEmitter {
  constructor() {
    super();
    this.radioAddr = 0x94;
    this._freq = 14195000;
    this._mode = { mode: 'USB', filter: 1 };
  }
  async getFrequency() {
    return this._freq;
  }
  async setFrequency(hz) {
    this._freq = hz;
    return true;
  }
  async getMode() {
    return this._mode;
  }
  async setMode(mode, filter = 1) {
    this._mode = { mode, filter };
    return true;
  }
  async setDataMode(on) {
    this._dataMode = on;
    return true;
  }
  async getDataMode() {
    return this._dataMode ?? false;
  }
  async setPtt(on) {
    this._ptt = on;
    return true;
  }
  async getSMeter() {
    return 120;
  }
  async tuneScopeToRange(lowHz, highHz) {
    this._lastScopeRange = { lowHz, highHz };
    return 500000; // pretend the driver clamped to the 500kHz preset
  }
  async centerScope(spanHz) {
    this._lastCenterScopeSpan = spanHz;
    return 250000; // pretend the driver clamped whatever was requested to the 250kHz preset
  }
  async setPreamp(value) {
    this._lastPreamp = value;
    return true;
  }
  async setNoiseReduction(on) {
    this._lastNoiseReduction = on;
    return true;
  }
  async setNoiseBlanker(on) {
    this._lastNoiseBlanker = on;
    return true;
  }
  async setNotch(on) {
    this._lastNotch = on;
    return true;
  }
  async setTuner(value) {
    this._lastTuner = value;
    return true;
  }
  async getPreamp() {
    return this._preampValue ?? 0;
  }
  async getNoiseReduction() {
    return this._noiseReductionValue ?? false;
  }
  async getNoiseBlanker() {
    return this._noiseBlankerValue ?? false;
  }
  async getNotch() {
    return this._notchValue ?? false;
  }
  async getTuner() {
    return this._tunerValue ?? 0;
  }
  async getSWR() {
    return this._swrValue ?? 0;
  }
  async setFilter(value) {
    this._lastFilter = value;
    return true;
  }
  async getFilter() {
    return this._filterValue ?? 1;
  }
  async setTxPower(watts) {
    this._lastTxPowerWatts = watts;
    return watts;
  }
  async getTxPower() {
    return this._txPowerWatts ?? 100;
  }
  async setRxGain(value) {
    this._lastRxGain = value;
    return value;
  }
  async getRxGain() {
    return this._rxGainValue ?? 255;
  }
}

// Attaching a 'message' listener only after awaiting 'open' is a real race
// on localhost: the server's messages can arrive and fire 'message' before
// anything is listening, and EventEmitter doesn't buffer for late
// listeners. So the 'message' handler here is wired up synchronously at
// socket creation time, queuing anything that arrives before nextMessage()
// is called to consume it.
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws._msgQueue = [];
    ws._msgWaiters = [];
    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (ws._msgWaiters.length) ws._msgWaiters.shift()(parsed);
      else ws._msgQueue.push(parsed);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws) {
  if (ws._msgQueue.length) return Promise.resolve(ws._msgQueue.shift());
  return new Promise((resolve) => ws._msgWaiters.push(resolve));
}

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`ok - ${msg}`);
  } else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

async function run() {
  const civ = new StubCivDriver();
  const server = new ControlServer({ civ, port: 0 });
  const port = await server.listen();

  const clientA = await connect(port);
  const helloA = await nextMessage(clientA);
  check(helloA.type === 'connected', 'new client receives an initial "connected" snapshot');
  check(
    helloA.data.frequency === 14195000,
    'listen() primes state.frequency from the radio before any client connects, so the first snapshot already has a real value'
  );
  check(
    helloA.data.mode && helloA.data.mode.mode === 'USB',
    'listen() primes state.mode from the radio before any client connects, so the first snapshot already has a real value'
  );
  check(helloA.data.screenTitle === 'SPARC PiRO', 'screenTitle defaults to "SPARC PiRO" when not configured');
  check(
    helloA.data.stationCallsign === null && helloA.data.stationGrid === null,
    'stationCallsign/stationGrid default to null when not configured'
  );
  check(
    helloA.data.ft8Active === false && helloA.data.freeDvActive === false,
    'ft8Active/freeDvActive default to false when nothing has armed either mode yet'
  );

  clientA.send(JSON.stringify({ id: '1', type: 'getFrequency' }));
  const freqReply = await nextMessage(clientA);
  check(
    freqReply.id === '1' && freqReply.ok === true && freqReply.data.value === 14195000,
    'getFrequency returns the driver value, correlated by id'
  );

  const clientB = await connect(port);
  await nextMessage(clientB); // clientB's own connected snapshot

  clientA.send(JSON.stringify({ id: '2', type: 'setFrequency', value: 7074000 }));
  const setReply = await nextMessage(clientA);
  check(setReply.id === '2' && setReply.ok === true, 'setFrequency acks directly to the requester');

  const broadcastToB = await nextMessage(clientB);
  check(
    broadcastToB.type === 'frequency' && broadcastToB.data.value === 7074000,
    'other connected clients are broadcast the change'
  );

  // Unsolicited event from the "radio" itself (e.g. operator turned the dial locally)
  const bothGetUnsolicited = Promise.all([nextMessage(clientA), nextMessage(clientB)]);
  civ.emit('frequency', 21074000);
  const [unsolA, unsolB] = await bothGetUnsolicited;
  check(
    unsolA.type === 'frequency' && unsolA.data.value === 21074000,
    'unsolicited radio events reach the original requester too'
  );
  check(
    unsolB.type === 'frequency' && unsolB.data.value === 21074000,
    'unsolicited radio events reach all other clients'
  );

  clientA.send(JSON.stringify({ id: '3', type: 'bogusRequestType' }));
  const errReply = await nextMessage(clientA);
  check(
    errReply.id === '3' && errReply.ok === false && typeof errReply.error === 'string',
    'unknown request type returns a correlated error reply'
  );

  clientA.send(JSON.stringify({ id: '4', type: 'setFrequency', value: 'not-a-number' }));
  const badValueReply = await nextMessage(clientA);
  check(
    badValueReply.id === '4' && badValueReply.ok === false,
    'invalid value type is rejected with an error, not thrown/crashed'
  );

  clientA.send(JSON.stringify({ id: '5', type: 'setScopeBand', lowHz: 7000000, highHz: 7300000 }));
  const scopeBandReply = await nextMessage(clientA);
  check(
    scopeBandReply.id === '5' && scopeBandReply.ok === true && scopeBandReply.data.span === 500000,
    'setScopeBand calls through to tuneScopeToRange and returns the applied span'
  );
  check(
    civ._lastScopeRange.lowHz === 7000000 && civ._lastScopeRange.highHz === 7300000,
    'setScopeBand passes the correct lowHz/highHz through to the driver'
  );

  clientA.send(JSON.stringify({ id: '6', type: 'setScopeBand', lowHz: 'nope' }));
  const badScopeBandReply = await nextMessage(clientA);
  check(
    badScopeBandReply.id === '6' && badScopeBandReply.ok === false,
    'setScopeBand rejects non-numeric lowHz/highHz with an error, not a crash'
  );

  clientA.send(JSON.stringify({ id: '7', type: 'setScopeSpan', spanHz: 200000 }));
  const scopeSpanReply = await nextMessage(clientA);
  check(
    scopeSpanReply.id === '7' && scopeSpanReply.ok === true && scopeSpanReply.data.span === 250000,
    'setScopeSpan calls through to civ.centerScope() and returns the applied span'
  );
  check(civ._lastCenterScopeSpan === 200000, 'setScopeSpan passes the requested spanHz through to the driver');

  clientA.send(JSON.stringify({ id: '8', type: 'setScopeSpan', spanHz: 'nope' }));
  const badScopeSpanReply = await nextMessage(clientA);
  check(
    badScopeSpanReply.id === '8' && badScopeSpanReply.ok === false,
    'setScopeSpan rejects a non-numeric spanHz with an error, not a crash'
  );

  clientA.send(JSON.stringify({ id: '9', type: 'setPreamp', value: 2 }));
  const preampReply = await nextMessage(clientA);
  check(
    preampReply.id === '9' && preampReply.ok === true && preampReply.data.value === 2 && civ._lastPreamp === 2,
    'setPreamp calls through to civ.setPreamp() and returns the applied value'
  );

  clientA.send(JSON.stringify({ id: '10', type: 'setPreamp', value: 3 }));
  const badPreampReply = await nextMessage(clientA);
  check(
    badPreampReply.id === '10' && badPreampReply.ok === false,
    'setPreamp rejects a value other than 0, 1, or 2 with an error, not a crash'
  );

  clientA.send(JSON.stringify({ id: '11', type: 'setNoiseReduction', on: true }));
  const nrReply = await nextMessage(clientA);
  check(
    nrReply.id === '11' && nrReply.ok === true && nrReply.data.on === true && civ._lastNoiseReduction === true,
    'setNoiseReduction calls through to civ.setNoiseReduction()'
  );

  clientA.send(JSON.stringify({ id: '12', type: 'setNoiseReduction', on: 'nope' }));
  const badNrReply = await nextMessage(clientA);
  check(badNrReply.id === '12' && badNrReply.ok === false, 'setNoiseReduction rejects a non-boolean "on"');

  clientA.send(JSON.stringify({ id: '13', type: 'setNoiseBlanker', on: true }));
  const nbReply = await nextMessage(clientA);
  check(
    nbReply.id === '13' && nbReply.ok === true && nbReply.data.on === true && civ._lastNoiseBlanker === true,
    'setNoiseBlanker calls through to civ.setNoiseBlanker()'
  );

  clientA.send(JSON.stringify({ id: '14', type: 'setNotch', on: true }));
  const notchReply = await nextMessage(clientA);
  check(
    notchReply.id === '14' && notchReply.ok === true && notchReply.data.on === true && civ._lastNotch === true,
    'setNotch calls through to civ.setNotch()'
  );

  clientA.send(JSON.stringify({ id: '15', type: 'setTuner', value: 1 }));
  const tunerReply = await nextMessage(clientA);
  check(
    tunerReply.id === '15' && tunerReply.ok === true && tunerReply.data.value === 1 && civ._lastTuner === 1,
    'setTuner calls through to civ.setTuner()'
  );

  clientA.send(JSON.stringify({ id: '16', type: 'setTuner', value: 2 }));
  const tuneNowReply = await nextMessage(clientA);
  check(
    tuneNowReply.id === '16' && tuneNowReply.ok === true && tuneNowReply.data.value === 2 && civ._lastTuner === 2,
    'setTuner with value 2 (start tuning now) calls through correctly'
  );

  clientA.send(JSON.stringify({ id: '17', type: 'setTuner', value: 5 }));
  const badTunerReply = await nextMessage(clientA);
  check(
    badTunerReply.id === '17' && badTunerReply.ok === false,
    'setTuner rejects a value other than 0, 1, or 2 with an error, not a crash'
  );

  // setDataMode: the IC-7300 "DATA MODE" toggle FT8 mode entry now relies
  // on (see app.js's enterFt8Mode()/exitFt8Mode() and civ/driver.js's
  // setDataMode() doc comment for why this is genuinely separate from
  // setMode('USB')). Also verifies it broadcasts to other clients, same
  // as setMode does, so a second connected client's UI stays in sync.
  const dataModeBroadcast = nextMessage(clientB);
  clientA.send(JSON.stringify({ id: '18', type: 'setDataMode', on: true }));
  const dataModeReply = await nextMessage(clientA);
  check(
    dataModeReply.id === '18' && dataModeReply.ok === true && dataModeReply.data.on === true && civ._dataMode === true,
    'setDataMode calls through to civ.setDataMode() and returns the applied value'
  );
  const dataModeBroadcastMsg = await dataModeBroadcast;
  check(
    dataModeBroadcastMsg.type === 'data-mode' && dataModeBroadcastMsg.data.on === true,
    'setDataMode broadcasts the change to other connected clients'
  );

  clientA.send(JSON.stringify({ id: '19', type: 'setDataMode', on: 'nope' }));
  const badDataModeReply = await nextMessage(clientA);
  check(badDataModeReply.id === '19' && badDataModeReply.ok === false, 'setDataMode rejects a non-boolean "on"');

  clientA.send(JSON.stringify({ id: '20', type: 'getDataMode' }));
  const getDataModeReply = await nextMessage(clientA);
  check(
    getDataModeReply.id === '20' && getDataModeReply.ok === true && getDataModeReply.data.on === true,
    'getDataMode returns the driver value'
  );

  civ._preampValue = 2;
  civ._noiseReductionValue = true;
  civ._noiseBlankerValue = true;
  civ._notchValue = true;
  civ._tunerValue = 1;

  clientA.send(JSON.stringify({ id: '18', type: 'getPreamp' }));
  const preampGetReply = await nextMessage(clientA);
  check(
    preampGetReply.id === '18' && preampGetReply.ok === true && preampGetReply.data.value === 2,
    'getPreamp calls through to civ.getPreamp() and returns the actual value'
  );

  clientA.send(JSON.stringify({ id: '19', type: 'getNoiseReduction' }));
  const nrGetReply = await nextMessage(clientA);
  check(
    nrGetReply.id === '19' && nrGetReply.ok === true && nrGetReply.data.on === true,
    'getNoiseReduction calls through to civ.getNoiseReduction()'
  );

  clientA.send(JSON.stringify({ id: '20', type: 'getNoiseBlanker' }));
  const nbGetReply = await nextMessage(clientA);
  check(
    nbGetReply.id === '20' && nbGetReply.ok === true && nbGetReply.data.on === true,
    'getNoiseBlanker calls through to civ.getNoiseBlanker()'
  );

  clientA.send(JSON.stringify({ id: '21', type: 'getNotch' }));
  const notchGetReply = await nextMessage(clientA);
  check(
    notchGetReply.id === '21' && notchGetReply.ok === true && notchGetReply.data.on === true,
    'getNotch calls through to civ.getNotch()'
  );

  clientA.send(JSON.stringify({ id: '22', type: 'getTuner' }));
  const tunerGetReply = await nextMessage(clientA);
  check(
    tunerGetReply.id === '22' && tunerGetReply.ok === true && tunerGetReply.data.value === 1,
    'getTuner calls through to civ.getTuner()'
  );

  civ._swrValue = 48;
  clientA.send(JSON.stringify({ id: '23', type: 'getSWR' }));
  const swrGetReply = await nextMessage(clientA);
  check(
    swrGetReply.id === '23' && swrGetReply.ok === true && swrGetReply.data.value === 48,
    'getSWR calls through to civ.getSWR()'
  );

  clientA.send(JSON.stringify({ id: '24', type: 'setFilter', value: 2 }));
  const filterSetReply = await nextMessage(clientA);
  check(
    filterSetReply.id === '24' && filterSetReply.ok === true && filterSetReply.data.value === 2 && civ._lastFilter === 2,
    'setFilter calls through to civ.setFilter()'
  );

  clientA.send(JSON.stringify({ id: '25', type: 'setFilter', value: 4 }));
  const badFilterReply = await nextMessage(clientA);
  check(
    badFilterReply.id === '25' && badFilterReply.ok === false,
    'setFilter rejects a value other than 1, 2, or 3 with an error, not a crash'
  );

  civ._filterValue = 3;
  clientA.send(JSON.stringify({ id: '26', type: 'getFilter' }));
  const filterGetReply = await nextMessage(clientA);
  check(
    filterGetReply.id === '26' && filterGetReply.ok === true && filterGetReply.data.value === 3,
    'getFilter calls through to civ.getFilter()'
  );

  clientA.send(JSON.stringify({ id: '27', type: 'setTxPower', watts: 75 }));
  const txPowerSetReply = await nextMessage(clientA);
  check(
    txPowerSetReply.id === '27' &&
      txPowerSetReply.ok === true &&
      txPowerSetReply.data.watts === 75 &&
      civ._lastTxPowerWatts === 75,
    'setTxPower calls through to civ.setTxPower()'
  );

  clientA.send(JSON.stringify({ id: '28', type: 'setTxPower', watts: 'nope' }));
  const badTxPowerReply = await nextMessage(clientA);
  check(
    badTxPowerReply.id === '28' && badTxPowerReply.ok === false,
    'setTxPower rejects a non-numeric watts with an error, not a crash'
  );

  civ._txPowerWatts = 50;
  clientA.send(JSON.stringify({ id: '29', type: 'getTxPower' }));
  const txPowerGetReply = await nextMessage(clientA);
  check(
    txPowerGetReply.id === '29' && txPowerGetReply.ok === true && txPowerGetReply.data.watts === 50,
    'getTxPower calls through to civ.getTxPower()'
  );

  clientA.send(JSON.stringify({ id: '30', type: 'setRxGain', value: 128 }));
  const rxGainSetReply = await nextMessage(clientA);
  check(
    rxGainSetReply.id === '30' &&
      rxGainSetReply.ok === true &&
      rxGainSetReply.data.value === 128 &&
      civ._lastRxGain === 128,
    'setRxGain calls through to civ.setRxGain()'
  );

  clientA.send(JSON.stringify({ id: '31', type: 'setRxGain', value: 300 }));
  const badRxGainReply = await nextMessage(clientA);
  check(
    badRxGainReply.id === '31' && badRxGainReply.ok === false,
    'setRxGain rejects a value outside 0-255 with an error, not a crash'
  );

  civ._rxGainValue = 90;
  clientA.send(JSON.stringify({ id: '32', type: 'getRxGain' }));
  const rxGainGetReply = await nextMessage(clientA);
  check(
    rxGainGetReply.id === '32' && rxGainGetReply.ok === true && rxGainGetReply.data.value === 90,
    'getRxGain calls through to civ.getRxGain()'
  );

  // --- setFt8Active / sendFt8: validate input and emit internal events for Ft8Bridge to consume ---
  {
    const seenActive = [];
    const onActive = (active) => seenActive.push(active);
    server.on('ft8-active', onActive);

    clientA.send(JSON.stringify({ id: '33', type: 'setFt8Active', active: true }));
    const activeReply = await nextMessage(clientA);
    check(
      activeReply.id === '33' && activeReply.ok === true && activeReply.data.active === true,
      'setFt8Active acks with the requested active value'
    );
    check(seenActive.length === 1 && seenActive[0] === true, "setFt8Active emits an internal 'ft8-active' event for Ft8Bridge to consume");
    check(server.state.ft8Active === true, 'setFt8Active is cached in server.state.ft8Active, so a newly-connecting client\'s snapshot reflects it');
    server.off('ft8-active', onActive);
  }

  clientA.send(JSON.stringify({ id: '34', type: 'setFt8Active', active: 'nope' }));
  const badActiveReply = await nextMessage(clientA);
  check(
    badActiveReply.id === '34' && badActiveReply.ok === false,
    'setFt8Active rejects a non-boolean "active" with an error, not a crash'
  );

  {
    const seenSend = [];
    const onSend = (payload) => seenSend.push(payload);
    server.on('ft8-send', onSend);

    clientA.send(JSON.stringify({ id: '35', type: 'sendFt8', message: 'CQ VK2IO QF56' }));
    const sendReply = await nextMessage(clientA);
    check(
      sendReply.id === '35' && sendReply.ok === true && sendReply.data.accepted === true,
      'sendFt8 acks with accepted: true'
    );
    check(
      seenSend.length === 1 && seenSend[0].message === 'CQ VK2IO QF56' && seenSend[0].freqHz === undefined,
      "sendFt8 emits an internal 'ft8-send' event carrying {message, freqHz} for Ft8Bridge to consume, with freqHz undefined when not given"
    );
    server.off('ft8-send', onSend);
  }

  {
    // freqHz lets a guided QSO reply (src/client/ft8-qso.js) target the
    // specific audio frequency the other station is actually listening
    // on, rather than always Ft8Bridge's fixed default.
    const seenSend = [];
    const onSend = (payload) => seenSend.push(payload);
    server.on('ft8-send', onSend);

    clientA.send(JSON.stringify({ id: '35b', type: 'sendFt8', message: 'VK2IO VK3XU R-08', freqHz: 1523 }));
    const sendReply = await nextMessage(clientA);
    check(sendReply.id === '35b' && sendReply.ok === true, 'sendFt8 with a freqHz still acks normally');
    check(
      seenSend.length === 1 && seenSend[0].freqHz === 1523,
      "an explicit freqHz is passed through on the 'ft8-send' event"
    );
    server.off('ft8-send', onSend);
  }

  clientA.send(JSON.stringify({ id: '35c', type: 'sendFt8', message: 'CQ VK2IO QF56', freqHz: 'loud' }));
  const badFreqSendReply = await nextMessage(clientA);
  check(
    badFreqSendReply.id === '35c' && badFreqSendReply.ok === false,
    'sendFt8 rejects a non-numeric freqHz with an error, not a crash'
  );

  clientA.send(JSON.stringify({ id: '36', type: 'sendFt8', message: '' }));
  const emptySendReply = await nextMessage(clientA);
  check(
    emptySendReply.id === '36' && emptySendReply.ok === false,
    'sendFt8 rejects an empty/blank message with an error, not a crash'
  );

  clientA.send(JSON.stringify({ id: '37', type: 'sendFt8', message: 42 }));
  const nonStringSendReply = await nextMessage(clientA);
  check(
    nonStringSendReply.id === '37' && nonStringSendReply.ok === false,
    'sendFt8 rejects a non-string message with an error, not a crash'
  );

  // --- setPskSpotEnabled: the "PSK Spot" checkbox — internal event for Ft8Bridge/psk-reporter.js, plus state + broadcast like setDataMode ---
  {
    check(server.state.pskSpotEnabled === true, 'pskSpotEnabled defaults to true, per the original "enabled by default" request');

    const seenEnabled = [];
    const onEnabled = (enabled) => seenEnabled.push(enabled);
    server.on('psk-spot-enabled', onEnabled);

    const pskSpotBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '38', type: 'setPskSpotEnabled', enabled: false }));
    const pskSpotReply = await nextMessage(clientA);
    check(
      pskSpotReply.id === '38' && pskSpotReply.ok === true && pskSpotReply.data.enabled === false && server.state.pskSpotEnabled === false,
      'setPskSpotEnabled updates state and acks with the applied value'
    );
    check(
      seenEnabled.length === 1 && seenEnabled[0] === false,
      "setPskSpotEnabled emits an internal 'psk-spot-enabled' event for Ft8Bridge to consume"
    );
    const pskSpotBroadcastMsg = await pskSpotBroadcast;
    check(
      pskSpotBroadcastMsg.type === 'psk-spot-enabled' && pskSpotBroadcastMsg.data.enabled === false,
      'setPskSpotEnabled broadcasts the change to other connected clients'
    );
    server.off('psk-spot-enabled', onEnabled);
  }

  clientA.send(JSON.stringify({ id: '39', type: 'setPskSpotEnabled', enabled: 'nope' }));
  const badPskSpotReply = await nextMessage(clientA);
  check(badPskSpotReply.id === '39' && badPskSpotReply.ok === false, 'setPskSpotEnabled rejects a non-boolean "enabled" with an error, not a crash');

  // --- setFt8Variant: the FT8/FT4 toggle — internal event for Ft8Bridge to consume, plus state + broadcast like setPskSpotEnabled ---
  {
    check(server.state.ft8Variant === 'FT8', 'ft8Variant defaults to "FT8"');

    const seenVariants = [];
    const onVariant = (variant) => seenVariants.push(variant);
    server.on('ft8-variant', onVariant);

    const variantBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '40', type: 'setFt8Variant', variant: 'FT4' }));
    const variantReply = await nextMessage(clientA);
    check(
      variantReply.id === '40' && variantReply.ok === true && variantReply.data.variant === 'FT4' && server.state.ft8Variant === 'FT4',
      'setFt8Variant updates state and acks with the applied value'
    );
    check(
      seenVariants.length === 1 && seenVariants[0] === 'FT4',
      "setFt8Variant emits an internal 'ft8-variant' event for Ft8Bridge to consume"
    );
    const variantBroadcastMsg = await variantBroadcast;
    check(
      variantBroadcastMsg.type === 'ft8-variant' && variantBroadcastMsg.data.variant === 'FT4',
      'setFt8Variant broadcasts the change to other connected clients'
    );
    server.off('ft8-variant', onVariant);
  }

  clientA.send(JSON.stringify({ id: '41', type: 'setFt8Variant', variant: 'WSPR' }));
  const badVariantReply = await nextMessage(clientA);
  check(badVariantReply.id === '41' && badVariantReply.ok === false, 'setFt8Variant rejects anything other than "FT8"/"FT4" with an error, not a crash');

  // --- setFreeDvActive: internal event for RadeBridge to consume, and cached in server.state (mirrors setFt8Active exactly) — NOT broadcast to other already-connected clients ---
  {
    const seenActive = [];
    const onActive = (active) => seenActive.push(active);
    server.on('freedv-active', onActive);

    clientA.send(JSON.stringify({ id: '41b', type: 'setFreeDvActive', active: true }));
    const activeReply = await nextMessage(clientA);
    check(
      activeReply.id === '41b' && activeReply.ok === true && activeReply.data.active === true,
      'setFreeDvActive acks with the requested active value'
    );
    check(
      seenActive.length === 1 && seenActive[0] === true,
      "setFreeDvActive emits an internal 'freedv-active' event for RadeBridge to consume"
    );
    check(server.state.freeDvActive === true, 'setFreeDvActive is cached in server.state.freeDvActive, so a newly-connecting client\'s snapshot reflects it');
    server.off('freedv-active', onActive);
  }

  clientA.send(JSON.stringify({ id: '41c', type: 'setFreeDvActive', active: 'nope' }));
  const badFreeDvActiveReply = await nextMessage(clientA);
  check(
    badFreeDvActiveReply.id === '41c' && badFreeDvActiveReply.ok === false,
    'setFreeDvActive rejects a non-boolean "active" with an error, not a crash'
  );

  // --- setFreeDvVariant: internal event for RadeBridge to consume, plus state + broadcast like setFt8Variant. The client's own '700E' UI toggle was removed (see ws-server.js's state.freeDvVariant doc comment), but the request/state still accept it. ---
  {
    check(server.state.freeDvVariant === 'RADE', 'freeDvVariant defaults to "RADE" (not "700E" — the client can no longer select it)');

    const seenVariants = [];
    const onVariant = (variant) => seenVariants.push(variant);
    server.on('freedv-variant', onVariant);

    const variantBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '41d', type: 'setFreeDvVariant', variant: 'RADE' }));
    const variantReply = await nextMessage(clientA);
    check(
      variantReply.id === '41d' && variantReply.ok === true && variantReply.data.variant === 'RADE' && server.state.freeDvVariant === 'RADE',
      'setFreeDvVariant updates state and acks with the applied value'
    );
    check(
      seenVariants.length === 1 && seenVariants[0] === 'RADE',
      "setFreeDvVariant emits an internal 'freedv-variant' event for RadeBridge to consume"
    );
    const variantBroadcastMsg = await variantBroadcast;
    check(
      variantBroadcastMsg.type === 'freedv-variant' && variantBroadcastMsg.data.variant === 'RADE',
      'setFreeDvVariant broadcasts the change to other connected clients'
    );
    server.off('freedv-variant', onVariant);
  }

  clientA.send(JSON.stringify({ id: '41e', type: 'setFreeDvVariant', variant: '2400' }));
  const badFreeDvVariantReply = await nextMessage(clientA);
  check(
    badFreeDvVariantReply.id === '41e' && badFreeDvVariantReply.ok === false,
    'setFreeDvVariant rejects anything other than "700E"/"RADE" with an error, not a crash'
  );

  // --- setFreeDvSpotEnabled: the "FreeDV spot" checkbox — internal event for FreeDvReporterBridge to consume, plus state + broadcast like setPskSpotEnabled ---
  {
    check(
      server.state.freeDvSpotEnabled === false,
      'freeDvSpotEnabled defaults to false, unlike pskSpotEnabled — opt-in, per the original "should be unselected by default" request'
    );

    const seenEnabled = [];
    const onEnabled = (enabled) => seenEnabled.push(enabled);
    server.on('freedv-spot-enabled', onEnabled);

    const freeDvSpotBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '41f', type: 'setFreeDvSpotEnabled', enabled: true }));
    const freeDvSpotReply = await nextMessage(clientA);
    check(
      freeDvSpotReply.id === '41f' &&
        freeDvSpotReply.ok === true &&
        freeDvSpotReply.data.enabled === true &&
        server.state.freeDvSpotEnabled === true,
      'setFreeDvSpotEnabled updates state and acks with the applied value'
    );
    check(
      seenEnabled.length === 1 && seenEnabled[0] === true,
      "setFreeDvSpotEnabled emits an internal 'freedv-spot-enabled' event for FreeDvReporterBridge to consume"
    );
    const freeDvSpotBroadcastMsg = await freeDvSpotBroadcast;
    check(
      freeDvSpotBroadcastMsg.type === 'freedv-spot-enabled' && freeDvSpotBroadcastMsg.data.enabled === true,
      'setFreeDvSpotEnabled broadcasts the change to other connected clients'
    );
    server.off('freedv-spot-enabled', onEnabled);
  }

  clientA.send(JSON.stringify({ id: '41g', type: 'setFreeDvSpotEnabled', enabled: 'nope' }));
  const badFreeDvSpotReply = await nextMessage(clientA);
  check(
    badFreeDvSpotReply.id === '41g' && badFreeDvSpotReply.ok === false,
    'setFreeDvSpotEnabled rejects a non-boolean "enabled" with an error, not a crash'
  );

  // --- setRnnoiseLevel: the 5-state "RNN" button (replaces the old NB button, and before that a plain on/off checkbox) — internal event for AudioBridge to consume, plus state + broadcast like setFreeDvSpotEnabled ---
  {
    check(
      server.state.rnnoiseLevel === 0,
      'rnnoiseLevel defaults to 0 ("RNN Off") — opt-in, same reasoning as freeDvSpotEnabled'
    );

    const seenLevels = [];
    const onLevel = (level) => seenLevels.push(level);
    server.on('rnnoise-level', onLevel);

    const rnnoiseBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '44f', type: 'setRnnoiseLevel', level: 2 }));
    const rnnoiseReply = await nextMessage(clientA);
    check(
      rnnoiseReply.id === '44f' &&
        rnnoiseReply.ok === true &&
        rnnoiseReply.data.level === 2 &&
        server.state.rnnoiseLevel === 2,
      'setRnnoiseLevel updates state and acks with the applied value'
    );
    check(
      seenLevels.length === 1 && seenLevels[0] === 2,
      "setRnnoiseLevel emits an internal 'rnnoise-level' event for AudioBridge to consume"
    );
    const rnnoiseBroadcastMsg = await rnnoiseBroadcast;
    check(
      rnnoiseBroadcastMsg.type === 'rnnoise-level' && rnnoiseBroadcastMsg.data.level === 2,
      'setRnnoiseLevel broadcasts the change to other connected clients'
    );

    // Drop it back to 0, confirming both directions are wired, not just a non-zero level.
    const rnnoiseOffBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '44g', type: 'setRnnoiseLevel', level: 0 }));
    const rnnoiseOffReply = await nextMessage(clientA);
    check(
      rnnoiseOffReply.id === '44g' && rnnoiseOffReply.ok === true && server.state.rnnoiseLevel === 0,
      'setRnnoiseLevel(0) updates state back and acks'
    );
    check(
      seenLevels.length === 2 && seenLevels[1] === 0,
      "setRnnoiseLevel(0) also emits the internal 'rnnoise-level' event"
    );
    const rnnoiseOffBroadcastMsg = await rnnoiseOffBroadcast;
    check(
      rnnoiseOffBroadcastMsg.type === 'rnnoise-level' && rnnoiseOffBroadcastMsg.data.level === 0,
      'setRnnoiseLevel(0) broadcasts the change to other connected clients too'
    );

    server.off('rnnoise-level', onLevel);
  }

  clientA.send(JSON.stringify({ id: '44h', type: 'setRnnoiseLevel', level: 'nope' }));
  const badRnnoiseReply = await nextMessage(clientA);
  check(
    badRnnoiseReply.id === '44h' && badRnnoiseReply.ok === false,
    'setRnnoiseLevel rejects a non-integer "level" with an error, not a crash'
  );

  clientA.send(JSON.stringify({ id: '44i', type: 'setRnnoiseLevel', level: 5 }));
  const outOfRangeRnnoiseReply = await nextMessage(clientA);
  check(
    outOfRangeRnnoiseReply.id === '44i' && outOfRangeRnnoiseReply.ok === false,
    'setRnnoiseLevel rejects an out-of-range "level" (5) with an error, not a crash'
  );

  // --- sendJsonEvent: pushes a JSON event to one specific client, not a broadcast — the mechanism a server-side bridge can use to give a newly-connecting client its current state ---
  {
    const serverSideSockets = [...server.clients];
    check(serverSideSockets.length === 2, 'sanity: two clients (A, B) currently connected server-side');
    const [serverSideA] = serverSideSockets; // clientA connected first

    const clientAGetsIt = nextMessage(clientA);
    server.sendJsonEvent(serverSideA, 'rig-error', { message: 'boom' });
    const receivedByA = await clientAGetsIt;
    check(
      receivedByA.type === 'rig-error' && receivedByA.data.message === 'boom',
      'sendJsonEvent() delivers the event to the targeted client'
    );

    // clientB must NOT have received it. Rather than registering a waiter
    // for clientB's "next message" (which would then steal a later,
    // unrelated broadcast this test file expects elsewhere), just give
    // any stray delivery a moment to arrive and inspect its raw queue
    // directly.
    await new Promise((resolve) => setTimeout(resolve, 150));
    check(clientB._msgQueue.length === 0, 'sendJsonEvent() does not broadcast to other connected clients');
  }

  // --- setFreeDvMessage: the FreeDV Reporter status message — persistent (state + broadcast) ---
  {
    check(server.state.freeDvMessage === '', 'freeDvMessage defaults to the empty string (no status message set)');

    const seenMessages = [];
    const onMessage = (message) => seenMessages.push(message);
    server.on('freedv-message', onMessage);

    const freeDvMessageBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '43a', type: 'setFreeDvMessage', message: 'Looking for contacts' }));
    const freeDvMessageReply = await nextMessage(clientA);
    check(
      freeDvMessageReply.id === '43a' &&
        freeDvMessageReply.ok === true &&
        freeDvMessageReply.data.message === 'Looking for contacts' &&
        server.state.freeDvMessage === 'Looking for contacts',
      'setFreeDvMessage updates state and acks with the applied value'
    );
    check(
      seenMessages.length === 1 && seenMessages[0] === 'Looking for contacts',
      "setFreeDvMessage emits an internal 'freedv-message' event for FreeDvReporterBridge to consume"
    );
    const freeDvMessageBroadcastMsg = await freeDvMessageBroadcast;
    check(
      freeDvMessageBroadcastMsg.type === 'freedv-message' &&
        freeDvMessageBroadcastMsg.data.message === 'Looking for contacts',
      'setFreeDvMessage broadcasts the change to other connected clients'
    );

    // Empty string clears it, per the protocol's own documented behavior.
    // Consumes clientB's broadcast for this change too (not just clientA's
    // reply) so clientB's message queue doesn't end up with a leftover
    // message that would desync a later test's nextMessage(clientB) call.
    const freeDvMessageClearBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '43b', type: 'setFreeDvMessage', message: '' }));
    const clearedReply = await nextMessage(clientA);
    check(
      clearedReply.ok === true && clearedReply.data.message === '' && server.state.freeDvMessage === '',
      'setFreeDvMessage with an empty string clears the cached message'
    );
    const freeDvMessageClearBroadcastMsg = await freeDvMessageClearBroadcast;
    check(
      freeDvMessageClearBroadcastMsg.type === 'freedv-message' && freeDvMessageClearBroadcastMsg.data.message === '',
      'setFreeDvMessage broadcasts the cleared message too'
    );

    server.off('freedv-message', onMessage);
  }

  clientA.send(JSON.stringify({ id: '43c', type: 'setFreeDvMessage', message: 42 }));
  const badMessageReply = await nextMessage(clientA);
  check(
    badMessageReply.id === '43c' && badMessageReply.ok === false,
    'setFreeDvMessage rejects a non-string "message" with an error, not a crash'
  );

  // --- setRttyReversed: the RTTY "Reverse" checkbox — internal event for RttyDecoderBridge to consume, plus state + broadcast like setFreeDvSpotEnabled ---
  {
    check(
      server.state.rttyReversed === false,
      'rttyReversed defaults to false — a signal already decoding fine shouldn\'t need touching'
    );

    const seenReversed = [];
    const onReversed = (reversed) => seenReversed.push(reversed);
    server.on('rtty-reversed', onReversed);

    const rttyReversedBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '44a', type: 'setRttyReversed', reversed: true }));
    const rttyReversedReply = await nextMessage(clientA);
    check(
      rttyReversedReply.id === '44a' &&
        rttyReversedReply.ok === true &&
        rttyReversedReply.data.reversed === true &&
        server.state.rttyReversed === true,
      'setRttyReversed updates state and acks with the applied value'
    );
    check(
      seenReversed.length === 1 && seenReversed[0] === true,
      "setRttyReversed emits an internal 'rtty-reversed' event for RttyDecoderBridge to consume"
    );
    const rttyReversedBroadcastMsg = await rttyReversedBroadcast;
    check(
      rttyReversedBroadcastMsg.type === 'rtty-reversed' && rttyReversedBroadcastMsg.data.reversed === true,
      'setRttyReversed broadcasts the change to other connected clients'
    );

    // Toggle back off, so it doesn't leak into later parts of this test
    // (like the "newly-connecting client's initial snapshot" block below,
    // which only asserts on ft8Active/freeDvActive and would otherwise be
    // fine either way, but leaving it on isn't representative of the
    // common case).
    const rttyReversedOffBroadcast = nextMessage(clientB);
    clientA.send(JSON.stringify({ id: '44b', type: 'setRttyReversed', reversed: false }));
    await nextMessage(clientA);
    await rttyReversedOffBroadcast;

    server.off('rtty-reversed', onReversed);
  }

  clientA.send(JSON.stringify({ id: '44c', type: 'setRttyReversed', reversed: 'nope' }));
  const badRttyReversedReply = await nextMessage(clientA);
  check(
    badRttyReversedReply.id === '44c' && badRttyReversedReply.ok === false,
    'setRttyReversed rejects a non-boolean "reversed" with an error, not a crash'
  );

  // --- A newly-connecting client's initial snapshot reflects FT8/FreeDV "armed" state ---
  // ft8Active and freeDvActive were both set true earlier in this test
  // (setFt8Active/setFreeDvActive above) — this checks that state a client
  // connecting *after* that actually sees it, the gap the original request
  // was about (armed state is a server-side setting, not anything CI-V
  // reports, so this snapshot is the only way a new client finds out).
  {
    const clientC = await connect(port);
    const helloC = await nextMessage(clientC);
    check(
      helloC.type === 'connected' && helloC.data.ft8Active === true && helloC.data.freeDvActive === true,
      "a client connecting after FT8/FreeDV were armed sees ft8Active: true and freeDvActive: true in its initial 'connected' snapshot"
    );
    clientC.close();
  }

  // --- setPttFromServer: the extracted helper used by both the setPtt request handler and Ft8Bridge's own TX ---
  {
    const bothSeePtt = Promise.all([nextMessage(clientA), nextMessage(clientB)]);
    await server.setPttFromServer(true);
    const [pttA, pttB] = await bothSeePtt;
    check(civ._ptt === true, 'setPttFromServer actually engages PTT on the radio');
    check(
      pttA.type === 'ptt' && pttA.data.value === true && pttB.type === 'ptt' && pttB.data.value === true,
      'setPttFromServer broadcasts a "ptt" event to all connected clients, same as a client-initiated setPtt request'
    );
    await server.setPttFromServer(false);
    await Promise.all([nextMessage(clientA), nextMessage(clientB)]); // drain the release broadcast
    check(civ._ptt === false, 'setPttFromServer can also release PTT');
  }

  clientA.close();
  clientB.close();
  await server.close();

  // A custom screenTitle option is respected, in a fresh server instance.
  {
    const customCiv = new StubCivDriver();
    const customServer = new ControlServer({
      civ: customCiv,
      port: 0,
      screenTitle: 'My Custom Title',
      stationCallsign: 'vk2io',
      stationGrid: 'qf56mc',
    });
    const customPort = await customServer.listen();
    const customClient = await connect(customPort);
    const hello = await nextMessage(customClient);
    check(hello.data.screenTitle === 'My Custom Title', 'a custom screenTitle option is passed through to new clients');
    check(
      hello.data.stationCallsign === 'vk2io' && hello.data.stationGrid === 'qf56mc',
      'custom stationCallsign/stationGrid options are passed through to new clients verbatim (case as configured)'
    );
    customClient.close();
    await customServer.close();
  }

  // The "RNN" button's level COUNT is configurable (driven by how many
  // comma-separated ratios src/server/index.js parses out of RNNOISE_WET
  // and passes through as rnnoiseLevelCount) rather than hardcoded at 5 —
  // this checks both the default and a custom count actually reach the
  // client, and that SET_RNNOISE_LEVEL's validation range tracks it.
  {
    const defaultCiv = new StubCivDriver();
    const defaultServer = new ControlServer({ civ: defaultCiv, port: 0 });
    const defaultPort = await defaultServer.listen();
    const defaultClient = await connect(defaultPort);
    const defaultHello = await nextMessage(defaultClient);
    check(defaultHello.data.rnnoiseLevelCount === 5, 'rnnoiseLevelCount defaults to 5 (Off + the original 4 wet ratios) when not configured');
    defaultClient.close();
    await defaultServer.close();

    const customCiv2 = new StubCivDriver();
    const customServer2 = new ControlServer({ civ: customCiv2, port: 0, rnnoiseLevelCount: 3 });
    const customPort2 = await customServer2.listen();
    const customClient2 = await connect(customPort2);
    const customHello2 = await nextMessage(customClient2);
    check(customHello2.data.rnnoiseLevelCount === 3, 'a custom rnnoiseLevelCount (e.g. from a shorter RNNOISE_WET list) is passed through to new clients');

    customClient2.send(JSON.stringify({ id: 'rnn1', type: 'setRnnoiseLevel', level: 2 }));
    const okReply = await nextMessage(customClient2);
    check(okReply.id === 'rnn1' && okReply.ok === true, 'with rnnoiseLevelCount=3, level 2 (the max valid level) is accepted');

    customClient2.send(JSON.stringify({ id: 'rnn2', type: 'setRnnoiseLevel', level: 3 }));
    const rejectReply = await nextMessage(customClient2);
    check(
      rejectReply.id === 'rnn2' && rejectReply.ok === false,
      'with rnnoiseLevelCount=3, level 3 is rejected — validation range tracks the configured count, not a hardcoded 0-4'
    );

    customClient2.close();
    await customServer2.close();
  }

  // listen()'s startup priming is best-effort: a civ driver that doesn't
  // implement getFrequency()/getMode() at all (as some of this test suite's
  // other stub drivers don't, since they only implement what their own
  // tests need) must not crash listen() — it should just fall back to the
  // constructor's null placeholders, same as before this fix.
  {
    class MinimalCivDriver extends EventEmitter {}
    const minimalCiv = new MinimalCivDriver();
    const minimalServer = new ControlServer({ civ: minimalCiv, port: 0 });
    const minimalPort = await minimalServer.listen();
    const minimalClient = await connect(minimalPort);
    const minimalHello = await nextMessage(minimalClient);
    check(
      minimalHello.data.frequency === null && minimalHello.data.mode === null,
      "listen() doesn't crash against a civ driver with no getFrequency()/getMode(), and just leaves state null"
    );
    minimalClient.close();
    await minimalServer.close();
  }

  // PTT fail-safe watchdog (10-minute cutoff in production; a short
  // override here so the test doesn't take 10 real minutes — see
  // docs/civ-notes.md for why this lives server-side).
  {
    const watchdogCiv = new StubCivDriver();
    const watchdogServer = new ControlServer({ civ: watchdogCiv, port: 0, pttWatchdogMs: 80 });
    const watchdogPort = await watchdogServer.listen();
    const client = await connect(watchdogPort);
    await nextMessage(client); // connected snapshot

    // Engage PTT and let the watchdog expire without ever releasing it.
    client.send(JSON.stringify({ id: '1', type: 'setPtt', value: true }));
    await nextMessage(client); // the setPtt result (the originating client is excluded from the broadcast echo)
    check(watchdogCiv._ptt === true, 'PTT is actually engaged on the (stub) radio');

    const timeoutEvent = await nextMessage(client);
    check(timeoutEvent.type === 'ptt-timeout', `watchdog fires a 'ptt-timeout' event after the timeout elapses, got type=${timeoutEvent.type}`);
    check(timeoutEvent.data.pttWatchdogMs === 80, 'the event reports the configured watchdog duration');
    const forcedOffEvent = await nextMessage(client);
    check(
      forcedOffEvent.type === 'ptt' && forcedOffEvent.data.value === false,
      'a \'ptt\' event confirming the forced release follows the timeout event'
    );
    check(watchdogCiv._ptt === false, 'the watchdog actually forced PTT off on the (stub) radio, not just in cached state');

    client.close();
    await watchdogServer.close();
  }

  // A normal release before the watchdog elapses cancels it — no
  // spurious timeout event should ever arrive.
  {
    const watchdogCiv = new StubCivDriver();
    const watchdogServer = new ControlServer({ civ: watchdogCiv, port: 0, pttWatchdogMs: 80 });
    const watchdogPort = await watchdogServer.listen();
    const client = await connect(watchdogPort);
    await nextMessage(client); // connected snapshot

    client.send(JSON.stringify({ id: '1', type: 'setPtt', value: true }));
    await nextMessage(client);
    client.send(JSON.stringify({ id: '2', type: 'setPtt', value: false }));
    await nextMessage(client);

    let sawSpuriousTimeout = false;
    const listener = (msg) => {
      if (msg.type === 'ptt-timeout') sawSpuriousTimeout = true;
    };
    client.on('message', (raw) => listener(JSON.parse(raw.toString())));
    await new Promise((resolve) => setTimeout(resolve, 150)); // longer than the 80ms watchdog window
    check(!sawSpuriousTimeout, 'releasing PTT normally before the watchdog elapses cancels it — no timeout event fires later');

    client.close();
    await watchdogServer.close();
  }

  // CW-style rapid on/off/on toggling (simulating keying) never trips
  // the watchdog, since each release cancels and re-arms it fresh —
  // only one truly continuous transmission accumulates toward the limit.
  {
    const watchdogCiv = new StubCivDriver();
    const watchdogServer = new ControlServer({ civ: watchdogCiv, port: 0, pttWatchdogMs: 80 });
    const watchdogPort = await watchdogServer.listen();
    const client = await connect(watchdogPort);
    await nextMessage(client);

    let sawSpuriousTimeout = false;
    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ptt-timeout') sawSpuriousTimeout = true;
    });

    const start = Date.now();
    while (Date.now() - start < 200) {
      client.send(JSON.stringify({ id: 'x', type: 'setPtt', value: true }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      client.send(JSON.stringify({ id: 'x', type: 'setPtt', value: false }));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    check(
      !sawSpuriousTimeout,
      'rapid PTT toggling (simulating CW keying) over a span longer than the watchdog window never trips it'
    );

    client.close();
    await watchdogServer.close();
  }

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
