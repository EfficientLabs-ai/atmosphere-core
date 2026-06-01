/**
 * compliance-router tests: deny-by-default permitting, cost/ToS approval gate (ask/auto-local/
 * always-spend), local-preference to save spend, and honoring/​rerouting an explicit paid model request.
 */
import assert from 'node:assert';
import { decideRoute } from './src/compliance-router.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

const BACKENDS = [
  { id: 'qwen-local', useClass: 'local', capabilities: ['simple', 'chat'] },
  { id: 'mesh-llama', useClass: 'mesh', capabilities: ['simple', 'chat', 'complex'] },
  { id: 'gpt-4o', useClass: 'byok-api', provider: 'openai', models: ['gpt-4o'], capabilities: ['simple', 'chat', 'complex', 'vision'], allowedTasks: ['complex', 'vision'] },
  { id: 'claude-code', useClass: 'frontier-tool', provider: 'anthropic', capabilities: ['complex', 'agentic'], allowedTasks: ['complex'] }, // NOT allowed for 'agentic'
];
const PROVIDERS = {
  openai: { name: 'OpenAI', estCostUsd: 0.03, tosNote: 'Billed per token under your OpenAI API agreement.' },
  anthropic: { name: 'Anthropic', estCostUsd: 0.05, tosNote: 'Used via the official tool interface.' },
};
const decide = (request, costApproval, saveApiSpend = true) => decideRoute({ request, policy: { costApproval, saveApiSpend }, backends: BACKENDS, providers: PROVIDERS });

console.log('=== free/local is preferred to save spend ===');
let d = decide({ taskClass: 'simple' }, 'ask');
ok(d.decision === 'route' && d.spend === false && ['qwen-local', 'mesh-llama'].includes(d.backend), 'a simple task → routed to a free local/mesh model, no spend');

console.log('\n=== deny-by-default for paid/subscription backends ===');
d = decide({ taskClass: 'agentic' }, 'always-spend');
ok(d.decision === 'denied', "an 'agentic' task is denied — claude-code is capable but NOT allow-listed for it (deny-by-default)");
d = decide({ taskClass: 'vision' }, 'always-spend');
ok(d.decision === 'route' && d.backend === 'gpt-4o' && d.spend === true, "a 'vision' task → gpt-4o (the only capable+permitted backend), spend acknowledged");

console.log('\n=== cost/ToS approval gate when only a PAID backend can do it ===');
d = decide({ taskClass: 'vision' }, 'ask');
ok(d.decision === 'approval-required' && d.wouldSpendOn === 'gpt-4o' && d.options.join() === 'proceed-spend', "ask + no local alternative → approval-required (proceed-or-cancel)");
ok(d.estCostUsd === 0.03 && /OpenAI API agreement/.test(d.tosNote), 'approval carries the provider cost estimate + ToS note');
d = decide({ taskClass: 'vision' }, 'auto-local');
ok(d.decision === 'route' && d.backend === 'gpt-4o' && /only because needed/.test(d.reason), "auto-local spends only because no local model can do 'vision'");

console.log('\n=== explicit paid-model request when a local CAN do it — the diversification choice ===');
d = decide({ taskClass: 'complex', model: 'gpt-4o' }, 'ask');
ok(d.decision === 'approval-required' && d.alternativeLocal === 'mesh-llama' && d.options.includes('reroute-local'), 'ask: a local can do it → offer reroute-to-local OR proceed-spend');
d = decide({ taskClass: 'complex', model: 'gpt-4o' }, 'auto-local');
ok(d.decision === 'route' && d.backend === 'mesh-llama' && d.rerouted === true && d.spend === false, 'auto-local: silently reroute the paid request to the capable local model (saves spend)');
d = decide({ taskClass: 'complex', model: 'gpt-4o' }, 'always-spend');
ok(d.decision === 'route' && d.backend === 'gpt-4o' && d.spend === true, 'always-spend: honor the explicit paid model request');

console.log('\n=== no capable backend at all ===');
ok(decideRoute({ request: { taskClass: 'quantum-telepathy' }, policy: {}, backends: BACKENDS, providers: PROVIDERS }).decision === 'denied', 'an unsupported task → denied');

console.log('\n=== default costApproval is the safe one (ask) ===');
d = decideRoute({ request: { taskClass: 'vision' }, policy: {}, backends: BACKENDS, providers: PROVIDERS });
ok(d.decision === 'approval-required', 'missing/invalid costApproval defaults to ask (never silently spends)');

console.log(`\n✅ ALL ${pass} compliance-router checks passed.`);
