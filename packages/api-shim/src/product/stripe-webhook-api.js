/**
 * stripe-webhook-api.js — POST /v1/stripe/webhook (STRIPE_PROVISIONING_PLAN.md §2).
 *
 * Thin router over provisioning-service.applyEvent(). Two deliberate safety properties:
 *  1. RAW BODY: Stripe signature verification needs the exact bytes, so this route uses express.raw()
 *     — NOT the global JSON parser (which would mutate the bytes and break signature checks).
 *  2. FAIL-CLOSED VERIFICATION: `verifyEvent` must authenticate the event (Stripe signature). The
 *     default refuses every request (503) until a real verifier is injected/configured — we never
 *     trust an unverified webhook (a forged event must not mint entitlements). Live Stripe secret +
 *     the stripe lib are founder-gated per plan §8; until then this endpoint only accepts events from
 *     an injected test-mode verifier.
 *
 * Retry semantics (plan §2/§5): a transient failure (e.g. subscription fetch down) → 500 so Stripe
 * RETRIES and the event is NOT marked processed; a handled/ignored/duplicate event → 200 (ack).
 */
import express from 'express';

/** Default verifier: fail-closed. No configured secret/verifier ⇒ reject (never trust raw input). */
const REFUSE_VERIFY = () => { const e = new Error('stripe webhook verification not configured'); e.code = 'no_verifier'; throw e; };

export function createStripeWebhookRouter(opts = {}) {
  const router = express.Router();
  const service = opts.service;
  if (!service?.applyEvent) throw new Error('stripe-webhook-api requires a provisioning service');
  // verifyEvent(rawBodyBuffer, signatureHeader) → the trusted event object, or throws if unverifiable.
  const verifyEvent = opts.verifyEvent || REFUSE_VERIFY;
  // Raw body so the signature is checked over the exact bytes Stripe signed.
  const raw = express.raw({ type: 'application/json', limit: '1mb' });

  router.post('/v1/stripe/webhook', raw, async (req, res) => {
    let event;
    try {
      event = verifyEvent(req.body, req.headers['stripe-signature']);
    } catch (e) {
      // Unverifiable / not configured → 400 (do not process; do not 200, so a misconfig is loud).
      return res.status(e.code === 'no_verifier' ? 503 : 400).json({ error: { type: 'stripe_webhook', message: e.message } });
    }
    try {
      const r = await service.applyEvent(event);
      if (r.retry) return res.status(500).json({ received: true, retry: true }); // Stripe will retry; not acked-as-done
      return res.status(200).json({ received: true, handled: !!r.handled, deduped: !!r.deduped, ignored: !!r.ignored });
    } catch (e) {
      // Unexpected → 500 so Stripe retries (the event was verified but processing crashed).
      return res.status(500).json({ received: true, retry: true });
    }
  });

  return router;
}
