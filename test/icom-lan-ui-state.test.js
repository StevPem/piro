'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/client/app.js'), 'utf8');
function productionFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  return start < 0 ? '' : source.slice(start, source.indexOf('\n}', start) + 2);
}
function ui(mode, status, radioState = 'connected') {
  const button = () => ({ disabled: false, classList: { toggle() {} } });
  const context = {
    link: { connected: true }, radioConnectionInfo: { transport: 'lan', state: radioState },
    ttyMode: () => mode, js8Status: mode === 'JS8' ? status : null,
    varaStatus: mode === 'VARA' ? status : null,
    ttySendBtn: button(), scopeSpanSlider: button(), scopeEnabled: true,
    freqStepButtonEls: {}, FUNCTION_CONTROLS: [], bandsEl: { querySelectorAll: () => [] },
    modesEl: { querySelectorAll: () => [] }, audioPipeline: null,
    paddleDotDown: false, paddleDashDown: false, cwSession: null, pttActive: false,
    currentFreqHz: null, varaShownState: null, varaReturnHz: null, document: {},
    varaHeardEl: { replaceChildren() {} },
  };
  for (const name of ['pttBtn', 'cwSendBtn', 'cwDotBtn', 'cwDashBtn', 'tunerBtn', 'tuneBtn',
    'txPowerSelect', 'rxGainSlider', 'freqDisplay', 'freqInput', 'varaStatusEl',
    'varaConnectBtn', 'varaCqBtn', 'varaQsydBtn', 'varaQsyuBtn', 'varaCallEl']) context[name] = button();
  vm.createContext(context);
  vm.runInContext(['radioReadyForPolling', 'syncTtySendAvailability', 'syncRadioControls',
    'renderJs8SendButton', 'renderVaraStatus'].map(productionFunction).join('\n'), context);
  return context;
}

for (const [mode, status, disabled] of [
  ['JS8', { available: true, canTransmit: false }, true],
  ['JS8', { available: false, canTransmit: true }, true],
  ['JS8', { available: true, canTransmit: true }, false],
  ['JS8', { available: true, canTransmit: false, sending: {} }, false],
  ['VARA', { available: true, state: 'listening' }, true],
  ['VARA', { available: true, state: 'disconnected' }, true],
  ['VARA', { available: true, state: 'connected' }, false],
]) {
  test(`${mode} ${JSON.stringify(status)} retains send capability after radio status refresh`, () => {
    const c = ui(mode, status);
    c.syncRadioControls();
    c.syncRadioControls(); // Repeated activity/status refreshes must preserve the constraint.
    assert.equal(c.ttySendBtn.disabled, disabled);
    c.radioConnectionInfo.state = 'disconnected';
    c.syncRadioControls();
    assert.equal(c.ttySendBtn.disabled, true);
    if (mode === 'JS8') {
      c.renderJs8SendButton();
      assert.equal(c.ttySendBtn.disabled, true, 'modem updates cannot enable an offline radio');
    } else {
      c.renderVaraStatus(status);
      assert.equal(c.ttySendBtn.disabled, true, 'modem updates cannot enable an offline radio');
    }
    c.radioConnectionInfo.state = 'connected';
    c.link.connected = false;
    c.syncRadioControls();
    assert.equal(c.ttySendBtn.disabled, true);
  });
}

test('losing VARA status disables Send immediately', () => {
  const c = ui('VARA', { available: true, state: 'connected' });
  c.syncRadioControls();
  assert.equal(c.ttySendBtn.disabled, false);
  c.renderVaraStatus(null);
  assert.equal(c.ttySendBtn.disabled, true);
});
