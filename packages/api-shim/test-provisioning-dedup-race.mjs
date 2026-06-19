/**
 * test-provisioning-dedup-race.mjs — REGRESSION for Codex HIGH (F3): dedup race + crash black-hole.
 *
 * The OLD two-structure design (separate processed-log + claim-file, with a pre-isProcessed() check
 * before openSync('wx'), and finalize = append-then-UNLINK) had two faults:
 *   - check-then-act window: isProcessed() read the processed-log, NOT the claim file, so it was not
 *     the gate; the gate was a separate openSync.
 *   - crash BLACK-HOLE: claim then die before finalize/release left an orphan 'claimed' file; every
 *     later Stripe retry saw it and returned deduped with processed:false and no record — forever.
 *
 * REDESIGN: ONE state file per event id; the atomic openSync('wx') IS the sole gate. claimEvent →
 * 'claimed'|'reclaimed' (process) | 'done' (deduped) | 'inflight' (skip). finalizeEvent overwrites the
 * SAME file to 'done' (never unlinked → permanent record). releaseEvent unlinks (retryable only). A
 * STALE_TTL on a 'claimed' file recovers an orphan after a crash (no black-hole).
 *
 * Proves:
 *   1. Two concurrent applyEvent for the same id → EXACTLY ONE processes; processed-count is 1.
 *   2. The store's claim primitive is atomic: many concurrent claimEvent → exactly one 'claimed'.
 *   3. A retryable failure RELEASES the claim → a later retry re-processes (claim never blocks a retry).
 *   4. Redelivery AFTER finalize → deduped ('done'), not reprocessed.
 *   5. CRASH BLACK-HOLE: a STALE 'claimed' state file (old ts) → a later retry RECLAIMS and processes.
 *   6. A FRESH 'claimed' state file (recent ts) → a concurrent retry is 'inflight'/skipped (deduped).
 * Hermetic: real store/signer, an injected fetchSubscription that yields the event loop to force the
 * interleave; tmp dirs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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

// Path to the single state file for an id (mirrors entitlement-store's claimPath), used to inspect /
// hand-craft on-disk state for the crash-recovery cases.
const claimFile = (dir, id) => path.join(dir, 'event-claims', crypto.createHash('sha256').update(id).digest('hex') + '.claim');
// processed-count = number of 'done' state files matching the id (the permanent processed record).
function processedCount(dir, id) {
  const p = claimFile(dir, id);
  if (!fs.existsSync(p)) return 0;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).status === 'done' ? 1 : 0; } catch { return 0; }
}

console.log('provisioning-dedup-race — single-file atomic claim (race + crash black-hole closed)\n');

// 1. Two concurrent applyEvent for the SAME id. The injected fetch yields the event loop; without an
//    atomic gate both would proceed. With the single-file gate exactly one wins, one is deduped.
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
  ok(processedCount(dir, 'evt_race') === 1, 'processed-count is EXACTLY 1 (single done state file, no duplicate)');
  ok(fetches === 1, 'the loser short-circuited at the claim → the subscription fetch ran only once');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. The store primitive itself is atomic: many concurrent claimEvent for the same id → exactly one
//    'claimed'; the rest are 'inflight' (a fresh concurrent claim) — never two winners.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
  const store = createEntitlementStore({ dir });
  const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => store.claimEvent('evt_atomic'))));
  ok(results.filter((r) => r === 'claimed').length === 1, '20 concurrent claimEvent(sameId) → exactly ONE "claimed" (O_CREAT|O_EXCL atomic)');
  ok(results.every((r) => r === 'claimed' || r === 'inflight'), 'every loser is "inflight" (a fresh concurrent claim) — never a second winner');
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
  ok(store.isProcessed('evt_retry') === false, 'retryable failure NOT finalized (state file released)');
  ok(!fs.existsSync(claimFile(dir, 'evt_retry')), 'releaseEvent unlinked the state file (Stripe can re-claim)');
  const r2 = await svc.applyEvent(evt); // Stripe retries the SAME id — must NOT be blocked by a stale claim
  ok(r2.handled === true, 'the retry re-claims and PROCESSES (the claim did not permanently block a legitimate retry)');
  ok(processedCount(dir, 'evt_retry') === 1, 'after the successful retry, the id is finalized exactly once');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4. Redelivery AFTER finalize → deduped ('done'), never reprocessed.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redeliver-'));
  const store = createEntitlementStore({ dir });
  let fetches = 0;
  const svc = createProvisioningService({
    store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey,
    fetchSubscription: async () => { fetches++; return apexSub(); },
  });
  const evt = { id: 'evt_redeliver', type: 'invoice.paid', created: 1000, data: { object: { subscription: 'sub_1' } } };
  const r1 = await svc.applyEvent(evt);
  ok(r1.handled === true, '4: first delivery → handled');
  const r2 = await svc.applyEvent(evt); // Stripe redelivers the already-finalized id
  ok(r2.deduped === true, '4: redelivery after finalize → deduped (status "done")');
  ok(fetches === 1, '4: the redelivery did NOT refetch/reprocess (short-circuited at the "done" gate)');
  ok(store.claimEvent('evt_redeliver') === 'done', '4: claimEvent on a finalized id returns "done"');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5. CRASH BLACK-HOLE CLOSED: a process that claimed then DIED leaves an orphan 'claimed' file. With an
//    OLD ts (older than STALE_TTL) a later retry must RECLAIM and process — the old design black-holed
//    it forever (deduped + never processed). Simulate the crash by hand-writing a stale 'claimed' file.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-'));
  const store = createEntitlementStore({ dir });
  fs.mkdirSync(path.join(dir, 'event-claims'), { recursive: true });
  const staleTs = Math.floor(Date.now() / 1000) - 5000; // > STALE_TTL (900s) old → orphaned
  fs.writeFileSync(claimFile(dir, 'evt_crash'), JSON.stringify({ status: 'claimed', ts: staleTs }));
  ok(store.claimEvent('evt_crash') === 'reclaimed', '5: a STALE "claimed" file (crash orphan) → claimEvent "reclaimed" (recovered, not black-holed)');
  // and end-to-end through the service: the reclaimed event PROCESSES (a record lands), proving the
  // legitimate Stripe retry is no longer permanently swallowed.
  fs.rmSync(dir, { recursive: true, force: true });

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'crash2-'));
  const store2 = createEntitlementStore({ dir: dir2 });
  const svc = createProvisioningService({ store: store2, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey, fetchSubscription: async () => apexSub() });
  fs.mkdirSync(path.join(dir2, 'event-claims'), { recursive: true });
  fs.writeFileSync(claimFile(dir2, 'evt_crash2'), JSON.stringify({ status: 'claimed', ts: Math.floor(Date.now() / 1000) - 5000 }));
  const r = await svc.applyEvent({ id: 'evt_crash2', type: 'invoice.paid', created: 1000, data: { object: { subscription: 'sub_1' } } });
  ok(r.handled === true && store2.get('cus_A')?.grant === true, '5: end-to-end — the reclaimed orphan PROCESSES and grants (black-hole closed)');
  ok(processedCount(dir2, 'evt_crash2') === 1, '5: the reclaimed event is finalized exactly once');
  fs.rmSync(dir2, { recursive: true, force: true });
}

// 6. A FRESH 'claimed' file (recent ts) → a concurrent retry is 'inflight' and SKIPPED (a live worker
//    still holds the claim; we must not double-process). The opposite of case 5's stale recovery.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  const store = createEntitlementStore({ dir });
  fs.mkdirSync(path.join(dir, 'event-claims'), { recursive: true });
  fs.writeFileSync(claimFile(dir, 'evt_fresh'), JSON.stringify({ status: 'claimed', ts: Math.floor(Date.now() / 1000) })); // fresh
  ok(store.claimEvent('evt_fresh') === 'inflight', '6: a FRESH "claimed" file → claimEvent "inflight" (a live worker holds it → skip)');
  const svc = createProvisioningService({ store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey, fetchSubscription: async () => apexSub() });
  const r = await svc.applyEvent({ id: 'evt_fresh', type: 'invoice.paid', created: 1000, data: { object: { subscription: 'sub_1' } } });
  ok(r.deduped === true, '6: applyEvent on a fresh in-flight id → deduped (not double-processed)');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? '✖' : '✓'} provisioning-dedup-race: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
