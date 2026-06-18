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
 */
import express from 'express';

const PASSTHROUGH = (req, res, next) => next();

export function createEntitlementIssueRouter(opts = {}) {
  const router = express.Router();
  const service = opts.service;
  if (!service?.issueToken) throw new Error('entitlement-issue-api requires a provisioning service');
  const auth = opts.auth || PASSTHROUGH;
  // subjectOf(req) → the billing subject bound to this authenticated request, or null.
  const subjectOf = opts.subjectOf || ((req) => req.headers['x-efl-subject'] || null); // test-friendly default

  router.get('/v1/account/entitlement-token', auth, (req, res) => {
    const subject = subjectOf(req);
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
