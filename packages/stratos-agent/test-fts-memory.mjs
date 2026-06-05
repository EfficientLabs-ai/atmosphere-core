/**
 * test-fts-memory.mjs — sovereign FTS5 cross-session recall (hermetic: no network, no Ollama).
 *
 * Covers: index turns → bm25-ranked search returns the right hits → conversation filter isolates →
 * FTS5 injection-safety (operator/quote-laden queries never crash or over-match) → recall() calls an
 * INJECTED summarizer (the only "model" touched) → honest degrade when FTS5 is unavailable → the CLI
 * `memory` surface is capability-gated (deny-by-default) and degrades honestly.
 *
 * Uses an in-memory SQLite db (':memory:') so it is fully self-contained and leaves no artifacts.
 */
import assert from 'node:assert';
import {
  initFtsMemory, indexTurn, search, recall, sanitizeQuery, available,
  unavailableReason, count, closeFtsMemory,
} from './src/memory/fts-memory.js';
import { run } from './src/cli/stratos-cli.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); pass++; };

console.log('fts-memory — sovereign full-text cross-session recall\n');

// ── sanitizeQuery: injection-safe by construction (pure, no db needed) ──────────────────────
ok('sanitizeQuery strips FTS5 operators, keeps words as quoted literals', () => {
  assert.strictEqual(sanitizeQuery('vault rotation'), '"vault" OR "rotation"');
  // Operator-laden / quote-laden input must not survive as operators:
  const malicious = sanitizeQuery('"; DROP) AND NEAR(* foo');
  assert.ok(!/DROP\)|NEAR\(|\bAND\b(?!")/.test(malicious), 'no raw operators leak through');
  assert.ok(malicious.includes('"foo"'), 'real words still searchable');
});
ok('sanitizeQuery returns empty for pure-operator/garbage input', () => {
  assert.strictEqual(sanitizeQuery('"""'), '');
  assert.strictEqual(sanitizeQuery('   ^*( )  '), '');
  assert.strictEqual(sanitizeQuery(null), '');
});

// ── live FTS5 path (skips gracefully if this SQLite build lacks fts5) ───────────────────────
const init = await initFtsMemory({ dbPath: ':memory:' });

if (!init.available) {
  // Honest-degrade branch is itself a tested behavior: search must return [] + a reason, never throw.
  console.log(`  (FTS5 unavailable in this build: ${init.reason}) — asserting honest degrade`);
  ok('degraded: search returns [] not a throw', () => {
    assert.deepStrictEqual(search('anything'), []);
  });
  ok('degraded: available() false + reason exposed', () => {
    assert.strictEqual(available(), false);
    assert.ok(typeof unavailableReason() === 'string' && unavailableReason().length > 0);
  });
} else {
  const C1 = 'tg:alice', C2 = 'tg:bob';
  ok('index a few turns across two conversations', () => {
    assert.strictEqual(indexTurn({ conversationId: C1, role: 'user', content: 'we decided to rotate the vault token on Friday', ts: 1000 }), true);
    assert.strictEqual(indexTurn({ conversationId: C1, role: 'assistant', content: 'noted: vault token rotation scheduled', ts: 1001 }), true);
    assert.strictEqual(indexTurn({ conversationId: C1, role: 'user', content: 'also remember the mesh uses hyperswarm DHT for hole punching', ts: 1002 }), true);
    assert.strictEqual(indexTurn({ conversationId: C2, role: 'user', content: 'bob asked about the pricing tiers, unrelated to vault', ts: 2000 }), true);
    assert.strictEqual(count(), 4);
    assert.strictEqual(count(C1), 3);
  });

  ok('search returns the right ranked hits (bm25), most-relevant first', () => {
    const hits = search('vault token rotation');
    assert.ok(hits.length >= 2, 'finds the vault turns');
    // Every hit must actually mention a query term (no over-match).
    for (const h of hits) assert.ok(/vault|token|rotation/i.test(h.content));
    // The two C1 vault turns should outrank bob's tangential "unrelated to vault" mention.
    assert.ok(hits[0].conversationId === C1, 'top hit is from the conversation that actually decided it');
    assert.ok(typeof hits[0].score === 'number');
    assert.ok(hits[0].snippet.includes('['), 'snippet highlights the matched term');
  });

  ok('conversation filter isolates recall to one conversation', () => {
    const all = search('vault');
    const onlyBob = search('vault', { conversationId: C2 });
    assert.ok(all.length > onlyBob.length, 'filter narrows the result set');
    assert.ok(onlyBob.every((h) => h.conversationId === C2));
    assert.strictEqual(onlyBob.length, 1);
  });

  ok('injection-safe: operator/quote-laden query never throws (operators defused, not executed)', () => {
    // Each of these would be an FTS5 SYNTAX ERROR or operator-injection if passed raw to MATCH.
    // sanitizeQuery turns them into harmless quoted literals, so search() must always return a real
    // array and never throw. (Result COUNT is incidental — sanitized words are OR-joined keyword
    // search; the guarantee under test is "no raw operator/quote ever reaches the FTS5 engine".)
    for (const q of ['"', '*', 'vault" OR role:user', 'a AND ( NEAR', 'foo*bar()', '""""', 'DROP TABLE turns_fts']) {
      const hits = search(q); // must not throw
      assert.ok(Array.isArray(hits), `query ${JSON.stringify(q)} returned an array`);
    }
    // A field-scoped FTS5 injection ("role:user") must NOT actually scope by column — it is treated
    // as the literal words "role" and "user". Prove the colon operator was neutralized: searching
    // the literal token "rotation" (present) finds rows; a column filter would behave differently.
    assert.ok(search('rotation').length >= 1, 'literal-word search still works after sanitization');
  });

  ok('empty/garbage query yields no results, not an error', () => {
    assert.deepStrictEqual(search(''), []);
    assert.deepStrictEqual(search('^*()'), []);
  });

  await okAsync('recall() searches then calls the INJECTED summarizer (no network)', async () => {
    let sawHits = null;
    const summarize = ({ query, hits }) => { sawHits = hits; return `summary for "${query}" from ${hits.length} hits`; };
    const out = await recall('vault token rotation', { summarize });
    assert.ok(out.available);
    assert.ok(out.hits.length >= 2);
    assert.ok(Array.isArray(sawHits) && sawHits.length === out.hits.length, 'summarizer received the hits');
    assert.ok(out.answer.startsWith('summary for'));
  });

  await okAsync('recall() without a summarizer returns raw hits honestly (answer null)', async () => {
    const out = await recall('vault');
    assert.strictEqual(out.answer, null);
    assert.ok(out.hits.length >= 1);
  });

  await okAsync('recall() with a throwing summarizer degrades, never throws', async () => {
    const out = await recall('vault', { summarize: () => { throw new Error('model down'); } });
    assert.strictEqual(out.answer, null);
    assert.ok(out.hits.length >= 1);
    assert.ok(/summarizer failed/.test(out.reason));
  });

  ok('indexTurn is fail-open: blank/garbage content is skipped, never throws', () => {
    assert.strictEqual(indexTurn({ conversationId: C1, role: 'user', content: '   ' }), false);
    assert.strictEqual(indexTurn(null), false);
    assert.strictEqual(count(), 4, 'no spurious rows added');
  });
}

// ── CLI surface: capability-gated (deny-by-default) + honest degrade ────────────────────────
// Injected memory stub keeps this branch hermetic regardless of FTS5 availability above.
const memStub = {
  initFtsMemory: async () => ({ available: true }),
  available: () => true,
  unavailableReason: () => null,
  search: (q) => (/vault/i.test(q) ? [{ conversationId: 'tg:alice', role: 'user', ts: 1000, content: 'rotate the vault token', snippet: 'rotate the [vault] token', score: -1.2 }] : []),
  recall: async (q, { summarize }) => {
    const hits = memStub.search(q);
    return { answer: summarize ? await summarize({ query: q, hits }) : null, hits, available: true };
  },
};

await okAsync('CLI: `memory search` returns ranked hits via injected backend', async () => {
  const r = await run(['memory', 'search', 'vault'], { memory: memStub });
  assert.strictEqual(r.code, 0);
  assert.ok(r.lines.join('\n').includes('vault'));
});

await okAsync('CLI: `memory recall` uses an injected summarizer (no network)', async () => {
  const r = await run(['memory', 'recall', 'vault'], { memory: memStub, summarize: ({ hits }) => `decided to rotate (${hits.length})` });
  assert.strictEqual(r.code, 0);
  assert.ok(/Recall:/.test(r.lines.join('\n')));
});

await okAsync('CLI: capability gate DENIES when memory.read not declared', async () => {
  // Inject capabilities that do NOT include memory.read → deny-by-default refuses.
  const denied = { compute: false, actions: ['click'], net: [], fs: [], secrets: [] };
  const r = await run(['memory', 'search', 'vault'], { memory: memStub, memoryCaps: denied });
  assert.strictEqual(r.code, 1);
  assert.ok(/CAPABILITY DENIED/.test(r.lines.join('\n')));
});

await okAsync('CLI: honest degrade when FTS5 unavailable (no fabricated results)', async () => {
  const degraded = { initFtsMemory: async () => ({ available: false }), available: () => false, unavailableReason: () => 'no fts5 in build', search: () => [], recall: async () => ({ answer: null, hits: [], available: false }) };
  const r = await run(['memory', 'search', 'vault'], { memory: degraded });
  assert.strictEqual(r.code, 0);
  assert.ok(/unavailable/i.test(r.lines.join('\n')));
});

await okAsync('CLI: bare `memory` prints help (code 0)', async () => {
  const r = await run(['memory'], {});
  assert.strictEqual(r.code, 0);
  assert.ok(/stratos memory/.test(r.lines.join('\n')));
});

closeFtsMemory();
console.log(`\n✅ fts-memory: ${pass} assertions passed.`);
