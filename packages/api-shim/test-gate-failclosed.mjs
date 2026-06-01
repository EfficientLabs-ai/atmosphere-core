/**
 * Gate fail-closed hardening (Codex review of PR #41). When the compliance gate THROWS (can't be
 * evaluated), the old catch only blocked when `wouldSpend` was truthy — so a gate error on a paid-family
 * model whose key wasn't present (or any unclassifiable model) fell through to the spend/proxy path.
 *
 * failClosedOnGateError now blocks ANYTHING that resolves to a paid provider (or that it can't classify),
 * and only lets a provably-local model proceed. This tests that helper directly with mock req/res.
 */
import assert from 'node:assert';
import { failClosedOnGateError } from './server.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const mockRes = () => { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

console.log('=== a paid-provider model is BLOCKED on gate error (fail-closed) ===');
for (const model of ['claude-3-5-sonnet-20241022', 'gpt-4o', 'o3-mini', 'gemini-2.0-flash', 'meta-llama/llama-3-70b']) {
  const res = mockRes();
  const blocked = failClosedOnGateError({ body: { model } }, res);
  ok(blocked === true && res.code === 402 && res.body?.error === 'approval_required', `${model} → 402 blocked`);
}

console.log('\n=== a provably-local model PROCEEDS (no false block) ===');
for (const model of ['qwen2.5:7b', 'llama3', 'local', 'phi3']) {
  const res = mockRes();
  const blocked = failClosedOnGateError({ body: { model } }, res);
  ok(blocked === false && res.code === null, `${model} → not blocked (local)`);
}

console.log('\n=== a missing/empty model has no paid provider to spend on → proceeds (local-ish) ===');
for (const body of [{ model: '' }, {}, { model: null }]) {
  // empty/missing model → providerForModel returns null → treated as local-ish and allowed
  // (a request with no model can't reach a paid API), so these PROCEED. We assert that explicitly:
  const res = mockRes();
  const blocked = failClosedOnGateError({ body }, res);
  ok(blocked === false, `empty/missing model (${JSON.stringify(body)}) → proceeds (no paid provider to spend on)`);
}

console.log(`\n✅ ALL ${pass} gate-failclosed checks passed.`);
