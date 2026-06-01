/**
 * job-policy tests: deny-by-default mounts (no `..`, under workspace roots only), env allow-list +
 * secret-shape refusal, network deny-by-default. Closes the wasi-sandbox.js over-grant gaps.
 */
import assert from 'node:assert';
import { sanitizeJobSpec } from './src/exec/job-policy.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const POLICY = { workspaceRoots: ['/srv/atmos-work'], allowedEnvKeys: ['ATMOS_JOB_ID', 'LANG'], allowDomains: ['api.github.com'] };

console.log('=== mounts: traversal + over-grant are refused ===');
ok(sanitizeJobSpec({ mounts: [{ host: '/srv/atmos-work/../../etc', guest: '/work' }] }, POLICY).ok === false, 'a `..` in the host path → refused');
ok(sanitizeJobSpec({ mounts: [{ host: '/srv/atmos-work/job1', guest: '/work/../etc' }] }, POLICY).ok === false, 'a `..` in the guest path → refused');
ok(sanitizeJobSpec({ mounts: [{ host: '/etc', guest: '/work' }] }, POLICY).ok === false, 'mounting /etc (outside workspace roots) → refused');
ok(sanitizeJobSpec({ mounts: [{ host: '/', guest: '/work' }] }, POLICY).ok === false, 'mounting / → refused');
ok(sanitizeJobSpec({ mounts: [{ host: '/srv/atmos-work/job1', guest: 'work' }] }, POLICY).ok === false, 'a relative guest path → refused');
const okMount = sanitizeJobSpec({ mounts: [{ host: '/srv/atmos-work/job1', guest: '/work' }] }, POLICY);
ok(okMount.ok === true && okMount.sanitized.allowedPaths['/work'] === '/srv/atmos-work/job1', 'a mount under the workspace root → allowed + mapped');

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
ok(sanitizeJobSpec({ env: { MONKEY_MODE: '1' } }, { ...POLICY, allowedEnvKeys: ['MONKEY_MODE'] }).ok === true, 'a benign key containing no secret segment (MONKEY_MODE) is NOT a false positive');

console.log('\n=== network: deny by default ===');
ok(bare.sanitized.allowedDomains.length === 0, 'no domains requested → no network');
ok(sanitizeJobSpec({ domains: ['evil.example'] }, POLICY).ok === false, 'a domain outside the policy allow-list → refused');
const netOk = sanitizeJobSpec({ domains: ['api.github.com'] }, POLICY);
ok(netOk.ok === true && netOk.sanitized.allowedDomains[0] === 'api.github.com', 'an allow-listed domain passes');

console.log(`\n✅ ALL ${pass} job-policy checks passed.`);
