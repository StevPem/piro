'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('CW stop error keeps the real client Stop action until receive is confirmed', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/client/app.js'), 'utf8');
  const start = app.indexOf('let cwTxBusy = false;');
  const handler = app.indexOf("link.addEventListener('cw-tx-status'", start);
  const end = app.indexOf('\n});', handler) + '\n});'.length;
  assert.ok(start >= 0 && handler > start && end > handler);
  const listeners = new Map();
  const requests = [];
  const classes = new Set();
  const buttonEvents = new Map();
  const button = { textContent: 'Send', classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
    addEventListener: (name, fn) => buttonEvents.set(name, fn) };
  const status = { hidden: true, textContent: '' };
  const input = { value: 'TEST', addEventListener() {} };
  vm.runInNewContext(app.slice(start, end), {
    link: { addEventListener: (name, fn) => listeners.set(name, fn),
      request: (type, data) => { requests.push({ type, data }); return Promise.resolve(); } },
    cwSendBtn: button, cwStatusEl: status, cwTextInput: input, cwWpmInput: { value: '20' },
    clearInterval() {}, setInterval() { return 1; }, mmss: String, showError() {},
  });
  const update = (detail) => listeners.get('cw-tx-status')({ detail });
  update({ status: 'error', transmitting: true, error: 'CW stop not confirmed' });
  assert.equal(button.textContent, 'Stop');
  assert.equal(classes.has('ptt--active'), true);
  assert.match(status.textContent, /stop not confirmed/);
  buttonEvents.get('click')();
  assert.equal(requests.at(-1).type, 'abortCw');

  // A rejected new Send is still an error on a possibly transmitting radio.
  update({ status: 'error', transmitting: true, error: 'Already sending CW' });
  assert.equal(button.textContent, 'Stop');
  update({ status: 'error', transmitting: false, error: 'Receive is now confirmed' });
  assert.equal(button.textContent, 'Send');
  assert.equal(classes.has('ptt--active'), false);
  assert.match(status.textContent, /Receive is now confirmed/);
  buttonEvents.get('click')();
  assert.equal(requests.at(-1).type, 'sendCw');

  // Existing sending events still work without the new optional flag.
  update({ status: 'sending', text: 'TEST', wpm: 20, durationSec: 1 });
  assert.equal(button.textContent, 'Stop');
});
