/**
 * entitlement-issue-api.js — GET /v1/account/entitlement-token (STRIPE_PROVISIONING_PLAN.md §4).
 *
 * The GRANTING delivery surface: an authenticated node fetches its signed `efl.entitlement.v1` token,
 * writes it to disk, and the (already-shipped) offline verifier in entitlement.js consumes it. This
 * route holds the binding between an authenticated request and a billing SUBJECT via injected
 * `subjectOf(req)` — in production the node↔account binding (account-link-api.js / gateway secret);
 * injected in tests. Auth is required: minting a token is a privilege act, so the default auth is a
 * PASSTHROUGH ONLY for tests and the live mount MUST pass requireGatewaySecretStrict (founder-gated).
 *
 * FAIL-TO-FREE on the wire: a subject with no granting record returns 200 { grant:false,
 * tier:'free_forever' } — NEVER an error wall. A node that gets this simply keeps no paid token and
 * runs on the Free Forever floor. No token is ever issued for a canceled/absent subscription.
 *
 * FAIL-CLOSED ON SUBJECT (Codex CRITICAL): the SUBJECT must come from an injected `subjectOf(req)`
 * resolver that binds to the authenticated node/account (the node→account ownership-proof keystone) —
 * NEVER from a client-supplied header. With a valid gateway secret but no bound subject, trusting
 * `x-efl-subject` let anyone mint a token for ANY account. So when no resolver is injected the route
 * REFUSES to mint (503), it does NOT fall back to the header. The header path is honored ONLY under
 * the explicit, default-off opt-in env flag ALLOW_HEADER_SUBJECT=1 (tests/local dev) — never live.
 */
import express from 'express';

const PASSTHROUGH = (req, res, next) => next();

/** Test/dev-only header subject, gated behind ALLOW_HEADER_SUBJECT=1 (read at REQUEST time so tests and
 *  runtime reconfig see the current value). Returns the header subject, or null when the flag is off. */
function headerSubjectIfAllowed(req) {
  if (process.env.ALLOW_HEADER_SUBJECT !== '1') return null;
  const s = req.headers['x-efl-subject'];
  return typeof s === 'string' && s ? s : null;
}

export function createEntitlementIssueRouter(opts = {}) {
  const router = express.Router();
  const service = opts.service;
  if (!service?.issueToken) throw new Error('entitlement-issue-api requires a provisioning service');
  const auth = opts.auth || PASSTHROUGH;
  // subjectOf(req) → the billing subject bound to this authenticated request, or null. INJECTED in
  // production from the node→account ownership-proof keystone; there is NO header fallback by default.
  const subjectOf = typeof opts.subjectOf === 'function' ? opts.subjectOf : null;
  const hasResolver = !!subjectOf;

  router.get('/v1/account/entitlement-token', auth, (req, res) => {
    // No injected resolver → the route cannot know WHO this request is for. Refuse to mint (fail-closed)
    // rather than trusting a client header (Codex CRITICAL: header-controlled mint). The ONLY exception
    // is the explicit, default-off ALLOW_HEADER_SUBJECT=1 opt-in for tests/local dev.
    let subject;
    if (hasResolver) {
      subject = subjectOf(req); // authoritative binding; the request header is IGNORED.
    } else {
      subject = headerSubjectIfAllowed(req);
      if (!subject && process.env.ALLOW_HEADER_SUBJECT !== '1') {
        return res.status(503).json({
          error: { type: 'subject_resolver', message: 'subject resolver not configured — refusing to mint an entitlement token without an authenticated account binding (fail-closed; never trust a client header for the subject)' },
        });
      }
    }
    if (!subject) {
      // No bound subject → honest Free floor (not an error): the node runs free until it binds.
      return res.status(200).json({ grant: false, tier: 'free_forever', reason: 'no account subject bound to this request' });
    }
    const issued = service.issueToken(subject);
    if (!issued.grant) {
      return res.status(200).json({ grant: false, tier: 'free_forever', reason: issued.reason });
    }
    return res.status(200).json({ grant: true, token: issued.token });
  });

  return router;
}
