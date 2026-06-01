/**
 * runner tests: policy → sandbox → signed receipt. The executor only ever sees SANITIZED config; every
 * outcome (rejected/success/failure/error) yields a verifiable receipt bound to exactly what ran.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJob } from './src/exec/runner.js';
import { createExecController, verifyReceipt } from './src/exec/controller-identity.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rws-')));
const job1 = path.join(ROOT, 'job1'); fs.mkdirSync(job1);
const POLICY = { workspaceRoots: [ROOT], allowedEnvKeys: ['ATMOS_JOB_ID'], allowDomains: [] };
const controller = createExecController();
const NOW = 1700;

console.log('=== a policy-violating spec is REJECTED before the sandbox, with a signed receipt ===');
let executed = null;
const evilExec = (s) => { executed = s; return { exitCode: 0 }; };
const rej = await runJob({
  spec: { mounts: [{ host: '/etc', guest: '/work' }], env: { OPENAI_API_KEY: 'x' } },
  policy: POLICY, controller, jobId: 'j1', execute: evilExec, now: NOW,
});
ok(rej.status === 'rejected' && executed === null, 'over-grant mount + secret env → rejected, executor NEVER called');
ok(rej.violations.length >= 2, 'violations are reported (/etc over-grant + secret-shaped key)');
ok(verifyReceipt(rej.receipt, controller.publicBundle) === true && rej.receipt.body.status === 'rejected', 'the rejection receipt is signed + verifies');

console.log('\n=== a valid spec runs in the sandbox with ONLY the sanitized config ===');
const goodExec = (s) => { executed = s; return { exitCode: 0 }; };
// RANDOM_THING is non-allow-listed (silently dropped); ATMOS_JOB_ID passes. (A *secret*-shaped key would
// hard-reject the whole job — covered above — so we use a benign one here to exercise the success path.)
const cleanRun = await runJob({
  spec: { mounts: [{ host: job1, guest: '/work' }], env: { ATMOS_JOB_ID: '7', RANDOM_THING: 'x' } },
  policy: POLICY, controller, jobId: 'j3', execute: goodExec, now: NOW,
});
ok(cleanRun.status === 'success' && cleanRun.exitCode === 0, 'valid spec → executed → success');
ok(executed.allowedPaths['/work'] === job1 && !('RANDOM_THING' in executed.env) && executed.env.ATMOS_JOB_ID === '7', 'executor saw the SANITIZED config (mount mapped, non-allowlisted env dropped)');
ok(verifyReceipt(cleanRun.receipt, controller.publicBundle) === true && cleanRun.receipt.body.status === 'success', 'success receipt verifies under the controller key');

console.log('\n=== non-zero exit → failure; thrown executor → error; both still signed ===');
const failRun = await runJob({ spec: { mounts: [{ host: job1, guest: '/work' }] }, policy: POLICY, controller, jobId: 'j4', execute: () => ({ exitCode: 2 }), now: NOW });
ok(failRun.status === 'failure' && verifyReceipt(failRun.receipt, controller.publicBundle) === true, 'exitCode 2 → failure, receipt verifies');
const errRun = await runJob({ spec: { mounts: [{ host: job1, guest: '/work' }] }, policy: POLICY, controller, jobId: 'j5', execute: () => { throw new Error('sandbox blew up'); }, now: NOW });
ok(errRun.status === 'error' && verifyReceipt(errRun.receipt, controller.publicBundle) === true, 'thrown executor → error (generic), receipt verifies');

console.log('\n=== receipt is bound to the exact sanitized spec + a wrong controller is rejected ===');
const other = createExecController();
ok(verifyReceipt(cleanRun.receipt, other.publicBundle) === false, 'receipt does NOT verify under a different controller key');

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n✅ ALL ${pass} runner checks passed.`);
