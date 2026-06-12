import crypto from 'node:crypto';
import { recordDenial } from '../../stratos-agent/src/security/denial-audit.js';

/**
 * F2 — opt-in per-request auth for the loopback gateway.
 *
 * The gateway binds to 127.0.0.1, so it is not exposed on the Tailnet; this adds
 * defense-in-depth against OTHER local processes/users on the host driving spend
 * or the /mcp browser. It is OPT-IN and non-breaking:
 *   - ATMOS_GATEWAY_SECRET unset  → routes behave exactly as before (warn once).
 *   - ATMOS_GATEWAY_SECRET set    → spend + /mcp routes require the secret via EITHER
 *                                   `x-atmos-gateway: <secret>`  (first-party callers), OR
 *                                   `Authorization: Bearer <secret>` (OpenAI convention —
 *                                   how ElevenLabs' Custom LLM and any OpenAI SDK client
 *                                   authenticate). The same secret, compared timing-safely.
 */
export const GATEWAY_SECRET = process.env.ATMOS_GATEWAY_SECRET || null;

let warned = false;

/** Timing-safe equality that never short-circuits on length (avoids leaking length via timing). */
export function secretMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  // Compare against a fixed-length digest so a length mismatch still does constant work.
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh) && a.length === b.length;
}

/** Pull the bearer token out of an `Authorization: Bearer <token>` header (case-insensitive scheme). */
function bearerToken(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

/**
 * Express middleware: gate a route behind the shared secret (allow + warn if unset).
 * Accepts the secret via `x-atmos-gateway` OR `Authorization: Bearer` — either is sufficient.
 */
export function requireGatewaySecret(req, res, next) {
  if (!GATEWAY_SECRET) {
    if (!warned) {
      console.warn('🔓 [Gateway] ATMOS_GATEWAY_SECRET not set — spend/mcp routes are loopback-perimeter only (no per-request auth). Set it to enable local-process isolation.');
      warned = true;
    }
    return next();
  }
  const viaHeader = secretMatches(req.get('x-atmos-gateway'), GATEWAY_SECRET);
  const viaBearer = secretMatches(bearerToken(req), GATEWAY_SECRET);
  if (!viaHeader && !viaBearer) {
    // Persist the denial (red-team gap: 401s previously left no queryable trace). Only the fact —
    // route/method/peer — is recorded; the provided credential value NEVER reaches the sink.
    recordDenial({ gate: 'gateway-auth', reason: 'invalid or missing gateway secret', route: req.path, method: req.method, actor: req.ip });
    return res.status(401).json({ error: { message: 'Unauthorized: invalid or missing gateway secret (x-atmos-gateway or Authorization: Bearer)', type: 'gateway_auth' } });
  }
  return next();
}

/** First-party callers spread this into their fetch headers. Empty when no secret is set. */
export function gatewayAuthHeaders() {
  return GATEWAY_SECRET ? { 'x-atmos-gateway': GATEWAY_SECRET } : {};
}
