'use strict';

// Keep npm test steps in the "node <file>" form used by upstream's CI runner.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const files = readdirSync(__dirname).filter((name) => /^icom-lan-.+\.test\.js$/.test(name)).sort();
if (!files.length) throw new Error('No Icom LAN test files found');
// Fault-injection tests use short CI-V deadlines and spawn native workers.
// Run files serially so unrelated startup load cannot simulate a link failure.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map((name) => join(__dirname, name))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
