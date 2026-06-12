/**
 * test-entitlement.mjs — Foundation F3 (safe slice): the LOCAL, OFFLINE entitlement verifier.
 * Hermetic: real hybrid sign/verify, tmp token files. Proves a VALID signed token unlocks its
 * namespaces (plus the Free floor), and that EVERY failure mode (no token / unreadable / malformed
 * / no prov key / forged sig / expired-past-grace) falls to Free Forever — never an error, never
 * fail-closed. No Stripe, no money, nothing signed by this module.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEntitlement, namespaceCovered, FREE_FOREVER_NAMESPACES } from './src/product/entitlement.js';
import { generateHybridKeyPair, signPayload, verifyPayload } from '../stratos-agent/src/security/quantum-crypto.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'entitlement-'));
let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };

console.log('entitlement — offline verify, fail-to-FREE (never fail-closed)\n');

// the provisioning key pair (the service's private signs; the node ships the public)
const prov = generateHybridKeyPair();
const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
const provPub = b64(prov.publicKey);

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const canonicalBody = (token) => { const { sig, ...body } = token; return canonical(body); };
function signToken(fields) {
  const token = { format: 'efl.entitlement.v1', issuer: 'efficientlabs-provisioning', ...fields };
  token.sig = signPayload(canonicalBody(token), prov.privateKey);
  return token;
}

function checker(tokenObj, { profileDir, expired } = {}) {
  const dir = profileDir || tmp();
  if (tokenObj) fs.writeFileSync(path.join(dir, 'entitlement.json'), JSON.stringify(tokenObj));
  return createEntitlement({ verifyPayload }, { profileDir: dir, provisioningPublicKey: provPub, now: () => (expired ? 9_999_999_999_999 : 1_700_000_000_000) });
}

ok('namespaceCovered: exact + prefix.* wildcard, no false positives', () => {
  assert.ok(namespaceCovered('terminal.shell', ['terminal.*']));
  assert.ok(namespaceCovered('receipts.export', ['receipts.*']));
  assert.ok(namespaceCovered('agent.attach', ['agent.attach']));
  assert.ok(!namespaceCovered('terminal.shell', ['terminalX.*']), 'no prefix bleed');
  assert.ok(!namespaceCovered('billing.charge', ['terminal.*', 'receipts.*']));
});

ok('a VALID signed token unlocks its namespaces + the Free floor', () => {
  const token = signToken({ subject: 'acct_1', tier: 'exos_pro', state: 'active', expires_at: 1_800_000_000_000, namespaces: ['terminal.*', 'agent.attach'] });
  const e = checker(token);
  const r = e.resolve();
  assert.strictEqual(r.source, 'token');
  assert.strictEqual(r.tier, 'exos_pro');
  assert.ok(e.isEntitled('terminal.shell'), 'paid namespace unlocked');
  assert.ok(e.isEntitled('agent.attach'));
  assert.ok(e.isEntitled('receipts.export'), 'Free floor still present');
  assert.ok(!e.isEntitled('teams.invite'), 'an un-granted namespace stays locked');
});

ok('NO token → Free Forever floor (zero contact required)', () => {
  const e = createEntitlement({ verifyPayload }, { profileDir: tmp(), provisioningPublicKey: provPub });
  const r = e.resolve();
  assert.strictEqual(r.source, 'free');
  assert.strictEqual(r.tier, 'free_forever');
  assert.ok(e.isEntitled('receipts.export') && e.isEntitled('continuity.store'), 'Free namespaces work');
  assert.ok(!e.isEntitled('terminal.shell'), 'paid stays locked without a token');
});

ok('FORGED signature → fail to Free (a forged token grants nothing)', () => {
  const token = signToken({ subject: 'x', tier: 'apex', expires_at: 1_800_000_000_000, namespaces: ['terminal.*'] });
  token.tier = 'apex_max'; // tamper AFTER signing — signature no longer matches the body
  const e = checker(token);
  assert.strictEqual(e.resolve().source, 'free', 'tampered token rejected');
  assert.ok(!e.isEntitled('terminal.shell'));
});

ok('WRONG provisioning key → fail to Free (cannot trust an unverifiable token)', () => {
  const token = signToken({ subject: 'x', tier: 'apex', expires_at: 1_800_000_000_000, namespaces: ['terminal.*'] });
  const other = generateHybridKeyPair();
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'entitlement.json'), JSON.stringify(token));
  const e = createEntitlement({ verifyPayload }, { profileDir: dir, provisioningPublicKey: b64(other.publicKey) });
  assert.strictEqual(e.resolve().source, 'free');
});

ok('EXPIRED past grace → fail to Free (never an error wall)', () => {
  const token = signToken({ subject: 'x', tier: 'apex', state: 'active', expires_at: 1_700_000_000_000, namespaces: ['terminal.*'] });
  const e = checker(token, { expired: true }); // now() far past expiry + grace
  assert.strictEqual(e.resolve().source, 'free');
  assert.ok(!e.isEntitled('terminal.shell'));
});

ok('malformed / unreadable token → fail to Free (never throws)', () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'entitlement.json'), 'not json{{');
  const e = createEntitlement({ verifyPayload }, { profileDir: dir, provisioningPublicKey: provPub });
  assert.strictEqual(e.resolve().source, 'free');
  const dir2 = tmp(); fs.writeFileSync(path.join(dir2, 'entitlement.json'), JSON.stringify({ format: 'wrong', tier: 'apex' }));
  assert.strictEqual(createEntitlement({ verifyPayload }, { profileDir: dir2, provisioningPublicKey: provPub }).resolve().source, 'free');
});

ok('no provisioning key configured → fail to Free (a paid token without a trust anchor grants nothing)', () => {
  const token = signToken({ subject: 'x', tier: 'apex', expires_at: 1_800_000_000_000, namespaces: ['terminal.*'] });
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'entitlement.json'), JSON.stringify(token));
  const e = createEntitlement({ verifyPayload }, { profileDir: dir }); // no provisioningPublicKey, no env
  assert.strictEqual(e.resolve().source, 'free');
});

ok('NESTED-field tamper after signing → fail to Free (recursive canonical)', () => {
  const token = signToken({ subject: 'x', tier: 'exos_pro', state: 'active', expires_at: 1_800_000_000_000, namespaces: ['terminal.*'], limits: { nodes: 1, seats: 1 } });
  token.limits.seats = 999; // tamper a NESTED field the flat-replacer bug used to ignore
  const e = checker(token);
  assert.strictEqual(e.resolve().source, 'free', 'nested tamper rejected by recursive canonical');
});

ok('REVOKED/CANCELED state → fail to Free even with a valid signature (state enforced)', () => {
  for (const state of ['revoked', 'canceled', 'suspended', '']) {
    const token = signToken({ subject: 'x', tier: 'apex', state, expires_at: 1_800_000_000_000, namespaces: ['terminal.*'] });
    const e = checker(token);
    assert.strictEqual(e.resolve().source, 'free', `state "${state}" must not grant`);
    assert.ok(!e.isEntitled('terminal.shell'));
  }
  // past_due IS a granting (grace) state
  const grace = signToken({ subject: 'x', tier: 'apex', state: 'past_due', expires_at: 1_800_000_000_000, namespaces: ['terminal.*'] });
  assert.ok(checker(grace).isEntitled('terminal.shell'), 'past_due (grace) still grants');
});

ok('JUNK/Infinity expires_at → fail to Free (a paid token must carry a real window)', () => {
  for (const exp of ['1e309', 'abc', null, '', 0, -5]) {
    const token = signToken({ subject: 'x', tier: 'apex', state: 'active', expires_at: exp, namespaces: ['terminal.*'] });
    const e = checker(token, { expired: true }); // far-future now()
    assert.strictEqual(e.resolve().source, 'free', `expires_at ${JSON.stringify(exp)} must not grant`);
  }
});

assert.strictEqual(pass, 11, `expected all 11 tests, got ${pass}`);
console.log(`\n✅ ${pass}/11 entitlement tests passed — offline verify, every failure falls to Free Forever.`);
