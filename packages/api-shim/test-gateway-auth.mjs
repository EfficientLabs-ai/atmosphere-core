/**
 * gateway-auth tests — the opt-in per-request secret for the loopback gateway.
 *
 * Covers the auth matrix WITHOUT a running daemon (hermetic): we import the module fresh in a child
 * env so GATEWAY_SECRET binds to the value we want, then drive requireGatewaySecret() directly with
 * tiny req/res fakes. Two modes are exercised in separate child processes:
 *   (A) no secret set  → allow + warn once
 *   (B) secret set     → x-atmos-gateway match → allow; Authorization: Bearer match → allow;
 *                        wrong / missing → 401
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ── child "drivers": run with MODE=... and assert in-process, exit non-zero on failure ──────────
const MODE = process.env.GWA_TEST_MODE;

if (MODE) {
  const assert = (await import('node:assert')).default;
  const { requireGatewaySecret, secretMatches } = await import('./src/gateway-auth.js');

  // minimal express-style req/res fakes
  const makeReq = (headers = {}) => {
    const lower = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return { get: (h) => lower[h.toLowerCase()] };
  };
  const makeRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };
  const run = (headers) => {
    const req = makeReq(headers); const res = makeRes(); let nextCalled = false;
    requireGatewaySecret(req, res, () => { nextCalled = true; });
    return { nextCalled, status: res.statusCode, body: res.body };
  };

  if (MODE === 'nosecret') {
    const r = run({});
    assert.ok(r.nextCalled, 'no secret set → request allowed (next called)');
    assert.equal(r.status, 200, 'no secret set → no 401');
    process.exit(0);
  }

  if (MODE === 'secret') {
    const SEC = process.env.ATMOS_GATEWAY_SECRET;
    assert.ok(SEC && SEC.length > 8, 'precondition: secret is set in child env');

    // x-atmos-gateway exact match → allow
    let r = run({ 'x-atmos-gateway': SEC });
    assert.ok(r.nextCalled && r.status === 200, 'x-atmos-gateway match → allow');

    // Authorization: Bearer <secret> → allow (OpenAI/ElevenLabs convention)
    r = run({ authorization: `Bearer ${SEC}` });
    assert.ok(r.nextCalled && r.status === 200, 'Bearer match → allow');

    // case-insensitive scheme also accepted
    r = run({ authorization: `bearer ${SEC}` });
    assert.ok(r.nextCalled, 'lowercase "bearer" scheme → allow');

    // wrong x-atmos-gateway → 401
    r = run({ 'x-atmos-gateway': 'not-the-secret-xxxxxxxx' });
    assert.ok(!r.nextCalled && r.status === 401, 'wrong x-atmos-gateway → 401');

    // wrong Bearer → 401
    r = run({ authorization: 'Bearer not-the-secret-xxxxxxxx' });
    assert.ok(!r.nextCalled && r.status === 401, 'wrong Bearer → 401');

    // missing entirely → 401
    r = run({});
    assert.ok(!r.nextCalled && r.status === 401, 'missing both headers → 401');

    // a Bearer of the right length but wrong value → 401 (length not a bypass)
    const sameLenWrong = 'x'.repeat(SEC.length);
    r = run({ authorization: `Bearer ${sameLenWrong}` });
    assert.ok(!r.nextCalled && r.status === 401, 'same-length wrong Bearer → 401');

    // secretMatches unit checks
    assert.ok(secretMatches(SEC, SEC), 'secretMatches: identical → true');
    assert.ok(!secretMatches('', SEC), 'secretMatches: empty → false');
    assert.ok(!secretMatches(SEC + 'a', SEC), 'secretMatches: longer → false');
    process.exit(0);
  }

  console.error('unknown GWA_TEST_MODE'); process.exit(2);
}

// ── parent: spawn the two child modes with the right env, report ────────────────────────────────
let pass = 0;
const child = (mode, env) => {
  const r = spawnSync(process.execPath, [SELF], {
    cwd: __dirname, encoding: 'utf8',
    env: { ...process.env, GWA_TEST_MODE: mode, ...env },
  });
  if (r.status === 0) { console.log(`  ✓ mode=${mode}`); pass++; }
  else { console.error(`  ✗ mode=${mode}\n${(r.stderr || r.stdout || '').trim()}`); process.exit(1); }
};

console.log('=== gateway-auth: no secret set → allow ===');
// ensure the child does NOT inherit a secret from the parent shell
child('nosecret', { ATMOS_GATEWAY_SECRET: '' });

console.log('=== gateway-auth: secret set → x-atmos-gateway + Bearer matrix ===');
child('secret', { ATMOS_GATEWAY_SECRET: 'test-gateway-secret-abc123' });

console.log(`\n✅ ALL ${pass} gateway-auth child suites passed.`);
