'use strict';

// The README states the current build number. It must match CACHE_NAME in
// src/client/sw.js, which is the number the app shows next to its title
// (see src/server/index.js's readAppVersion()). When you bump CACHE_NAME,
// update the "Current build" line in README.md too; this test fails until
// you do.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sw = fs.readFileSync(path.join(root, 'src/client/sw.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const swMatch = sw.match(/CACHE_NAME\s*=\s*'[^']*-v(\d+)'/);
const readmeMatch = readme.match(/\*\*Current build: v(\d+)\.\*\*/);

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

check(swMatch, 'sw.js has a CACHE_NAME ending in -vN');
check(readmeMatch, 'README.md has a "**Current build: vN.**" line');
if (swMatch && readmeMatch) {
  check(
    swMatch[1] === readmeMatch[1],
    `README build (v${readmeMatch[1]}) matches sw.js CACHE_NAME (v${swMatch[1]})`
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll README version checks passed');
