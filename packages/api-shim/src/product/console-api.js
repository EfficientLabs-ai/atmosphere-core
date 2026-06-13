/**
 * console-api.js — POST /console/session: mint a console-scoped read token (CONSOLE_UI_SPEC).
 *
 * Authenticated with the gateway MASTER secret (the `stratos console` CLI calls it). Hands back a
 * short-TTL, read-scoped token the browser console will hold INSTEAD of the master secret. The token
 * authorizes only the console read surface (/score, /entitlements via makeConsoleReadAuth); it can
 * never reach spend/mint/register/link. Read-only itself (minting a token is not a proof-surface
 * mutation — no receipt), and it returns only the token + its expiry, never the master secret.
 */
import express from 'express';

const PASSTHROUGH = (req, res, next) => next();

export function createConsoleRouter(opts = {}) {
  const router = express.Router();
  const auth = opts.auth || PASSTHROUGH;       // requireGatewaySecretStrict — the master-secret gate
  const tokens = opts.tokens || null;          // the console-token store (makeConsoleTokens)
  const deny = (res, code, message) => res.status(code).json({ error: { message, type: 'console_api' } });

  // ── POST /console/session — mint a console read token (master-secret gated) ──
  router.post('/console/session', auth, (req, res) => {
    if (!tokens?.mint) return deny(res, 503, 'console token service unavailable');
    const { token, expires_at } = tokens.mint();
    // The page opens at <console_url>#<token> — token in the FRAGMENT (never logged/sent to a server).
    res.status(201).json({ token, expires_at, scope: 'console.read', token_header: 'x-atmos-console' });
  });

  return router;
}
