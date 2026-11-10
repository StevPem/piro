'use strict';

// Runs every test that needs no hardware: each test/*.test.js and
// test/*.test.mjs file, in name order, each in its own Node process. A
// new test file is picked up by its name; there is no list to edit.
//
//   npm test                      every file; no retries (--no-retry)
//   npm test -- deepcw lan        only files whose names contain one of these
//   npm run test:ci               every file; a failed file is run once more
//
// It runs every file even after one fails, then lists the failures. With
// retries (TEST_RETRIES, default 1; CI uses this), a file that fails and
// then passes is reported as flaky: a warning, not a failure. One that
// fails every time fails the run. Used by CI (.github/workflows/test.yml).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const NO_RETRY = ARGS.includes('--no-retry');
const FILTERS = ARGS.filter((a) => !a.startsWith('--'));
const RETRIES = NO_RETRY ? 0 : Math.max(0, Number.parseInt(process.env.TEST_RETRIES ?? '1', 10) || 0);
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

/** test/*.test.js and test/*.test.mjs, in name order, narrowed by FILTERS if given. */
function testFiles() {
  const all = fs
    .readdirSync(__dirname)
    .filter((name) => /\.test\.m?js$/.test(name))
    .sort()
    .map((name) => `test/${name}`);
  return FILTERS.length ? all.filter((file) => FILTERS.some((f) => file.includes(f))) : all;
}

function runOnce(file) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, stdio: 'inherit' });
  return { ok: r.status === 0, code: r.status ?? r.signal, secs: (Date.now() - started) / 1000 };
}

function main() {
  const files = testFiles();
  if (!files.length) {
    console.error(FILTERS.length ? `No test file name contains: ${FILTERS.join(', ')}` : 'No test files found.');
    process.exitCode = 1;
    return;
  }
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
