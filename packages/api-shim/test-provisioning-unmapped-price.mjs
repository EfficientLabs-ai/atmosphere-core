/**
 * test-provisioning-unmapped-price.mjs — REGRESSION for Codex HIGH: unmapped price silently ACKed as free.
 *
 * An ACTIVE subscription whose price maps to no known tier was downgraded to a free/canceled record and
 * marked processed — so Stripe never retried and the operator was never alerted to a price→tier map gap.
 * Fixed: distinguish a genuine cancellation (status not granting → free is correct) from an ACTIVE/grace
 * subscription on an UNMAPPED price (operator misconfig → 5xx retry + loud log, NOT finalized).
 *
 * Proves:
 *   1. ACTIVE sub + unmapped price → retry (NOT handled:true free), NOT finalized (Stripe re-delivers).
 *   2. past_due (grace) + unmapped price → same (still a granting status, still a misconfig).
 *   3. a genuine .deleted/canceled → free record, handled, finalized (the correct free path is intact).
 *   4. once the price IS mapped, the retried event applies as a normal grant.
 * Hermetic: real store/signer, no Stripe; tmp dirs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateHybridKeyPair } from '../stratos-agent/src/security/quantum-crypto.js';
import { signEntitlement } from './src/product/entitlement-signer.js';
import { createEntitlementStore } from './src/product/entitlement-store.js';
import { createProvisioningService } from './src/product/provisioning-service.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

const DAY = 86_400_000;
const prov = generateHybridKeyPair();
const periodEndSec = Math.round((Date.now() + 30 * DAY) / 1000);
// Map only price_apex; price_mystery is intentionally UNMAPPED (the operator forgot to add it).
const tierForPrice = (pid) => (pid === 'price_apex' ? 'apex' : null);
const subOn = (priceId, over = {}) => ({ id: 'sub_1', status: 'active', current_period_end: periodEndSec, customer: 'cus_A', items: { data: [{ price: { id: priceId, recurring: { interval: 'month' } } }] }, ...over });

console.log('provisioning-unmapped-price — active+unmapped → retry+alert (never silent free)\n');

// 1. ACTIVE subscription on an UNMAPPED price → retry, NOT a free record, NOT finalized.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmap-'));
  const store = createEntitlementStore({ dir });
  const svc = createProvisioningService({ store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey });
  const r = await svc.applyEvent({ id: 'evt_bad', type: 'customer.subscription.updated', created: 1000, data: { object: subOn('price_mystery') } });
  ok(r.retry === true && /unmapped price/.test(r.reason || ''), 'active + unmapped price → retry (operator misconfig), NOT handled:true');
  ok(r.handled !== true && r.record === undefined, 'no free/canceled record was returned');
  ok(store.get('cus_A') === null, 'NO record written for the unmapped-price subject (not silently downgraded to free)');
  ok(store.isProcessed('evt_bad') === false, 'event NOT finalized → Stripe will re-deliver (operator gets a chance to fix the map)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. past_due (grace, still granting) + unmapped price → same retry posture.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmap2-'));
  const store = createEntitlementStore({ dir });
  const svc = createProvisioningService({ store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey });
  const r = await svc.applyEvent({ id: 'evt_pd', type: 'customer.subscription.updated', created: 1000, data: { object: subOn('price_mystery', { status: 'past_due' }) } });
  ok(r.retry === true, 'past_due + unmapped price → retry (a grace status is still granting → still a misconfig)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. A GENUINE cancellation → free record, handled, finalized (the correct free path is preserved).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-'));
  const store = createEntitlementStore({ dir });
  const svc = createProvisioningService({ store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey });
  // canceled status: not granting regardless of price → free is the CORRECT outcome.
  const r = await svc.applyEvent({ id: 'evt_del', type: 'customer.subscription.deleted', created: 1000, data: { object: subOn('price_mystery', { status: 'canceled' }) } });
  ok(r.handled === true && r.record.grant === false && r.record.tier === 'free_forever', 'genuine .deleted/canceled → free record (correct), even on an unmapped price');
  ok(store.isProcessed('evt_del') === true, 'genuine cancellation IS finalized (no needless retry)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4. Once the operator MAPS the price, the retried event applies as a normal grant.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-'));
  const store = createEntitlementStore({ dir });
  let mapped = false;
  const dynMap = (pid) => (pid === 'price_mystery' && mapped ? 'apex' : (pid === 'price_apex' ? 'apex' : null));
  const svc = createProvisioningService({ store, tierForPrice: dynMap, signEntitlement, provPrivBundle: prov.privateKey });
  const evt = { id: 'evt_fix', type: 'customer.subscription.updated', created: 1000, data: { object: subOn('price_mystery') } };
  const r1 = await svc.applyEvent(evt);
  ok(r1.retry === true, 'before the map fix → retry');
  mapped = true; // operator adds price_mystery → apex
  const r2 = await svc.applyEvent(evt); // Stripe re-delivers the same id; the claim was released
  ok(r2.handled === true && r2.record.tier === 'apex' && r2.record.grant === true, 'after the map fix, the retried event applies as apex (loop heals)');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? '✖' : '✓'} provisioning-unmapped-price: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
