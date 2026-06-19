/**
 * provisioning-mount.js — the WIRING SEAM that mounts the paid→provisioned→delivered loop on the live
 * bridge (STRIPE_PROVISIONING_PLAN.md §2/§4/§8). It assembles the (already-tested, hermetic) pieces —
 * entitlement-store, provisioning-service, stripe-webhook router, entitlement-issue router — and the
 * Supabase console-mirror sink, behind a SINGLE injectable capability bundle.
 *
 * SAFE-BY-DEFAULT (task §2/§4): with NO live bundle injected, the webhook stays fail-closed
 * (REFUSE_VERIFY → 503) and the issuer stays on the Free Forever floor (no signing key → no token).
 * Nothing goes live by accident on a reload.
 *
 * ── HOW THE FOUNDER GOES LIVE (the injection seam) ───────────────────────────────────────────────
 * Set ATMOS_PROVISIONING_PATH to an operator-plane module (kept OUTSIDE this repo, sourced from the
 * vault — same pattern as ATMOS_CLASSIFIER_PATH / ATMOS_LIFECYCLE_GATE_PATH in server.js). That module
 * default-exports an async/sync factory returning the live capability bundle:
 *
 *     // /home/neo/vault/provisioning/atmos-provisioning.mjs   (0600, operator-owned, NEVER in this repo)
 *     import Stripe from 'stripe';
 *     const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);                 // founder-provisioned
 *     export default async function () {
 *       return {
 *         // verifyEvent(rawBodyBuffer, signatureHeader) → trusted Stripe event, or THROWS.
 *         verifyEvent: (raw, sig) =>
 *           stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET),
 *         // price_id → canonical tier key (the founder/Stripe-gated map; the ONLY place prices resolve).
 *         tierForPrice: (pid) => ({ price_xxx: 'apex', price_yyy: 'apex_max' }[pid] || null),
 *         fetchSubscription: (id) => stripe.subscriptions.retrieve(id),
 *         listActiveSubscriptions: async () => {
 *           const out = []; for await (const s of stripe.subscriptions.list({ status: 'active' })) out.push(s); return out;
 *         },
 *         // the provisioning PRIVATE key bundle (hybrid Ed25519 + ML-DSA-65), loaded from the vault.
 *         provPrivBundle: JSON.parse(fs.readFileSync('/home/neo/vault/provisioning/prov-priv.json','utf8')),
 *         // OPTIONAL: override the Supabase console mirror (otherwise built from SUPABASE_* env, below).
 *         // supabase: { url, serviceKey, table }
 *       };
 *     }
 *
 * The Supabase console mirror is built from env when the bundle does not provide one:
 *     SUPABASE_URL                = https://<proj>.supabase.co
 *     SUPABASE_SERVICE_ROLE_KEY   = <service-role key>   (server-side only; founder-provisioned)
 *     SUPABASE_SUBSCRIPTIONS_TABLE= subscriptions        (optional; defaults to 'subscriptions')
 *
 * The signing key + Stripe verifier + Supabase service key are FOUNDER-PROVISIONED from the vault and
 * are NEVER read, fabricated, or hardcoded here. This file leaves the seam; the founder injects.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { signEntitlement } from './entitlement-signer.js';
import { createEntitlementStore } from './entitlement-store.js';
import { createProvisioningService } from './provisioning-service.js';
import { createStripeWebhookRouter } from './stripe-webhook-api.js';
import { createEntitlementIssueRouter } from './entitlement-issue-api.js';
import { createSupabaseFulfillment } from './supabase-fulfillment.js';

/** Load the operator-plane provisioning bundle (vault module via ATMOS_PROVISIONING_PATH), or null.
 *  Same fail-closed posture as server.js's _loadOperatorFn: a set-but-unloadable path stays fail-closed. */
export async function loadProvisioningBundle(env = process.env, importer = (p) => import(p)) {
  const p = env.ATMOS_PROVISIONING_PATH;
  if (!p) return null;
  try {
    const mod = await importer(p);
    const factory = mod.default || mod.createProvisioningBundle || mod;
    const bundle = typeof factory === 'function' ? await factory() : factory;
    return bundle && typeof bundle === 'object' ? bundle : null;
  } catch (e) {
    console.warn(`⚠️  [provisioning] ATMOS_PROVISIONING_PATH set but unloadable (${e.message}) — staying fail-closed (webhook 503, issuer Free floor)`);
    return null;
  }
}

/**
 * Build the provisioning loop and return the routers to mount, plus a status snapshot for logging.
 *
 * @param {object} deps
 *   bundle      : the injected live capability bundle (or null → safe default).
 *   issueAuth   : Express auth middleware for GET /v1/account/entitlement-token (live: strict; tests: passthrough).
 *   subjectOf   : (req) → billing subject bound to the request (live: node↔account binding; tests: header).
 *   storeDir    : entitlement-store dir override (tests); default = profile/provisioning.
 *   fetchImpl   : injected fetch for the Supabase sink (tests).
 *   now         : clock.
 *
 * @returns {{ webhookRouter, issueRouter, status, service, fulfillment }}
 */
export function buildProvisioning(deps = {}) {
  const bundle = deps.bundle || {};
  const now = deps.now || Date.now;

  const store = createEntitlementStore({ dir: deps.storeDir, now });

  // Console mirror: bundle.supabase overrides env; either way, creds absent ⇒ enabled:false ⇒ write()
  // THROWS (fail loud), which the wrapper below turns into a retryable 5xx. NEVER a silent no-op.
  const sbCfg = bundle.supabase || {
    url: (deps.env || process.env).SUPABASE_URL,
    serviceKey: (deps.env || process.env).SUPABASE_SERVICE_ROLE_KEY,
    table: (deps.env || process.env).SUPABASE_SUBSCRIPTIONS_TABLE,
  };
  const fulfillment = deps.fulfillment || createSupabaseFulfillment({ ...sbCfg, fetchImpl: deps.fetchImpl, now });

  const service = createProvisioningService({
    store,
    fetchSubscription: bundle.fetchSubscription,
    tierForPrice: bundle.tierForPrice,
    listActiveSubscriptions: bundle.listActiveSubscriptions,
    signEntitlement,
    provPrivBundle: bundle.provPrivBundle,
    now,
  });

  // FULFILLMENT WRAPPER (task §3): wrap applyEvent so that on a VERIFIED, GRANTING/handled outcome we
  // ALSO mirror the recompute result into the Supabase `subscriptions` row the console reads. The
  // bridge record (store.upsert inside applyEvent) is the truth; this mirrors it for the console.
  //
  // FAIL-CLOSED on the mirror: if the Supabase write throws (creds absent OR upstream error), we
  // surface a retry so the webhook router returns 500 and Stripe RETRIES — the event is NOT marked
  // "done" with a half-applied state. (The local record is already upserted and idempotent; the retry
  // simply re-mirrors. We never 200-with-noop a fulfillment we could not complete.)
  async function applyEventWithMirror(event) {
    const r = await service.applyEvent(event);
    if (r && r.handled && r.record && r.record.subject) {
      try {
        await fulfillment.write(r.record);
      } catch (e) {
        console.error(`✖ [provisioning] console mirror (Supabase) write FAILED for subject — signalling retry: ${e.message}`);
        return { retry: true, reason: `console mirror failed: ${e.message}` };
      }
    }
    return r;
  }

  // REQUIRE fetchSubscription FOR THE LIVE WEBHOOK (Codex HIGH F2). Refetch-current-state is the PRIMARY
  // out-of-order defense: a `.updated`/`.deleted` event's EMBEDDED subscription can be stale relative to
  // Stripe's current truth, so the service refetches when a fetcher is present. Without it the loop would
  // run on the weak monotonic-timestamp floor ALONE — which cannot fully order same-second events — so a
  // bundle that injects a verifier but no fetchSubscription must FAIL CLOSED, not silently degrade. We do
  // this with the SAME pattern as the missing verifier: drop the real verifier so the webhook 503s. (The
  // floor in provisioning-service is also hardened against same-second grant resurrection as the
  // belt-and-braces second layer — see applyEvent — but the live mount must not depend on it alone.)
  const hasFetcher = typeof bundle.fetchSubscription === 'function';
  if (bundle.verifyEvent && !hasFetcher) {
    console.warn('⚠️  [provisioning] live verifier injected WITHOUT fetchSubscription — refetch-current-state is the primary out-of-order defense, so the webhook stays FAIL-CLOSED (503). Add fetchSubscription to the bundle to go live.');
  }
  const webhookRouter = createStripeWebhookRouter({
    service: { applyEvent: applyEventWithMirror }, // verifier-gated; raw body inside the router
    // absent verifier OR absent fetchSubscription ⇒ REFUSE_VERIFY ⇒ 503 (fail-closed). fetchSubscription
    // is REQUIRED for the live webhook (out-of-order primary defense), not optional.
    verifyEvent: hasFetcher ? bundle.verifyEvent : undefined,
  });

  // subjectOf resolves an authenticated request → its billing subject (the node↔account binding). In
  // production the founder injects the real resolver via the bundle (bundle.subjectOf); the route's
  // own default (x-efl-subject header) is test-only and is NOT used live unless explicitly chosen,
  // because the route is already gated by requireGatewaySecretStrict (only the bound node can call).
  const issueRouter = createEntitlementIssueRouter({
    service,
    auth: deps.issueAuth,
    subjectOf: deps.subjectOf || bundle.subjectOf,
  });

  // LIVE requires BOTH a verifier AND fetchSubscription (the webhook is fail-closed without either).
  const live = !!bundle.verifyEvent && hasFetcher;
  const status = {
    live,                                   // a live Stripe verifier AND fetchSubscription are injected
    canSign: !!bundle.provPrivBundle,       // signing key present ⇒ issuer can mint tokens
    consoleMirror: fulfillment.enabled,     // Supabase console mirror configured
    priceMap: typeof bundle.tierForPrice === 'function',
    canFetch: hasFetcher,                   // fetchSubscription present ⇒ refetch-current-state defense active
  };

  return { webhookRouter, issueRouter, status, service, fulfillment };
}
