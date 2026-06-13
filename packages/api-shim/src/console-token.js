/**
 * console-token.js — short-TTL, READ-SCOPED capability tokens for the node-served console
 * (CONSOLE_UI_SPEC slice "scoped-token handoff"; TRANSPORT_IDENTITY_KEYSTONE rule: the gateway MASTER
 * secret must NEVER enter a browser page).
 *
 * A `stratos console` invocation authenticates with the master secret (POST /console/session) and is
 * handed one of these tokens; the browser holds ONLY the token (in the URL fragment), never the master
 * secret. The token authorizes the console READ surface only (/score, /entitlements) — never spend,
 * mint, register, or link (those keep requireGatewaySecretStrict). Three deliberate differences from
 * the terminal attach token (session-manager.js):
 *   - REUSABLE within its TTL (the console polls /score and /entitlements repeatedly) — NOT single-use.
 *   - bounded store with expiry pruning (a runaway minter cannot grow memory unbounded).
 *   - high-entropy (256-bit) random secret, so a Map-key lookup is not a practical timing oracle (the
 *     same posture session-manager's attach token relies on).
 */
import crypto from 'node:crypto';

export function makeConsoleTokens({ ttlMs = 15 * 60_000, now = Date.now, max = 256 } = {}) {
  const tokens = new Map(); // token -> { expires }

  function prune() {
    for (const [t, v] of tokens) if (now() > v.expires) tokens.delete(t);
  }

  /** Mint a fresh console token. Bounds the store: prune expired first, and if still at capacity
   *  evict the soonest-to-expire entry (mint must never silently fail; capacity is a DoS guard, not a
   *  feature gate). Returns { token, expires_at }. */
  function mint() {
    if (tokens.size >= max) {
      prune();
      if (tokens.size >= max) {
        let oldestKey = null, oldestExp = Infinity;
        for (const [t, v] of tokens) if (v.expires < oldestExp) { oldestExp = v.expires; oldestKey = t; }
        if (oldestKey) tokens.delete(oldestKey);
      }
    }
    const token = crypto.randomBytes(32).toString('base64url'); // 256-bit secret
    const expires = now() + ttlMs;
    tokens.set(token, { expires });
    return { token, expires_at: expires };
  }

  /** True iff the token exists and is unexpired. NOT consumed (reusable within TTL). An expired token
   *  is deleted on read. Fail-closed on any non-string / unknown / expired input. */
  function verify(token) {
    if (typeof token !== 'string' || !token) return false;
    const v = tokens.get(token);
    if (!v) return false;
    if (now() > v.expires) { tokens.delete(token); return false; }
    return true;
  }

  function revoke(token) { return tokens.delete(token); }

  return { mint, verify, revoke, prune, get size() { return tokens.size; } };
}
