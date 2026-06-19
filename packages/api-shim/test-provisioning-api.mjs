/**
 * test-provisioning-api.mjs — HTTP loop: POST /v1/stripe/webhook → GET /v1/account/entitlement-token.
 * Proves the routers wire the service correctly and that a token fetched over HTTP verifies offline.
 * Hermetic: injected test-mode verifyEvent (no Stripe secret), fake subscription source.
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
import { createStripeWebhookRouter } from './src/product/stripe-webhook-api.js';
import { createEntitlementIssueRouter } from './src/product/entitlement-issue-api.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

// This suite drives the issue route via the test-only x-efl-subject header (no injected resolver).
// The header path is fail-closed by default (Codex CRITICAL); opt in explicitly for the hermetic test.
process.env.ALLOW_HEADER_SUBJECT = '1';

const DAY = 86_400_000;
const prov = generateHybridKeyPair();
const periodEndSec = Math.round((Date.now() + 30 * DAY) / 1000);
const tierForPrice = (pid) => (pid === 'price_apex' ? 'apex' : null);
const apexSub = (over = {}) => ({ id: 'sub_1', status: 'active', current_period_end: periodEndSec, customer: 'cus_A', items: { data: [{ price: { id: 'price_apex', recurring: { interval: 'month' } } }] }, ...over });
const subs = { sub_1: apexSub() };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-api-'));
const store = createEntitlementStore({ dir });
const svc = createProvisioningService({
  store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey,
  fetchSubscription: async (id) => subs[id] || null,
});

// test-mode verifier: trust the body as the event (a real deploy injects Stripe signature verify).
const verifyEvent = (rawBuf) => JSON.parse(Buffer.from(rawBuf).toString('utf8'));

function serve(withVerifier = true) {
  const app = express();
  app.use(createStripeWebhookRouter({ service: svc, verifyEvent: withVerifier ? verifyEvent : undefined }));
  app.use(createEntitlementIssueRouter({ service: svc }));
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${s.address().port}`, close: () => s.close() })); });
}

console.log('provisioning HTTP — webhook → issue token\n');

// 1. default (no verifier) → fail-closed 503 (never trust an unverified webhook).
{
  const { base, close } = await serve(false);
  const r = await fetch(`${base}/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'evt_x', type: 'customer.subscription.updated', data: { object: subs.sub_1 } }) });
  close();
  ok(r.status === 503, 'webhook with no verifier configured → 503 fail-closed');
}

const { base, close } = await serve(true);

// 2. checkout.session.completed → 200 handled.
{
  const r = await fetch(`${base}/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=test' }, body: JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { subscription: 'sub_1', customer: 'cus_A' } } }) });
  const b = await r.json();
  ok(r.status === 200 && b.handled === true, 'POST webhook checkout.session.completed → 200 handled');
}

// 3. GET entitlement-token for the bound subject → 200 grant + a token that verifies offline.
{
  const r = await fetch(`${base}/v1/account/entitlement-token`, { headers: { 'x-efl-subject': 'cus_A' } });
  const b = await r.json();
  ok(r.status === 200 && b.grant === true && b.token?.format === 'efl.entitlement.v1', 'GET entitlement-token → signed token');
  const tokenPath = path.join(dir, 'entitlement.json');
  fs.writeFileSync(tokenPath, JSON.stringify(b.token));
  const resolved = createEntitlement({ verifyPayload }, { tokenPath, provisioningPublicKey: prov.publicKey }).resolve();
  ok(resolved.source === 'token' && resolved.tier === 'apex', 'token fetched over HTTP verifies offline → apex (HTTP LOOP CLOSED)');
  fs.rmSync(tokenPath, { force: true });
}

// 4. no bound subject → honest Free floor, not an error.
{
  const r = await fetch(`${base}/v1/account/entitlement-token`);
  const b = await r.json();
  ok(r.status === 200 && b.grant === false && b.tier === 'free_forever', 'no subject bound → 200 Free floor (never an error wall)');
}

// 5. cancel → token endpoint stops granting.
{
  subs.sub_1 = apexSub({ status: 'canceled' });
  await fetch(`${base}/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=test' }, body: JSON.stringify({ id: 'evt_del', type: 'customer.subscription.deleted', data: { object: subs.sub_1 } }) });
  const r = await fetch(`${base}/v1/account/entitlement-token`, { headers: { 'x-efl-subject': 'cus_A' } });
  const b = await r.json();
  ok(r.status === 200 && b.grant === false, 'after cancel → entitlement-token returns Free floor (no token)');
}

close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? '✖' : '✓'} provisioning-api: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
