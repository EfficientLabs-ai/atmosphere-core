// test-stratos-egress.mjs — `stratos egress` CLI: print posture, check ALLOW/DENY+why, capability gate.
import assert from 'node:assert';
import { run } from './src/cli/stratos-cli.js';
import { EgressPolicy } from './src/security/egress-policy.js';
import { parseCapabilities } from './src/security/capability-gate.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const strip = (lines) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');

console.log('stratos egress — CLI posture + check + deny-by-default gate\n');

const policy = new EgressPolicy({ source: {
  default: 'deny',
  allow: [{ host: 'api.github.com' }, { host: '.githubusercontent.com' }, { host: 'api.stripe.com', methods: ['POST'], paths: ['/v1/charges'] }],
} });

await ok('`stratos egress` prints active policy + default-DENY posture', async () => {
  const r = await run(['egress'], { egressPolicy: policy });
  assert.strictEqual(r.code, 0);
  const out = strip(r.lines);
  assert.match(out, /default\s+DENY/);
  assert.match(out, /api\.github\.com/);
  assert.match(out, /\.githubusercontent\.com/);
  assert.match(out, /intersection|∩/);   // composition rule is documented in the output
});

await ok('`stratos egress check <allowed-host>` ⇒ ALLOW exit 0', async () => {
  const r = await run(['egress', 'check', 'api.github.com'], { egressPolicy: policy });
  assert.strictEqual(r.code, 0);
  assert.match(strip(r.lines), /ALLOW/);
});

await ok('`stratos egress check <unlisted-host>` ⇒ DENY exit 1 + why', async () => {
  const r = await run(['egress', 'check', 'evil.com'], { egressPolicy: policy });
  assert.strictEqual(r.code, 1);
  const out = strip(r.lines);
  assert.match(out, /DENY/);
  assert.match(out, /not permitted by egress policy/);
});

await ok('check honors method/path granularity', async () => {
  const allow = await run(['egress', 'check', 'api.stripe.com', 'POST', '/v1/charges'], { egressPolicy: policy });
  assert.strictEqual(allow.code, 0);
  const deny = await run(['egress', 'check', 'api.stripe.com', 'DELETE', '/v1/charges'], { egressPolicy: policy });
  assert.strictEqual(deny.code, 1);
});

await ok('check spoofed host ⇒ DENY', async () => {
  const r = await run(['egress', 'check', 'evil-github.com'], { egressPolicy: policy });
  assert.strictEqual(r.code, 1);
  assert.match(strip(r.lines), /DENY/);
});

await ok('check --caps composes policy ∩ skill caps', async () => {
  // host is in policy but NOT in supplied caps ⇒ DENY (intersection)
  const d1 = await run(['egress', 'check', 'api.github.com', '--caps', 'api.stripe.com'], { egressPolicy: policy });
  assert.strictEqual(d1.code, 1);
  assert.match(strip(d1.lines), /\[caps\]|not in skill/);
  // host in BOTH ⇒ ALLOW
  const a1 = await run(['egress', 'check', 'api.github.com', '--caps', 'api.github.com'], { egressPolicy: policy });
  assert.strictEqual(a1.code, 0);
});

await ok('capability gate: denied egress.read caps ⇒ refused (deny-by-default)', async () => {
  const deniedCaps = parseCapabilities({ capabilities: { actions: ['something.else'] } });
  const r = await run(['egress'], { egressPolicy: policy, egressCaps: deniedCaps });
  assert.strictEqual(r.code, 1);
  assert.match(strip(r.lines), /CAPABILITY DENIED/);
});

await ok('`stratos egress help` lists show + check', async () => {
  const r = await run(['egress', 'help'], { egressPolicy: policy });
  assert.strictEqual(r.code, 0);
  const out = strip(r.lines);
  assert.match(out, /egress check/);
  assert.match(out, /default-DENY/i);
});

await ok('egress is registered in COMMANDS + dispatched', async () => {
  const { COMMANDS } = await import('./src/cli/stratos-cli.js');
  assert.ok(COMMANDS.includes('egress'));
});

console.log(`\n${pass} assertions passed.`);
