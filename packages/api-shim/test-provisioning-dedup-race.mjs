/**
 * test-provisioning-dedup-race.mjs — REGRESSION for Codex HIGH (F3): dedup race + crash black-hole.
 *
 * THE LAST RESIDUAL RACE (why this is the 4th round). Three file-based designs failed in turn:
 *   r1: separate processed-log + claim-file with a pre-isProcessed() check → check-then-act window.
 *   r2: single state file, O_CREAT|O_EXCL as the gate, finalize=append-then-UNLINK → crash BLACK-HOLE
 *       (claim then die → orphan 'claimed' file deduped every later retry, forever).
 *   r3: keep the single file but add a STALE_TTL reclaim (read ts → if stale, tmp+rename overwrite).
 *       This closed the black-hole but left the LAST race: the stale-reclaim is a NON-ATOMIC
 *       read-then-overwrite, so TWO concurrent reclaimers of ONE stale event both read "stale" and both
 *       rename their own tmp into place — BOTH win, DOUBLE-PROCESS. A file primitive cannot atomically
 *       "remove-stale-then-exclusively-claim" — that is exactly what Codex broke on the 3rd round.
 *
 * REDESIGN (sqlite, this round): the claim is ONE synchronous better-sqlite3 transaction over a row
 * keyed by event id. First-claim = INSERT … ON CONFLICT DO NOTHING ('claimed'). A STALE reclaim is a
 * compare-and-swap UPDATE predicated on the EXACT old claimed_at + the row lock
 * (WHERE id=? AND status='claimed' AND claimed_at=<old>): EXACTLY ONE concurrent reclaimer's CAS can
 * match (changes===1 → 'reclaimed'); every other reclaimer matches 0 rows → 'inflight'. finalizeEvent
 * sets status='done' (permanent, never deleted). releaseEvent DELETEs only a 'claimed' row (retryable).
 *
 * Proves:
 *   1. N concurrent applyEvent for the same id → EXACTLY ONE processes; processed-count is 1.
 *   2. N concurrent first-claims of one id → exactly ONE 'claimed', processed-count 1.
 *   3. A retryable failure RELEASES the claim → a later retry re-processes (claim never blocks a retry);
 *      a 'done' row is NEVER deleted.
 *   4. Redelivery AFTER finalize → deduped ('done'), not reprocessed.
 *   5. CRASH BLACK-HOLE: a STALE 'claimed' row (old claimed_at) → a later retry RECLAIMS and processes.
 *   6. A FRESH 'claimed' row (recent claimed_at) → a concurrent retry is 'inflight'/skipped (deduped).
 *   7. ★ THE CASE CODEX BROKE — 16 CONCURRENT RECLAIMERS of ONE STALE event → EXACTLY 1 'reclaimed',
 *      the other 15 'inflight'; processed-count 1. This is the exclusivity a file primitive could not
 *      give (r3's non-atomic read-then-overwrite double-won here).
 * Hermetic: real store/signer, an injected fetchSubscription that yields the event loop to force the
 * interleave; tmp dirs. Real better-sqlite3 (already the bridge's dep for .stratos-*.db).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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

// The dedup DB co-located with the store dir (mirrors entitlement-store's dbPath). Used to inspect /
// hand-craft on-disk dedup state for the crash-recovery cases — a fresh read-only handle each time so
// it observes the WAL-committed state written by the store's own handle.
const dbPath = (dir) => path.join(dir, '.provisioning-dedup.db');
function readRow(dir, id) {
  const d = new Database(dbPath(dir), { readonly: true, fileMustExist: true });
  try { return d.prepare('SELECT id,status,owner,claimed_at,updated_at FROM processed_events WHERE id=?').get(id) || null; }
  finally { d.close(); }
}
// processed-count = number of 'done' rows for the id (the permanent processed record): 0 or 1.
function processedCount(dir, id) {
  try { return readRow(dir, id)?.status === 'done' ? 1 : 0; } catch { return 0; }
}
// Hand-write a 'claimed' row with a chosen claimed_at (simulate a crash orphan) using a separate handle,
// then return — the store opens its own handle and sees the WAL-committed row.
function seedClaim(dir, id, claimedAt) {
  fs.mkdirSync(dir, { recursive: true });
  const d = new Database(dbPath(dir));
  try {
    d.pragma('journal_mode = WAL');
    d.exec(`CREATE TABLE IF NOT EXISTS processed_events (id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('claimed','done')), owner TEXT, claimed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    d.prepare(`INSERT INTO processed_events (id,status,owner,claimed_at,updated_at) VALUES (?, 'claimed', 'seed', ?, ?) ON CONFLICT(id) DO UPDATE SET status='claimed', claimed_at=excluded.claimed_at, updated_at=excluded.updated_at`).run(id, claimedAt, claimedAt);
  } finally { d.close(); }
}

console.log('provisioning-dedup-race — sqlite atomic+exclusive claim (the LAST race + crash black-hole closed)\n');

// 1. Two concurrent applyEvent for the SAME id. The injected fetch yields the event loop; without an
//    atomic gate both would proceed. With the sqlite gate exactly one wins, one is deduped.
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
  ok(processedCount(dir, 'evt_race') === 1, 'processed-count is EXACTLY 1 (single done row, no duplicate)');
  ok(fetches === 1, 'the loser short-circuited at the claim → the subscription fetch ran only once');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. The store primitive itself is atomic: many concurrent claimEvent for the same id → exactly one
//    'claimed'; the rest are 'inflight' (a fresh concurrent claim) — never two winners.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
  const store = createEntitlementStore({ dir });
  const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => store.claimEvent('evt_atomic'))));
  ok(results.filter((r) => r === 'claimed').length === 1, '20 concurrent claimEvent(sameId) → exactly ONE "claimed" (sqlite INSERT … ON CONFLICT DO NOTHING)');
  ok(results.every((r) => r === 'claimed' || r === 'inflight'), 'every loser is "inflight" (a fresh concurrent claim) — never a second winner');
  ok(processedCount(dir, 'evt_atomic') === 0, 'no "done" row yet (claimed, not finalized)');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. A retryable failure RELEASES the claim so a legitimate Stripe retry re-processes (no permanent
//    block); and releaseEvent NEVER deletes a 'done' row.
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
  ok(store.isProcessed('evt_retry') === false, 'retryable failure NOT finalized (claim released)');
  ok(readRow(dir, 'evt_retry') === null, 'releaseEvent DELETEd the claimed row (Stripe can re-claim)');
  const r2 = await svc.applyEvent(evt); // Stripe retries the SAME id — must NOT be blocked by a stale claim
  ok(r2.handled === true, 'the retry re-claims and PROCESSES (the claim did not permanently block a legitimate retry)');
  ok(processedCount(dir, 'evt_retry') === 1, 'after the successful retry, the id is finalized exactly once');
  // releaseEvent on a 'done' row is a no-op (DELETE … WHERE status=\'claimed\').
  store.releaseEvent('evt_retry');
  ok(processedCount(dir, 'evt_retry') === 1, "releaseEvent NEVER deletes a 'done' row (record stays permanent)");
  store.close();
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
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5. CRASH BLACK-HOLE CLOSED: a process that claimed then DIED leaves an orphan 'claimed' row. With an
//    OLD claimed_at (older than STALE_TTL) a later retry must RECLAIM and process — the r2 design
//    black-holed it forever (deduped + never processed). Simulate the crash by seeding a stale row.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-'));
  const staleTs = Math.floor(Date.now() / 1000) - 5000; // > STALE_TTL (900s) old → orphaned
  seedClaim(dir, 'evt_crash', staleTs);
  const store = createEntitlementStore({ dir });
  ok(store.claimEvent('evt_crash') === 'reclaimed', '5: a STALE "claimed" row (crash orphan) → claimEvent "reclaimed" (recovered, not black-holed)');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // and end-to-end through the service: the reclaimed event PROCESSES (a record lands), proving the
  // legitimate Stripe retry is no longer permanently swallowed.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'crash2-'));
  seedClaim(dir2, 'evt_crash2', Math.floor(Date.now() / 1000) - 5000);
  const store2 = createEntitlementStore({ dir: dir2 });
  const svc = createProvisioningService({ store: store2, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey, fetchSubscription: async () => apexSub() });
  const r = await svc.applyEvent({ id: 'evt_crash2', type: 'invoice.paid', created: 1000, data: { object: { subscription: 'sub_1' } } });
  ok(r.handled === true && store2.get('cus_A')?.grant === true, '5: end-to-end — the reclaimed orphan PROCESSES and grants (black-hole closed)');
  ok(processedCount(dir2, 'evt_crash2') === 1, '5: the reclaimed event is finalized exactly once');
  store2.close();
  fs.rmSync(dir2, { recursive: true, force: true });
}

// 6. A FRESH 'claimed' row (recent claimed_at) → a concurrent retry is 'inflight' and SKIPPED (a live
//    worker still holds the claim; we must not double-process). The opposite of case 5's stale recovery.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  seedClaim(dir, 'evt_fresh', Math.floor(Date.now() / 1000)); // fresh
  const store = createEntitlementStore({ dir });
  ok(store.claimEvent('evt_fresh') === 'inflight', '6: a FRESH "claimed" row → claimEvent "inflight" (a live worker holds it → skip)');
  const svc = createProvisioningService({ store, tierForPrice, signEntitlement, provPrivBundle: prov.privateKey, fetchSubscription: async () => apexSub() });
  const r = await svc.applyEvent({ id: 'evt_fresh', type: 'invoice.paid', created: 1000, data: { object: { subscription: 'sub_1' } } });
  ok(r.deduped === true, '6: applyEvent on a fresh in-flight id → deduped (not double-processed)');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 7. ★ THE CASE CODEX BROKE on round 3. 16 CONCURRENT RECLAIMERS of ONE STALE event. The r3 file
//    design (non-atomic read-stale-then-overwrite) let MULTIPLE reclaimers all read "stale" and all
//    rename their own tmp into place → MULTIPLE winners → double-process. The sqlite CAS
//    (UPDATE … WHERE claimed_at=<exact old> + row lock) admits EXACTLY ONE — the other 15 match 0 rows.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim16-'));
  const staleTs = Math.floor(Date.now() / 1000) - 5000; // orphaned
  seedClaim(dir, 'evt_thundering', staleTs);
  const store = createEntitlementStore({ dir });
  // 16 concurrent reclaimers of the SAME stale id. Each is a distinct owner so a winning CAS is
  // attributable; Promise.all fans them onto microtasks to maximize interleave pressure.
  const N = 16;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => Promise.resolve().then(() => store.claimEvent('evt_thundering', { owner: `reclaimer-${i}` })))
  );
  const reclaimed = results.filter((r) => r === 'reclaimed').length;
  const inflight = results.filter((r) => r === 'inflight').length;
  console.log(`    [16-reclaimer proof] results = ${JSON.stringify(results)}`);
  console.log(`    [16-reclaimer proof] reclaimed=${reclaimed} inflight=${inflight} (claimed=${results.filter(r=>r==='claimed').length} done=${results.filter(r=>r==='done').length})`);
  ok(reclaimed === 1, '7: ★ 16 concurrent reclaimers of ONE stale event → EXACTLY 1 "reclaimed" (the CAS admits exactly one)');
  ok(inflight === N - 1, `7: ★ the other ${N - 1} reclaimers are "inflight" (their CAS matched 0 rows — no double-claim)`);
  ok(results.every((r) => r === 'reclaimed' || r === 'inflight'), '7: ★ every result is "reclaimed" or "inflight" — never two winners, never a phantom "claimed"/"done"');
  // The single winner finalizes; processed-count is EXACTLY 1 — no double-process.
  store.finalizeEvent('evt_thundering', 'invoice.paid');
  ok(processedCount(dir, 'evt_thundering') === 1, '7: ★ after the lone winner finalizes → processed-count is EXACTLY 1 (no double-process)');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? '✖' : '✓'} provisioning-dedup-race: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
