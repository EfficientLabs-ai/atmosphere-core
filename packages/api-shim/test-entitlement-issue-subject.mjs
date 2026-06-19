/**
 * test-entitlement-issue-subject.mjs — REGRESSION for Codex CRITICAL: header-controlled entitlement mint.
 *
 * The GET /v1/account/entitlement-token route must NOT trust a client `x-efl-subject` header for the
 * billing SUBJECT in production. The subject MUST come from an injected `subjectOf(req)` resolver that
 * binds to the authenticated node/account; with no resolver the route REFUSES to mint (fail-closed),
 * except under the explicit, default-off ALLOW_HEADER_SUBJECT=1 opt-in for tests/local dev.
 *
 * Proves:
 *   1. NO resolver + NO flag + arbitrary x-efl-subject → 503 (NOT a 200 minted token).  [the exploit, closed]
 *   2. Resolver INJECTED → subject comes from the resolver; a spoofed x-efl-subject is IGNORED.
 *   3. ALLOW_HEADER_SUBJECT=1 (tests only) → header is honored again (the documented opt-in).
 * Hermetic: in-process express app, real signer, tmp store; no Stripe/network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { generateHybridKeyPair, verifyPayload } from '../stratos-agent/src/security/quantum-crypto.js';
import { signEntitlement } from './src/product/entitlement-signer.js';
import { createEntitlement } from './src/product/entitlement.js';
import { createEntitlementStore } from './src/product/entitlement-store.js';
import { createProvisioningService } from './src/product/provisioning-service.js';
import { createEntitlementIssueRouter } from './src/product/entitlement-issue-api.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

const DAY = 86_400_000;
const prov = generateHybridKeyPair();

// Two granting records on disk: the attacker's TARGET (cus_victim) and the resolver's REAL subject (cus_real).
function makeService(dir) {
  const store = createEntitlementStore({ dir });
  const granting = (subject) => ({ subject, grant: true, tier: 'apex', state: 'active', namespaces: ['terminal.*', 'receipts.export'], expires_at: Date.now() + 30 * DAY });
  store.upsert(granting('cus_victim'));
  store.upsert(granting('cus_real'));
  return createProvisioningService({ store, signEntitlement, provPrivBundle: prov.privateKey });
}

function serve({ subjectOf }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-subj-'));
  const app = express();
  app.use(createEntitlementIssueRouter({ service: makeService(dir), subjectOf })); // auth = passthrough (focus is the subject seam)
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${s.address().port}`, close: () => { s.close(); fs.rmSync(dir, { recursive: true, force: true }); } })); });
}

// Recursive canonical JSON — byte-identical to entitlement.js/entitlement-signer.js (the repo idiom),
// so we can re-verify the signature over the EXACT signed body the node would.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const pubBundle = Object.fromEntries(Object.entries(prov.publicKey).map(([k, v]) => [k, typeof v === 'string' ? Buffer.from(v, 'base64') : v]));

/** Resolve the token offline (proves it grants paid namespaces) AND read its signed `subject` claim
 *  after re-verifying the signature — the subject is a signed claim in the token body. */
function verifyTokenSubject(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-tok-'));
  const tokenPath = path.join(dir, 'entitlement.json');
  fs.writeFileSync(tokenPath, JSON.stringify(token));
  const resolved = createEntitlement({ verifyPayload }, { tokenPath, provisioningPublicKey: prov.publicKey }).resolve();
  fs.rmSync(dir, { recursive: true, force: true });
  // re-verify the signature over the canonical body, then trust token.subject (a signed claim).
  const { sig, ...body } = token;
  let sigOk = false;
  try { sigOk = verifyPayload(canonical(body), sig, pubBundle); } catch { sigOk = false; }
  return { source: resolved.source, subject: sigOk ? token.subject : null };
}

console.log('entitlement-issue — subject binding (fail-closed; never trust a client header)\n');

// 1. NO resolver, flag OFF, arbitrary x-efl-subject → REFUSED (503). The exploit is closed.
{
  delete process.env.ALLOW_HEADER_SUBJECT;
  const { base, close } = await serve({ subjectOf: undefined });
  const r = await fetch(`${base}/v1/account/entitlement-token`, { headers: { 'x-efl-subject': 'cus_victim' } });
  const b = await r.json();
  ok(r.status === 503 && b.error?.type === 'subject_resolver', 'no resolver + no flag + arbitrary x-efl-subject → 503 refuse-to-mint (NOT a 200 minted token)');
  ok(b.grant === undefined && b.token === undefined, 'no token field is returned on the refusal');
  close();
}

// 2. Resolver INJECTED → subject from the resolver; a spoofed x-efl-subject is IGNORED.
{
  delete process.env.ALLOW_HEADER_SUBJECT;
  // The resolver authoritatively binds this request to cus_real (e.g. node→account proof), regardless of headers.
  const { base, close } = await serve({ subjectOf: () => 'cus_real' });
  const r = await fetch(`${base}/v1/account/entitlement-token`, { headers: { 'x-efl-subject': 'cus_victim' } });
  const b = await r.json();
  ok(r.status === 200 && b.grant === true && b.token?.format === 'efl.entitlement.v1', 'resolver injected → token minted from the bound subject');
  const v = verifyTokenSubject(b.token);
  ok(v.source === 'token' && v.subject === 'cus_real', 'minted token subject = resolver subject (cus_real) — the spoofed header (cus_victim) was IGNORED');
  ok(v.subject !== 'cus_victim', 'the attacker-controlled header did NOT determine the subject');
  close();
}

// 3. ALLOW_HEADER_SUBJECT=1 (tests/local only) → the header is honored again (documented opt-in).
{
  process.env.ALLOW_HEADER_SUBJECT = '1';
  const { base, close } = await serve({ subjectOf: undefined });
  const r = await fetch(`${base}/v1/account/entitlement-token`, { headers: { 'x-efl-subject': 'cus_real' } });
  const b = await r.json();
  ok(r.status === 200 && b.grant === true, 'ALLOW_HEADER_SUBJECT=1 → header subject honored (the explicit test opt-in)');
  // and with the flag on but NO header → honest Free floor (not a 503, not a mint).
  const r2 = await fetch(`${base}/v1/account/entitlement-token`);
  const b2 = await r2.json();
  ok(r2.status === 200 && b2.grant === false && b2.tier === 'free_forever', 'flag on + no header → honest Free floor');
  close();
  delete process.env.ALLOW_HEADER_SUBJECT;
}

console.log(`\n${fail ? '✖' : '✓'} entitlement-issue-subject: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
