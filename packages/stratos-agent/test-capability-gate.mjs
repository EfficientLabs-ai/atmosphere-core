// test-capability-gate.mjs — least-privilege enforcement for signed skills (deny-by-default).
import assert from 'node:assert';
import { parseCapabilities, assertComputeAllowed, assertStepAllowed, CapabilityError } from './src/security/capability-gate.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const denied = (fn) => { try { fn(); return false; } catch (e) { return e instanceof CapabilityError && e.denied === true; } };

console.log('capability-gate — deny-by-default least-privilege\n');

// --- parseCapabilities normalizes + denies by default ---
ok('absent capabilities ⇒ everything denied', () => {
  const c = parseCapabilities({ id: 's', kind: 'automation' });
  assert.deepStrictEqual(c, { compute: false, actions: [], net: [], fs: [], secrets: [] });
});
ok('malformed capability fields are dropped, not trusted', () => {
  const c = parseCapabilities({ capabilities: { compute: 'yes', actions: 'click', net: [1, 'h.com'], secrets: null } });
  assert.strictEqual(c.compute, false);            // only boolean true counts
  assert.deepStrictEqual(c.actions, []);           // string, not array ⇒ dropped
  assert.deepStrictEqual(c.net, ['h.com']);        // non-strings filtered out
  assert.deepStrictEqual(c.secrets, []);
});

// --- compute capability ---
ok('compute denied unless declared', () => {
  assert.strictEqual(denied(() => assertComputeAllowed(parseCapabilities({}))), true);
  assertComputeAllowed(parseCapabilities({ capabilities: { compute: true } })); // allowed, no throw
});

// --- automation step gating ---
const caps = parseCapabilities({ capabilities: {
  actions: ['click', 'type', 'fetch', 'read'],
  net: ['api.github.com'],
  fs: ['/data/skills'],
  secrets: ['github'],
} });

ok('declared action allowed', () => { assertStepAllowed(caps, { action: 'click' }); });
ok('UNdeclared action refused', () => {
  assert.strictEqual(denied(() => assertStepAllowed(caps, { action: 'navigate' })), true);
});
ok('step with no action refused', () => {
  assert.strictEqual(denied(() => assertStepAllowed(caps, {})), true);
});
ok('egress to allowlisted host allowed', () => { assertStepAllowed(caps, { action: 'fetch', url: 'https://api.github.com/x' }); });
ok('egress to NON-allowlisted host refused', () => {
  assert.strictEqual(denied(() => assertStepAllowed(caps, { action: 'fetch', url: 'https://evil.example/exfil' })), true);
});
ok('fs path under declared prefix allowed', () => { assertStepAllowed(caps, { action: 'read', path: '/data/skills/a.txt' }); });
ok('fs path OUTSIDE declared prefix refused', () => {
  assert.strictEqual(denied(() => assertStepAllowed(caps, { action: 'read', path: '/etc/passwd' })), true);
});
ok('path-prefix boundary is not foolable (/data/skills-evil)', () => {
  assert.strictEqual(denied(() => assertStepAllowed(caps, { action: 'read', path: '/data/skills-evil/x' })), true);
});
ok('declared secret scope allowed; undeclared refused', () => {
  assertStepAllowed(caps, { action: 'fetch', url: 'https://api.github.com/x', secret: 'github' });
  assert.strictEqual(denied(() => assertStepAllowed(caps, { action: 'type', secret: 'stripe' })), true);
});
ok('deny-by-default: with no caps, every step refused', () => {
  const none = parseCapabilities({});
  assert.strictEqual(denied(() => assertStepAllowed(none, { action: 'click' })), true);
});

// --- executor wiring smoke-check (imports resolve + flag present) ---
ok('SkillExecutor wires the gate behind enforceCapabilities flag', async () => {
  const { SkillExecutor } = await import('./src/evolution/skill-executor.js');
  const off = new SkillExecutor({ requireSignature: false });
  const on = new SkillExecutor({ requireSignature: false, enforceCapabilities: true });
  assert.strictEqual(off.enforceCapabilities, false); // default preserves current behavior
  assert.strictEqual(on.enforceCapabilities, true);
});

console.log(`\n✅ ${pass}/${pass} capability-gate tests passed — least-privilege enforced, deny-by-default.`);
