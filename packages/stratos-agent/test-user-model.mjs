/**
 * test-user-model.mjs — DIALECTIC user-modeling (hermetic: no network, no Ollama, mocked summarizer).
 *
 * Covers the full observe → synthesize → inject → forget cycle plus the safety properties the red-team
 * cares about:
 *   - observe() accrues lightweight observations (append-only; assistant turns skipped).
 *   - synthesize() DISTILLS the observations via an INJECTED summarizer (the only "model" touched) and
 *     SUPERSEDES the prior model (dialectic: revise, not append) — the latest theory replaces the old.
 *   - getUserContext() returns the current capped summary string for prompt injection (length cap honored).
 *   - STRICT per-conversation ISOLATION: conv A's model never appears for conv B (context-bleed guard).
 *   - FAIL-OPEN: a broken store / throwing summarizer never crashes — methods degrade to safe no-ops.
 *   - forget() clears observations AND the synthesized model.
 *   - the `stratos user` CLI is capability-gated (deny-by-default), shows/forgets, and degrades honestly.
 *
 * Uses an in-memory SQLite db (':memory:') so it is fully self-contained and leaves no artifacts.
 */
import assert from 'node:assert';
import {
  initUserModel, observe, synthesize, getUserContext, forget, modelInfo,
  observationCount, shouldSynthesize, available, unavailableReason, closeUserModel,
} from './src/memory/user-model.js';
import { run } from './src/cli/stratos-cli.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); pass++; };

console.log('user-model — sovereign dialectic theory of the user\n');

const init = await initUserModel({ dbPath: ':memory:' });

if (!init.available) {
  // Honest-degrade branch is itself tested: every method is a safe no-op, never a throw.
  console.log(`  (user-model store unavailable: ${init.reason}) — asserting honest degrade`);
  ok('degraded: observe/getUserContext/forget are safe no-ops, never throw', () => {
    assert.strictEqual(observe('c', { content: 'hi' }), false);
    assert.strictEqual(getUserContext('c'), '');
    assert.strictEqual(forget('c'), false);
    assert.strictEqual(available(), false);
    assert.ok(typeof unavailableReason() === 'string' && unavailableReason().length > 0);
  });
  await okAsync('degraded: synthesize returns null model, never throws', async () => {
    const out = await synthesize('c', { summarizer: () => 'x' });
    assert.strictEqual(out.model, null);
    assert.strictEqual(out.synthesized, false);
  });
} else {
  const A = 'tg:alice', B = 'tg:bob';

  ok('observe accrues user observations (append-only); assistant turns are skipped', () => {
    assert.strictEqual(observe(A, { role: 'user', content: 'I prefer concise answers, no fluff', ts: 1000 }), true);
    assert.strictEqual(observe(A, { role: 'user', content: 'My goal this quarter is to ship the sovereign mesh', ts: 1001 }), true);
    // Assistant turn must NOT shape the theory of the USER:
    assert.strictEqual(observe(A, { role: 'assistant', content: 'Sure, here is a verbose essay', ts: 1002 }), false);
    // Blank/garbage is skipped, never throws:
    assert.strictEqual(observe(A, { role: 'user', content: '   ' }), false);
    assert.strictEqual(observe(A, null), false);
    assert.strictEqual(observationCount(A), 2, 'only the two real user turns were stored');
  });

  ok('observations stay strictly per-conversation', () => {
    assert.strictEqual(observe(B, { role: 'user', content: 'I love long detailed walkthroughs and pricing tables', ts: 2000 }), true);
    assert.strictEqual(observationCount(A), 2);
    assert.strictEqual(observationCount(B), 1);
  });

  await okAsync('synthesize DISTILLS via the INJECTED summarizer (no network)', async () => {
    let sawObs = null, sawPrior = null;
    const summarizer = ({ observations, priorModel }) => {
      sawObs = observations; sawPrior = priorModel;
      return '- seems to prefer concise answers\n- goal: ship the sovereign mesh';
    };
    const out = await synthesize(A, { summarizer });
    assert.ok(out.synthesized, 'synthesis happened');
    assert.ok(Array.isArray(sawObs) && sawObs.length === 2, 'summarizer received the observations');
    assert.strictEqual(sawPrior, null, 'first synthesis has no prior model');
    assert.ok(out.model.includes('concise'));
    // The theory is now retrievable for injection:
    assert.ok(getUserContext(A).includes('sovereign mesh'));
  });

  await okAsync('synthesize SUPERSEDES the prior model (dialectic: revise, not append)', async () => {
    const before = getUserContext(A);
    observe(A, { role: 'user', content: 'actually I now want detailed step-by-step plans', ts: 1003 });
    let sawPrior = null;
    const out = await synthesize(A, {
      summarizer: ({ priorModel }) => { sawPrior = priorModel; return '- now prefers detailed step-by-step plans'; },
    });
    assert.ok(out.synthesized);
    assert.ok(sawPrior && sawPrior.includes('concise'), 'the prior theory was handed to the summarizer for revision');
    const after = getUserContext(A);
    assert.notStrictEqual(before, after, 'the model was replaced, not appended to');
    assert.ok(after.includes('step-by-step'));
    assert.ok(!after.includes('concise'), 'the superseded theory is gone (not a growing fact-pile)');
    assert.strictEqual(modelInfo(A).exists, true);
  });

  ok('getUserContext respects the length cap (never balloons the prompt)', () => {
    const capped = getUserContext(A, { maxChars: 12 });
    assert.ok(capped.length <= 12, `capped to <=12 chars, got ${capped.length}`);
    assert.strictEqual(getUserContext(A, { maxChars: 0 }), '', 'maxChars 0 yields empty');
  });

  await okAsync('STRICT per-conversation ISOLATION: conv A theory never appears for conv B', async () => {
    await synthesize(B, { summarizer: () => '- seems to love long detailed walkthroughs' });
    const ctxA = getUserContext(A);
    const ctxB = getUserContext(B);
    assert.ok(ctxA.includes('step-by-step'), 'A has A theory');
    assert.ok(ctxB.includes('walkthroughs'), 'B has B theory');
    assert.ok(!ctxB.includes('step-by-step'), 'B never sees A theory');
    assert.ok(!ctxA.includes('walkthroughs'), 'A never sees B theory');
    // An unknown conversation has NO context (no fallback / no bleed):
    assert.strictEqual(getUserContext('tg:stranger'), '');
  });

  await okAsync('FAIL-OPEN: a throwing summarizer keeps the prior model, never throws', async () => {
    const prior = getUserContext(A);
    const out = await synthesize(A, { summarizer: () => { throw new Error('model down'); } });
    assert.strictEqual(out.synthesized, false);
    assert.ok(/summarizer failed/.test(out.reason));
    assert.strictEqual(getUserContext(A), prior, 'prior theory preserved (not wiped by a failed synthesis)');
  });

  await okAsync('FAIL-OPEN: no summarizer wired → keeps prior, honest reason, no fabrication', async () => {
    const out = await synthesize(A, {});
    assert.strictEqual(out.synthesized, false);
    assert.ok(/no summarizer/.test(out.reason));
  });

  ok('shouldSynthesize gates the cadence (sparse synthesis, not every turn)', () => {
    // Fresh conversation: false until at least one observation; once a model exists, requires N new obs.
    assert.strictEqual(shouldSynthesize('tg:fresh'), false);
    observe('tg:fresh', { role: 'user', content: 'hello there', ts: 5000 });
    assert.strictEqual(shouldSynthesize('tg:fresh', { every: 8 }), true, 'never-synthesized + has obs → synthesize');
  });

  ok('forget clears observations AND the synthesized model', () => {
    assert.strictEqual(forget(A), true);
    assert.strictEqual(observationCount(A), 0);
    assert.strictEqual(getUserContext(A), '');
    assert.strictEqual(modelInfo(A).exists, false);
    // B is untouched by forgetting A (isolation holds through forget too):
    assert.ok(getUserContext(B).includes('walkthroughs'));
  });
}

// ── CLI surface: capability-gated (deny-by-default) + show/forget + honest degrade ──────────────
const umStub = {
  initUserModel: async () => ({ available: true }),
  available: () => true,
  unavailableReason: () => null,
  _wiped: false,
  modelInfo: (cid) => (cid === 'tg:alice'
    ? { exists: true, summary: '- seems to prefer concise answers', synthesizedAt: 1700000000000, observations: 4 }
    : { exists: false, observations: 0 }),
  forget: function (cid) { this._wiped = cid; return cid === 'tg:alice'; },
};

await okAsync('CLI: `user show <cid>` prints the synthesized theory via injected store', async () => {
  const r = await run(['user', 'show', 'tg:alice'], { userModel: umStub });
  assert.strictEqual(r.code, 0);
  const out = r.lines.join('\n');
  assert.ok(/concise answers/.test(out), 'prints the theory');
  assert.ok(/revisable/.test(out), 'labels it a revisable theory, not asserted fact');
});

await okAsync('CLI: `user show` on an unknown conversation says no theory yet (no fabrication)', async () => {
  const r = await run(['user', 'show', 'tg:nobody'], { userModel: umStub });
  assert.strictEqual(r.code, 0);
  assert.ok(/No synthesized theory yet/.test(r.lines.join('\n')));
});

await okAsync('CLI: `user forget <cid>` wipes via injected store', async () => {
  const r = await run(['user', 'forget', 'tg:alice'], { userModel: umStub });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(umStub._wiped, 'tg:alice', 'forget reached the store');
  assert.ok(/forgot the theory/.test(r.lines.join('\n')));
});

await okAsync('CLI: capability gate DENIES show when user.read not declared', async () => {
  const denied = { compute: false, actions: ['click'], net: [], fs: [], secrets: [] };
  const r = await run(['user', 'show', 'tg:alice'], { userModel: umStub, userCaps: denied });
  assert.strictEqual(r.code, 1);
  assert.ok(/CAPABILITY DENIED/.test(r.lines.join('\n')));
});

await okAsync('CLI: capability gate DENIES forget when user.forget not declared', async () => {
  const denied = { compute: false, actions: ['user.read'], net: [], fs: [], secrets: [] };
  const r = await run(['user', 'forget', 'tg:alice'], { userModel: umStub, userCaps: denied });
  assert.strictEqual(r.code, 1);
  assert.ok(/CAPABILITY DENIED/.test(r.lines.join('\n')));
});

await okAsync('CLI: honest degrade when store unavailable (no fabricated profile)', async () => {
  const degraded = { initUserModel: async () => ({ available: false }), available: () => false, unavailableReason: () => 'no better-sqlite3', forget: () => false, modelInfo: () => ({ exists: false, observations: 0 }) };
  const r = await run(['user', 'show', 'tg:alice'], { userModel: degraded });
  assert.strictEqual(r.code, 0);
  assert.ok(/unavailable/i.test(r.lines.join('\n')));
});

await okAsync('CLI: bare `user` prints help (code 0)', async () => {
  const r = await run(['user'], {});
  assert.strictEqual(r.code, 0);
  assert.ok(/stratos user/.test(r.lines.join('\n')));
});

closeUserModel();
console.log(`\n✅ user-model: ${pass} assertions passed.`);
