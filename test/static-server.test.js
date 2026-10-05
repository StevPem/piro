'use strict';

// Run with: node test/static-server.test.js
// Spins up a real HTTP server using createStaticHandler against a
// temporary directory (not the real src/client — keeps this test
// independent of what's currently in the app shell).

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStaticHandler } = require('../src/server/static-server');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${port}${urlPath}`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      })
      .on('error', reject);
  });
}

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'static-server-test-'));
  fs.writeFileSync(path.join(tmpRoot, 'index.html'), '<!doctype html><title>shell</title>');
  fs.writeFileSync(path.join(tmpRoot, 'app.js'), 'console.log("hi");');
  fs.writeFileSync(path.join(tmpRoot, 'manifest.webmanifest'), JSON.stringify({ name: 'Test' }));
  fs.mkdirSync(path.join(tmpRoot, 'icons'));
  fs.writeFileSync(path.join(tmpRoot, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // A sibling "secret" file outside the served root, to confirm traversal is blocked.
  fs.writeFileSync(path.join(tmpRoot, '..', 'secret-outside-root.txt'), 'should never be served');

  const handler = createStaticHandler(tmpRoot);
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const root = await get(port, '/');
  check(root.status === 200 && root.body.toString().includes('shell'), '/ serves index.html');

  const js = await get(port, '/app.js');
  check(
    js.status === 200 && js.headers['content-type'].includes('javascript'),
    '/app.js is served with a JS content-type'
  );

  const manifest = await get(port, '/manifest.webmanifest');
  check(
    manifest.status === 200 && manifest.headers['content-type'].includes('application/manifest+json'),
    'manifest is served with the correct content-type'
  );
  check(
    (() => {
      try {
        JSON.parse(manifest.body.toString());
        return true;
      } catch {
        return false;
      }
    })(),
    'manifest body is valid JSON'
  );

  const icon = await get(port, '/icons/icon-192.png');
  check(
    icon.status === 200 && icon.headers['content-type'] === 'image/png',
    'icon is served with image/png content-type'
  );

  const missing = await get(port, '/does-not-exist.txt');
  check(missing.status === 404, 'missing file returns 404');

  const traversal1 = await get(port, '/../secret-outside-root.txt');
  const traversal2 = await get(port, '/%2e%2e/secret-outside-root.txt');
  check(
    traversal1.status !== 200 && traversal2.status !== 200,
    'path traversal attempts do not reach files outside the static root'
  );

  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(tmpRoot), 'secret-outside-root.txt'), { force: true });

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
