/**
 * test-console-token.mjs — the console scoped-token handoff (CONSOLE_UI_SPEC).
 * Covers: the token store (mint/verify/expire/reuse/revoke/bounded); makeConsoleReadAuth (valid token
 * + loopback → pass; non-loopback Host → 403 rebinding refusal; invalid/expired → 401; no token →
 * strict master-secret gate); POST /console/session (master-secret gated mint).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';

// Hermetic env BEFORE importing the gateway (denial-audit sink → tmp; master secret for strict).
process.env.STRATOS_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'console-tok-'));
process.env.ATMOS_GATEWAY_SECRET = 'test-master-secret';
const { makeConsoleTokens } = await import('./src/console-token.js');
const { makeConsoleReadAuth } = await import('./src/gateway-auth.js');
const { createConsoleRouter } = await import('./src/product/console-api.js');
const { requireGatewaySecretStrict } = await import('./src/gateway-auth.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

console.log('console-token — scoped-token handoff\n');

// ── 1. store: mint / verify / reuse / expire / revoke / bounded ──
{
  let t = 1000;
  const store = makeConsoleTokens({ ttlMs: 100, now: () => t, max: 3 });
  const { token, expires_at } = store.mint();
  ok(typeof token === 'string' && token.length >= 40, 'mint → high-entropy token');
  ok(expires_at === 1100, 'expires_at = now + ttl');
  ok(store.verify(token) === true, 'verify true within TTL');
  ok(store.verify(token) === true, 'REUSABLE within TTL (not single-use)');
  ok(store.verify('nope') === false && store.verify(123) === false && store.verify('') === false, 'unknown / non-string / empty → false');
  t = 1201;
  ok(store.verify(token) === false, 'expired → false');
}
{
  let t = 2000;
  const s = makeConsoleTokens({ ttlMs: 10_000, now: () => t, max: 3 });
  for (let i = 0; i < 6; i++) s.mint(); // 6 mints, cap 3
  ok(s.size <= 3, `store bounded to max (size=${s.size})`);
  const s2 = makeConsoleTokens();
  const { token } = s2.mint();
  ok(s2.revoke(token) === true && s2.verify(token) === false, 'revoke works');
}

// ── 2. makeConsoleReadAuth (mock req/res for deterministic Host/token cases) ──
const mockReq = (headers) => ({ get: (h) => headers[h.toLowerCase()], path: '/score', method: 'GET', ip: '127.0.0.1' });
const mockRes = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
{
  const store = makeConsoleTokens();
  const { token } = store.mint();
  const mw = makeConsoleReadAuth({ verifyConsoleToken: store.verify });

  let nexted = false;
  mw(mockReq({ 'x-atmos-console': token, host: '127.0.0.1:4000' }), mockRes(), () => { nexted = true; });
  ok(nexted, 'valid console token + loopback Host → next()');

  let res = mockRes(); nexted = false;
  mw(mockReq({ 'x-atmos-console': token, host: 'evil.com' }), res, () => { nexted = true; });
  ok(!nexted && res.statusCode === 403, 'valid console token + non-loopback Host → 403 (rebinding refused)');

  res = mockRes(); nexted = false;
  mw(mockReq({ 'x-atmos-console': 'bogus-token', host: '127.0.0.1' }), res, () => { nexted = true; });
  ok(!nexted && res.statusCode === 401, 'present-but-invalid console token → 401 (re-authenticate), no fall-through');

  // no console token + correct master secret → falls through to strict → next
  res = mockRes(); nexted = false;
  mw(mockReq({ 'x-atmos-gateway': 'test-master-secret', host: '127.0.0.1' }), res, () => { nexted = true; });
  ok(nexted, 'no console token + valid master secret → strict gate passes');

  // no console token + wrong master secret → strict 401
  res = mockRes(); nexted = false;
  mw(mockReq({ 'x-atmos-gateway': 'wrong', host: '127.0.0.1' }), res, () => { nexted = true; });
  ok(!nexted && res.statusCode === 401, 'no console token + wrong master secret → strict 401');

  // a console token can NEVER be minted into reaching a spend route — it's only wired to read routes;
  // proven structurally (server.js applies consoleReadAuth ONLY to /score + /entitlements).

  // Origin allowlist on the console-token branch (dual-Codex round 1 fix) — auth-layer, not just CORS.
  process.env.ATMOS_GATEWAY_ORIGINS = 'http://127.0.0.1:7777';
  res = mockRes(); nexted = false;
  mw(mockReq({ 'x-atmos-console': token, host: '127.0.0.1', origin: 'https://evil.example' }), res, () => { nexted = true; });
  ok(!nexted && res.statusCode === 403, 'valid console token + non-allowlisted Origin → 403 (auth-layer)');

  res = mockRes(); nexted = false;
  mw(mockReq({ 'x-atmos-console': token, host: '127.0.0.1', origin: 'http://127.0.0.1:7777' }), res, () => { nexted = true; });
  ok(nexted, 'valid console token + allowlisted Origin → pass');

  res = mockRes(); nexted = false;
  mw(mockReq({ 'x-atmos-console': token, host: '127.0.0.1' }), res, () => { nexted = true; });
  ok(nexted, 'valid console token + no Origin (same-origin GET) → pass');

  // bracketed IPv6 loopback Host parsed correctly (dual-Codex round 1 note)
  res = mockRes(); nexted = false;
  mw(mockReq({ 'x-atmos-console': token, host: '[::1]:4000' }), res, () => { nexted = true; });
  ok(nexted, 'valid console token + [::1] loopback Host → pass (IPv6 parsed)');
  delete process.env.ATMOS_GATEWAY_ORIGINS;
}

// ── 3. POST /console/session — master-secret gated mint ──
function serve() {
  const store = makeConsoleTokens();
  const app = express();
  app.use(express.json());
  app.use(createConsoleRouter({ auth: requireGatewaySecretStrict, tokens: store }));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}/console/session`, store, close: () => s.close() }));
  });
}
{
  const s = await serve();
  // CLI caller: master secret header, no browser Origin → strict passes → 201
  const good = await fetch(s.url, { method: 'POST', headers: { 'x-atmos-gateway': 'test-master-secret' } });
  const body = await good.json();
  ok(good.status === 201 && typeof body.token === 'string', 'POST /console/session with master secret → 201 + token');
  ok(body.scope === 'console.read' && body.token_header === 'x-atmos-console', 'response declares read scope + the token header');
  ok(s.store.verify(body.token) === true, 'the minted token verifies in the store');
  // no secret → strict 401
  const bad = await fetch(s.url, { method: 'POST' });
  ok(bad.status === 401, 'POST /console/session without the master secret → 401');
  s.close();
}

console.log(`\n${fail ? '✖' : '✓'} console-token: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
