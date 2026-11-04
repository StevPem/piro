'use strict';

// Run with: node test/run-all.js   (or npm run test:ci)
//
// Runs the same test files as `npm test`, read from its script in
// package.json so there is one list. Unlike `npm test` it runs every file
// even after one fails, and retries a failed file once (TEST_RETRIES, 0 to
// turn off). A file that fails and then passes is reported as flaky: a
// warning, not a failure. One that fails every time fails the run.
// Used by CI (.github/workflows/test.yml).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RETRIES = Math.max(0, Number.parseInt(process.env.TEST_RETRIES ?? '1', 10) || 0);
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

/** The test files in package.json's "test" script, in order. */
function testFiles() {
  const script = require(path.join(ROOT, 'package.json')).scripts.test;
  return script.split('&&').map((part) => {
    const m = /^node\s+(\S+)$/.exec(part.trim());
    if (!m) throw new Error(`run-all.js only understands "node <file>" steps; "npm test" has: ${part.trim()}`);
    return m[1];
  });
}

function runOnce(file) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, stdio: 'inherit' });
  return { ok: r.status === 0, code: r.status ?? r.signal, secs: (Date.now() - started) / 1000 };
}

function main() {
  const files = testFiles();
  const results = [];
  for (const file of files) {
    const attempts = [];
    for (let i = 0; i <= RETRIES; i++) {
      if (IN_ACTIONS) console.log(`::group::${file}${i ? ` (retry ${i})` : ''}`);
      else console.log(`\n=== ${file}${i ? ` (retry ${i})` : ''}`);
      const r = runOnce(file);
      attempts.push(r);
      if (IN_ACTIONS) console.log('::endgroup::');
      if (r.ok) break;
      console.log(`${file} failed (exit ${r.code})${i < RETRIES ? '; running it again' : ''}`);
    }
    const passed = attempts[attempts.length - 1].ok;
    results.push({ file, passed, flaky: passed && attempts.length > 1, attempts });
  }

  const failed = results.filter((r) => !r.passed);
  const flaky = results.filter((r) => r.flaky);
  for (const r of flaky) {
    const msg = `${r.file} failed, then passed on retry: flaky`;
    console.log(IN_ACTIONS ? `::warning file=${r.file}::${msg}` : `WARNING: ${msg}`);
  }
  for (const r of failed) {
    const msg = `${r.file} failed ${r.attempts.length} time(s)`;
    console.log(IN_ACTIONS ? `::error file=${r.file}::${msg}` : `FAILED: ${msg}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `### Tests (Node ${process.versions.node})`,
      '',
      `${results.length - failed.length} of ${results.length} test files passed` + (flaky.length ? `, ${flaky.length} only on retry` : '') + '.',
      '',
    ];
    if (failed.length || flaky.length) {
      lines.push('| File | Result |', '|---|---|');
      for (const r of failed) lines.push(`| \`${r.file}\` | failed ${r.attempts.length} time(s) |`);
      for (const r of flaky) lines.push(`| \`${r.file}\` | flaky: passed on retry |`);
      lines.push('');
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }

  const total = results.reduce((s, r) => s + r.attempts.reduce((t, a) => t + a.secs, 0), 0);
  console.log(
    `\n${results.length - failed.length}/${results.length} test files passed` +
      (flaky.length ? ` (${flaky.length} flaky)` : '') +
      ` in ${Math.round(total)} s.`
  );
  process.exitCode = failed.length ? 1 : 0;
}

main();
