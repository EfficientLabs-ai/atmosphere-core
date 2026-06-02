import crypto from 'node:crypto';

/**
 * F2 — opt-in per-request auth for the loopback gateway.
 *
 * The gateway binds to 127.0.0.1, so it is not exposed on the Tailnet; this adds
 * defense-in-depth against OTHER local processes/users on the host driving spend
 * or the /mcp browser. It is OPT-IN and non-breaking:
 *   - ATMOS_GATEWAY_SECRET unset  → routes behave exactly as before (warn once).
 *   - ATMOS_GATEWAY_SECRET set    → spend + /mcp routes require the
 *                                   `x-atmos-gateway` header to match; the
 *                                   first-party callers attach it automatically.
 */
export const GATEWAY_SECRET = process.env.ATMOS_GATEWAY_SECRET || null;

let warned = false;

/** Express middleware: gate a route behind the shared secret (allow + warn if unset). */
export function requireGatewaySecret(req, res, next) {
  if (!GATEWAY_SECRET) {
    if (!warned) {
      console.warn('🔓 [Gateway] ATMOS_GATEWAY_SECRET not set — spend/mcp routes are loopback-perimeter only (no per-request auth). Set it to enable local-process isolation.');
      warned = true;
    }
    return next();
  }
  const provided = Buffer.from(req.get('x-atmos-gateway') || '');
  const expected = Buffer.from(GATEWAY_SECRET);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: { message: 'Unauthorized: invalid or missing x-atmos-gateway header', type: 'gateway_auth' } });
  }
  return next();
}

/** First-party callers spread this into their fetch headers. Empty when no secret is set. */
export function gatewayAuthHeaders() {
  return GATEWAY_SECRET ? { 'x-atmos-gateway': GATEWAY_SECRET } : {};
}
