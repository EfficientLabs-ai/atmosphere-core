// test-stratos-route.mjs — `stratos route` previews the sovereign router faithfully:
// local by default, /private + /force-* honored, cloud only on opt-in (a configured key + hard prompt).
import assert from 'node:assert';

for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY']) delete process.env[k];
const { run } = await import('./src/cli/stratos-cli.js');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const text = (r) => r.lines.join('\n');
const deps = { version: '0.0.0-test' };
// difficulty >=4: long (>1200 chars → +2) + reasoning keywords (+2)
const HARD = 'architect, derive and prove the optimal distributed consensus algorithm and reason through every step in detail '.repeat(13);

console.log('stratos route — preview the sovereign routing decision\n');

let r = await run(['route', 'say', 'hi'], deps);
ok(r.code === 0 && /LOCAL/.test(text(r)), 'casual prompt → LOCAL (sovereign default)');
ok(/key:.*none/s.test(text(r).replace(/\x1b\[[0-9;]*m/g, '')), 'context shows no key configured');

r = await run(['route', HARD], deps);
ok(/LOCAL/.test(text(r)), 'hard prompt with NO key → still LOCAL');

r = await run(['route', '--key', HARD], deps);
ok(/CLOUD/.test(text(r)), 'hard prompt WITH --key → CLOUD (opt-in escalation)');
ok(/4\/5|5\/5/.test(text(r)), 'difficulty shown (>=4) for the hard prompt');

r = await run(['route', '--key', '--private', HARD], deps);
ok(/LOCAL/.test(text(r)) && /private:.*on/s.test(text(r).replace(/\x1b\[[0-9;]*m/g, '')), '--private pins LOCAL even with a key');

r = await run(['route', '--mesh', HARD], deps);
ok(/MESH/.test(text(r)), 'heavy prompt + --mesh → MESH (your hardware)');

r = await run(['route', '/force-cloud', 'do', 'it'], deps);
ok(/CLOUD/.test(text(r)) && /directive/.test(text(r)), '/force-cloud directive → CLOUD');

r = await run(['route', '/force-local', HARD], deps);
ok(/LOCAL/.test(text(r)) && /directive/.test(text(r)), '/force-local directive → LOCAL even for a hard prompt');

r = await run(['route'], deps);
ok(r.code === 1 && /usage/.test(text(r)), 'no prompt → usage (code 1)');

r = await run(['route', 'easy one'], deps);
ok(/never silently/.test(text(r)), 'local decision explains cloud is never silent');

console.log(`\n✅ ${pass}/${pass} — route preview is faithful to the live path; cloud never silent.`);
