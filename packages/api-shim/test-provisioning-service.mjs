/**
 * test-provisioning-service.mjs — the orchestrator + the FULL LOOP end-to-end (hermetic, no Stripe).
 * Proves STRIPE_PROVISIONING_PLAN.md §8 step 7 at the unit level:
 *   webhook event → recompute → store → issue signed token → the SHIPPED offline verifier resolves it
 *   → paid namespaces on; then cancel → issue nothing → verifier falls to the Free Forever floor.
 * Uses the REAL signer (entitlement-signer.js) and the REAL verifier (entitlement.js) — the token the
 * service issues is the token a node would actually verify.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateHybridKeyPair, verifyPayload } from '../stratos-agent/src/security/quantum-crypto.js';
import { signEntitlement } from './src/product/entitlement-signer.js';
import { createEntitlement } from './src/product/entitlement.js';
import { createEntitlementStore } from './src/product/entitlement-store.js';
import { createProvisioningService } from './src/product/provisioning-service.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

const DAY = 86_400_000;
const prov = generateHybridKeyPair();
const periodEndSec = Math.round((Date.now() + 30 * DAY) / 1000);
const tierForPrice = (pid) => ({ price_apex: 'apex', price_teams: 'teams' }[pid] || null);

// A fake Stripe: a subscription registry + the injected fetch/list the service speaks to.
function fakeStripe(initial = {}) {
  const subs = { ...initial };
  return {
    subs,
    fetchSubscription: async (id) => subs[id] || null,
    listActiveSubscriptions: async () => Object.values(subs).filter((s) => s.status === 'active' || s.status === 'past_due'),
  };
}
const apexSub = (over = {}) => ({
  id: 'sub_1', status: 'active', current_period_end: periodEndSec, customer: 'cus_A',
  items: { data: [{ price: { id: 'price_apex', recurring: { interval: 'month' } } }] }, ...over,
});

console.log('provisioning-service — apply / issue / reconcile + full loop\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-svc-'));
const store = createEntitlementStore({ dir });
const stripe = fakeStripe({ sub_1: apexSub() });
const svc = createProvisioningService({
  store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey,
  fetchSubscription: stripe.fetchSubscription, listActiveSubscriptions: stripe.listActiveSubscriptions,
});

// 1. checkout.session.completed → record upserted as granting apex.
{
  const r = await svc.applyEvent({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { subscription: 'sub_1', customer: 'cus_A' } } });
  ok(r.handled && r.subject === 'cus_A' && r.record.tier === 'apex', 'checkout.session.completed → apex record for cus_A');
}

// 2. dedup: same event again → deduped, no double-apply.
{
  const r = await svc.applyEvent({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { subscription: 'sub_1', customer: 'cus_A' } } });
  ok(r.deduped === true, 'replayed event id → deduped (exactly-once-in-effect)');
}

// 3. issueToken → THE FULL LOOP: sign, write to disk, resolve with the shipped offline verifier.
{
  const issued = svc.issueToken('cus_A');
  ok(issued.grant === true && issued.token?.format === 'efl.entitlement.v1', 'issueToken mints a signed efl.entitlement.v1');
  const tokenPath = path.join(dir, 'entitlement.json');
  fs.writeFileSync(tokenPath, JSON.stringify(issued.token));
  const resolved = createEntitlement({ verifyPayload }, { tokenPath, provisioningPublicKey: prov.publicKey }).resolve();
  ok(resolved.source === 'token' && resolved.tier === 'apex', 'shipped verifier resolves the issued token → apex (LOOP CLOSED)');
  ok(resolved.namespaces.includes('receipts.export') && resolved.namespaces.includes('files.read'), 'paid namespaces + Free floor unioned');
  fs.rmSync(tokenPath, { force: true });
}

// 4. retryable fetch failure → NOT marked processed (Stripe will retry).
{
  const stripe2 = { fetchSubscription: async () => { throw new Error('stripe down'); } };
  const svc2 = createProvisioningService({ store, tierForPrice, fetchSubscription: stripe2.fetchSubscription });
  const r = await svc2.applyEvent({ id: 'evt_retry', type: 'invoice.paid', data: { object: { subscription: 'sub_1' } } });
  ok(r.retry === true, 'transient fetch failure → retry signal');
  ok(store.isProcessed('evt_retry') === false, 'retryable failure is NOT marked processed (Stripe retries)');
}

// 5. invoice.payment_failed → past_due (still grants, grace).
{
  stripe.subs.sub_1 = apexSub({ status: 'past_due' });
  const r = await svc.applyEvent({ id: 'evt_pf', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_1' } } });
  ok(r.handled && r.record.state === 'past_due' && r.record.grant === true, 'payment_failed → past_due, features stay on (grace)');
}

// 6. subscription.deleted → canceled → issueToken returns no token → verifier falls to Free.
{
  // Stripe is the source of truth: a deleted subscription retrieves as canceled (the service refetches
  // current state to defeat out-of-order delivery), so the fake registry must reflect the cancellation.
  stripe.subs.sub_1 = apexSub({ status: 'canceled' });
  const r = await svc.applyEvent({ id: 'evt_del', type: 'customer.subscription.deleted', data: { object: apexSub({ status: 'canceled' }) } });
  ok(r.handled && r.record.grant === false, 'subscription.deleted → canceled record (NEVER data deletion)');
  const issued = svc.issueToken('cus_A');
  ok(issued.grant === false, 'canceled subject → issueToken issues NO token (node stays on Free floor)');
  // a node with no token resolves to Free — the fail-to-free contract.
  const resolved = createEntitlement({ verifyPayload }, { tokenPath: path.join(dir, 'absent.json'), provisioningPublicKey: prov.publicKey }).resolve();
  ok(resolved.source === 'free' && resolved.tier === 'free_forever', 'no token → Free Forever floor (fail-to-free)');
}

// 7. reconcile: restore an active sub in Stripe; a stale granting subject not in Stripe gets downgraded.
{
  stripe.subs.sub_1 = apexSub({ status: 'active' });           // cus_A active again
  store.upsert({ subject: 'cus_ghost', grant: true, tier: 'apex', state: 'active', namespaces: ['terminal.*'], expires_at: Date.now() + DAY }); // not in Stripe
  const r = await svc.reconcile();
  ok(r.upserted >= 1, 'reconcile upserts active subscriptions from the truth path');
  ok(store.get('cus_A').grant === true, 'reconcile restores cus_A to granting');
  ok(store.get('cus_ghost').grant === false, 'reconcile downgrades a subject Stripe no longer reports active');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? '✖' : '✓'} provisioning-service: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
