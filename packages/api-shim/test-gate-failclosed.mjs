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

console.log('\n=== paid OpenRouter slugs whose VENDOR matches a local family are still BLOCKED (Codex #45 finding) ===');
// deepseek/deepseek-chat, qwen/qwen-2.5-72b, mistralai/mistral-large used to force-local (the vendor
// prefix matched the local-family regex) → providerForModel null → the gate let them through. They are
// PAID OpenRouter slugs and must block.
for (const model of ['deepseek/deepseek-chat', 'qwen/qwen-2.5-72b-instruct', 'mistralai/mistral-large']) {
  const res = mockRes();
  const blocked = failClosedOnGateError({ body: { model } }, res);
  ok(blocked === true && res.code === 402, `${model} (OpenRouter slug) → 402 blocked, not misrouted to local`);
}

console.log('\n=== a PROVABLY-local model (matches the router\'s own heuristic) PROCEEDS — no false block ===');
for (const model of ['qwen2.5:7b', 'llama3', 'local', 'local:gemma2', 'my-quantized-model']) {
  const res = mockRes();
  const blocked = failClosedOnGateError({ body: { model } }, res);
  ok(blocked === false && res.code === null, `${model} → not blocked (routes local)`);
}

console.log('\n=== bare local-FAMILY names the router does NOT route local are BLOCKED (Codex #45 second finding) ===');
// isForcedLocal treats these as "local family", but the routing heuristic (local|quantized|qwen|llama)
// does NOT send them to local inference → they would fall through to the proxy. The gate must block them.
for (const model of ['mistral-large', 'gemma2:9b', 'phi3', 'deepseek-r1']) {
  const res = mockRes();
  const blocked = failClosedOnGateError({ body: { model } }, res);
  ok(blocked === true && res.code === 402, `${model} (family name, not provably-local) → 402 blocked`);
}

console.log('\n=== a missing/empty model is BLOCKED (fail-closed — not provably local) ===');
for (const body of [{ model: '' }, {}, { model: null }]) {
  const res = mockRes();
  const blocked = failClosedOnGateError({ body }, res);
  ok(blocked === true && res.code === 402, `empty/missing model (${JSON.stringify(body)}) → 402 blocked (fail-closed)`);
}

console.log(`\n✅ ALL ${pass} gate-failclosed checks passed.`);
