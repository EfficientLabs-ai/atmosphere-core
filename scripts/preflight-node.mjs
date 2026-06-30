#!/usr/bin/env node
import fs from 'node:fs';

const expected = fs.readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
const actual = process.version.replace(/^v/, '');
const ecosystem = fs.readFileSync(new URL('../ecosystem.config.cjs', import.meta.url), 'utf8');
const expectedPm2Interpreter = '/home/neo/.nvm/versions/node/v' + expected + '/bin/node';

if (actual !== expected) {
  console.error(`atmosphere-core requires Node ${expected}; current runtime is ${actual}.`);
  console.error('Use the pinned runtime before install/test/start: nvm use');
  process.exit(1);
}

if (!ecosystem.includes(expectedPm2Interpreter)) {
  console.error(`PM2 interpreter must be pinned to ${expectedPm2Interpreter}.`);
  console.error('Update ecosystem.config.cjs before reloading atmos-secure-bridge.');
  process.exit(1);
}

console.log(`Node runtime OK: ${actual}`);
