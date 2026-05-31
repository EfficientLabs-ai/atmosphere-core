/**
 * Universal Model Manager unit tests — resolution + install-gated local selection.
 * Pure: injected env + injected hardware/install probe (no real keys, no real GPU/Ollama).
 */
import assert from 'node:assert';
import { resolveRoute, selectLocalModel } from './src/model-manager.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log('=== resolveRoute (capability map, explicit errors, no silent substitution) ===');
const withKeys = { OPENAI_API_KEY: 'sk-live-xxxxxxxxxxxx', GEMINI_API_KEY: 'AIza-xxxxxxxxxxxx' };
const noKeys = {};

let r = resolveRoute('gpt-4o', withKeys);
ok(r.kind === 'byok' && r.provider === 'openai' && r.endpoint.includes('api.openai.com'), 'gpt-* + key → BYOK OpenAI (official endpoint)');
r = resolveRoute('gpt-4o', noKeys);
ok(r.kind === 'error' && r.provider === 'openai' && r.status === 501, 'gpt-* + NO key → explicit error (no qwen substitution)');
r = resolveRoute('gemini-1.5-pro', withKeys);
ok(r.kind === 'byok' && r.provider === 'google', 'gemini-* + key → BYOK Google (OpenAI-compat endpoint)');
r = resolveRoute('claude-3-5-sonnet', { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxx' });
ok(r.kind === 'byok' && r.provider === 'anthropic' && r.format === 'anthropic', 'claude-* + key → BYOK anthropic (now supported via /v1/messages adapter)');
r = resolveRoute('claude-3-5-sonnet', noKeys);
ok(r.kind === 'error' && r.provider === 'anthropic', 'claude-* + no key → explicit error — NOT a silent local sub');
r = resolveRoute('qwen2.5:7b', noKeys);
ok(r.kind === 'local', 'qwen → local');
r = resolveRoute('local:gemma2:9b', noKeys);
ok(r.kind === 'local', 'local: prefix → forced local');
r = resolveRoute('some-random-model', noKeys);
ok(r.kind === 'local', 'unknown family → local (default)');
r = resolveRoute('gpt-4o', { BYOK_AUTO_LOCAL: '1' });
ok(r.kind === 'error' && r.allowAuto === true, 'no key + BYOK_AUTO_LOCAL=1 → error flagged allowAuto (opt-in fallback)');

console.log('\n=== selectLocalModel (install-gated, hardware-aware, honest concrete model) ===');
let s = await selectLocalModel({ requested: 'default', probe: { cap: { gb: 6, kind: 'ram' }, installed: ['qwen2.5:7b'] } });
ok(s.model === 'qwen2.5:7b', `6GB RAM, only qwen installed → ${s.model} (CPU-only reality)`);
s = await selectLocalModel({ requested: 'default', probe: { cap: { gb: 20, kind: 'vram' }, installed: ['qwen2.5:7b', 'gemma2:9b', 'gemma2:27b'] } });
ok(s.model === 'gemma2:27b', `20GB VRAM + 27b installed → ${s.model} (top tier)`);
s = await selectLocalModel({ requested: 'default', probe: { cap: { gb: 10, kind: 'vram' }, installed: ['qwen2.5:7b'] } });
ok(s.model === 'qwen2.5:7b', `10GB but gemma2:9b NOT pulled → falls back to installed ${s.model} (install-gated, no pretending)`);
s = await selectLocalModel({ requested: 'gemma2:9b', probe: { cap: { gb: 12, kind: 'vram' }, installed: ['qwen2.5:7b', 'gemma2:9b'] } });
ok(s.model === 'gemma2:9b', `explicitly-requested installed model honored → ${s.model}`);
s = await selectLocalModel({ requested: 'default', probe: { cap: { gb: 4, kind: 'ram' }, installed: [] } });
ok(s.model === 'qwen2.5:7b' && s.capacityKind === 'ram', 'nothing installed → configured default (honest fallback)');

console.log(`\n✅ ALL ${pass} model-manager checks passed.`);
