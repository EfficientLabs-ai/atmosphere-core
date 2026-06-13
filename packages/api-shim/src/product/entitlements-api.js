/**
 * entitlements-api.js — GET /entitlements: the node's CURRENT entitlement, resolved locally.
 *
 * Wires the (until-now INERT) offline verifier (entitlement.js) live as a READ surface — WITHOUT
 * flipping enforcement on any feature route. Enforcement (a route consulting isEntitled() and
 * refusing) stays the deliberate, separate Phase 1.3 step; this only lets a node (or its console)
 * SEE what it would resolve to. Same posture as /score: R0 read, strict auth per-route, read-only —
 * no write-on-read (F1 discipline).
 *
 * FAIL-TO-FREE preserved end-to-end: resolve() never throws and never fail-closes — no token / bad
 * signature / wrong state / expired-past-grace all return the Free Forever floor with a reason. So a
 * GET here is always 200 with an honest body; it never gates, errors, or deletes.
 */
import express from 'express';
import { verifyPayload as defaultVerifyPayload } from '../../../stratos-agent/src/security/quantum-crypto.js';
import { createEntitlement } from './entitlement.js';

const PASSTHROUGH = (req, res, next) => next();

export function createEntitlementsRouter(opts = {}) {
  const router = express.Router();
  const auth = opts.auth || PASSTHROUGH;
  // verifyPayload + entitlement opts (profileDir/tokenPath/provisioningPublicKey/now) are injectable
  // for tests; the defaults are the live local verifier reading the node profile + ATMOS_PROV_PUBKEY.
  const verifyPayload = opts.verifyPayload || defaultVerifyPayload;
  const entOpts = opts.entitlementOpts || {};

  // ── GET /entitlements — resolve THIS node's entitlement from its local signed token (or Free) ──
  router.get('/entitlements', auth, (req, res) => {
    const resolved = createEntitlement({ verifyPayload }, entOpts).resolve();
    // Verbatim resolver output (tier · namespaces · state · source · reason) under an honest envelope.
    // No enforcement is performed here; `enforced:false` says so on the wire.
    res.json({
      format: 'efl.entitlement-resolution.v1',
      enforced: false, // this surface REPORTS; it does not gate (enforcement = Phase 1.3)
      resolved_at: new Date((entOpts.now || Date.now)()).toISOString(),
      entitlement: resolved,
    });
  });

  return router;
}
