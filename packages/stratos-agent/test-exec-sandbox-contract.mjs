/**
 * Exec sandbox contract tests (Gap 7, #39):
 *   1. WasiSandbox consumes allowedPaths in the SAME direction job-policy.js emits it ({guest: host}).
 *      Regression guard for the inverted-mapping bug where every mount silently failed.
 *   2. runJob hands the executor ONLY the sanitized config — never the raw spec.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WasiSandbox } from './src/execution/wasi-sandbox.js';
import { sanitizeJobSpec } from './src/exec/job-policy.js';
import { runJob } from './src/exec/runner.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log('=== WasiSandbox preopens consume job-policy output {guest -> host} ===');
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasi-host-'));
// job-policy emits { guest: host }; feed that EXACT shape to the sandbox.
const allowedPaths = { '/work': hostDir };
const sb = new WasiSandbox({ allowedPaths, verbose: false });
const preopens = sb.buildPreopens();
ok(preopens['/work'] === hostDir, 'guest mount "/work" maps to the real host dir (direction preserved end-to-end)');
ok(!(hostDir in preopens), 'the host path is NOT used as a guest key (the old inverted bug is gone)');

const missing = new WasiSandbox({ allowedPaths: { '/work': path.join(hostDir, 'nope') }, verbose: false });
ok(Object.keys(missing.buildPreopens()).length === 0, 'a non-existent host path is dropped (no phantom mount)');

console.log('\n=== job-policy → WasiSandbox shapes line up ===');
const { sanitized } = sanitizeJobSpec({ mounts: [{ host: hostDir, guest: '/work' }] }, { workspaceRoots: [os.tmpdir()] });
ok(sanitized.allowedPaths['/work'] === fs.realpathSync(hostDir), 'sanitizer emits { "/work": <realpath host> } — the key IS the guest mount');
ok(new WasiSandbox({ allowedPaths: sanitized.allowedPaths, verbose: false }).buildPreopens()['/work'] === fs.realpathSync(hostDir), 'sandbox consumes the sanitizer output directly, correct direction');

console.log('\n=== runJob passes the executor ONLY the sanitized config (never the raw spec) ===');
const controller = { issueReceipt: ({ jobId, status }) => ({ jobId, status, sig: 'x' }) };
let argsSeen = null;
const execSpy = (...a) => { argsSeen = a; return { exitCode: 0 }; };
const run = await runJob({
  spec: { mounts: [{ host: hostDir, guest: '/work' }], env: { NON_ALLOWLISTED: 'drop-me', ATMOS_JOB_ID: '1' } },
  policy: { workspaceRoots: [os.tmpdir()], allowedEnvKeys: ['ATMOS_JOB_ID'] },
  controller, jobId: 'j1', execute: execSpy, now: 1000,
});
ok(run.status === 'success', 'the valid spec ran (executor invoked)');
ok(argsSeen.length === 1, 'execute() is called with exactly ONE argument (the sanitized config) — raw spec not forwarded');
ok(!JSON.stringify(argsSeen[0]).includes('drop-me'), 'the non-allowlisted env never reaches the executor (only the sanitized config does)');

fs.rmSync(hostDir, { recursive: true, force: true });
console.log(`\n✅ ALL ${pass} exec-sandbox-contract checks passed.`);
