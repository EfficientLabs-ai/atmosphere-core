/**
 * wizard brain tests: live model/key validation (injectable), applyWizard → config (routing + mesh),
 * cost-approval validation, and the honest privacy posture.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// isolate config in a temp cwd BEFORE import (agent-config resolves off process.cwd())
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-')));
const { validateModelChoice, applyWizard, privacyPosture, MODEL_SOURCES, multiSelectReduce, resolveProviderKeysToEnv } = await import('./src/cli/wizard.js');
const config = await import('./src/core/agent-config.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const probesWith = (reachable, models) => ({ probeOllama: async () => ({ reachable, models }) });

console.log('=== live model validation (local) ===');
ok((await validateModelChoice({ provider: 'local', model: 'qwen2.5:7b' }, { probes: probesWith(true, ['qwen2.5:7b']) })).ok === true, 'installed local model → ready');
const notPulled = await validateModelChoice({ provider: 'local', model: 'llama3:8b' }, { probes: probesWith(true, ['qwen2.5:7b']) });
ok(notPulled.ok === false && /ollama pull/.test(notPulled.fix), 'missing local model → not-pulled + a real fix command');
ok((await validateModelChoice({ provider: 'local', model: 'qwen2.5:7b' }, { probes: probesWith(false, []) })).state === 'ollama-down', 'Ollama down → honest ollama-down state');
ok((await validateModelChoice({ provider: 'local', model: 'gpt-4o' }, { probes: probesWith(true, []) })).state === 'invalid', 'a non-local model name under local → invalid');

console.log('\n=== live key validation (BYOK cloud) — never reads/stores the key ===');
ok((await validateModelChoice({ provider: 'openai' }, { env: { OPENAI_API_KEY: 'sk-x' } })).ok === true, 'present BYOK key → ok');
const noKey = await validateModelChoice({ provider: 'anthropic' }, { env: {} });
ok(noKey.ok === false && /ANTHROPIC_API_KEY/.test(noKey.fix), 'missing key → no-key + the exact env var to set');

console.log('\n=== applyWizard → config (name, local model, routing, mesh) ===');
const cfg = applyWizard({ agentName: 'Aurora', provider: 'local', localModel: 'qwen2.5:7b', saveApiSpend: true, costApproval: 'auto-local', meshEnroll: true }, config);
ok(cfg.agentName === 'Aurora' && cfg.model.name === 'qwen2.5:7b', 'name + local model applied');
ok(cfg.routing.saveApiSpend === true && cfg.routing.costApproval === 'auto-local', 'routing prefs applied');
ok(cfg.meshOptIn === true && cfg.configured === true, 'mesh opt-in + configured flag set');

console.log('\n=== cost-approval mode is validated ===');
let threw = false; try { config.setRouting({ costApproval: 'spend-everything-lol' }); } catch { threw = true; }
ok(threw, 'an invalid costApproval mode is rejected');
ok(config.getRouting().costApproval === 'auto-local', 'the previous valid mode is unchanged after a rejected write');

console.log('\n=== honest privacy posture ===');
ok(privacyPosture('local').private === true, 'local brain → private');
ok(privacyPosture('openai').private === false && /THEIR terms/.test(privacyPosture('openai').note), 'cloud brain → not blanket-private, stated plainly');

console.log('\n=== model-source catalog has no "cloud" jargon + a free local option ===');
ok(MODEL_SOURCES.some((s) => s.value === 'local' && /free/.test(s.hint)), 'local source is present + labelled free');
ok(MODEL_SOURCES.filter((s) => s.kind === 'provider').length >= 3, 'multiple named providers offered');
ok(!JSON.stringify(MODEL_SOURCES).toLowerCase().includes('cloud'), 'no "cloud" wording anywhere in the source list');

console.log('\n=== multi-select reducer: navigate + toggle ===');
let st = { index: 0, selected: new Set(), count: MODEL_SOURCES.length };
st = multiSelectReduce(st, 'down'); ok(st.index === 1, '↓ moves the cursor');
st = multiSelectReduce(st, 'space'); ok(st.selected.has(1), 'space toggles the current item ON');
st = multiSelectReduce(st, 'space'); ok(!st.selected.has(1), 'space again toggles it OFF');
st = multiSelectReduce({ index: 0, selected: new Set(), count: 3 }, 'up'); ok(st.index === 2, '↑ wraps to the end');

console.log('\n=== enabling providers stores ONLY a vault handle in config (key stays in the vault) ===');
config.setLocalSource({ enabled: true, name: 'qwen2.5:7b' });
config.enableProvider('anthropic', 'cvault:anthropic:api-key:' + 'a'.repeat(32));
const ms = config.getModelSources();
ok(ms.local.enabled && ms.providers.anthropic.keyHandle.startsWith('cvault:'), 'local enabled + anthropic provider holds a vault handle');
ok(!JSON.stringify(ms).includes('sk-'), 'no raw API key material in the model-sources config');

console.log('\n=== resolveProviderKeysToEnv: vault handle → PROVIDER_API_KEY at runtime ===');
const fakeVault = { resolveSecret: (h) => (h === 'cvault:anthropic:api-key:' + 'a'.repeat(32) ? 'sk-ant-REAL' : null) };
const env = {};
const wired = resolveProviderKeysToEnv(config, fakeVault, env);
ok(wired.includes('anthropic') && env.ANTHROPIC_API_KEY === 'sk-ant-REAL', 'the encrypted key is resolved into ANTHROPIC_API_KEY for the gateway');
config.disableProvider('anthropic');
ok(!config.getModelSources().providers.anthropic, 'disableProvider removes the entry');

console.log(`\n✅ ALL ${pass} wizard-brain checks passed.`);
