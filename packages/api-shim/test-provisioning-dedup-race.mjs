/**
 * test-provisioning-dedup-race.mjs — REGRESSION for Codex HIGH: non-atomic dedup race.
 *
 * isProcessed() ran BEFORE the async subscription fetch and markProcessed() only AFTER the upsert, so
 * two concurrent applyEvent(sameId) both cleared the dedup check and both processed (the processed log
 * contained the id twice). Fixed: the event id is claimed ATOMICALLY (claimEvent, O_CREAT|O_EXCL) at
 * the very start before any await; a lost claim short-circuits as a duplicate. The claim is finalized
 * only on success and RELEASED on a retryable failure (so a legitimate Stripe retry can re-process).
 *
 * Proves:
 *   1. Two concurrent applyEvent for the same id → EXACTLY ONE processes; no duplicate in the log.
 *   2. The store's claim primitive is atomic: many concurrent claimEvent → exactly one true.
 *   3. A retryable failure RELEASES the claim → a later retry re-processes (claim never blocks a retry).
 * Hermetic: real store/signer, an injected fetchSubscription that yields the event loop to force the
 * interleave; tmp dirs.
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

function logCount(dir, id) {
  const p = path.join(dir, 'processed-events.jsonl');
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).filter((l) => { try { return JSON.parse(l).evt_id === id; } catch { return false; } }).length;
}

console.log('provisioning-dedup-race — atomic event claim (concurrent same-id → exactly one)\n');

// 1. Two concurrent applyEvent for the SAME id. The injected fetch yields the event loop, so without an
//    atomic claim both would clear isProcessed() and both apply. With the fix exactly one wins.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-'));
  const store = createEntitlementStore({ dir });
  let fetches = 0;
  const svc = createProvisioningService({
    store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey,
    fetchSubscription: async () => { fetches++; await new Promise((r) => setTimeout(r, 5)); return apexSub(); },
  });
  const evt = { id: 'evt_race', type: 'invoice.paid', created: 1000, data: { object: { subscription: 'sub_1' } } };
  const [a, b] = await Promise.all([svc.applyEvent(evt), svc.applyEvent(evt)]);
  const handled = [a, b].filter((r) => r.handled === true).length;
  const deduped = [a, b].filter((r) => r.deduped === true).length;
  ok(handled === 1 && deduped === 1, 'concurrent same-id → exactly one handled, one deduped');
  ok(logCount(dir, 'evt_race') === 1, 'processed log contains the id EXACTLY ONCE (no duplicate)');
  ok(fetches === 1, 'the loser short-circuited at the claim → the subscription fetch ran only once');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. The store primitive itself is atomic: many concurrent claimEvent for the same id → exactly one true.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
  const store = createEntitlementStore({ dir });
  const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => store.claimEvent('evt_atomic'))));
  ok(results.filter(Boolean).length === 1, '20 concurrent claimEvent(sameId) → exactly ONE true (O_CREAT|O_EXCL atomic)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. A retryable failure RELEASES the claim so a legitimate Stripe retry re-processes (no permanent block).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  const store = createEntitlementStore({ dir });
  let up = false;
  const svc = createProvisioningService({
    store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey,
    // first delivery: fetch throws (transient) → retry + release; retry: succeeds.
    fetchSubscription: async () => { if (!up) { up = true; throw new Error('stripe down'); } return apexSub(); },
  });
  const evt = { id: 'evt_retry', type: 'invoice.paid', created: 1000, data: { object: { subscription: 'sub_1' } } };
  const r1 = await svc.applyEvent(evt);
  ok(r1.retry === true, 'transient fetch failure → retry signal');
  ok(store.isProcessed('evt_retry') === false, 'retryable failure NOT finalized in the durable log');
  const r2 = await svc.applyEvent(evt); // Stripe retries the SAME id — must NOT be blocked by a stale claim
  ok(r2.handled === true, 'the retry re-claims and PROCESSES (the claim did not permanently block a legitimate retry)');
  ok(logCount(dir, 'evt_retry') === 1, 'after the successful retry, the id is finalized exactly once');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? '✖' : '✓'} provisioning-dedup-race: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
