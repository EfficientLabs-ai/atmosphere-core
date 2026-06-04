// test-classify-live.mjs — the live request-path router (TaskClassifierRouter) now delegates to the
// ONE sovereign model router. Proves the silent-cloud-default is gone: local by default, cloud opt-in.
import assert from 'node:assert';
import { TaskClassifierRouter } from './src/task-router.js';

for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY']) delete process.env[k];

const r = new TaskClassifierRouter({ verbose: false });
const msg = (t) => [{ role: 'user', content: t }];
// difficulty >=4: long (>1200 chars → +2) + reasoning keywords (+2)
const HARD = 'architect, derive and prove the optimal distributed consensus algorithm and reason through every step in detail '.repeat(15);

let n = 0;
const ok = (name, c) => { assert.ok(c, name); console.log('  ✓ ' + name); n++; };

console.log('live classify() — sovereign default, cloud never silent\n');

const easy = await r.classify(msg('hey, say hi'));
ok('casual prompt → local (NOT silent cloud — the old default-to-cloud bug)', easy.decision === 'local');
ok('hard prompt with NO key → still local (sovereign)', (await r.classify(msg(HARD))).decision === 'local');

process.env.OPENAI_API_KEY = 'sk-test';
ok('hard prompt WITH a key configured → opt-in cloud escalation', (await r.classify(msg(HARD))).decision === 'cloud');
delete process.env.OPENAI_API_KEY;

ok('/force-local directive honored', (await r.classify(msg('/force-local do this'))).decision === 'local');
ok('/force-cloud directive honored (explicit opt-in)', (await r.classify(msg('/force-cloud do this'))).decision === 'cloud');

process.env.OPENAI_API_KEY = 'sk'; const privd = await r.classify(msg('/private ' + HARD)); delete process.env.OPENAI_API_KEY;
ok('/private pins to local even with a key + hard prompt', privd.decision === 'local');

ok('explicit local model → local', (await r.classify(msg('hello'), 'qwen2.5:7b')).decision === 'local');
ok('every decision carries reason + targetModel', !!easy.reason && !!easy.targetModel);

console.log(`\n✅ ${n}/${n} — router LIVE in the request path; sovereign default restored.`);
