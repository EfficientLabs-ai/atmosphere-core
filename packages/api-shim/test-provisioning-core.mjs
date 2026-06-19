/**
 * test-provisioning-core.mjs — the PURE provisioning cores:
 *   subscription-state.js (tier→entitlement recompute + state machine) and
 *   entitlement-store.js (record store + idempotent event dedup).
 * Hermetic: no Stripe, no network, temp dir only.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  entitlementFromSubscription, mapSubscriptionStatus, priceIdOf, TIER_NAMESPACES,
} from './src/product/subscription-state.js';
import { createEntitlementStore } from './src/product/entitlement-store.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

const DAY = 86_400_000;
const periodEndSec = Math.round((Date.now() + 30 * DAY) / 1000); // Stripe seconds
// A test price→tier map (real price_ids are founder/Stripe-gated; inject like production will config).
const tierForPrice = (pid) => ({ price_apex: 'apex', price_pro: 'exos_pro', price_teams: 'teams' }[pid] || null);
const sub = (over = {}) => ({
  status: 'active',
  current_period_end: periodEndSec,
  quantity: null,
  items: { data: [{ price: { id: 'price_apex', recurring: { interval: 'month' } } }] },
  customer: 'cus_123',
  ...over,
});

console.log('subscription-state — recompute + state machine\n');

// 1. active known price → grant, tier, namespaces, expiry.
{
  const e = entitlementFromSubscription(sub(), { tierForPrice });
  ok(e.grant === true, 'active sub grants');
  ok(e.tier === 'apex', 'tier resolved from price_id');
  ok(e.state === 'active', 'state active');
  ok(e.namespaces.includes('receipts.export') && e.namespaces.includes('terminal.*'), 'apex namespaces present');
  ok(e.expires_at === periodEndSec * 1000, 'expires_at = current_period_end in ms (no grace double-count)');
  ok(e.interval === 'month', 'interval carried');
}

// 2. past_due → still grants (grace), state past_due.
{
  const e = entitlementFromSubscription(sub({ status: 'past_due' }), { tierForPrice });
  ok(e.grant === true && e.state === 'past_due', 'past_due grants with grace state');
}

// 3. canceled → no grant.
{
  const e = entitlementFromSubscription(sub({ status: 'canceled' }), { tierForPrice });
  ok(e.grant === false && e.state === 'canceled', 'canceled → no grant (Free floor)');
}

// 4. unknown price → no grant.
{
  const e = entitlementFromSubscription(sub({ items: { data: [{ price: { id: 'price_unknown' } }] } }), { tierForPrice });
  ok(e.grant === false, 'unknown price → no grant');
}

// 5. teams seats → nodes = seats.
{
  const e = entitlementFromSubscription(
    sub({ items: { data: [{ price: { id: 'price_teams', recurring: { interval: 'month' } } }] }, quantity: 7 }),
    { tierForPrice });
  ok(e.tier === 'teams' && e.seats === 7 && e.limits.nodes === 7, 'teams: nodes = seats');
}

// 6. missing current_period_end → no grant (a paid token must carry a window).
{
  const e = entitlementFromSubscription(sub({ current_period_end: undefined }), { tierForPrice });
  ok(e.grant === false, 'missing current_period_end → no grant');
}

// 7. helpers
ok(mapSubscriptionStatus('trialing') === 'active', 'trialing maps to active');
ok(mapSubscriptionStatus('unpaid') === 'past_due', 'unpaid maps to past_due grace');
ok(mapSubscriptionStatus('weird') === 'canceled', 'unknown status → canceled');
ok(priceIdOf({ items: { data: [{ price: { id: 'price_x' } }] } }) === 'price_x', 'priceIdOf reads items.data[].price.id');
ok(priceIdOf({ plan: { id: 'price_y' } }) === 'price_y', 'priceIdOf falls back to plan.id');
ok(Object.isFrozen(TIER_NAMESPACES.apex), 'TIER_NAMESPACES frozen (shared arrays not mutable)');

console.log('\nentitlement-store — records + dedup\n');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  let t = 1_000_000;
  const store = createEntitlementStore({ dir, now: () => t });

  // upsert + get
  const rec = store.upsert({ subject: 'cus_123', tier: 'apex', state: 'active', price_id: 'price_apex', expires_at: 123 });
  ok(rec.updated_at === 1_000_000, 'upsert stamps updated_at from injected now');
  ok(store.get('cus_123').tier === 'apex', 'get returns the upserted record');
  ok(store.get('nope') === null, 'get unknown subject → null');

  // all()
  store.upsert({ subject: 'cus_456', tier: 'exos_pro', state: 'active' });
  ok(store.all().length === 2, 'all() returns both records');

  // dedup (single-state-file: claim → finalize → done is the permanent processed record)
  ok(store.isProcessed('evt_1') === false, 'unseen event → not processed');
  ok(store.claimEvent('evt_1') === 'claimed', 'unseen event → claimEvent returns "claimed"');
  store.finalizeEvent('evt_1', 'checkout.session.completed');
  ok(store.isProcessed('evt_1') === true, 'finalized event → processed (dedup hit)');
  ok(store.claimEvent('evt_1') === 'done', 'a re-claim of a finalized id → "done" (deduped, not reprocessed)');
  ok(store.isProcessed('evt_2') === false, 'other event → still not processed');

  // persistence across a fresh store instance over the same dir (atomic write survived)
  const store2 = createEntitlementStore({ dir, now: () => t });
  ok(store2.get('cus_123').tier === 'apex', 'records persist across a new store instance');
  ok(store2.isProcessed('evt_1') === true, 'dedup state persists across a new store instance');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? '✖' : '✓'} provisioning-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
