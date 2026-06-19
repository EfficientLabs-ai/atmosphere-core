/**
 * entitlement-store.js — the server-side entitlement RECORD store + idempotent event log
 * (STRIPE_PROVISIONING_PLAN.md §2 dedup + §3 record store + §4 the record the signer signs from).
 *
 * SCOPE LINE: this module persists records and dedups events. It touches NO Stripe and holds NO
 * signing key — it stores the recompute RESULT (from subscription-state.js) so the issuer can sign a
 * token and the reconcile poll can diff. On-disk artifacts under a single dir:
 *   - records.json            : { [subject]: record }   the CURRENT entitlement per subject
 *   - event-claims/<sha>.claim: ONE state file per Stripe event id, {status:'claimed'|'done', ts} —
 *                               the single atomic dedup gate (claimed → in-flight; done → processed)
 *
 * Idempotency (plan §2): Stripe retries webhooks; the dedup key is the Stripe EVENT ID (evt_…, stable
 * across retries). A second sight of an event id is refused as a duplicate (the automation-runtime
 * dedupKey() contract). Out-of-order delivery is handled UPSTREAM by recomputing from subscription
 * STATE (subscription-state.js), not event deltas — so this store only needs at-most-once application.
 *
 * ATOMIC EVENT CLAIM — SINGLE STATE FILE (Codex HIGH, REDESIGN): there is ONE state file per event id
 * under event-claims/, and an atomic create-exclusive (O_CREAT|O_EXCL) on that file IS the sole dedup
 * gate — there is NO separate processed-log and NO check-then-act window (no pre-isProcessed()):
 *   - claimEvent(id): openSync('wx'). Success → write {status:'claimed', ts} and return 'claimed'.
 *     EEXIST → read the file: 'done' → return 'done' (already processed); 'claimed' & ts older than
 *     STALE_TTL → reclaim (overwrite, return 'reclaimed'); 'claimed' & fresh → return 'inflight'.
 *   - finalizeEvent(id): atomically OVERWRITE the SAME file to {status:'done', ts} (tmp + rename). It
 *     is NEVER unlinked — the done file is the permanent processed record. A successful terminal
 *     outcome (handled, ignored, OR a non-retryable error) finalizes, so a poison event never loops.
 *   - releaseEvent(id): unlink the file (RETRYABLE failure only) so Stripe redelivery can re-claim.
 * This kills the two old failure modes: (a) the check-then-act race (separate processed-log + claim
 * file + pre-isProcessed) and (b) the crash BLACK-HOLE (the old finalize did append-then-unlink, so a
 * crash after claim left an orphan 'claimed' file that every retry saw as deduped with processed:false
 * — a permanent black-hole of legitimate Stripe retries; STALE_TTL reclaim now recovers it).
 *
 * Out-of-order FLOOR (Codex HIGH): refetch-current-state (in the service) is the primary defense, but a
 * per-subject monotonic high-water mark (the largest applied `event.created`) is the floor — an event
 * older than the last applied for that subject is rejected so a stale `.updated` can never regress a
 * `.deleted`. Stored in records.json under `_last_event_at` per subject; advanced atomically on upsert.
 *
 * Writes are atomic (write tmp + rename) so a crash mid-write never corrupts records.json. Reads
 * never throw (a missing/garbage file → empty); fail-soft like the rest of the rail.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_RECORDS_BYTES = 8 * 1024 * 1024; // generous cap; a corrupt/huge file → treated as empty

/** Stale-claim TTL (seconds): a 'claimed' state file older than this is treated as ORPHANED (the
 *  process that claimed it died before finalize/release) and may be reclaimed — recovering the crash
 *  black-hole. Comfortably longer than any single webhook's processing time; Stripe retries for days. */
const STALE_TTL_SECONDS = 900;

const MAX_CLAIM_BYTES = 64 * 1024; // a state file is tiny; anything larger is corrupt → treat as stale.

/** Per-subject monotonic marker key inside a record. The largest applied event.created (seconds) for
 *  that subject; an incoming event older than this is rejected (out-of-order floor). */
const LAST_EVENT_AT = '_last_event_at';

export function createEntitlementStore(opts = {}) {
  const dir = opts.dir
    || process.env.STRATOS_PROVISIONING_DIR
    || path.join(process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile'), 'provisioning');
  const now = opts.now || Date.now;
  const nowSeconds = () => Math.floor(now() / 1000); // state files carry unix SECONDS (ts), not ms.
  const recordsPath = () => path.join(dir, 'records.json');
  const claimsDir = () => path.join(dir, 'event-claims');
  // ONE state file per event id; atomic create-exclusive on it IS the dedup gate (no processed-log).
  const claimPath = (eventId) => path.join(claimsDir(), crypto.createHash('sha256').update(eventId).digest('hex') + '.claim');

  function ensureDir() { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists/uncreatable → writes will surface */ } }
  function ensureClaimsDir() { try { fs.mkdirSync(claimsDir(), { recursive: true }); } catch { /* surfaces on the claim write */ } }

  /** Read the records map. Never throws; corrupt/oversized/missing → {}. */
  function readRecords() {
    try {
      const st = fs.statSync(recordsPath());
      if (!st.isFile() || st.size > MAX_RECORDS_BYTES) return {};
      const obj = JSON.parse(fs.readFileSync(recordsPath(), 'utf8'));
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch { return {}; }
  }

  /** Atomic write: tmp + rename (rename is atomic on the same filesystem). */
  function writeRecords(map) {
    ensureDir();
    const tmp = recordsPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, recordsPath());
  }

  /** Read+parse the single state file for an event id, or null (missing/corrupt/oversized → null). */
  function readClaim(eventId) {
    try {
      const p = claimPath(eventId);
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_CLAIM_BYTES) return null;
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch { return null; }
  }

  /** Atomically (over)write the state file via tmp + rename — a crash mid-write never leaves a torn file. */
  function writeClaimAtomic(eventId, state) {
    ensureClaimsDir();
    const p = claimPath(eventId);
    // Unique tmp name so two atomic writers never collide on the temp file.
    const tmp = `${p}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, p);
  }

  return {
    /** Read helper: true iff this event id is the permanent 'done' state. NOT part of the claim gate —
     *  the atomic openSync('wx') in claimEvent IS the gate; this is for callers/tests/audit only. */
    isProcessed(eventId) {
      if (typeof eventId !== 'string' || !eventId) return false;
      return readClaim(eventId)?.status === 'done';
    },

    /**
     * Claim an event id for processing — the SINGLE atomic dedup gate (Codex HIGH, REDESIGN). One
     * state file per id; openSync('wx') (O_CREAT|O_EXCL) IS the check (no pre-isProcessed window).
     * Returns one of:
     *   'claimed'   — THIS call created the file and owns the claim → caller processes.
     *   'reclaimed' — an ORPHANED stale 'claimed' file (ts older than STALE_TTL, i.e. the prior claimant
     *                 died before finalize/release) was overwritten → caller processes (recovers the
     *                 crash black-hole). Also covers a corrupt/unparseable existing file.
     *   'done'      — already finalized → caller treats as deduped/skip (no reprocess).
     *   'inflight'  — a FRESH 'claimed' file (recent ts) held by a concurrent claimant → caller skips
     *                 as a duplicate (Stripe will retry; the in-flight worker will finalize).
     */
    claimEvent(eventId) {
      if (typeof eventId !== 'string' || !eventId) return 'inflight';
      ensureClaimsDir();
      const p = claimPath(eventId);
      try {
        const fd = fs.openSync(p, 'wx'); // wx = O_CREAT|O_EXCL|O_WRONLY — fails with EEXIST if it exists
        try { fs.writeSync(fd, JSON.stringify({ status: 'claimed', ts: nowSeconds() })); }
        finally { fs.closeSync(fd); }
        return 'claimed';
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e; // a real I/O failure must surface (caller signals retry)
      }
      // EEXIST: the file already exists — inspect its state to decide.
      const cur = readClaim(eventId);
      if (cur?.status === 'done') return 'done';
      if (cur?.status === 'claimed') {
        const ts = Number(cur.ts);
        const fresh = Number.isFinite(ts) && (nowSeconds() - ts) < STALE_TTL_SECONDS;
        if (fresh) return 'inflight'; // a live concurrent claimant holds it → skip as duplicate
        // stale → orphaned (claimant died). Fall through to reclaim.
      }
      // Orphaned stale claim OR a corrupt/unreadable file → reclaim it (atomic overwrite) and process.
      writeClaimAtomic(eventId, { status: 'claimed', ts: nowSeconds() });
      return 'reclaimed';
    },

    /** Finalize a claimed event: durably overwrite the SAME state file to 'done' (atomic tmp+rename).
     *  NEVER unlinked — the done file is the permanent processed record. isProcessed() is then true
     *  across restarts, and a redelivery re-claims, sees 'done', and is deduped (never a black-hole). */
    finalizeEvent(eventId, type) {
      if (typeof eventId !== 'string' || !eventId) return false;
      writeClaimAtomic(eventId, { status: 'done', ts: nowSeconds(), type: type || null });
      return true;
    },

    /** Release a claim WITHOUT finalizing — RETRYABLE failure only — by unlinking the state file so a
     *  legitimate Stripe redelivery can re-claim and re-process (a claim must never permanently block). */
    releaseEvent(eventId) {
      if (typeof eventId !== 'string' || !eventId) return false;
      try { fs.unlinkSync(claimPath(eventId)); } catch { /* already gone */ }
      return true;
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
