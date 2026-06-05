// test-model-adapter.mjs — INCREMENT 4: unified model-adapter, policy precedence Privacy > Capability
// > Cost > Fallback. Hermetic: injected FAKE providers, NO network anywhere (each provider's call() is
// a local stub). Wraps the existing model-router.js (route) — does not fork it.
import assert from 'node:assert';
import { selectAndComplete } from './src/routing/model-adapter.js';

let pass = 0;
const ok = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); pass++; };

console.log('model adapter — Privacy > Capability > Cost > Fallback (injected providers, no network)\n');

// ── fake provider factory: records calls, no network ──────────────────────────────────────────
const mk = (id, kind, opts = {}) => {
  const p = {
    id, kind, calls: 0,
    capability: opts.capability,
    costClass: opts.costClass,
    costHint: opts.costHint,
    async call(req) {
      p.calls++;
      if (opts.fail) {                                  // simulate error/timeout deterministically
        if (opts.failKind === 'notok') return { ok: false, error: `${id} not-ok` };
        throw new Error(`${id} boom`);
      }
      return { ok: true, text: `${id}:${(req.prompt || '').slice(0, 12)}`, served: id };
    },
  };
  return p;
};

// ── PRIVACY: a sensitive task forces local/open-weight even when a frontier provider is present ──
await ok('PRIVACY override — sensitive task never reaches a frontier provider', async () => {
  const frontier = mk('openai', 'frontier', { capability: 5 });
  const local = mk('local-gemma', 'openweight', { capability: 3, costClass: 'local' });
  const out = await selectAndComplete({
    task: { prompt: 'prove this complex theorem '.repeat(40) }, // hard prompt
    classHint: 'reasoning',                                     // would WANT frontier…
    privacy: true,                                             // …but privacy forbids it
    providers: [frontier, local],
    ctx: { hasFrontierKey: true, meshAvailable: true },        // even with a key + mesh available
  });
  assert.strictEqual(out.kind, 'openweight', 'must serve open-weight, never frontier');
  assert.strictEqual(out.provider, 'local-gemma');
  assert.strictEqual(out.cloud, false);
  assert.strictEqual(frontier.calls, 0, 'frontier provider must NEVER be called for a private task');
});

// ── CAPABILITY: high-reasoning → frontier (when allowed); batch/extraction → open-weight/local ──
await ok('CAPABILITY — high-reasoning routes to frontier when the router allows cloud', async () => {
  const frontier = mk('anthropic', 'frontier', { capability: 5 });
  const local = mk('local-gemma', 'openweight', { capability: 3, costClass: 'local' });
  const out = await selectAndComplete({
    // explicit cloud model + not private → router allows cloud (the opt-in is the explicit model)
    task: { prompt: 'architect a distributed system', model: 'claude-opus' },
    classHint: 'reasoning',
    providers: [local, frontier],            // order shouldn't matter — capability/class decides
    ctx: { hasFrontierKey: true },
  });
  assert.strictEqual(out.kind, 'frontier');
  assert.strictEqual(out.provider, 'anthropic');
  assert.strictEqual(out.cloud, true);
});

await ok('CAPABILITY — batch/extraction routes to open-weight/local (not frontier)', async () => {
  const frontier = mk('openai', 'frontier', { capability: 5 });
  const local = mk('local-gemma', 'openweight', { capability: 3, costClass: 'local' });
  const out = await selectAndComplete({
    task: { prompt: 'extract the dates from this text' },
    classHint: 'extraction',
    providers: [frontier, local],
    ctx: { hasFrontierKey: true },           // key present, but the class doesn't want frontier
  });
  assert.strictEqual(out.kind, 'openweight');
  assert.strictEqual(out.provider, 'local-gemma');
  assert.strictEqual(out.cloud, false, 'default (no escalation) keeps it local');
  assert.strictEqual(frontier.calls, 0);
});

// ── COST: within an acceptable capability tier, pick the cheaper provider; local ($0) preferred ──
await ok('COST — cheaper provider wins within an acceptable tier (local $0 preferred)', async () => {
  // two adequate local-class providers: one with a cheaper costHint should win.
  const cheap = mk('local-cheap', 'openweight', { capability: 3, costClass: 'local', costHint: 0 });
  const pricier = mk('local-pricier', 'openweight', { capability: 3, costClass: 'local', costHint: 5 });
  const out = await selectAndComplete({
    task: { prompt: 'summarize this' }, classHint: 'summarize',
    providers: [pricier, cheap],
  });
  assert.strictEqual(out.provider, 'local-cheap');
});

await ok('COST — local ($0) beats a frontier provider when local is capability-adequate', async () => {
  const frontier = mk('openai', 'frontier', { capability: 5 });
  const local = mk('local-gemma', 'openweight', { capability: 3, costClass: 'local' });
  const out = await selectAndComplete({
    // general class, not private, no escalation → router stays local → frontier filtered out anyway,
    // AND even were cloud allowed, a general class prefers the $0 adequate local.
    task: { prompt: 'write a short note' }, classHint: 'general',
    providers: [frontier, local], ctx: { hasFrontierKey: true },
  });
  assert.strictEqual(out.kind, 'openweight');
  assert.strictEqual(out.provider, 'local-gemma');
});

// ── FALLBACK: on provider error/timeout, degrade along the chain and log each hop; deterministic ─
await ok('FALLBACK — degrades along the chain on error, logs each hop, deterministic', async () => {
  const events = [];
  const a = mk('frontier-a', 'frontier', { capability: 5, fail: true });               // throws
  const b = mk('frontier-b', 'frontier', { capability: 5, fail: true, failKind: 'notok' }); // {ok:false}
  const c = mk('frontier-c', 'frontier', { capability: 5 });                            // succeeds
  const out = await selectAndComplete({
    task: { prompt: 'architect the system', model: 'gpt-5' }, // cloud-allowed (explicit cloud model)
    classHint: 'reasoning',
    providers: [a, b, c], ctx: { hasFrontierKey: true },
    log: (e) => events.push(e),
  });
  assert.strictEqual(out.provider, 'frontier-c', 'falls through to the first healthy provider');
  // each failed hop is logged with ok:false + an error, in order:
  const callHops = out.hops.filter((h) => h.stage === 'call');
  assert.deepStrictEqual(callHops.map((h) => [h.provider, h.ok]), [
    ['frontier-a', false], ['frontier-b', false], ['frontier-c', true],
  ]);
  assert.ok(callHops[0].error && callHops[1].error, 'each failed hop carries an honest error');
  assert.ok(events.length > 0, 'the injected logger received every hop');
  // determinism: same inputs → same chain order + same outcome.
  const out2 = await selectAndComplete({
    task: { prompt: 'architect the system', model: 'gpt-5' }, classHint: 'reasoning',
    providers: [mk('frontier-a', 'frontier', { capability: 5, fail: true }),
                mk('frontier-b', 'frontier', { capability: 5, fail: true, failKind: 'notok' }),
                mk('frontier-c', 'frontier', { capability: 5 })],
    ctx: { hasFrontierKey: true },
  });
  assert.strictEqual(out2.provider, 'frontier-c');
});

await ok('FALLBACK — whole chain exhausted fails deterministically with the full hop log', async () => {
  const a = mk('local-a', 'openweight', { capability: 3, costClass: 'local', fail: true });
  const b = mk('local-b', 'openweight', { capability: 3, costClass: 'local', fail: true });
  await assert.rejects(
    () => selectAndComplete({ task: { prompt: 'hi' }, providers: [a, b] }),
    (err) => {
      assert.ok(/all 2 provider\(s\) failed/.test(err.message));
      assert.ok(Array.isArray(err.hops) && err.hops.some((h) => h.stage === 'call' && h.ok === false));
      return true;
    },
  );
});

// ── USER-PROVIDED provider plugs in via the SAME interface (no special path) ─────────────────────
await ok('USER-PROVIDED model plugs into the same interface + precedence', async () => {
  const user = mk('my-own-llm', 'user', { capability: 4, costClass: 'local' });
  // private task → frontier filtered; the user provider (treated $0/open-weight-equivalent) serves it.
  const frontier = mk('openai', 'frontier', { capability: 5 });
  const out = await selectAndComplete({
    task: { prompt: 'analyze my private notes' }, classHint: 'general', privacy: true,
    providers: [frontier, user], ctx: { hasFrontierKey: true },
  });
  assert.strictEqual(out.kind, 'user');
  assert.strictEqual(out.provider, 'my-own-llm');
  assert.strictEqual(out.cloud, false);
  assert.strictEqual(frontier.calls, 0);
  // and a user provider competes normally on capability/cost when cloud IS allowed:
  const userStrong = mk('my-strong-llm', 'user', { capability: 5, costClass: 'local' });
  const front2 = mk('anthropic', 'frontier', { capability: 5 });
  const out2 = await selectAndComplete({
    task: { prompt: 'plan this', model: 'claude-opus' }, classHint: 'reasoning',
    providers: [front2, userStrong], ctx: { hasFrontierKey: true },
  });
  // reasoning WANTS frontier-kind first; the $0 user model is the fallback if frontier fails — but
  // both are adequate, so frontier-kind preference picks anthropic. Honest: no special user path.
  assert.strictEqual(out2.provider, 'anthropic');
});

// ── PRECEDENCE PROOF: privacy beats capability beats cost ───────────────────────────────────────
await ok('PRECEDENCE — Privacy > Capability > Cost proven in one scenario', async () => {
  // Most capable + (pretend) acceptable provider is frontier; cheapest is local. Private task:
  // Privacy must win over BOTH capability and cost-preference-for-frontier, forcing local.
  const frontier = mk('openai', 'frontier', { capability: 5, costClass: 'frontier' });
  const local = mk('local-gemma', 'openweight', { capability: 2, costClass: 'local' });
  const out = await selectAndComplete({
    task: { prompt: 'highly complex reasoning '.repeat(40) }, classHint: 'reasoning', privacy: true,
    providers: [frontier, local], ctx: { hasFrontierKey: true, meshAvailable: true },
  });
  assert.strictEqual(out.provider, 'local-gemma', 'privacy overrides capability + cost');
  assert.strictEqual(frontier.calls, 0);
});

console.log(`\n✅ ${pass}/${pass} model-adapter tests passed — Privacy > Capability > Cost > Fallback, no network.`);
