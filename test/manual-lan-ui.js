'use strict';

// NODE_PATH=<Playwright install>/node_modules CHROMIUM_PATH=<Chrome binary>
// node test/manual-lan-ui.js — synthetic localhost radio only.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');
const { IcomPeer } = require('./fixtures/icom-lan-peer');
const { serverEnvironment } = require('./icom-lan-demo');

async function main() {
  const peer = await new IcomPeer().start();
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server/index.js')], {
    env: serverEnvironment(peer), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', exit;
  child.stdout.on('data', (p) => { output += p; });
  child.stderr.on('data', () => {});
  child.on('exit', (code) => { exit = code; });
  let browser;
  try {
    const deadline = performance.now() + 10000;
    while (!output.includes('Scope output enabled')) {
      if (exit !== undefined || performance.now() > deadline) throw new Error('PiRO did not start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const port = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)[1];
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => document.getElementById('radio-link-status')?.textContent === 'Radio connected');
    assert.ok(await page.locator('#radio-link-status').isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '/tmp/piro-icom-reference/lan-ui-360.png', fullPage: true });
    peer.release();
    await page.waitForFunction(() => document.getElementById('radio-link-status')?.textContent === 'Reconnecting to radio');
    assert.ok((await page.locator('#radio-link-status').getAttribute('title')).includes('released'));
    await page.waitForFunction(() => document.getElementById('radio-link-status')?.textContent === 'Radio connected');
    await page.setViewportSize({ width: 900, height: 900 });
    await page.screenshot({ path: '/tmp/piro-icom-reference/lan-ui-900.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('LAN browser UI passed: connected, reconnect, 360px layout, no page errors.');
  } finally {
    await browser?.close();
    child.kill('SIGTERM');
    const deadline = performance.now() + 3000;
    while (exit === undefined && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (exit === undefined) child.kill('SIGKILL');
    await peer.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
