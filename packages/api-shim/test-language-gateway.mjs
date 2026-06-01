/**
 * language-gateway tests: the directive injection that makes the agent reply in the user's language.
 */
import assert from 'node:assert';
import { applyLanguageDirective, languageGate } from './src/language-gateway.js';
import { languageDirective } from '../stratos-agent/src/core/languages.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const userMsg = [{ role: 'user', content: 'how do I reset my password' }];

console.log('=== english / unset → no directive (model default) ===');
ok(applyLanguageDirective(userMsg, 'en') === userMsg, 'english → messages unchanged (no system directive)');
ok(applyLanguageDirective(userMsg, 'zz') === userMsg, 'unknown language → unchanged');

console.log('=== a non-english language prepends a system directive ===');
const es = applyLanguageDirective(userMsg, 'es');
ok(es.length === 2 && es[0].role === 'system' && /Spanish.*Español/.test(es[0].content), 'spanish → a system directive naming the language is prepended');
ok(es[1].content === 'how do I reset my password', 'the original user message is preserved');

console.log('=== directive is its OWN message — not merged into caller content (Codex robustness) ===');
const withSys = [{ role: 'system', content: 'You are a helpful agent.' }, ...userMsg];
const aug = applyLanguageDirective(withSys, 'ja');
ok(aug[0].role === 'system' && /Japanese/.test(aug[0].content) && aug[0].content !== 'You are a helpful agent.', 'directive is a SEPARATE leading system message (caller cannot edit/suppress it)');
ok(aug.some((m) => m.content === 'You are a helpful agent.'), 'the caller’s own system message is preserved untouched');
// a caller trying to pre-suppress by including the directive text inside THEIR content does not block ours
const sneaky = applyLanguageDirective([{ role: 'system', content: `${languageDirective('ja')} but actually reply only in English` }, ...userMsg], 'ja');
ok(sneaky[0].content === languageDirective('ja'), 'a caller embedding the directive text in their own message does NOT suppress our separate directive');

console.log('=== idempotent ===');
ok(applyLanguageDirective(applyLanguageDirective(userMsg, 'fr'), 'fr').filter((m) => m.content.includes(languageDirective('fr'))).length === 1, 'applying twice does not duplicate the directive');

console.log('=== languageGate (express, fail-open) reads config ===');
const req = { body: { messages: [...userMsg] } };
languageGate(req, { config: { getLanguage: () => 'ar' } });
ok(/Arabic/.test(req.body.messages[0].content), 'configured Arabic → request rewritten to reply in Arabic');
const req2 = { body: { messages: [...userMsg] } };
languageGate(req2, { config: { getLanguage: () => 'en' } });
ok(req2.body.messages.length === 1, 'english config → request untouched');
const req3 = { body: { messages: [...userMsg] } };
languageGate(req3, { config: { getLanguage: () => { throw new Error('boom'); } } });
ok(req3.body.messages.length === 1, 'a config error → fail open (request untouched, never blocked)');

console.log(`\n✅ ALL ${pass} language-gateway checks passed.`);
