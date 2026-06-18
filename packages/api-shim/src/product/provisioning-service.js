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

  /** Resolve the authoritative subscription object for an event (truth path, plan §5). Returns the
   *  subscription object, or throws (→ caller signals retry). */
  async function resolveSubscription(event) {
    const obj = event?.data?.object;
    if (SUBSCRIPTION_TYPES.has(event.type)) return obj; // event object IS the subscription
    // checkout.session.completed / invoice.* carry a `subscription` id → fetch authoritative state.
    const subId = obj?.subscription;
    if (typeof subId !== 'string' || !subId) return null; // e.g. a one-time checkout with no subscription
    if (typeof fetchSubscription !== 'function') throw new Error('fetchSubscription not configured');
    return await fetchSubscription(subId);
  }

  /**
   * Apply one Stripe event idempotently. NEVER throws on a handled outcome; throws only are caught by
   * the router to signal a retryable failure. Returns:
   *   { deduped:true }                         already processed → ack, do nothing
   *   { handled:false, ignored:true, reason }  irrelevant event type → ack, do nothing
   *   { handled:true, subject, record }        record upserted (grant or canceled)
   *   { retry:true, reason }                   transient — DON'T ack (let Stripe retry); not marked processed
   */
  async function applyEvent(event) {
    if (!event || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') {
      return { handled: false, ignored: true, reason: 'malformed event' };
    }
    if (store.isProcessed(event.id)) return { deduped: true };

    const known = SUBSCRIPTION_TYPES.has(event.type) || SESSION_TYPES.has(event.type) || INVOICE_TYPES.has(event.type);
    if (!known) { store.markProcessed(event.id, event.type); return { handled: false, ignored: true, reason: `ignored type ${event.type}` }; }

    let sub;
    try { sub = await resolveSubscription(event); }
    catch (e) { return { retry: true, reason: `subscription fetch failed: ${e.message}` }; } // do NOT mark processed

    if (!sub) { store.markProcessed(event.id, event.type); return { handled: false, ignored: true, reason: 'event carries no subscription' }; }

    const ent = entitlementFromSubscription(sub, { tierForPrice });
    const subject = ent.subject;
    if (!subject) { store.markProcessed(event.id, event.type); return { handled: false, ignored: true, reason: 'subscription has no resolvable subject' }; }

    const record = ent.grant
      ? { ...ent }                                   // full granting record
      : canceledRecord(subject, ent.price_id, ent.reason); // canceled → Free floor (NEVER data deletion)
    store.upsert(record);
    store.markProcessed(event.id, event.type);
    return { handled: true, subject, record };
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
