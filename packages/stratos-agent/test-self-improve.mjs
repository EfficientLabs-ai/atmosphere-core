// test-self-improve.mjs — INCREMENT 3: the SELF-IMPROVEMENT COMPRESSION engine.
//
// The closing hops of the canonical loop: trace → evaluation → lesson → updated instruction → reusable
// skill. Hermetic: pure fs + crypto in an isolated tmp dir — no network, no Ollama, no daemon, no on-disk
// keys (the node keypair is generated in-process and injected). Builds directly on Increments 1+2
// (workspace-tree + trace-engine + eval-engine + capability-receipt). Proves:
//   1. a FAILED eval → writes a lesson + appends its suggested_instruction to instructions.md; re-running
//      is IDEMPOTENT (no duplicate instruction).
//   2. a PASSED eval → scaffolds a reusable skill (skill.md + examples/ + tools.json) in the EXISTING
//      SKILL.md format that skill-store loads back; a FAILED eval does NOT scaffold a skill.
//   3. DETERMINISTIC (same input → same output); the distill hook is OFF by default; a throwing distiller
//      degrades gracefully (never fabricates).
//   4. input validation; the capability-gated `stratos improve` CLI (deny-by-default).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTask } from './src/workspace/workspace-tree.js';
import { startTrace, recordStep, endTrace } from './src/trace/trace-engine.js';
import { ReceiptLog, makeReceiptSigner, makeReceiptVerifier } from './src/ledger/capability-receipt.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { originId } from './src/memory/skill-seal.js';
import { evaluate } from './src/eval/eval-engine.js';
import { improve, loadSkill, readLesson, lessonId, LESSONS_HEADING } from './src/self-improve/improvement-engine.js';
import { parseSkillMd } from './src/skills/skill-md.js';
import { SkillStore } from './src/skills/skill-store.js';

let pass = 0;
const _cases = [];
const ok = (name, fn) => { _cases.push([name, fn]); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'selfimp-'));
const opt = { root: ROOT };

console.log('self-improve — lesson distillation · idempotent instruction patch · reusable skill scaffold\n');

function freshKit() {
  const kp = generateHybridKeyPair();
  const nodeId = originId(kp.publicKey);
  let tms = 9000; const now = () => (tms += 1);
  let n = 0; const jti = () => `rcpt-${++n}`;
  const verifier = makeReceiptVerifier(kp.publicKey);
  const log = new ReceiptLog({ signer: makeReceiptSigner(kp.privateKey), verifier, nodeId, now, jti });
  return { kp, nodeId, now, jti, verifier, log };
}

// Build a finished trace + eval for a fresh task. Returns { taskPath, trace, evalRecord }.
function tracedAndEvaluated(taskPath, { outputs = ['done'], result = 'ok', errStep = false } = {}) {
  const parts = taskPath.split('/');
  createTask(parts[0], parts[1], parts[2], parts[3], opt);
  const kit = freshKit();
  const h = startTrace({ task: taskPath, model_used: 'gemma2:2b', model_class: 'openweight', root: ROOT, now: kit.now });
  recordStep(h, { kind: 'plan', summary: 'plan the task', who: kit.nodeId, model: 'gemma2:2b', permission: 'plan' });
  if (errStep) recordStep(h, { kind: 'tool', tool: 'fs.write', summary: 'write FAILED with an error', who: kit.nodeId, permission: 'fs.write', input: 'a', output: '', cost_units: 5 });
  else recordStep(h, { kind: 'io', summary: 'write the output', who: kit.nodeId, model: 'gemma2:2b', permission: 'fs.write', input: 'a', output: 'b', cost_units: 5 });
  const res = endTrace(h, { result, outputs, receiptLog: kit.log, actor_id: kit.nodeId, now: kit.now });
  const ev = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier });
  return { taskPath, trace: res.trace, evalRecord: ev.record, kit };
}

// ── 1. FAILED eval → lesson + instruction patch; idempotent re-run ───────────────────────────────

ok('a FAILED eval writes a lesson and appends its suggested_instruction to instructions.md', () => {
  const { taskPath, trace, evalRecord } = tracedAndEvaluated('acme/web/learn/fail1', { outputs: [], result: 'error', errStep: true });
  assert.strictEqual(evalRecord.passed, false, 'precondition: eval failed');
  assert.ok(evalRecord.lessons.length > 0, 'precondition: candidate lessons emitted');

  const out = improve({ taskPath, root: ROOT, trace, evalRecord, now: () => 1700000000000 });
  // a LESSON record was persisted
  assert.ok(out.lesson && fs.existsSync(out.lesson.file), 'lesson file written');
  const lesson = readLesson(out.lesson.file);
  assert.ok(lesson.suggestions.length > 0, 'lesson carries suggestions distilled from the eval');
  assert.ok(['low', 'medium', 'high'].includes(lesson.severity), 'severity rolled up');
  // the INSTRUCTION was updated
  assert.ok(out.instruction.applied, 'instruction applied');
  const instr = fs.readFileSync(path.join(ROOT, 'acme', 'web', 'learn', 'fail1', 'instructions.md'), 'utf8');
  assert.ok(instr.includes(LESSONS_HEADING), 'managed Lessons learned section added');
  assert.ok(lesson.suggestions.some((s) => instr.includes(s)), 'a suggested instruction landed in instructions.md');
  // a FAILED run does NOT scaffold a skill
  assert.strictEqual(out.skill, null, 'no skill scaffolded for a failed run');
});

ok('re-running improve is IDEMPOTENT — the instruction is not duplicated', () => {
  const { taskPath, trace, evalRecord } = tracedAndEvaluated('acme/web/learn/idem', { outputs: [], result: 'error', errStep: true });
  const instrFile = path.join(ROOT, 'acme', 'web', 'learn', 'idem', 'instructions.md');

  const first = improve({ taskPath, root: ROOT, trace, evalRecord, now: () => 1 });
  assert.strictEqual(first.instruction.applied, true, 'first run applies');
  const afterFirst = fs.readFileSync(instrFile, 'utf8');

  const second = improve({ taskPath, root: ROOT, trace, evalRecord, now: () => 2 });
  assert.strictEqual(second.instruction.applied, false, 'second run is a no-op');
  assert.strictEqual(second.instruction.alreadyApplied, true, 'already-applied detected');
  const afterSecond = fs.readFileSync(instrFile, 'utf8');
  assert.strictEqual(afterFirst, afterSecond, 'instructions.md unchanged on re-run (no duplicate)');

  // the applied-lesson marker appears exactly once
  const id = lessonId(evalRecord.lessons[0]);
  const occurrences = afterSecond.split(`applied-lesson:${id}`).length - 1;
  assert.strictEqual(occurrences, 1, 'the lesson marker appears exactly once');
});

// ── 2. PASSED eval → reusable skill scaffold loadable via skill-store ──────────────────────────────

ok('a PASSED eval scaffolds a reusable skill (skill.md + examples/ + tools.json) in the SKILL.md format', () => {
  const { taskPath, trace, evalRecord } = tracedAndEvaluated('acme/web/learn/pass1');
  assert.strictEqual(evalRecord.passed, true, 'precondition: eval passed');

  const out = improve({ taskPath, root: ROOT, trace, evalRecord, now: () => 1700000001000 });
  assert.ok(out.skill, 'a skill was scaffolded');
  assert.ok(fs.existsSync(out.skill.skillMdFile), 'skill.md written');
  assert.ok(fs.existsSync(out.skill.toolsFile), 'tools.json written');
  assert.ok(fs.existsSync(out.skill.exampleFile), 'examples/ seeded with the worked path');
  // deny-by-default tools.json shape
  const tools = JSON.parse(fs.readFileSync(out.skill.toolsFile, 'utf8'));
  assert.ok(tools.capabilities && Array.isArray(tools.capabilities.actions), 'tools.json has a capabilities block');

  // the skill.md is the EXISTING portable SKILL.md format — parseSkillMd round-trips it
  const md = fs.readFileSync(out.skill.skillMdFile, 'utf8');
  const parsed = parseSkillMd(md);
  assert.ok(parsed.name, 'skill.md has a name in frontmatter');
  assert.ok(parsed.description, 'skill.md has a description');
  assert.ok(parsed.body.includes('What worked'), 'body distilled from the worked path');

  // and it LOADS BACK via the EXISTING SkillStore (rooted at <task>/skills)
  const skillsDir = path.join(ROOT, 'acme', 'web', 'learn', 'pass1', 'skills');
  const loaded = loadSkill(skillsDir, out.skill.id);
  assert.ok(loaded, 'skill loads via SkillStore.get');
  assert.strictEqual(loaded.id, out.skill.id);
  assert.strictEqual(loaded.kind, 'instruction', 'stored as an instruction skill');
  // the store's own listing includes it
  const listed = new SkillStore(skillsDir).list().map((s) => s.id);
  assert.ok(listed.includes(out.skill.id), 'skill appears in the store index');
});

ok('a PASSED eval with no failed criteria writes NO lesson and NO instruction patch', () => {
  const { taskPath, trace, evalRecord } = tracedAndEvaluated('acme/web/learn/pass2');
  const out = improve({ taskPath, root: ROOT, trace, evalRecord });
  assert.strictEqual(out.lesson, null, 'no lesson when nothing failed');
  assert.strictEqual(out.instruction, null, 'no instruction patch when nothing failed');
  assert.ok(out.skill, 'but a skill is still scaffolded for the passing run');
});

// ── 3. determinism + the off-by-default distiller ─────────────────────────────────────────────────

ok('deterministic: same trace+eval → identical lesson record (modulo injected clock)', () => {
  const { taskPath, trace, evalRecord } = tracedAndEvaluated('acme/web/learn/determinism', { outputs: [], result: 'error', errStep: true });
  const a = improve({ taskPath, root: ROOT, trace, evalRecord, now: () => 111 });
  const la = readLesson(a.lesson.file);
  // run again on a FRESH task with the same logical input → same id, severity, suggestions, body
  const b2 = tracedAndEvaluated('acme/web/learn/determinism2', { outputs: [], result: 'error', errStep: true });
  const b = improve({ taskPath: b2.taskPath, root: ROOT, trace: b2.trace, evalRecord: { ...b2.evalRecord, task_id: evalRecord.task_id }, now: () => 222 });
  const lb = readLesson(b.lesson.file);
  assert.strictEqual(la.id, lb.id, 'same lesson id (content-addressed)');
  assert.strictEqual(la.severity, lb.severity);
  assert.deepStrictEqual(la.suggestions, lb.suggestions);
  assert.strictEqual(la.body, lb.body, 'identical distilled body');
});

ok('the distill hook is OFF by default; a throwing distiller degrades gracefully (never fabricates)', () => {
  const base = tracedAndEvaluated('acme/web/learn/distill-off', { outputs: [], result: 'error', errStep: true });
  const off = improve({ taskPath: base.taskPath, root: ROOT, trace: base.trace, evalRecord: base.evalRecord });
  const offLesson = readLesson(off.lesson.file);

  // a THROWING distiller must not crash and must yield the SAME deterministic body as the off case
  const thr = tracedAndEvaluated('acme/web/learn/distill-throw', { outputs: [], result: 'error', errStep: true });
  let out;
  assert.doesNotThrow(() => {
    out = improve({ taskPath: thr.taskPath, root: ROOT, trace: thr.trace,
      evalRecord: { ...thr.evalRecord, task_id: base.evalRecord.task_id },
      distill: () => { throw new Error('distiller model down'); } });
  });
  const thrLesson = readLesson(out.lesson.file);
  assert.strictEqual(thrLesson.body, offLesson.body, 'throwing distiller → deterministic template, never fabricated');

  // a WORKING distiller may enrich the prose body (structured fields stay authoritative)
  const enr = tracedAndEvaluated('acme/web/learn/distill-on', { outputs: [], result: 'error', errStep: true });
  const out2 = improve({ taskPath: enr.taskPath, root: ROOT, trace: enr.trace, evalRecord: enr.evalRecord,
    distill: () => ({ summary: 'a synthesized summary', body: 'a synthesized distilled body' }) });
  const l2 = readLesson(out2.lesson.file);
  assert.strictEqual(l2.body, 'a synthesized distilled body', 'distiller body honored when present');
  assert.strictEqual(l2.summary, 'a synthesized summary');
  assert.ok(l2.suggestions.length > 0, 'structured suggestions still derived from the eval, not the hook');
});

// ── 4. input validation + the CLI gate ───────────────────────────────────────────────────────────

ok('improve() validates inputs (deny-by-default on a missing/bad trace, eval, or task)', () => {
  assert.throws(() => improve({}), /trace/, 'no trace');
  assert.throws(() => improve({ trace: { steps: 'nope' }, evalRecord: { passed: true } }), /trace/, 'bad trace');
  assert.throws(() => improve({ trace: { steps: [] }, evalRecord: {} }), /EvalRecord|passed/, 'bad eval');
  assert.throws(() => improve({ taskPath: 'no/such/task/here', trace: { steps: [] }, evalRecord: { passed: true } }), /incomplete|no task/, 'task must exist');
});

import { run as runCli } from './src/cli/stratos-cli.js';
import { parseCapabilities } from './src/security/capability-gate.js';
const DENY = parseCapabilities({ capabilities: { actions: [] } });

ok('CLI: stratos improve on a FAILED eval writes a lesson + patches instructions.md', async () => {
  tracedAndEvaluated('cli/proj/flow/failt', { outputs: [], result: 'error', errStep: true });
  const r = await runCli(['improve', 'cli/proj/flow/failt'], { workspacesRoot: ROOT });
  assert.strictEqual(r.code, 0, 'improve succeeds');
  const out = r.lines.join('\n');
  assert.ok(out.includes('improve'), 'mentions improve');
  assert.ok(out.includes('instruction applied'), 'reports instruction applied');
  assert.ok(fs.existsSync(path.join(ROOT, 'cli', 'proj', 'flow', 'failt', 'skills', 'lessons')), 'lessons dir created');
  // idempotent on the CLI path too
  const r2 = await runCli(['improve', 'cli/proj/flow/failt'], { workspacesRoot: ROOT });
  assert.ok(r2.lines.join('\n').includes('already applied'), 'second run is idempotent');
});

ok('CLI: stratos improve on a PASSED eval scaffolds a loadable skill', async () => {
  tracedAndEvaluated('cli/proj/flow/passt');
  const r = await runCli(['improve', 'cli/proj/flow/passt'], { workspacesRoot: ROOT });
  assert.strictEqual(r.code, 0);
  assert.ok(r.lines.join('\n').includes('reusable skill scaffolded'), 'reports skill scaffold');
  const skillsDir = path.join(ROOT, 'cli', 'proj', 'flow', 'passt', 'skills');
  assert.ok(new SkillStore(skillsDir).list().length >= 1, 'skill registered in the store');
});

ok('CLI: improve on a task with no eval is an honest error (not a fabricated lesson)', async () => {
  createTask('cli', 'proj', 'flow', 'noeval', opt);
  const r = await runCli(['improve', 'cli/proj/flow/noeval'], { workspacesRoot: ROOT });
  assert.strictEqual(r.code, 1);
  assert.ok(/no trace|no eval/i.test(r.lines.join('\n')), 'honest missing-input error');
});

ok('CLI: stratos improve is capability-gated deny-by-default; help is ungated', async () => {
  tracedAndEvaluated('cli/proj/flow/gated', { outputs: [], result: 'error', errStep: true });
  assert.strictEqual((await runCli(['improve', 'cli/proj/flow/gated'], { workspacesRoot: ROOT, workspaceCaps: DENY })).code, 1, 'denied caps → exit 1');
  assert.strictEqual((await runCli(['improve', 'help'], { workspacesRoot: ROOT, workspaceCaps: DENY })).code, 0, 'help reachable');
});

ok('CLI: improve is in the COMMANDS surface', async () => {
  const { COMMANDS } = await import('./src/cli/stratos-cli.js');
  assert.ok(COMMANDS.includes('improve'), 'COMMANDS has improve');
});

// Run every case in order, then clean up.
for (const [name, fn] of _cases) { await fn(); console.log(`  ✓ ${name}`); pass++; }
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n✅ ${pass}/${pass} self-improve tests passed — lesson distillation, idempotent instruction patch, reusable skill scaffold (PASS only), determinism, gated CLI.`);
