'use strict';

/**
 * Manual test client for the WebSocket control layer against a *running*
 * server (src/server/index.js). Useful for poking at a real radio over
 * the network from a dev machine.
 *
 * Usage:
 *   node test/manual-ws-test.js ws://<pi-hostname-or-ip>:8080
 */

const WebSocket = require('ws');

const url = process.argv[2] || 'ws://localhost:8080';
const ws = new WebSocket(url);

let nextId = 1;
function request(type, extra = {}) {
  const id = String(nextId++);
  ws.send(JSON.stringify({ id, type, ...extra }));
  return id;
}

ws.on('open', () => {
  console.log(`Connected to ${url}`);
  request('getFrequency');
  request('getMode');
  request('getSMeter');
});

ws.on('message', (raw) => {
  console.log(raw.toString());
});

ws.on('error', (err) => console.error('WS error:', err.message));
ws.on('close', () => console.log('Connection closed'));

setTimeout(() => {
  console.log('Closing after 20s (try changing frequency/mode on another client meanwhile)...');
  ws.close();
}, 20000);
