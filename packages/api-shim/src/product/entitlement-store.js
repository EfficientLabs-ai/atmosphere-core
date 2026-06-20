/**
 * entitlement-store.js — the server-side entitlement RECORD store + idempotent event log
 * (STRIPE_PROVISIONING_PLAN.md §2 dedup + §3 record store + §4 the record the signer signs from).
 *
 * SCOPE LINE: this module persists records and dedups events. It touches NO Stripe and holds NO
 * signing key — it stores the recompute RESULT (from subscription-state.js) so the issuer can sign a
 * token and the reconcile poll can diff. On-disk artifacts under a single dir:
 *   - records.json              : { [subject]: record }   the CURRENT entitlement per subject (F2 logic)
 *   - .provisioning-dedup.db    : sqlite WAL dedup ledger — ONE row per Stripe event id, the single
 *                                 ATOMIC + EXCLUSIVE dedup gate (claimed → in-flight; done → processed)
 *
 * Idempotency (plan §2): Stripe retries webhooks; the dedup key is the Stripe EVENT ID (evt_…, stable
 * across retries). A second sight of an event id is refused as a duplicate (the automation-runtime
 * dedupKey() contract). Out-of-order delivery is handled UPSTREAM by recomputing from subscription
 * STATE (subscription-state.js), not event deltas — so this store only needs at-most-once application.
 *
 * ATOMIC + EXCLUSIVE EVENT CLAIM — SQLITE (Codex HIGH F3, 4th-round REDESIGN): three rounds of
 * file-based fixes (separate processed-log; single-file O_CREAT|O_EXCL; tmp+rename reclaim) could not
 * close the LAST residual race because a file primitive cannot atomically "remove-stale-then-
 * exclusively-claim" — the stale-reclaim was a non-atomic read-then-overwrite, so two concurrent
 * reclaimers of ONE stale event could BOTH win and double-process. The founder chose sqlite: the
 * claim is now a SINGLE synchronous better-sqlite3 transaction (better-sqlite3 txns are synchronous,
 * so there is no await window inside) over a row keyed by event id:
 *   - claimEvent(id): INSERT … ON CONFLICT DO NOTHING (first-claim) → 'claimed'; else read the row:
 *     status 'done' → 'done' (deduped); fresh 'claimed' (claimed_at within staleTtl) → 'inflight';
 *     STALE 'claimed' → a compare-and-swap UPDATE predicated on the EXACT old claimed_at + row lock
 *     (WHERE id=? AND status='claimed' AND claimed_at=<old>) — exactly ONE reclaimer's CAS can match
 *     (changes===1 → 'reclaimed'); every other concurrent reclaimer matches 0 rows → 'inflight'. This
 *     is the exclusivity a file primitive could not give: the stale-reclaim is now atomic.
 *   - finalizeEvent(id): UPDATE … status='done' — a PERMANENT processed record (never deleted). A
 *     terminal outcome (handled, ignored, OR a non-retryable error) finalizes, so a poison event
 *     never loops; a redelivery re-claims, sees 'done', and is deduped (no black-hole).
 *   - releaseEvent(id): DELETE … WHERE status='claimed' (RETRYABLE failure only — never a 'done') so a
 *     legitimate Stripe redelivery can re-claim. A crash that releases nothing is recovered by the
 *     staleTtl reclaim in claimEvent.
 * The bridge is a single PM2 fork (one process, async-interleaved), so the synchronous transaction is
 * already atomic for the live deployment; the CAS + WAL row lock additionally make it correct
 * cross-process (and cross-restart), so the gate is airtight regardless of process topology.
 *
 * Out-of-order FLOOR (Codex HIGH, F2 — UNCHANGED): refetch-current-state (in the service) is the
 * primary defense, but a per-subject monotonic high-water mark (the largest applied `event.created`)
 * is the floor — an event older than the last applied for that subject is rejected so a stale
 * `.updated` can never regress a `.deleted`. Stored in records.json under `_last_event_at` per subject;
 * advanced atomically on upsert. This (and the whole records layer) is deliberately left file-based —
 * only the dedup gate moved to sqlite.
 *
 * Record writes are atomic (write tmp + rename) so a crash mid-write never corrupts records.json.
 * Reads never throw (a missing/garbage file → empty); fail-soft like the rest of the rail.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const MAX_RECORDS_BYTES = 8 * 1024 * 1024; // generous cap; a corrupt/huge file → treated as empty

/** Stale-claim TTL (seconds): a 'claimed' row older than this is treated as ORPHANED (the process that
 *  claimed it died before finalize/release) and may be reclaimed — recovering the crash black-hole.
 *  Comfortably longer than any single webhook's processing time; Stripe retries for days. */
const STALE_TTL_SECONDS = 900;

/** Per-subject monotonic marker key inside a record. The largest applied event.created (seconds) for
 *  that subject; an incoming event older than this is rejected (out-of-order floor). */
const LAST_EVENT_AT = '_last_event_at';

export function createEntitlementStore(opts = {}) {
  const dir = opts.dir
    || process.env.STRATOS_PROVISIONING_DIR
    || path.join(process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile'), 'provisioning');
  const now = opts.now || Date.now;
  const nowSeconds = () => Math.floor(now() / 1000); // dedup rows carry unix SECONDS, not ms.
  const recordsPath = () => path.join(dir, 'records.json');
  // The dedup DB is CO-LOCATED with the records store dir (configurable via opts.dbPath) so it stays
  // per-instance/portable — the same dir config that makes records.json portable carries the gate.
  const dbPath = opts.dbPath || path.join(dir, '.provisioning-dedup.db');

  function ensureDir() { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists/uncreatable → writes will surface */ } }

  // ── Sqlite dedup ledger (opened ONCE, reused) ──────────────────────────────────────────────────
  let _db = null;
  /** Open the dedup DB once and reuse the handle. Sets the WAL/timeout pragmas and the schema. */
  function db() {
    if (_db) return _db;
    ensureDir(); // the DB lives inside `dir`; it must exist before better-sqlite3 opens the file.
    const d = new Database(dbPath);
    // WAL: concurrent readers + a single writer, durable across crash. synchronous=NORMAL: WAL-safe,
    // fast. busy_timeout: a competing writer waits (does not immediately SQLITE_BUSY) for the lock.
    d.pragma('journal_mode = WAL');
    d.pragma('synchronous = NORMAL');
    d.pragma('busy_timeout = 5000');
    d.exec(`CREATE TABLE IF NOT EXISTS processed_events (
      id         TEXT PRIMARY KEY,
      status     TEXT NOT NULL CHECK(status IN ('claimed','done')),
      owner      TEXT,
      claimed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
    _db = d;
    return _db;
  }

  // Prepared statements are lazily built on first use against the (cached) handle.
  let _stmts = null;
  function stmts() {
    if (_stmts) return _stmts;
    const d = db();
    _stmts = {
      insert: d.prepare(`INSERT INTO processed_events (id, status, owner, claimed_at, updated_at)
                         VALUES (?, 'claimed', ?, ?, ?) ON CONFLICT(id) DO NOTHING`),
      read: d.prepare(`SELECT id, status, owner, claimed_at, updated_at FROM processed_events WHERE id = ?`),
      // CAS reclaim: the `claimed_at = ?` predicate (the EXACT old value) + the row lock means EXACTLY
      // ONE concurrent reclaimer can match — the others see 0 changes and fall to 'inflight'.
      reclaim: d.prepare(`UPDATE processed_events SET owner = ?, claimed_at = ?, updated_at = ?
                          WHERE id = ? AND status = 'claimed' AND claimed_at = ?`),
      finalize: d.prepare(`UPDATE processed_events SET status = 'done', updated_at = ? WHERE id = ?`),
      release: d.prepare(`DELETE FROM processed_events WHERE id = ? AND status = 'claimed'`),
    };
    // The whole claim decision runs inside ONE synchronous transaction → atomic + isolated. No await
    // is possible inside (better-sqlite3 is synchronous), so there is no check-then-act window.
    _stmts.claimTxn = d.transaction((id, owner, ts, staleTtl) => {
      // 1. First-claim: insert-if-absent. changes===1 ⇒ this call created the row and owns the claim.
      if (_stmts.insert.run(id, owner, ts, ts).changes === 1) return 'claimed';
      // 2. Row exists — inspect it.
      const row = _stmts.read.get(id);
      if (!row) {
        // Extremely unlikely (the conflicting row vanished between INSERT and SELECT inside the txn).
        // Retry the insert once; if it now lands we own it, else treat as a live concurrent claim.
        return _stmts.insert.run(id, owner, ts, ts).changes === 1 ? 'claimed' : 'inflight';
      }
      if (row.status === 'done') return 'done'; // permanently processed → dedup.
      // status === 'claimed' from here.
      const claimedAt = Number(row.claimed_at);
      const fresh = Number.isFinite(claimedAt) && claimedAt >= (ts - staleTtl);
      if (fresh) return 'inflight'; // a live concurrent claimant holds it → skip as a duplicate.
      // 3. STALE 'claimed' (orphaned — prior claimant crashed). Reclaim via CAS on the EXACT old
      //    claimed_at + row lock: exactly ONE concurrent reclaimer can match.
      const won = _stmts.reclaim.run(owner, ts, ts, id, claimedAt).changes === 1;
      return won ? 'reclaimed' : 'inflight'; // 0 changes ⇒ another reclaimer won the CAS → skip.
    });
    return _stmts;
  }

  /** Read the records map. Never throws; corrupt/oversized/missing → {}. (F2 records layer — unchanged.) */
  function readRecords() {
    try {
      const st = fs.statSync(recordsPath());
      if (!st.isFile() || st.size > MAX_RECORDS_BYTES) return {};
      const obj = JSON.parse(fs.readFileSync(recordsPath(), 'utf8'));
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch { return {}; }
  }

  /** Atomic write: tmp + rename (rename is atomic on the same filesystem). (F2 records layer — unchanged.) */
  function writeRecords(map) {
    ensureDir();
    const tmp = recordsPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, recordsPath());
  }

  return {
    /** Read helper: true iff this event id is the permanent 'done' status. NOT part of the gate — the
     *  synchronous claim transaction IS the gate; this is for callers/tests/audit only. */
    isProcessed(eventId) {
      if (typeof eventId !== 'string' || !eventId) return false;
      try { return stmts().read.get(eventId)?.status === 'done'; }
      catch { return false; } // fail-soft read like the rest of the rail
    },

    /**
     * Claim an event id for processing — the SINGLE atomic + EXCLUSIVE dedup gate (Codex HIGH F3,
     * sqlite). The entire decision runs inside ONE synchronous better-sqlite3 transaction, so it is
     * atomic and isolated (no await window). Options are optional so the existing single-arg call
     * `claimEvent(id)` keeps working unchanged.
     * @param {string} eventId
     * @param {{owner?:string, now?:number, staleTtl?:number}} [opts]
     *   owner    — an opaque tag for who holds the claim (audit only); defaults to the process pid.
     *   now      — unix SECONDS override (test clock); defaults to the store clock.
     *   staleTtl — seconds after which a 'claimed' row is orphaned/reclaimable; defaults to 900.
     * Returns one of:
     *   'claimed'   — THIS call created the row and owns the claim → caller processes.
     *   'reclaimed' — an ORPHANED stale 'claimed' row (claimed_at older than staleTtl) was reclaimed via
     *                 the exclusive CAS → caller processes (recovers the crash black-hole).
     *   'done'      — already finalized → caller treats as deduped/skip (no reprocess).
     *   'inflight'  — a FRESH 'claimed' row held by a concurrent claimant, OR a stale row another
     *                 reclaimer's CAS already won → caller skips as a duplicate (Stripe will retry).
     */
    claimEvent(eventId, opts = {}) {
      if (typeof eventId !== 'string' || !eventId) return 'inflight';
      const owner = typeof opts.owner === 'string' && opts.owner ? opts.owner : `pid:${process.pid}`;
      const ts = Number.isFinite(opts.now) ? Math.floor(opts.now) : nowSeconds();
      const staleTtl = Number.isFinite(opts.staleTtl) ? opts.staleTtl : STALE_TTL_SECONDS;
      // A real DB I/O failure must SURFACE (the caller signals a retry) — do not silently dedup.
      return stmts().claimTxn(eventId, owner, ts, staleTtl);
    },

    /** Finalize a claimed event: set status='done' — a PERMANENT processed record (never deleted).
     *  isProcessed() is then true across restarts, and a redelivery re-claims, sees 'done', and is
     *  deduped (never a black-hole). The legacy 2nd arg (event type) is accepted and ignored so the
     *  existing call `finalizeEvent(id, type)` keeps working; an options object `{now}` is also accepted. */
    finalizeEvent(eventId, opts) {
      if (typeof eventId !== 'string' || !eventId) return false;
      const ts = (opts && typeof opts === 'object' && Number.isFinite(opts.now)) ? Math.floor(opts.now) : nowSeconds();
      stmts().finalize.run(ts, eventId);
      return true;
    },

    /** Release a claim WITHOUT finalizing — RETRYABLE failure only — by DELETING the row IFF it is still
     *  'claimed' (never a 'done', so a finalized record is never resurrected) so a legitimate Stripe
     *  redelivery can re-claim and re-process (a claim must never permanently block a legitimate retry). */
    releaseEvent(eventId) {
      if (typeof eventId !== 'string' || !eventId) return false;
      try { stmts().release.run(eventId); } catch { /* already gone / db unavailable */ }
      return true;
    },

    /** Close the dedup DB handle cleanly (idempotent). Tests/shutdown call this to release the file. */
    close() {
      if (_db) { try { _db.close(); } catch { /* already closed */ } _db = null; _stmts = null; }
    },

    /** The largest applied event.created (seconds) for a subject, or 0 if none (out-of-order floor). */
    lastEventAt(subject) {
      if (typeof subject !== 'string' || !subject) return 0;
      const rec = readRecords()[subject];
      const v = rec && Number(rec[LAST_EVENT_AT]);
      return Number.isFinite(v) && v > 0 ? v : 0;
    },

    /**
     * Upsert the current entitlement record for a subject. Stamps updated_at. Optionally advances the
     * per-subject monotonic event marker (eventAt = event.created seconds) so a later stale event is
     * rejected by lastEventAt(); never moves the marker backwards.
     */
    upsert(record, eventAt) {
      if (!record || typeof record.subject !== 'string' || !record.subject) {
        throw new Error('entitlement record requires a string subject');
      }
      const map = readRecords();
      const prevAt = Number(map[record.subject]?.[LAST_EVENT_AT]) || 0;
      const at = Number(eventAt);
      const nextAt = Number.isFinite(at) && at > prevAt ? at : prevAt; // monotonic; never regresses
      map[record.subject] = { ...record, updated_at: now(), [LAST_EVENT_AT]: nextAt || undefined };
      writeRecords(map);
      return map[record.subject];
    },

    /** Get the current record for a subject, or null. */
    get(subject) {
      if (typeof subject !== 'string' || !subject) return null;
      return readRecords()[subject] || null;
    },

    /** All current records (array). Used by the reconcile poll to diff against Stripe. */
    all() {
      const map = readRecords();
      return Object.keys(map).map((k) => map[k]);
    },
  };
}
