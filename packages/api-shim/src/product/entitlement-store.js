/**
 * entitlement-store.js — the server-side entitlement RECORD store + idempotent event log
 * (STRIPE_PROVISIONING_PLAN.md §2 dedup + §3 record store + §4 the record the signer signs from).
 *
 * SCOPE LINE: this module persists records and dedups events. It touches NO Stripe and holds NO
 * signing key — it stores the recompute RESULT (from subscription-state.js) so the issuer can sign a
 * token and the reconcile poll can diff. Two on-disk artifacts under a single dir:
 *   - records.json            : { [subject]: record }   the CURRENT entitlement per subject
 *   - processed-events.jsonl  : append-only {evt_id, type, at} — the exactly-once-in-effect dedup log
 *
 * Idempotency (plan §2): Stripe retries webhooks; the dedup key is the Stripe EVENT ID (evt_…, stable
 * across retries). A second sight of an event id is refused as a duplicate (the automation-runtime
 * dedupKey() contract). Out-of-order delivery is handled UPSTREAM by recomputing from subscription
 * STATE (subscription-state.js), not event deltas — so this store only needs at-most-once application.
 *
 * ATOMIC EVENT CLAIM (Codex HIGH): the dedup key is claimed write-if-absent at the START of processing
 * (claimEvent), not after the work, so two concurrent applyEvent(sameId) cannot both proceed. A claim
 * is provisional until finalizeEvent() succeeds; a retryable failure releases it so a legitimate Stripe
 * retry is never permanently blocked.
 *
 * Writes are atomic (write tmp + rename) so a crash mid-write never corrupts records.json. Reads
 * never throw (a missing/garbage file → empty); fail-soft like the rest of the rail.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_RECORDS_BYTES = 8 * 1024 * 1024; // generous cap; a corrupt/huge file → treated as empty

export function createEntitlementStore(opts = {}) {
  const dir = opts.dir
    || process.env.STRATOS_PROVISIONING_DIR
    || path.join(process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile'), 'provisioning');
  const now = opts.now || Date.now;
  const recordsPath = () => path.join(dir, 'records.json');
  const eventsPath = () => path.join(dir, 'processed-events.jsonl');
  const claimsDir = () => path.join(dir, 'event-claims');
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

  return {
    /** True if this Stripe event id was already processed (dedup — plan §2). */
    isProcessed(eventId) {
      if (typeof eventId !== 'string' || !eventId) return false;
      try {
        if (!fs.existsSync(eventsPath())) return false;
        const lines = fs.readFileSync(eventsPath(), 'utf8').split('\n');
        for (const line of lines) {
          if (!line) continue;
          try { if (JSON.parse(line).evt_id === eventId) return true; } catch { /* skip bad line */ }
        }
      } catch { /* unreadable → not processed (we'll try, and re-dedup is harmless) */ }
      return false;
    },

    /** Append a processed-event marker. Append-only; the dedup log is the audit trail of what ran. */
    markProcessed(eventId, type) {
      if (typeof eventId !== 'string' || !eventId) return false;
      ensureDir();
      fs.appendFileSync(eventsPath(), JSON.stringify({ evt_id: eventId, type: type || null, at: now() }) + '\n');
      return true;
    },

    /**
     * ATOMICALLY claim an event id for processing (Codex HIGH: non-atomic dedup race). Uses
     * O_CREAT|O_EXCL so the create either succeeds (we own the claim) or fails with EEXIST (someone
     * else already claimed it) — there is no check-then-act window. Already-finalized (in the durable
     * processed-events log) also counts as claimed. Returns true iff THIS call won the claim.
     */
    claimEvent(eventId) {
      if (typeof eventId !== 'string' || !eventId) return false;
      if (this.isProcessed(eventId)) return false; // already finalized in a prior run → not a fresh claim
      ensureClaimsDir();
      try {
        const fd = fs.openSync(claimPath(eventId), 'wx'); // wx = O_CREAT|O_EXCL|O_WRONLY — fails if exists
        fs.writeSync(fd, JSON.stringify({ evt_id: eventId, claimed_at: now() }));
        fs.closeSync(fd);
        return true;
      } catch (e) {
        if (e && e.code === 'EEXIST') return false; // a concurrent caller already holds the claim
        throw e; // a real I/O failure must surface (caller signals retry)
      }
    },

    /** Finalize a claimed event: append to the durable processed-events log AND drop the provisional
     *  claim file. After this, isProcessed(eventId) is true across restarts. */
    finalizeEvent(eventId, type) {
      if (typeof eventId !== 'string' || !eventId) return false;
      this.markProcessed(eventId, type);
      try { fs.unlinkSync(claimPath(eventId)); } catch { /* already gone */ }
      return true;
    },

    /** Release a provisional claim WITHOUT finalizing — for a retryable failure, so a legitimate Stripe
     *  retry can re-claim and re-process (the claim must never permanently block a retry). */
    releaseEvent(eventId) {
      if (typeof eventId !== 'string' || !eventId) return false;
      try { fs.unlinkSync(claimPath(eventId)); } catch { /* already gone */ }
      return true;
    },

    /** Upsert the current entitlement record for a subject. Stamps updated_at. */
    upsert(record) {
      if (!record || typeof record.subject !== 'string' || !record.subject) {
        throw new Error('entitlement record requires a string subject');
      }
      const map = readRecords();
      map[record.subject] = { ...record, updated_at: now() };
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
