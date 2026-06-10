/**
 * test-vector-isolation.mjs — EFL-003 regression: cross-channel context-bleed must be CLOSED.
 *
 * Proves that a per-channel RAG query (cognitive_skills / intercepted_reasoning / ambient_memory)
 * returns only THAT channel's rows + global/untagged rows, and NEVER another channel's data — while
 * an internal/global query (no contextTag, e.g. self-evolution) still sees everything.
 *
 * Hermetic: chdir to a temp dir (the LanceDB store is cwd-relative `./.stratos-vector-store`), and
 * embeddings use the deterministic non-semantic fallback (no Ollama). No network, no live services.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initializeMemorySchema,
  insertCognitiveSkill, queryCognitiveSkill,
  insertInterceptedReasoning, queryInterceptedReasoning,
  insertAmbientMemory, queryAmbientMemory,
} from './src/memory/vector-bank.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'efl003-'));
process.chdir(tmp);                                  // getDatabase() → ./.stratos-vector-store under tmp
process.env.OLLAMA_HOST = 'http://127.0.0.1:1';      // force the embedding fallback (no real Ollama)

const A = 'chanA-team_x', B = 'chanB-team_y';

await initializeMemorySchema();

// Seed each layer with a channel-A row, a channel-B row, and a global ('') row.
await insertCognitiveSkill({ skillId: 'sA', triggerIntent: 'alpha skill', astGraph: '{}', contextTag: A });
await insertCognitiveSkill({ skillId: 'sB', triggerIntent: 'bravo skill', astGraph: '{}', contextTag: B });
await insertCognitiveSkill({ skillId: 'sG', triggerIntent: 'global skill', astGraph: '{}' /* contextTag '' */ });
await insertInterceptedReasoning({ promptHash: 'hA', modelSource: 'm', reasoningTrace: 'alpha reasoning', contextTag: A });
await insertInterceptedReasoning({ promptHash: 'hB', modelSource: 'm', reasoningTrace: 'bravo reasoning', contextTag: B });
await insertAmbientMemory({ source: 's', content: 'alpha ambient', tags: A });
await insertAmbientMemory({ source: 's', content: 'bravo ambient', tags: B });

// --- Channel A's view: isolated ---
const skillsA = await queryCognitiveSkill('skill', 10, A);
const reasonA = await queryInterceptedReasoning('reasoning', 10, A);
const ambientA = await queryAmbientMemory('ambient', 10, A);

assert.ok(!skillsA.some(r => r.context_tag === B), 'LEAK: channel-B cognitive_skill surfaced in channel-A query');
assert.ok(!reasonA.some(r => r.context_tag === B), 'LEAK: channel-B intercepted_reasoning surfaced in channel-A query');
assert.ok(!ambientA.some(r => r.tags === B), 'LEAK: channel-B ambient_memory surfaced in channel-A query');

// Isolation is not a blackout: A sees its own rows + global rows.
assert.ok(skillsA.some(r => r.context_tag === A), 'channel A should still see its own skills');
assert.ok(skillsA.some(r => r.context_tag === ''), 'global (untagged) skills should remain visible to every channel');

// --- Internal/global query (no tag) — self-evolution path — still sees ALL channels ---
const allSkills = await queryCognitiveSkill('skill', 10);
assert.ok(allSkills.some(r => r.context_tag === A) && allSkills.some(r => r.context_tag === B),
  'a global (untagged) query must still see every channel (self-evolution global access preserved)');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('  ✓ EFL-003: cross-channel context-bleed CLOSED — cognitive_skills + intercepted_reasoning + ambient isolated per channel; self-evolution global access preserved');
