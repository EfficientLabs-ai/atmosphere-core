/**
 * test-provisioning-ordering.mjs — REGRESSION for Codex HIGH: out-of-order events regress state.
 *
 * For customer.subscription.updated/.deleted the service trusted the event's EMBEDDED subscription
 * object, so applying `.deleted` then a STALE older `.updated` restored grant:true. Fixed two ways
 * (defense in depth): (A) refetch the CURRENT subscription from Stripe (source of truth for out-of-order
 * delivery) when fetchSubscription is available; (B) a per-subject monotonic event.created floor that
 * rejects an event older than the last applied — the floor for the no-fetcher fallback.
 *
 * HARDENED (Codex HIGH F2, 2nd review): the floor previously rejected only created < last, NOT
 * created === last, and the LIVE MOUNT did not require fetchSubscription — so on the no-fetch / same-
 * second path .deleted(created=1000) then a stale .updated(created=1000) restored grant:true. Now the
 * floor never resurrects a grant at an EQUAL timestamp (grant:true only flips when created > last), and
 * the mount fails closed without fetchSubscription (see test-provisioning-mount.mjs).
 *
 * Proves:
 *   A. fetchSubscription present: .deleted (Stripe now canceled) then a stale .updated carrying an
 *      active object → grant stays FALSE (refetch-current wins over the stale embedded object).
 *   B. fetchSubscription absent: a monotonic event.created floor rejects the older .updated → grant
 *      stays FALSE (the stale event cannot regress the record).
 *   C. a NEWER event still applies (the floor is a floor, not a freeze).
 *   D. SAME-SECOND no-fetch: .deleted(1000) then stale .updated(1000) → grant stays FALSE (the equal-
 *      timestamp grant-resurrection bug). E. SAME-SECOND WITH fetch: refetch returns the deleted/current
 *      truth → grant stays FALSE.
 * Hermetic: real signer/store, injected fake Stripe, tmp dirs.
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
const tierForPrice = (pid) => (pid === 'price_apex' ? 'apex' : null);
const apexSub = (over = {}) => ({ id: 'sub_1', status: 'active', current_period_end: periodEndSec, customer: 'cus_A', items: { data: [{ price: { id: 'price_apex', recurring: { interval: 'month' } } }] }, ...over });

console.log('provisioning-ordering — out-of-order webhooks cannot regress state\n');

// A. REFETCH-CURRENT-STATE: Stripe is the source of truth. .deleted (now canceled in Stripe) then a
//    stale .updated carrying an ACTIVE object → refetch returns canceled → grant stays false.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-a-'));
  const store = createEntitlementStore({ dir });
  const stripeStatus = { val: 'canceled' }; // Stripe's CURRENT truth once the sub is deleted
  const svc = createProvisioningService({
    store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey,
    fetchSubscription: async () => apexSub({ status: stripeStatus.val }),
  });
  // .deleted arrives first (current truth = canceled).
  await svc.applyEvent({ id: 'evt_del', type: 'customer.subscription.deleted', created: 2000, data: { object: apexSub({ status: 'canceled' }) } });
  const afterDel = store.get('cus_A');
  ok(afterDel.grant === false, 'A: after .deleted → grant:false');
  // a STALE older .updated carrying an ACTIVE object arrives late; Stripe still reports canceled.
  const r = await svc.applyEvent({ id: 'evt_stale_upd', type: 'customer.subscription.updated', created: 1000, data: { object: apexSub({ status: 'active' }) } });
  const afterStale = store.get('cus_A');
  ok(afterStale.grant === false, 'A: stale .updated did NOT restore grant (refetch-current-state wins)');
  void r;
  fs.rmSync(dir, { recursive: true, force: true });
}

// B. MONOTONIC FLOOR (no fetcher): the embedded object is all there is; the event.created floor rejects
//    the older .updated so it cannot regress the .deleted record.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-b-'));
  const store = createEntitlementStore({ dir });
  const svc = createProvisioningService({ store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey }); // NO fetchSubscription
  await svc.applyEvent({ id: 'evt_del2', type: 'customer.subscription.deleted', created: 2000, data: { object: apexSub({ status: 'canceled' }) } });
  ok(store.get('cus_A').grant === false, 'B: after .deleted (no fetcher) → grant:false');
  const r = await svc.applyEvent({ id: 'evt_stale2', type: 'customer.subscription.updated', created: 1000, data: { object: apexSub({ status: 'active' }) } });
  ok(r.ignored === true && /stale event/.test(r.reason || ''), 'B: older event.created → ignored as stale (monotonic floor)');
  ok(store.get('cus_A').grant === false, 'B: stale .updated did NOT restore grant (timestamp floor held)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// C. The floor is a FLOOR, not a freeze: a NEWER event still applies normally.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-c-'));
  const store = createEntitlementStore({ dir });
  const svc = createProvisioningService({ store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey });
  await svc.applyEvent({ id: 'evt_old', type: 'customer.subscription.updated', created: 1000, data: { object: apexSub({ status: 'canceled' }) } });
  ok(store.get('cus_A').grant === false, 'C: older event applied first → canceled');
  const r = await svc.applyEvent({ id: 'evt_new', type: 'customer.subscription.updated', created: 3000, data: { object: apexSub({ status: 'active' }) } });
  ok(r.handled === true && store.get('cus_A').grant === true, 'C: a NEWER event still applies (floor is not a freeze)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// D. SAME-SECOND, NO FETCHER (the F2 regression): .deleted(1000) then a stale .updated(1000) must NOT
//    resurrect the grant. The OLD floor only rejected created < last, so an equal timestamp slipped
//    through and restored grant:true. Now grant:true only flips when created > last.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-d-'));
  const store = createEntitlementStore({ dir });
  const svc = createProvisioningService({ store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey }); // NO fetchSubscription
  await svc.applyEvent({ id: 'evt_del_d', type: 'customer.subscription.deleted', created: 1000, data: { object: apexSub({ status: 'canceled' }) } });
  ok(store.get('cus_A').grant === false, 'D: after .deleted(1000) (no fetcher) → grant:false');
  const r = await svc.applyEvent({ id: 'evt_upd_d', type: 'customer.subscription.updated', created: 1000, data: { object: apexSub({ status: 'active' }) } });
  ok(r.ignored === true && /same-second/.test(r.reason || ''), 'D: same-second .updated(1000) → ignored (cannot resurrect a non-granting state)');
  ok(store.get('cus_A').grant === false, 'D: stale same-second .updated did NOT restore grant (equal-timestamp floor held)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// E. SAME-SECOND, WITH FETCHER: refetch returns Stripe's CURRENT (deleted/canceled) truth, so the stale
//    same-second .updated cannot regress — grant stays false via the primary defense too.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-e-'));
  const store = createEntitlementStore({ dir });
  const svc = createProvisioningService({
    store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey,
    fetchSubscription: async () => apexSub({ status: 'canceled' }), // Stripe's current truth = canceled
  });
  await svc.applyEvent({ id: 'evt_del_e', type: 'customer.subscription.deleted', created: 1000, data: { object: apexSub({ status: 'canceled' }) } });
  ok(store.get('cus_A').grant === false, 'E: after .deleted(1000) (with fetcher) → grant:false');
  await svc.applyEvent({ id: 'evt_upd_e', type: 'customer.subscription.updated', created: 1000, data: { object: apexSub({ status: 'active' }) } });
  ok(store.get('cus_A').grant === false, 'E: same-second .updated, refetch returns canceled → grant stays false (refetch-current wins)');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? '✖' : '✓'} provisioning-ordering: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
