/**
 * subscription-state.js — the PURE recompute core of the provisioning loop
 * (STRIPE_PROVISIONING_PLAN.md §1 tier→entitlement matrix + §3 state machine).
 *
 * SCOPE LINE (mirrors entitlement.js / entitlement-signer.js): this module is PURE. It touches NO
 * Stripe, holds NO key, signs NOTHING, writes NOTHING. Given a (already-fetched, trusted) Stripe
 * subscription object + a price_id→tier map, it computes WHAT entitlement that subscription grants.
 * The webhook receiver and the signer call it; it decides nothing about WHO or HOW money moved.
 *
 * The single source of truth for "subscription state → entitlement" so the webhook fast-path and the
 * reconcile truth-path can never disagree (plan §5: "entitlement recompute always reads the
 * subscription object state, not the event payload deltas" — an out-of-order older event cannot
 * regress the record because both paths recompute from the same function over the same object).
 *
 * Free Forever needs NO token (entitlement.js owns the floor); a CANCELED subscription therefore
 * yields grant:false (issue no token / let the existing token expire → the node falls to Free).
 */

/**
 * Tier → granted namespace patterns. These are the PAID namespaces the signed token carries; the
 * verifier (entitlement.js) UNIONS them with the Free Forever floor, so the floor is never repeated
 * here. Mirrors STRIPE_PROVISIONING_PLAN.md §1 exactly (names are the coordination contract with
 * ATMOS_API_SPEC). Frozen so a downstream caller cannot mutate the shared arrays.
 */
export const TIER_NAMESPACES = Object.freeze({
  exos_pro: Object.freeze([
    'workspace.*', 'receipts.*', 'files.*', 'agent.hub', 'agent.attach',
    'terminal.*', 'runtime-score.verdict', 'continuity.*',
  ]),
  apex: Object.freeze([
    'workspace.*', 'receipts.*', 'receipts.export', 'files.*', 'agent.hub', 'agent.attach',
    'terminal.*', 'runtime-score.*', 'continuity.*',
  ]),
  apex_max: Object.freeze([
    'workspace.*', 'receipts.*', 'receipts.export', 'files.*', 'agent.hub', 'agent.attach',
    'terminal.*', 'runtime-score.*', 'continuity.*', 'routing.priority',
  ]),
  teams: Object.freeze([
    'workspace.*', 'receipts.*', 'receipts.export', 'files.*', 'agent.hub', 'agent.attach',
    'terminal.*', 'runtime-score.*', 'continuity.*', 'teams.*',
  ]),
  enterprise: Object.freeze([
    'workspace.*', 'receipts.*', 'receipts.export', 'files.*', 'agent.hub', 'agent.attach',
    'terminal.*', 'runtime-score.*', 'continuity.*', 'teams.*', 'routing.priority',
  ]),
});

/** PROPOSED per-tier limits (plan §1; PROPOSED, founder-gated). credits = null (TBD founder+counsel —
 *  no number exists; never invent one). */
export const TIER_LIMITS = Object.freeze({
  exos_pro: Object.freeze({ nodes: 1, workspaces: 3, credits_per_cycle: null }),
  apex: Object.freeze({ nodes: 3, workspaces: 10, credits_per_cycle: null }),
  apex_max: Object.freeze({ nodes: 5, workspaces: 10, credits_per_cycle: null }),
  teams: Object.freeze({ nodes: null, workspaces: 10, credits_per_cycle: null }), // nodes = 1/seat (computed from seats)
  enterprise: Object.freeze({ nodes: null, workspaces: null, credits_per_cycle: null }), // by agreement
});

/** Stripe subscription.status → our entitlement state (plan §3). Only active|past_due GRANT (the
 *  verifier's GRANTING_STATES); everything else → canceled (Free floor). trialing grants (active). */
export function mapSubscriptionStatus(status) {
  switch (String(status || '')) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due'; // grace: features stay on, no new credit grants (plan §3)
    default:
      // canceled, incomplete, incomplete_expired, paused, or anything unknown → no grant
      return 'canceled';
  }
}

/** Extract the active price id from a Stripe subscription object (first item). Tolerant of the two
 *  common shapes (`items.data[].price.id` and a flattened `plan.id`); returns null if absent. */
export function priceIdOf(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const item = sub.items?.data?.[0];
  const pid = item?.price?.id || item?.plan?.id || sub.plan?.id;
  return typeof pid === 'string' && pid ? pid : null;
}

/**
 * Recompute the entitlement a subscription grants. PURE, never throws.
 *
 * @param {object} sub                Stripe subscription object (already fetched/trusted).
 * @param {object} deps
 * @param {(priceId:string)=>string|null} deps.tierForPrice  price_id → canonical tier key, or null.
 *        (Real price_ids are founder+Stripe-gated; inject the map. Keep this the ONLY place price_ids
 *        resolve so grandfathered + new-generation prices both map — plan §4.)
 * @returns {object} one of:
 *   { grant:false, state:'canceled', subject, price_id, reason }   → issue/keep no token (Free floor)
 *   { grant:true, subject, tier, state, namespaces[], limits, seats, price_id, interval, expires_at }
 */
export function entitlementFromSubscription(sub, deps = {}) {
  const tierForPrice = deps.tierForPrice || (() => null);
  const subject = (sub && (sub.customer_account || sub.metadata?.account_id || sub.customer)) || null;
  const price_id = priceIdOf(sub);
  const state = mapSubscriptionStatus(sub?.status);

  // `mapped_state` carries the status-derived state (active|past_due|canceled) on a NO result too, so a
  // caller can tell a genuine cancellation (status not granting) from an ACTIVE/grace subscription that
  // merely failed a downstream check (e.g. an unmapped price). `unmapped_price` flags the specific
  // operator-misconfig case: an otherwise-granting subscription whose price maps to no known tier —
  // that must NOT be silently downgraded to free (Codex HIGH); the caller signals retry + alerts.
  const no = (reason, extra = {}) => ({ grant: false, state: 'canceled', mapped_state: state, subject, price_id, reason, ...extra });

  if (state === 'canceled') return no(`subscription status "${sub?.status}" is not granting`);
  if (!price_id) return no('subscription has no resolvable price id');

  const tier = tierForPrice(price_id);
  // An ACTIVE/grace subscription whose price maps to no known tier is an operator misconfig, NOT a free
  // user: flag it so the caller retries + alerts instead of writing a free record + acking the event.
  if (!tier || !TIER_NAMESPACES[tier]) return no(`price "${price_id}" maps to no known tier`, { unmapped_price: true });

  // current_period_end is Stripe seconds → epoch ms. The token's expires_at is the PERIOD END only;
  // the verifier (entitlement.js) applies the 14-day grace ON TOP via GRACE_MS, so do NOT add grace
  // here (doing so would double-count it). A missing/invalid period end → no grant (a paid token MUST
  // carry a finite window; the verifier rejects junk expiries to Free).
  const cpe = Number(sub?.current_period_end);
  if (!Number.isFinite(cpe) || cpe <= 0) return no('subscription has no valid current_period_end');
  const expires_at = Math.round(cpe * 1000);

  const seats = Number.isInteger(sub?.quantity) && sub.quantity > 0 ? sub.quantity : null;
  const interval = sub?.items?.data?.[0]?.price?.recurring?.interval || sub?.plan?.interval || null;

  const limits = { ...TIER_LIMITS[tier] };
  if (tier === 'teams' && seats) limits.nodes = seats; // 1 node/seat (plan §1)

  return {
    grant: true,
    subject,
    tier,
    state, // 'active' | 'past_due' (grace) — both GRANT in the verifier
    namespaces: [...TIER_NAMESPACES[tier]],
    limits,
    seats,
    price_id,
    interval,
    expires_at,
  };
}
