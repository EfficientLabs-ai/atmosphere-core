/**
 * provisioning-service.js — the ORCHESTRATOR of the paid→provisioned→delivered loop
 * (STRIPE_PROVISIONING_PLAN.md §2 webhook semantics, §3 state machine, §4 issuance, §5 reconcile).
 *
 * SCOPE LINE: pure orchestration over INJECTED capabilities. It holds no Express, no Stripe SDK, and
 * speaks to Stripe and the signing key ONLY through injected functions, so it is fully hermetic and
 * the thin routers stay dumb. It never deletes data and never fail-closes a paid user out of their
 * own local data — cancellation only stops issuing tokens; the node falls to the Free Forever floor.
 *
 * Truth path, not delta path (plan §5): every apply RECOMPUTES the entitlement from the subscription
 * OBJECT STATE (subscription-state.js), never from the event payload deltas — so a late/out-of-order
 * webhook can never regress a record, and the hourly reconcile and the live webhook produce the same
 * result from the same subscription.
 */
import { entitlementFromSubscription } from './subscription-state.js';

/** Stripe event types this loop acts on (plan §2). Anything else is acknowledged + ignored (200). */
const SUBSCRIPTION_TYPES = new Set(['customer.subscription.updated', 'customer.subscription.deleted']);
const SESSION_TYPES = new Set(['checkout.session.completed']);
const INVOICE_TYPES = new Set(['invoice.paid', 'invoice.payment_failed']);

/** Build a canceled (Free-floor) record for a subject — no namespaces, no token will be issued. */
function canceledRecord(subject, price_id, reason) {
  return { subject, grant: false, tier: 'free_forever', state: 'canceled', namespaces: [], price_id: price_id || null, reason };
}

/**
 * Create the provisioning service.
 * @param {object} deps
 *   store                  : createEntitlementStore() instance (records + dedup)
 *   fetchSubscription(id)  : async/sync → the authoritative Stripe subscription object (truth source)
 *   tierForPrice(priceId)  : price_id → canonical tier key (founder/Stripe-gated map; inject)
 *   signEntitlement(f,key) : the token minter (entitlement-signer.js) — only used by issueToken
 *   provPrivBundle         : the provisioning PRIVATE key bundle (only used by issueToken)
 *   listActiveSubscriptions(): async/sync → array of active subscription objects (reconcile truth)
 *   now()                  : clock
 */
export function createProvisioningService(deps = {}) {
  const { store, fetchSubscription, tierForPrice, signEntitlement, provPrivBundle, listActiveSubscriptions } = deps;
  const now = deps.now || Date.now;
  if (!store) throw new Error('provisioning-service requires a store');

  /**
   * Resolve the authoritative subscription object for an event (truth path, plan §5).
   *
   * OUT-OF-ORDER FIX (Codex HIGH): Stripe delivers webhooks out of order, so the subscription object
   * EMBEDDED in a `.updated`/`.deleted` event can be stale relative to Stripe's current truth. We
   * therefore REFETCH the current subscription via fetchSubscription whenever its id is known and the
   * fetcher is available — Stripe is the source of truth. We fall back to the embedded object only when
   * no fetcher is configured (test/dev) or the id is absent; the per-subject monotonic timestamp floor
   * in applyEvent() is the additional guard for that fallback. Returns the subscription object, or
   * throws (→ caller signals retry).
   */
  async function resolveSubscription(event) {
    const obj = event?.data?.object;
    if (SUBSCRIPTION_TYPES.has(event.type)) {
      // The event object IS the subscription, but it may be stale (out-of-order delivery). Prefer the
      // current authoritative state from Stripe; fall back to the embedded object only with no fetcher.
      const subId = obj?.id;
      if (typeof fetchSubscription === 'function' && typeof subId === 'string' && subId) {
        const current = await fetchSubscription(subId);
        // A `.deleted` whose subscription Stripe no longer returns (null) → treat the embedded canceled
        // object as truth (it IS gone); otherwise the current object wins over the stale embedded one.
        return current || obj;
      }
      return obj;
    }
    // checkout.session.completed / invoice.* carry a `subscription` id → fetch authoritative state.
    const subId = obj?.subscription;
    if (typeof subId !== 'string' || !subId) return null; // e.g. a one-time checkout with no subscription
    if (typeof fetchSubscription !== 'function') throw new Error('fetchSubscription not configured');
    return await fetchSubscription(subId);
  }

  /**
   * Apply one Stripe event idempotently. NEVER throws on a handled outcome; throws only are caught by
   * the router to signal a retryable failure. Returns:
   *   { deduped:true }                         already processed/claimed → ack, do nothing
   *   { handled:false, ignored:true, reason }  irrelevant event type → ack, do nothing
   *   { handled:true, subject, record }        record upserted (grant or canceled)
   *   { retry:true, reason }                   transient — DON'T ack (let Stripe retry); not finalized
   *
   * ATOMIC CLAIM — SINGLE STATE FILE (Codex HIGH, REDESIGN): the event id is claimed write-if-absent at
   * the very START (claimEvent), before any await, via one atomic state file per id. claimEvent returns:
   * 'done' (already processed) or 'inflight' (a fresh concurrent claim) → dedup; 'claimed' or 'reclaimed'
   * (a fresh claim, or an orphaned stale claim recovered after a crash) → process. A TERMINAL outcome —
   * handled, ignored, OR a non-retryable error — FINALIZES the state file to 'done' (so a poison/terminal
   * event never loops forever); only a RETRYABLE failure RELEASES it so a legitimate Stripe retry can
   * re-claim (and a crash that releases nothing is recovered by the STALE_TTL reclaim in claimEvent).
   *
   * OUT-OF-ORDER FLOOR (Codex HIGH, HARDENED F2): resolveSubscription refetches current state; on top of
   * that, a per-subject monotonic event.created marker guards the no-fetch fallback. The floor rejects an
   * event STRICTLY older than the last applied; AND at an EQUAL timestamp it never allows a transition
   * that INCREASES entitlement (grant:false→grant:true) — a terminal/cancellation outcome at second T must
   * win over a same-second non-terminal event. Equivalently: grant:true only flips when created > lastEventAt.
   *
   * UNMAPPED ACTIVE PRICE (Codex HIGH): an ACTIVE subscription whose price maps to no known tier is an
   * operator misconfig — it RETRIES + alerts loudly and is NOT finalized/downgraded to free (only a
   * genuine non-granting status becomes a free record).
   */
  async function applyEvent(event) {
    if (!event || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') {
      return { handled: false, ignored: true, reason: 'malformed event' };
    }
    // Claim the id ATOMICALLY before any await (single state file; openSync('wx') IS the gate).
    //   'done'      → already processed   → dedup.
    //   'inflight'  → a fresh concurrent claimant holds it → dedup (Stripe will retry; it will finalize).
    //   'claimed'   → THIS call owns a fresh claim → process.
    //   'reclaimed' → an orphaned stale claim (prior claimant crashed) recovered → process (no black-hole).
    let claim;
    try { claim = store.claimEvent(event.id); }
    catch (e) { return { retry: true, reason: `event claim failed: ${e.message}` }; }
    if (claim === 'done' || claim === 'inflight') return { deduped: true };

    // From here on (claim is 'claimed' or 'reclaimed') a RETRYABLE exit MUST release the state file; a
    // TERMINAL exit (handled, ignored, OR a non-retryable error) FINALIZES it to 'done' so it can't loop.
    try {
      const known = SUBSCRIPTION_TYPES.has(event.type) || SESSION_TYPES.has(event.type) || INVOICE_TYPES.has(event.type);
      if (!known) { store.finalizeEvent(event.id, event.type); return { handled: false, ignored: true, reason: `ignored type ${event.type}` }; }

      let sub;
      try { sub = await resolveSubscription(event); }
      catch (e) { store.releaseEvent(event.id); return { retry: true, reason: `subscription fetch failed: ${e.message}` }; }

      if (!sub) { store.finalizeEvent(event.id, event.type); return { handled: false, ignored: true, reason: 'event carries no subscription' }; }

      const ent = entitlementFromSubscription(sub, { tierForPrice });
      const subject = ent.subject;
      if (!subject) { store.finalizeEvent(event.id, event.type); return { handled: false, ignored: true, reason: 'subscription has no resolvable subject' }; }

      // UNMAPPED ACTIVE PRICE → retry + alert (NOT a free record, NOT finalized). The subscription would
      // otherwise grant (its status is active/past_due) but the founder/Stripe price→tier map is missing
      // an entry — silently writing free would let Stripe stop retrying and the operator never notice.
      if (!ent.grant && ent.unmapped_price && (ent.mapped_state === 'active' || ent.mapped_state === 'past_due')) {
        console.error(`✖ [provisioning] ACTIVE subscription on UNMAPPED price "${ent.price_id}" (subject ${subject}) — price→tier map is missing this entry. Signalling retry (Stripe will re-deliver); NOT writing a free record. Add the price to tierForPrice.`);
        store.releaseEvent(event.id);
        return { retry: true, reason: `active subscription on unmapped price "${ent.price_id}" — operator must map it (not downgrading to free)` };
      }

      // OUT-OF-ORDER FLOOR (HARDENED F2): refetch-current-state above is the primary defense; this is the
      // floor for the no-fetcher fallback and any path where the refetch still yields a stale snapshot.
      //   (a) STRICTLY OLDER (created < last): reject — a stale event can never regress current state.
      //   (b) SAME SECOND (created === last): a grant-INCREASING transition (false→true) is rejected — a
      //       terminal/cancellation outcome at second T must win over a same-second non-terminal event, so
      //       grant:true may only flip when created > last. (A same-second grant:false→false or a state
      //       that does not increase entitlement is allowed through; it cannot resurrect a grant.)
      // Both are benign duplicates (finalize, ack) — Stripe need not retry an order it already lost.
      const eventAt = Number(event.created) || 0;
      if (eventAt > 0) {
        const last = store.lastEventAt(subject);
        if (last > 0 && eventAt < last) {
          store.finalizeEvent(event.id, event.type);
          return { handled: false, ignored: true, reason: `stale event (created ${eventAt} < last applied ${last}) — ignored to preserve current state` };
        }
        if (last > 0 && eventAt === last && ent.grant) {
          const prev = store.get(subject);
          // Only block if this would INCREASE entitlement (the last-applied state was non-granting). A
          // same-second event that keeps/repeats an existing grant is harmless and applied normally.
          if (prev && prev.grant === false) {
            store.finalizeEvent(event.id, event.type);
            return { handled: false, ignored: true, reason: `same-second event (created ${eventAt} === last applied ${last}) cannot resurrect a non-granting state — grant:true only flips when created > last` };
          }
        }
      }

      const record = ent.grant
        ? { ...ent }                                   // full granting record
        : canceledRecord(subject, ent.price_id, ent.reason); // canceled → Free floor (NEVER data deletion)
      store.upsert(record, eventAt);
      store.finalizeEvent(event.id, event.type);
      return { handled: true, subject, record };
    } catch (e) {
      // An exception HERE is a TERMINAL (poison) failure: the explicitly-retryable paths above
      // (subscription fetch down, unmapped active price) already returned { retry:true } after
      // releaseEvent — they never reach this catch. Anything that throws during recompute/upsert is
      // deterministic in the event bytes, so redelivering the identical event would crash identically
      // forever. Per the prescribed design a TERMINAL/non-retryable error FINALIZES the claim (so the
      // poison event does not loop) and is acked. We surface it as ignored (loud log), never as a grant.
      console.error(`✖ [provisioning] TERMINAL processing failure for event ${event.id} (${event.type}) — finalizing as poison (no retry, no grant): ${e.message}`);
      store.finalizeEvent(event.id, event.type);
      return { handled: false, ignored: true, reason: `terminal processing failure: ${e.message}` };
    }
  }

  /**
   * Issue the node's signed entitlement token from its stored record (plan §4 granting side).
   * Returns { grant:false } when the subject has no granting record (the node then stays on the Free
   * Forever floor — issue NO token). Returns { grant:true, token } otherwise.
   */
  function issueToken(subject) {
    const rec = store.get(subject);
    if (!rec || rec.grant === false || !Array.isArray(rec.namespaces) || rec.namespaces.length === 0) {
      return { grant: false, reason: rec ? `record state "${rec.state}" is not granting` : 'no record — Free Forever floor' };
    }
    if (typeof signEntitlement !== 'function' || !provPrivBundle) {
      return { grant: false, reason: 'signing not configured (provisioning key absent) — Free Forever floor' };
    }
    const token = signEntitlement({
      tier: rec.tier,
      state: rec.state,
      namespaces: rec.namespaces,
      expires_at: rec.expires_at,
      // node↔account binding + non-core context carried as additional SIGNED claims (verifier unions
      // namespaces with the Free floor; these are informational/binding, never a privilege source).
      extra: { subject, price_id: rec.price_id || null, seats: rec.seats ?? null, limits: rec.limits || null, interval: rec.interval || null, issued_at: now() },
    }, provPrivBundle);
    return { grant: true, token };
  }

  /**
   * Reconcile poll (plan §5 truth path): pull active subscriptions from Stripe, recompute each, and
   * upsert; any granting record whose subscription is NO LONGER active (missing from the list) is
   * downgraded to the Free floor. Webhooks are the fast path; this is the truth path that repairs
   * missed/auth-down deliveries. Returns { checked, upserted, downgraded }.
   */
  async function reconcile() {
    if (typeof listActiveSubscriptions !== 'function') throw new Error('listActiveSubscriptions not configured');
    const subs = (await listActiveSubscriptions()) || [];
    const activeSubjects = new Set();
    let upserted = 0;
    for (const sub of subs) {
      const ent = entitlementFromSubscription(sub, { tierForPrice });
      if (!ent.subject) continue;
      activeSubjects.add(ent.subject);
      if (ent.grant) { store.upsert({ ...ent }); upserted++; }
    }
    // Downgrade any locally-granting record that Stripe no longer reports active.
    let downgraded = 0;
    for (const rec of store.all()) {
      if (rec.grant !== false && rec.subject && !activeSubjects.has(rec.subject)) {
        store.upsert(canceledRecord(rec.subject, rec.price_id, 'not active in reconcile — downgraded to Free floor'));
        downgraded++;
      }
    }
    return { checked: subs.length, upserted, downgraded };
  }

  return { applyEvent, issueToken, reconcile };
}
