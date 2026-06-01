/**
 * compliance-gateway tests: build backends from wizard config, classify tasks, plan the route, and the
 * express approval gate (402 only on approval-required, honors overrides, no-op for legacy/unconfigured).
 */
import assert from 'node:assert';
import { buildBackends, classifyTask, planComplianceRoute, complianceApprovalGate } from './src/compliance-gateway.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log('=== buildBackends from configured model sources ===');
const ms = { local: { enabled: true, name: 'qwen2.5:7b' }, providers: { anthropic: { keyHandle: 'cvault:x' } } };
let bs = buildBackends(ms, {});
ok(bs.some((b) => b.useClass === 'local') && bs.some((b) => b.id === 'anthropic' && b.useClass === 'byok-api'), 'local + a vault-configured provider become backends');
ok(buildBackends({ local: { enabled: true } }, { OPENAI_API_KEY: 'sk' }).some((b) => b.id === 'openai'), 'a provider with an env key (legacy BYOK) is included too');
ok(!buildBackends({ local: { enabled: true } }, {}).some((b) => b.useClass === 'byok-api'), 'a provider with NO key is excluded');

console.log('\n=== classifyTask ===');
ok(classifyTask([{ role: 'user', content: 'hi there' }]) === 'simple', 'short chat → simple');
ok(classifyTask([{ role: 'user', content: 'write a python ```def f()``` ' }]) === 'complex', 'code → complex');
ok(classifyTask([{ role: 'user', content: [{ type: 'image_url' }, { type: 'text', text: 'what is this' }] }]) === 'vision', 'image content → vision');

console.log('\n=== planComplianceRoute: cost gate driven by costApproval ===');
const cfg = { modelSources: ms, env: {} };
let p = planComplianceRoute({ messages: [{ role: 'user', content: 'hi' }] }, { ...cfg, routing: { costApproval: 'ask', saveApiSpend: true } });
ok(p.decision === 'route' && p.useClass === 'local', 'a simple task → routed local, no spend (saves money)');
p = planComplianceRoute({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-3-5-sonnet' }, { ...cfg, routing: { costApproval: 'ask' } });
ok(p.decision === 'approval-required' && p.options.includes('proceed-spend'), 'an explicit paid-model request in ask mode → approval-required');
p = planComplianceRoute({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-3-5-sonnet' }, { ...cfg, routing: { costApproval: 'ask' }, override: 'proceed-spend' });
ok(p.decision === 'route' && p.spend === true && p.viaApproval, 'override proceed-spend → routes the paid backend');
p = planComplianceRoute({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-3-5-sonnet' }, { ...cfg, routing: { costApproval: 'ask' }, override: 'reroute-local' });
ok(p.decision === 'route' && p.useClass === 'local' && p.spend === false, 'override reroute-local → routes the free local model');
p = planComplianceRoute({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-3-5-sonnet' }, { ...cfg, routing: { costApproval: 'always-spend' } });
ok(p.decision === 'route' && p.spend === true, 'always-spend → no approval, just routes the paid model');

console.log('\n=== complianceApprovalGate (express) ===');
const fakeConfig = (configured, routing, modelSources) => ({ getConfig: () => ({ configured }), getRouting: () => routing, getModelSources: () => modelSources });
const mkRes = () => { const r = { _code: 200, _json: null, status(c) { this._code = c; return this; }, json(j) { this._json = j; return this; } }; return r; };

let res = mkRes();
ok(complianceApprovalGate({ headers: {}, body: { messages: [{ role: 'user', content: 'hi' }], model: 'claude-3-5-sonnet' } }, res, { config: fakeConfig(false, { costApproval: 'ask' }, ms) }) === false, 'UNCONFIGURED agent → gate is a no-op (legacy behavior preserved)');

res = mkRes();
const handled = complianceApprovalGate({ headers: {}, body: { messages: [{ role: 'user', content: 'hi' }], model: 'claude-3-5-sonnet' } }, res, { config: fakeConfig(true, { costApproval: 'ask' }, ms) });
ok(handled === true && res._code === 402 && res._json.error === 'approval_required', 'configured + ask + paid request → 402 approval-required');
ok(res._json.estCostUsd != null && /reroute-local|proceed-spend/.test(res._json.options.join()), 'the 402 carries the cost estimate + the options to reply with');

res = mkRes();
ok(complianceApprovalGate({ headers: { 'x-stratos-route': 'proceed-spend' }, body: { messages: [{ role: 'user', content: 'hi' }], model: 'claude-3-5-sonnet' } }, res, { config: fakeConfig(true, { costApproval: 'ask' }, ms) }) === false, 'a proceed-spend override → gate lets it through to spend');

res = mkRes();
const reqLocal = { headers: { 'x-stratos-route': 'reroute-local' }, body: { messages: [{ role: 'user', content: 'hi' }], model: 'claude-3-5-sonnet' } };
ok(complianceApprovalGate(reqLocal, res, { config: fakeConfig(true, { costApproval: 'ask' }, ms) }) === false && reqLocal.body.model === 'qwen2.5:7b', 'a reroute-local override → gate rewrites the model to local + continues');

res = mkRes();
ok(complianceApprovalGate({ headers: {}, body: { messages: [{ role: 'user', content: 'hi' }] } }, res, { config: fakeConfig(true, { costApproval: 'always-spend' }, ms) }) === false, 'always-spend mode → gate never intercepts');

console.log(`\n✅ ALL ${pass} compliance-gateway checks passed.`);
