/**
 * Anthropic BYOK adapter unit tests — request/response translation + routing.
 * Pure: no real key, no network.
 */
import assert from 'node:assert';
import { toAnthropicRequest, toOpenAIResponse } from './src/routers/anthropic-adapter.js';
import { resolveRoute } from './src/model-manager.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log('=== resolveRoute: claude now supported (BYOK) ===');
let r = resolveRoute('claude-3-5-sonnet', { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxxxxxx' });
ok(r.kind === 'byok' && r.provider === 'anthropic' && r.format === 'anthropic' && r.endpoint.includes('api.anthropic.com/v1/messages'),
   'claude + key → BYOK anthropic (/v1/messages, format=anthropic)');
r = resolveRoute('claude-3', {});
ok(r.kind === 'error' && r.provider === 'anthropic' && /not configured/i.test(r.reason),
   'claude + NO key → explicit error (not configured) — not a silent local sub');

console.log('\n=== request translation (OpenAI → Anthropic) ===');
const a = toAnthropicRequest({ model: 'claude-3-5-sonnet', messages: [
  { role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' }, { role: 'user', content: 'bye' }], temperature: 0.5 });
ok(a.system === 'be terse', 'system message extracted to top-level `system`');
ok(a.messages.length === 3 && a.messages.every((m) => m.role !== 'system'), 'system stripped from messages; user/assistant preserved in order');
ok(a.max_tokens === 1024, 'max_tokens defaulted (Anthropic requires it)');
ok(a.temperature === 0.5, 'temperature passed through');
const a2 = toAnthropicRequest({ model: 'claude-3', messages: [{ role: 'user', content: 'x' }], max_tokens: 50 });
ok(a2.max_tokens === 50 && !('system' in a2), 'explicit max_tokens honored; no `system` when none given');

console.log('\n=== response translation (Anthropic → OpenAI) ===');
const oa = toOpenAIResponse({ id: 'msg_1', model: 'claude-3-5-sonnet',
  content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }],
  stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }, 'claude-3');
ok(oa.object === 'chat.completion' && oa.choices[0].message.content === 'Hello world', 'content blocks joined into one assistant message');
ok(oa.choices[0].finish_reason === 'stop', 'stop_reason end_turn → finish_reason stop');
ok(oa.usage.prompt_tokens === 10 && oa.usage.completion_tokens === 5 && oa.usage.total_tokens === 15, 'usage mapped (input/output → prompt/completion/total)');
ok(toOpenAIResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' }, 'c').choices[0].finish_reason === 'length', 'stop_reason max_tokens → finish_reason length');

console.log(`\n✅ ALL ${pass} anthropic-adapter checks passed.`);
