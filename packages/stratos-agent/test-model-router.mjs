// test-model-router.mjs — one simple router: local default, privacy-forced-local, cloud opt-in only.
import assert from 'node:assert';
import { route, difficulty, TIERS } from './src/routing/model-router.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };

console.log('model router — sovereign default, cloud never silent\n');

ok('difficulty is a monotonic-ish 0–5 heuristic', () => {
  assert.ok(difficulty('hi') < difficulty('refactor this algorithm step by step: ```code```'));
  assert.ok(difficulty('x'.repeat(2000)) >= 2);
  assert.ok(difficulty('') === 0 && difficulty('a'.repeat(5000)) <= 5);
});

ok('DEFAULT (no flags) is always local — never cloud', () => {
  const easy = route({ prompt: 'say hi' });
  const hard = route({ prompt: 'derive and prove the optimal algorithm, step by step '.repeat(40) });
  assert.strictEqual(easy.cloud, false);
  assert.strictEqual(hard.cloud, false);          // hard but no opt-in → still local
  assert.strictEqual(easy.tier, 'local-fast');
  assert.strictEqual(hard.tier, 'local-strong');
});

ok('PRIVACY forces local even for hard asks and even with escalate + key', () => {
  const r = route({ prompt: 'prove this complex theorem '.repeat(50), private: true, escalate: true }, { hasFrontierKey: true, meshAvailable: true });
  assert.strictEqual(r.cloud, false);
  assert.ok(r.tier.startsWith('local'));          // not mesh, not frontier
});

ok('CLOUD is opt-in only — needs escalate AND key AND difficulty', () => {
  const base = { prompt: 'architect and prove the optimal distributed algorithm, reason through every step '.repeat(20), escalate: true };
  assert.strictEqual(route(base, { hasFrontierKey: false }).cloud, false);        // no key → local
  assert.strictEqual(route({ ...base, escalate: false }, { hasFrontierKey: true }).cloud, false); // no flag → local
  assert.strictEqual(route({ prompt: 'hi', escalate: true }, { hasFrontierKey: true }).cloud, false); // easy → local
  const yes = route(base, { hasFrontierKey: true });
  assert.strictEqual(yes.cloud, true);            // all three present → frontier
  assert.strictEqual(yes.tier, 'frontier');
});

ok('explicit cloud model is honored (opt-in) — unless privacy overrides', () => {
  assert.deepStrictEqual(route({ prompt: 'x', model: 'claude-opus' }).cloud, true);
  assert.deepStrictEqual(route({ prompt: 'x', model: 'deepseek/deepseek-chat' }).cloud, true);
  assert.strictEqual(route({ prompt: 'x', model: 'claude-opus', private: true }).cloud, false); // privacy wins
  assert.strictEqual(route({ prompt: 'x', model: 'qwen2.5:7b' }).cloud, false);                  // local family
});

ok('heavy work routes to the mesh (your hardware) when available', () => {
  const r = route({ prompt: 'optimize this huge algorithm '.repeat(60) }, { meshAvailable: true });
  assert.strictEqual(r.tier, 'mesh');
  assert.strictEqual(r.cloud, false);
});

ok('every route is one of the declared tiers + carries an honest reason', () => {
  for (const req of [{ prompt: 'a' }, { prompt: 'b', private: true }, { prompt: 'c', model: 'gpt-5' }]) {
    const r = route(req, {});
    assert.ok(TIERS.includes(r.tier) && typeof r.reason === 'string' && r.reason.length);
  }
});

console.log(`\n✅ ${pass}/${pass} model-router tests passed — local by default, cloud never silent.`);
