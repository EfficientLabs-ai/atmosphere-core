/**
 * test-entitlement-signer.mjs — the round-trip oracle for the GRANTING side.
 * Proves the signer is the exact inverse of the SHIPPED verifier (entitlement.js + raw verifyPayload):
 *   - a real signed token, written to disk and read back, resolves to source:'token' with the granted
 *     namespaces unioned onto the Free floor;
 *   - every failure mode (tamper, wrong key, non-granting state, expired-past-grace, no token) falls
 *     to Free Forever — NEVER an error, NEVER fail-closed;
 *   - grace window honors a recently-expired active token;
 *   - canonical() parity: the signer's canonical and the verifier's agree (proven transitively — if
 *     they disagreed, the real-signature happy path could not verify).
 * Run: node test-entitlement-signer.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { generateHybridKeyPair, verifyPayload } from '../stratos-agent/src/security/quantum-crypto.js';
import { createEntitlement, FREE_FOREVER_NAMESPACES } from './src/product/entitlement.js';
import { signEntitlement } from './src/product/entitlement-signer.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

const prov = generateHybridKeyPair();          // the provisioning keypair (signs grants)
const stranger = generateHybridKeyPair();      // an unrelated key (forgery attempts)
const DAY = 86_400_000;

// A fresh temp profile dir per token so resolve()'s disk read is hermetic.
function resolveToken(token, { pubKey = prov.publicKey } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-'));
  const tokenPath = path.join(dir, 'entitlement.json');
  if (token !== undefined) fs.writeFileSync(tokenPath, JSON.stringify(token));
  const r = createEntitlement({ verifyPayload }, { tokenPath, provisioningPublicKey: pubKey, now: Date.now }).resolve();
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

console.log('entitlement-signer round-trip:');

// 1. HAPPY PATH — real signature verifies, grants, unions with the Free floor.
{
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*', 'workflows.run'], expires_at: Date.now() + 30 * DAY }, prov.privateKey);
  const r = resolveToken(token);
  ok(r.source === 'token', `valid signed token → source:'token' (got '${r.source}': ${r.reason || ''})`);
  ok(r.tier === 'apex', "tier carried through ('apex')");
  ok(r.namespaces.includes('terminal.*') && r.namespaces.includes('workflows.run'), 'granted namespaces present');
  ok(FREE_FOREVER_NAMESPACES.every((n) => r.namespaces.includes(n)), 'Free Forever floor unioned in');
}

// 2. TAMPER — flip a granted namespace after signing → signature breaks → Free.
{
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() + 30 * DAY }, prov.privateKey);
  token.namespaces = ['admin.*']; // privilege-escalation attempt, post-signature
  const r = resolveToken(token);
  ok(r.source === 'free' && !r.namespaces.includes('admin.*'), 'tampered namespaces → fail-to-free, no escalation');
}
// 2b. TAMPER — bump the tier after signing → Free.
{
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() + 30 * DAY }, prov.privateKey);
  token.tier = 'enterprise';
  ok(resolveToken(token).source === 'free', 'tampered tier → fail-to-free');
}
// 2c. TAMPER — extend expiry after signing → Free.
{
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() + DAY }, prov.privateKey);
  token.expires_at = Date.now() + 3650 * DAY;
  ok(resolveToken(token).source === 'free', 'tampered expiry → fail-to-free');
}

// 3. WRONG KEY — verify against a stranger's public key → Free.
{
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() + 30 * DAY }, prov.privateKey);
  ok(resolveToken(token, { pubKey: stranger.publicKey }).source === 'free', 'signed by prov, verified against stranger → fail-to-free');
}
// 3b. FORGED — signed by a stranger, verified against prov pubkey → Free.
{
  const token = signEntitlement({ tier: 'enterprise', state: 'active', namespaces: ['admin.*'], expires_at: Date.now() + 30 * DAY }, stranger.privateKey);
  ok(resolveToken(token).source === 'free', 'forged by stranger key → fail-to-free');
}

// 4. NON-GRANTING STATE — a validly-signed but canceled token grants nothing.
{
  const token = signEntitlement({ tier: 'apex', state: 'canceled', namespaces: ['terminal.*'], expires_at: Date.now() + 30 * DAY }, prov.privateKey);
  const r = resolveToken(token);
  ok(r.source === 'free' && r.reason.includes('not granting'), 'state:canceled (validly signed) → Free');
}
// 4b. past_due IS granting (grace state).
{
  const token = signEntitlement({ tier: 'apex', state: 'past_due', namespaces: ['terminal.*'], expires_at: Date.now() + 30 * DAY }, prov.privateKey);
  ok(resolveToken(token).source === 'token', 'state:past_due → still grants (grace)');
}

// 5. EXPIRY — past grace → Free; within grace → still grants.
{
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() - 30 * DAY }, prov.privateKey);
  ok(resolveToken(token).source === 'free', 'expired past 14d grace → Free');
}
{
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() - 1 * DAY }, prov.privateKey);
  ok(resolveToken(token).source === 'token', 'expired 1d ago (within 14d grace) → still grants');
}

// 6. NO TOKEN — pure Free Forever, no error.
{
  const r = resolveToken(undefined);
  ok(r.source === 'free' && r.tier === 'free_forever', 'no token → Free Forever floor');
}

// 7. INPUT VALIDATION — signer rejects bad grants loudly (provisioning-time error, not a silent bad token).
{
  let threw = false;
  try { signEntitlement({ tier: 'apex', state: 'active', namespaces: ['ok'], expires_at: Infinity }, prov.privateKey); } catch { threw = true; }
  ok(threw, 'signer rejects non-finite expires_at');
  threw = false;
  try { signEntitlement({ tier: 'apex', state: 'active', namespaces: ['ok'], expires_at: Date.now() + DAY }, null); } catch { threw = true; }
  ok(threw, 'signer rejects a missing private bundle');
}

// 8. RESERVED-CLAIM GUARD (dual-Codex fix #1) — extra may not override a core claim; loud throw.
{
  const base = { tier: 'apex', state: 'canceled', namespaces: ['workspace.read'], expires_at: Date.now() + DAY };
  // the escalation the reviewers reproduced: extra flips a canceled token to active+admin.
  let threw = false;
  try { signEntitlement({ ...base, extra: { state: 'active', namespaces: ['admin.*'] } }, prov.privateKey); } catch { threw = true; }
  ok(threw, 'extra overriding state+namespaces → throws (no silent escalation)');
  for (const k of ['tier', 'format', 'expires_at', 'sig', 'namespaces', 'state']) {
    let t = false;
    try { signEntitlement({ ...base, extra: { [k]: 'x' } }, prov.privateKey); } catch { t = true; }
    ok(t, `extra.${k} (reserved) → throws`);
  }
}

// 9. ROUND-TRIP PARITY (dual-Codex fix #2) — legit extra is signed AND survives; non-stable extra
//    (undefined) is neutralized so the token still verifies (signs exactly the persisted bytes).
{
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() + 30 * DAY, extra: { account_id: 'acct_123', node_did: 'did:atmos:abc' } }, prov.privateKey);
  ok(token.account_id === 'acct_123' && token.node_did === 'did:atmos:abc', 'legit extra claims present in the token');
  ok(resolveToken(token).source === 'token', 'token with extra claims still verifies (source:token)');
}
{
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() + 30 * DAY, extra: { note: undefined, account_id: 'acct_9' } }, prov.privateKey);
  ok(!('note' in token), 'non-serializable extra (undefined) dropped from the token');
  ok(resolveToken(token).source === 'token', 'token verifies despite a non-stable extra value (round-trip parity holds)');
}

// 10. BOUNDED READ (dual-Codex fix #3) — oversized / non-regular token path → Free, never blocks.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-big-'));
  const tokenPath = path.join(dir, 'entitlement.json');
  fs.writeFileSync(tokenPath, 'x'.repeat(70 * 1024)); // > 64 KB cap
  const r = createEntitlement({ verifyPayload }, { tokenPath, provisioningPublicKey: prov.publicKey, now: Date.now }).resolve();
  ok(r.source === 'free', 'oversized token file (>64KB) → fail-to-free (not read into memory)');
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-dir-'));
  const tokenPath = path.join(dir, 'entitlement.json');
  fs.mkdirSync(tokenPath); // a DIRECTORY where a regular file is expected (stand-in for FIFO/device)
  const r = createEntitlement({ verifyPayload }, { tokenPath, provisioningPublicKey: prov.publicKey, now: Date.now }).resolve();
  ok(r.source === 'free', 'non-regular token path (dir/FIFO/device) → fail-to-free');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 11. toJSON BYPASS (dual-Codex round 2 fix) — extra with a toJSON that injects reserved claims must
//     NOT mint an escalated token; it is materialized + key-checked → throws.
{
  const evil = { toJSON() { return { format: 'efl.entitlement.v1', tier: 'enterprise', state: 'active', namespaces: ['admin.*'], expires_at: Date.now() + 3650 * DAY }; } };
  let threw = false;
  try { signEntitlement({ tier: 'apex', state: 'canceled', namespaces: ['workspace.read'], expires_at: Date.now() + DAY, extra: evil }, prov.privateKey); } catch { threw = true; }
  ok(threw, 'extra.toJSON injecting reserved claims → throws (no escalation via serialization hijack)');
  // a toJSON returning a non-reserved object is materialized to inert data and accepted.
  const okExtra = { toJSON() { return { account_id: 'acct_via_tojson' }; } };
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() + 30 * DAY, extra: okExtra }, prov.privateKey);
  ok(token.account_id === 'acct_via_tojson' && typeof token.toJSON !== 'function', 'benign toJSON materialized to inert data (no callable toJSON on the token)');
  ok(resolveToken(token).source === 'token', 'token from a benign toJSON extra still verifies');
}

// 12. FIFO TOKEN PATH (dual-Codex round 2 fix) — a named pipe must NOT block the read; O_NONBLOCK lets
//     fstat reject it → Free. If this regresses, the open() blocks and this test hangs (a visible fail).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-fifo-'));
  const tokenPath = path.join(dir, 'entitlement.json');
  let madeFifo = true;
  try { execFileSync('mkfifo', [tokenPath]); } catch { madeFifo = false; } // no shell; arg array
  if (madeFifo) {
    const r = createEntitlement({ verifyPayload }, { tokenPath, provisioningPublicKey: prov.publicKey, now: Date.now }).resolve();
    ok(r.source === 'free', 'FIFO token path → fail-to-free without blocking (O_NONBLOCK + isFile guard)');
  } else {
    console.log('  ⓘ mkfifo unavailable — FIFO regression skipped');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// 13. VALIDATE-THEN-MUTATE TOCTOU (dual-Codex round 3 fix) — user-controlled serialization in `extra`
//     (a getter, or a nested toJSON) must NOT be able to mutate the caller's namespaces array between
//     validation and signing. The signed token must carry the ORIGINAL namespaces, never the smuggled one.
{
  const ns = ['terminal.read'];
  const extra = {};
  Object.defineProperty(extra, 'trigger', { enumerable: true, get() { ns[0] = 'admin.*'; return 'x'; } });
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ns, expires_at: Date.now() + 30 * DAY, extra }, prov.privateKey);
  ok(!token.namespaces.includes('admin.*') && token.namespaces[0] === 'terminal.read', 'extra getter mutating namespaces → token keeps the original namespaces (no smuggle)');
  ok(resolveToken(token).source === 'token', 'token still verifies (signed over the inert snapshot)');
}
{
  const ns = ['terminal.read'];
  const extra = { meta: { toJSON() { ns[0] = 'admin.*'; return {}; } } };
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: ns, expires_at: Date.now() + 30 * DAY, extra }, prov.privateKey);
  ok(!token.namespaces.includes('admin.*'), 'nested extra toJSON mutating namespaces → no smuggle into the token');
  ok(resolveToken(token).source === 'token', 'token still verifies (snapshot taken before materialization)');
}

// 14. PROXIED-ARRAY TRAP (dual-Codex round 4 fix) — a Proxy namespaces that traps map/every/toJSON to
//     pass validation then serialize to ['admin.*'] must NOT smuggle. The signer uses only indexed
//     reads into a fresh real array, so the token carries the genuine indexed values.
{
  const evilNs = new Proxy(['terminal.read'], {
    get(target, prop, recv) {
      if (prop === 'map') return () => ({ every: () => true, toJSON: () => ['admin.*'] });
      if (prop === 'every') return () => true;
      if (prop === 'toJSON') return () => ['admin.*'];
      return Reflect.get(target, prop, recv);
    },
  });
  const token = signEntitlement({ tier: 'apex', state: 'active', namespaces: evilNs, expires_at: Date.now() + 30 * DAY }, prov.privateKey);
  ok(Array.isArray(token.namespaces) && !token.namespaces.includes('admin.*') && token.namespaces[0] === 'terminal.read', 'proxied-array trap → token carries the genuine indexed values, no admin.* smuggle');
  ok(resolveToken(token).source === 'token', 'token from a proxied namespaces input still verifies (signed over the real-array snapshot)');
}

console.log(`\n${fail ? '✖' : '✓'} entitlement-signer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
