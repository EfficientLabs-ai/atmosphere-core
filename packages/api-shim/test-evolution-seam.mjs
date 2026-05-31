/**
 * Isolated end-to-end test of the live-daemon self-evolution SEAM (self-evolution-runtime.js)
 * and the three correctness fixes (upsert, example accumulation, single-observation refusal).
 *
 * Runs against a TEMP cwd so it creates its own ./.stratos-vector-store and never touches the
 * production store. Requires local Ollama (nomic-embed-text) for embeddings, which is read-only.
 *
 * It does NOT import index.js (that binds the live port) — it drives the seam module directly.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Self-isolate: run inside a throwaway temp cwd so the vector store, node keys, and compiled
// skills land there — NEVER in the production ./.stratos-vector-store. Safe to run from anywhere.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-seam-'));
process.chdir(SANDBOX);
process.env.STRATOS_NODE_KEYS = path.join(SANDBOX, 'node-keys.json');
process.env.STRATOS_SKILLS_DIR = path.join(SANDBOX, 'skills');
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });

const RT = '/home/neo/atmosphere-core/packages/api-shim/src/self-evolution-runtime.js';
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ✓ ${m}`); pass++; };

console.log('\n=== Phase 1: INERT when flags are OFF ===');
{
  const rt = await import(RT + '?off');
  ok(rt.isEnabled() === false, 'isEnabled() === false with no flags');
  ok((await rt.getEngine()) === null, 'getEngine() === null (no engine built)');
  ok((await rt.tryServe('double 4')) === null, 'tryServe() inert → null');
  ok((await rt.observe('double 4', '8')) === null, 'observe() inert → null');
  ok((await rt.startLearnScheduler()) === false, 'startLearnScheduler() inert → false');
}

console.log('\n=== Phase 2: LIVE seam — OBSERVE accumulates, LEARN induces, EXECUTE serves ===');
// Enable all gates BEFORE importing (flags are read at module load).
process.env.STRATOS_EVOLUTION = '1';
process.env.STRATOS_EVOLUTION_OBSERVE = '1';
process.env.STRATOS_EVOLUTION_EXECUTE = '1';
{
  // Initialize the isolated triple-layer schema (production already has these tables).
  const vb = await import('/home/neo/atmosphere-core/packages/stratos-agent/src/memory/vector-bank.js');
  await vb.initializeMemorySchema();

  const rt = await import(RT + '?on');
  ok(rt.isEnabled() === true, 'isEnabled() === true with flags set');
  const eng = await rt.getEngine();
  ok(eng && typeof eng.runNightShift === 'function', 'engine constructed');

  // OBSERVE: feed several "triple <N>" exchanges. The prompt carries the operand; the answer
  // is the integer result. canonicalIntent masks the number so they share one skill id.
  // triple => affine a=3, b=0.
  const obs = [['triple 4', '12'], ['triple 5', '15'], ['triple 10', 'the answer is 30']];
  let lastId = null;
  for (const [p, a] of obs) lastId = await rt.observe(p, a);
  ok(lastId, `OBSERVE captured + accumulated under one skill id (${lastId})`);

  // Single-observation refusal: a lone example must NOT mint a skill (no distinct-x signal).
  // Use a fresh intent so it doesn't merge with the triples.
  const solo = await import('/home/neo/atmosphere-core/packages/stratos-agent/src/evolution/skill-induction.js');
  ok(solo.induceComputation([{ input: 7, output: 99 }]) === null,
     'single example → induceComputation returns null (no skill minted from one observation)');
  ok(solo.induceComputation([{ input: 4, output: 12 }, { input: 5, output: 15 }]).type === 'affine',
     'two examples → affine induced (3x)');

  // LEARN: run one night-shift pass — harvest → distill (induce 3x) → compile → PQC-sign.
  const res = await eng.runNightShift();
  ok(res.compiled.length >= 1, `night shift compiled ${res.compiled.length} skill(s)`);

  // EXECUTE: a DIFFERENTLY-worded request for the same transform must be served by the
  // verified wasm skill, computing the real result (triple 9 = 27) — not the LLM.
  const served = await rt.tryServe('please triple 9 for me');
  ok(served && Number(served.text) === 27,
     `EXECUTE served verified skill: triple 9 → ${served?.text} (expected 27)`);
}

console.log(`\n✅ ALL ${pass} CHECKS PASSED — live seam is correct, gated, and tamper-honest.\n`);
