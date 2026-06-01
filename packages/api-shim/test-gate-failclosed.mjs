/**
 * Gate fail-closed hardening (Codex reviews of PR #41 + #45). When the compliance gate THROWS (can't be
 * evaluated), failClosedOnGateError must block exactly the requests that would SPEND on a paid external
 * API — and only those. "Would spend" is defined by the router itself: resolveRoute(model).kind==='byok'
 * (a provider matched AND its key is configured). Local / no-key / unknown do not spend → they proceed.
 *
 * This is the precise, router-consistent definition that supersedes the earlier providerForModel /
 * isProvablyLocalModel heuristics, which couldn't match the router's case-sensitive, env-flag behavior.
 */
import assert from 'node:assert';

// Configure provider keys so paid models resolve to BYOK ("would spend"). Set BEFORE importing the server.
process.env.OPENAI_API_KEY = 'sk-openai-test-key-1234567890';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-1234567890';
process.env.GEMINI_API_KEY = 'gm-test-key-1234567890';
process.env.OPENROUTER_API_KEY = 'or-test-key-1234567890';
delete process.env.STRATOS_FORCE_LOCAL;

const { failClosedOnGateError } = await import('./server.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const mockRes = () => { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const block = (model) => { const res = mockRes(); const b = failClosedOnGateError({ body: { model } }, res); return { blocked: b, code: res.code, body: res.body }; };

console.log('=== paid providers WITH a key configured → BLOCKED (a real BYOK spend) ===');
for (const model of ['gpt-4o', 'o3-mini', 'claude-3-5-sonnet-20241022', 'gemini-2.0-flash']) {
  const r = block(model);
  ok(r.blocked === true && r.code === 402 && r.body?.error === 'approval_required', `${model} → 402 blocked`);
}

console.log('\n=== paid OpenRouter slugs (vendor matches a local family) → BLOCKED (Codex #45) ===');
for (const model of ['deepseek/deepseek-chat', 'qwen/qwen-2.5-72b-instruct', 'mistralai/mistral-large', 'meta-llama/llama-3-70b']) {
  const r = block(model);
  ok(r.blocked === true && r.code === 402, `${model} (OpenRouter byok) → 402 blocked`);
}

console.log('\n=== a paid model with NO key configured does NOT spend → proceeds ===');
{
  delete process.env.OPENAI_API_KEY;
  const r = block('gpt-4o');
  ok(r.blocked === false && r.code === null, 'gpt-4o with no OPENAI_API_KEY → resolveRoute=error (no spend possible) → proceeds');
  process.env.OPENAI_API_KEY = 'sk-openai-test-key-1234567890';
}

console.log('\n=== local + bare local-family names route local (no spend) → PROCEED, no false block (Codex #45) ===');
for (const model of ['qwen2.5:7b', 'QWEN2.5:7B', 'llama3', 'local', 'local:gemma2', 'mistral-large', 'gemma2:9b', 'phi3', 'deepseek-r1']) {
  const r = block(model);
  ok(r.blocked === false && r.code === null, `${model} → not blocked (resolveRoute=local, never spends)`);
}

console.log('\n=== a missing/empty model resolves local (no provider) → proceeds ===');
for (const body of [{ model: '' }, {}, { model: null }]) {
  const res = mockRes();
  const b = failClosedOnGateError({ body }, res);
  ok(b === false, `empty/missing model (${JSON.stringify(body)}) → proceeds (no paid route to spend on)`);
}

console.log(`\n✅ ALL ${pass} gate-failclosed checks passed.`);
