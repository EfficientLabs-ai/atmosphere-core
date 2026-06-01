/**
 * job-policy tests: deny-by-default mounts (no `..`, no SYMLINK escape, under realpath'd workspace
 * roots only, non-existent denied), env allow-list + secret-shape refusal, network deny-by-default.
 * Closes the wasi-sandbox.js over-grant gaps + the symlink-traversal bypass.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeJobSpec } from './src/exec/job-policy.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

// real filesystem fixtures (realpathSync requires existing paths)
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')));   // the workspace root
const SECRET = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-'))); // sensitive dir OUTSIDE the root
const job1 = path.join(ROOT, 'job1'); fs.mkdirSync(job1);
const escape = path.join(ROOT, 'escape'); fs.symlinkSync(SECRET, escape); // a symlink inside the root → outside
const POLICY = { workspaceRoots: [ROOT], allowedEnvKeys: ['ATMOS_JOB_ID', 'LANG'], allowDomains: ['api.github.com'] };

console.log('=== mounts: traversal, symlink-escape, over-grant, non-existent are refused ===');
const good = sanitizeJobSpec({ mounts: [{ host: job1, guest: '/work' }] }, POLICY);
ok(good.ok === true && good.sanitized.allowedPaths['/work'] === job1, 'a real dir under the workspace root → allowed + mapped');
ok(sanitizeJobSpec({ mounts: [{ host: escape, guest: '/work' }] }, POLICY).ok === false, 'a SYMLINK inside the root pointing outside → refused (realpath escapes the root)');
ok(sanitizeJobSpec({ mounts: [{ host: SECRET, guest: '/work' }] }, POLICY).ok === false, 'a real dir OUTSIDE the workspace root → refused');
ok(sanitizeJobSpec({ mounts: [{ host: path.join(ROOT, 'nope'), guest: '/work' }] }, POLICY).ok === false, 'a NON-EXISTENT host path → refused');
ok(sanitizeJobSpec({ mounts: [{ host: `${ROOT}/../etc`, guest: '/work' }] }, POLICY).ok === false, 'a `..` in the host path → refused');
ok(sanitizeJobSpec({ mounts: [{ host: job1, guest: '/work/../etc' }] }, POLICY).ok === false, 'a `..` in the guest path → refused');
ok(sanitizeJobSpec({ mounts: [{ host: '/etc', guest: '/work' }] }, POLICY).ok === false, 'mounting /etc (outside roots) → refused');
ok(sanitizeJobSpec({ mounts: [{ host: '/', guest: '/work' }] }, POLICY).ok === false, 'mounting / → refused');
ok(sanitizeJobSpec({ mounts: [{ host: job1, guest: 'work' }] }, POLICY).ok === false, 'a relative guest path → refused');
ok(sanitizeJobSpec({ mounts: [{ host: 'relative/host', guest: '/work' }] }, POLICY).ok === false, 'a relative host path → refused');

console.log('\n=== preopens empty by default ===');
const bare = sanitizeJobSpec({}, POLICY);
ok(bare.ok === true && Object.keys(bare.sanitized.allowedPaths).length === 0, 'no mounts → empty preopens (deny by default)');

console.log('\n=== env: allow-list AND never secret-shaped ===');
const envRes = sanitizeJobSpec({ env: { ATMOS_JOB_ID: '42', LANG: 'C', RANDOM_THING: 'x' } }, POLICY);
ok(envRes.sanitized.env.ATMOS_JOB_ID === '42' && envRes.sanitized.env.LANG === 'C', 'allow-listed keys pass through');
ok(!('RANDOM_THING' in envRes.sanitized.env) && envRes.droppedEnv.includes('RANDOM_THING'), 'a non-allow-listed key is silently dropped (deny by default)');
for (const bad of ['AWS_SECRET_ACCESS_KEY', 'SOLANA_KEYPAIR', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'WALLET_MNEMONIC']) {
  ok(sanitizeJobSpec({ env: { [bad]: 'v' } }, { ...POLICY, allowedEnvKeys: [bad] }).ok === false, `secret-shaped key '${bad}' refused EVEN IF allow-listed`);
}
ok(sanitizeJobSpec({ env: { MONKEY_MODE: '1' } }, { ...POLICY, allowedEnvKeys: ['MONKEY_MODE'] }).ok === true, 'a benign key (MONKEY_MODE) is NOT a false positive');

console.log('\n=== network: deny by default ===');
ok(bare.sanitized.allowedDomains.length === 0, 'no domains requested → no network');
ok(sanitizeJobSpec({ domains: ['evil.example'] }, POLICY).ok === false, 'a domain outside the policy allow-list → refused');
const netOk = sanitizeJobSpec({ domains: ['api.github.com'] }, POLICY);
ok(netOk.ok === true && netOk.sanitized.allowedDomains[0] === 'api.github.com', 'an allow-listed domain passes');

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(SECRET, { recursive: true, force: true });
console.log(`\n✅ ALL ${pass} job-policy checks passed.`);
