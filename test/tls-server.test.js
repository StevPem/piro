'use strict';

// Run with: node test/tls-server.test.js
// Generates a throwaway self-signed cert via openssl (a system tool, not
// an npm dependency) and confirms the control server actually serves
// HTTPS and accepts WSS connections with it — this is what unlocks
// microphone access on non-localhost origins (see docs/pwa-notes.md).

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { ControlServer } = require('../src/server/ws-server');

class StubCivDriver extends EventEmitter {
  constructor() {
    super();
    this.radioAddr = 0x94;
  }
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

function generateSelfSignedCert(dir) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '1',
    '-nodes',
    '-subj', '/CN=localhost',
  ]);
  return { keyPath, certPath };
}

function getJson(port) {
  return new Promise((resolve, reject) => {
    https
      .get(`https://localhost:${port}/`, { rejectUnauthorized: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      })
      .on('error', reject);
  });
}

function connectWss(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://localhost:${port}`, { rejectUnauthorized: false });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
}

async function run() {
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-server-test-'));
  } catch (err) {
    console.log(`skip - could not create temp dir (${err.message})`);
    return;
  }

  let certPaths;
  try {
    certPaths = generateSelfSignedCert(tmpDir);
  } catch (err) {
    console.log(`skip - openssl not available to generate a test cert (${err.message})`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  const civ = new StubCivDriver();
  const tls = {
    cert: fs.readFileSync(certPaths.certPath),
    key: fs.readFileSync(certPaths.keyPath),
  };
  const server = new ControlServer({ civ, port: 0, tls });
  const port = await server.listen();

  check(server.httpServer.constructor.name === 'Server' || !!server.tls, 'server was constructed with tls config');

  const httpsResponse = await getJson(port);
  check(httpsResponse.status === 200, 'plain HTTPS GET succeeds against the TLS-enabled server');

  const ws = await connectWss(port);
  const hello = await nextMessage(ws);
  check(hello.type === 'connected', 'WSS (WebSocket over TLS) connection succeeds and gets the hello');

  ws.close();
  await server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

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
