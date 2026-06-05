// test-eval-engine.mjs — INCREMENT 2: the EVAL-ENGINE (the trace→evaluation→lesson hop).
//
// Hermetic: pure fs + crypto in an isolated tmp dir — no network, no Ollama, no daemon, no on-disk
// keys (the node keypair is generated in-process and injected). Builds directly on Increment 1
// (workspace-tree + trace-engine + capability-receipt). Proves:
//   1. evaluate() writes evals/{id}.md AND .json; the .json matches the EvalRecord shape.
//   2. the DEFAULT rubric: a clean ok-trace PASSES; an error-step / no-outputs trace FAILS the right
//      criteria; TRACE-INTEGRITY passes for a verifying receipt and FAILS for a tampered one (fail-closed).
//   3. the eval links back into the trace (eval_path written; eval references trace_path + receipt_path).
//   4. failed criteria emit candidate lessons; the score is DETERMINISTIC (same input → same score).
//   5. the LLM-judge hook is OFF by default; a throwing judge never crashes or fabricates a score.
//   6. the capability-gated `stratos eval` CLI is deny-by-default.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTask } from './src/workspace/workspace-tree.js';
import { startTrace, recordStep, endTrace, readTrace, traceInputHash } from './src/trace/trace-engine.js';
import { ReceiptLog, makeReceiptSigner, makeReceiptVerifier } from './src/ledger/capability-receipt.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { originId } from './src/memory/skill-seal.js';
import { evaluate, readEval, EVAL_FIELDS, DEFAULT_RUBRIC, computeReceiptVerify } from './src/eval/eval-engine.js';

let pass = 0;
const _cases = [];
const ok = (name, fn) => { _cases.push([name, fn]); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'evaleng-'));
const opt = { root: ROOT };

console.log('eval-engine — deterministic rubric · verify-as-a-criterion · candidate lessons\n');

// A reusable kit: a fresh keypair + verifier + a deterministic receipt log + clock.
function freshKit() {
  const kp = generateHybridKeyPair();
  const nodeId = originId(kp.publicKey);
  let tms = 9000; const now = () => (tms += 1);
  let n = 0; const jti = () => `rcpt-${++n}`;
  const verifier = makeReceiptVerifier(kp.publicKey);
  const log = new ReceiptLog({ signer: makeReceiptSigner(kp.privateKey), verifier, nodeId, now, jti });
  return { kp, nodeId, now, jti, verifier, log };
}

// Build + finish a CLEAN, OK trace for a fresh task. Returns { taskPath, res, kit }.
function cleanTrace(taskPath, { outputs = ['done'], result = 'ok', errStep = false } = {}) {
  const parts = taskPath.split('/');
  createTask(parts[0], parts[1], parts[2], parts[3], opt);
  const kit = freshKit();
  const h = startTrace({ task: taskPath, model_used: 'gemma2:2b', model_class: 'openweight', root: ROOT, now: kit.now });
  recordStep(h, { kind: 'plan', summary: 'plan it', who: kit.nodeId, model: 'gemma2:2b', permission: 'plan' });
  if (errStep) recordStep(h, { kind: 'tool', tool: 'fs.write', summary: 'write FAILED with an error', who: kit.nodeId, permission: 'fs.write', input: 'a', output: '', cost_units: 5 });
  else recordStep(h, { kind: 'io', summary: 'write output', who: kit.nodeId, model: 'gemma2:2b', permission: 'fs.write', input: 'a', output: 'b', cost_units: 5 });
  const res = endTrace(h, { result, outputs, receiptLog: kit.log, actor_id: kit.nodeId, now: kit.now });
  return { taskPath, res, kit };
}

// ── 1. evaluate() writes both artifacts; .json matches the EvalRecord shape ──────────────────────

ok('evaluate() writes evals/{id}.md AND .json; .json matches the EvalRecord shape', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/onboard/signup');
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier, now: () => 1700000000000 });

  assert.ok(out.mdFile.endsWith(path.join('signup', 'evals', 'signup.md')), 'md path');
  assert.ok(out.jsonFile.endsWith(path.join('signup', 'evals', 'signup.json')), 'json path');
  assert.ok(fs.existsSync(out.mdFile) && fs.existsSync(out.jsonFile), 'both files written');

  const onDisk = readEval(out.jsonFile);
  for (const f of EVAL_FIELDS) assert.ok(f in onDisk, `EvalRecord has field "${f}"`);
  assert.strictEqual(onDisk.task_id, 'signup');
  assert.strictEqual(onDisk.workspace, 'acme');
  assert.strictEqual(onDisk.rubric, 'default');
  assert.ok(Array.isArray(onDisk.criteria) && onDisk.criteria.length === DEFAULT_RUBRIC.length, 'all default criteria scored');
  // the markdown is a real scorecard
  const md = fs.readFileSync(out.mdFile, 'utf8');
  assert.ok(md.includes('# Eval: signup'));
  assert.ok(md.includes('PASS') || md.includes('FAIL'));
  assert.ok(md.includes('trace-integrity'));
});

// ── 2. default rubric: clean PASS; bad trace FAILS the right criteria ─────────────────────────────

ok('default rubric: a clean ok-trace with a verifying receipt PASSES', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/onboard/clean');
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier });
  assert.strictEqual(out.record.passed, true, 'clean trace passes');
  assert.strictEqual(out.record.normalized, 1, 'perfect normalized score');
  for (const c of out.record.criteria) assert.strictEqual(c.pass, true, `${c.id} passes`);
  assert.deepStrictEqual(out.record.lessons, [], 'no lessons when everything passes');
});

ok('default rubric: an error-step + no-outputs trace FAILS exactly the right criteria', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/onboard/broken', { outputs: [], result: 'error', errStep: true });
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier });
  const byId = Object.fromEntries(out.record.criteria.map((c) => [c.id, c]));
  assert.strictEqual(byId['result-ok'].pass, false, 'result!=ok fails');
  assert.strictEqual(byId['no-error-steps'].pass, false, 'error step fails');
  assert.strictEqual(byId['outputs-present'].pass, false, 'no outputs fails');
  // trace-integrity still PASSES (the receipt itself is honest — only the work failed)
  assert.strictEqual(byId['trace-integrity'].pass, true, 'integrity independent of task success');
  assert.strictEqual(out.record.passed, false, 'overall fails');
});

ok('cost-within-budget: informational with no budget; fails when over budget', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/onboard/costly'); // total cost = 5u
  const noBudget = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier });
  assert.strictEqual(noBudget.record.criteria.find((c) => c.id === 'cost-within-budget').pass, true, 'no budget → pass (informational)');
  const overBudget = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier, budget: 2 });
  const cb = overBudget.record.criteria.find((c) => c.id === 'cost-within-budget');
  assert.strictEqual(cb.pass, false, '5u > 2u budget → fail');
  assert.ok(cb.score < 1 && cb.score >= 0, 'score degrades, never negative');
});

// ── 2b. TRACE-INTEGRITY: verify-as-a-criterion (pass for verifying, fail for tampered) ──────────────

ok('trace-integrity PASSES for a verifying receipt (chain + signature + input-hash match)', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/trust/good');
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier });
  const ti = out.record.criteria.find((c) => c.id === 'trace-integrity');
  assert.strictEqual(ti.pass, true);
  assert.strictEqual(ti.score, 1);
});

ok('trace-integrity FAILS CLOSED for a tampered trace (steps no longer hash to receipt input_hash)', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/trust/tampered-trace');
  // forge the recorded work AFTER the receipt was signed
  const forged = JSON.parse(JSON.stringify(res.trace));
  forged.steps[1].cost_units = 999999;
  assert.notStrictEqual(traceInputHash(forged), res.receipt.input_hash, 'precondition: hash now differs');
  const out = evaluate({ taskPath, root: ROOT, trace: forged, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier });
  const ti = out.record.criteria.find((c) => c.id === 'trace-integrity');
  assert.strictEqual(ti.pass, false, 'edited trace fails integrity');
  assert.strictEqual(out.record.passed, false, 'overall fails');
});

ok('trace-integrity FAILS CLOSED for a tampered receipt (altered field breaks the chain hash)', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/trust/tampered-receipt');
  // mutate the in-memory receipt chain so its stored hash no longer matches the body
  kit.log.chain[0].cost_units = 424242;
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: kit.log.chain[0], receiptLog: kit.log, verifier: kit.verifier });
  const ti = out.record.criteria.find((c) => c.id === 'trace-integrity');
  assert.strictEqual(ti.pass, false, 'altered receipt fails integrity');
});

ok('trace-integrity does NOT pass when no receipt/verifier is available (absence of proof ≠ pass)', () => {
  const { taskPath, res } = cleanTrace('acme/web/trust/unproven');
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace }); // no receipt, no verifier
  const ti = out.record.criteria.find((c) => c.id === 'trace-integrity');
  assert.strictEqual(ti.pass, false, 'unverified → not a pass');
  assert.ok(/unverified|no receipt|unproven/i.test(ti.detail), 'honest detail');
});

// ── 3. eval ↔ trace linkage ──────────────────────────────────────────────────────────────────────

ok('eval links back into the trace (eval_path) and references trace_path + receipt_path', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/link/back');
  // the trace file on disk has NO eval_path yet
  const before = readTrace(res.file);
  assert.strictEqual(before.eval_path, '', 'trace starts with no eval link');
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier });
  // after eval, the persisted trace points at the eval scorecard (bidirectional link)
  const after = readTrace(res.file);
  assert.strictEqual(after.eval_path, out.mdFile, 'trace.eval_path written back');
  // and the eval references the trace + receipt
  assert.ok(out.record.trace_path && out.record.trace_path.endsWith(path.join('back', 'traces', 'back.json')), 'eval references trace');
  assert.ok(out.record.receipt_path, 'eval references the receipt path');
  assert.strictEqual(out.record.receipt_path, res.trace.receipt_path);
});

// ── 4. lessons + determinism ───────────────────────────────────────────────────────────────────

ok('failed criteria emit structured candidate lessons (the seam for Increment 3)', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/learn/lessons', { outputs: [], result: 'error', errStep: true });
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier });
  const ids = out.record.lessons.map((l) => l.criterion).sort();
  assert.deepStrictEqual(ids, ['no-error-steps', 'outputs-present', 'result-ok'], 'one lesson per failed criterion');
  for (const l of out.record.lessons) {
    assert.ok(l.criterion && l.severity && l.detail, 'lesson shape');
    assert.ok(l.suggested_instruction && l.suggested_instruction.length > 0, 'a non-empty suggested_instruction');
    assert.strictEqual(l.source, 'rubric');
  }
});

ok('deterministic: same trace → identical score, criteria, and lessons', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/learn/determinism', { outputs: [], result: 'partial' });
  const a = evaluate({ taskPath, root: ROOT, trace: JSON.parse(JSON.stringify(res.trace)), receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier, now: () => 111 });
  const b = evaluate({ taskPath, root: ROOT, trace: JSON.parse(JSON.stringify(res.trace)), receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier, now: () => 222 });
  // evaluated timestamp differs (injected clock), everything substantive is identical
  assert.strictEqual(a.record.score, b.record.score);
  assert.strictEqual(a.record.normalized, b.record.normalized);
  assert.strictEqual(a.record.passed, b.record.passed);
  assert.deepStrictEqual(a.record.criteria, b.record.criteria);
  assert.deepStrictEqual(a.record.lessons, b.record.lessons);
});

// ── 5. judge hook — OFF by default, never fabricates ─────────────────────────────────────────────

ok('judge hook is OFF by default (deterministic-only)', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/judge/off');
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier });
  assert.strictEqual(out.record.judge.used, false);
  assert.strictEqual(out.record.judge.criteria, 0);
  assert.strictEqual(out.record.criteria.length, DEFAULT_RUBRIC.length, 'no extra criteria');
});

ok('a working judge adds subjective criteria, kept separate + reproducible base score', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/judge/on');
  const judge = () => [{ id: 'tone', pass: true, score: 0.8, detail: 'clear and concise', severity: 'low' }];
  const out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier, judge });
  assert.strictEqual(out.record.judge.used, true);
  const tone = out.record.criteria.find((c) => c.id === 'tone');
  assert.ok(tone && tone.judge === true, 'judge criterion tagged');
  assert.strictEqual(tone.score, 0.8);
});

ok('a THROWING/absent judge never crashes or fabricates — degrades to deterministic-only', () => {
  const { taskPath, res, kit } = cleanTrace('acme/web/judge/throws');
  let out;
  assert.doesNotThrow(() => {
    out = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier, judge: () => { throw new Error('judge model down'); } });
  });
  assert.strictEqual(out.record.judge.used, false, 'a thrown judge contributes nothing');
  assert.strictEqual(out.record.criteria.length, DEFAULT_RUBRIC.length, 'only deterministic criteria');
  assert.strictEqual(out.record.passed, true, 'clean trace still passes deterministically');
  // a non-function judge is simply ignored
  const out2 = evaluate({ taskPath, root: ROOT, trace: res.trace, receipt: res.receipt, receiptLog: kit.log, verifier: kit.verifier, judge: 'not-a-fn' });
  assert.strictEqual(out2.record.judge.used, false);
});

// ── 6. input validation + the CLI gate ──────────────────────────────────────────────────────────

ok('evaluate() validates inputs (deny-by-default on a missing/bad trace or task)', () => {
  assert.throws(() => evaluate({ taskPath: 'acme/web/onboard/signup' }), /trace/, 'no trace');
  assert.throws(() => evaluate({ taskPath: 'acme/web/onboard/signup', trace: { steps: 'nope' } }), /steps/, 'bad trace');
  assert.throws(() => evaluate({ taskPath: 'no/such/task/here', trace: { steps: [], result: 'ok' } }), /incomplete|no task/, 'task must exist');
});

import { run as runCli } from './src/cli/stratos-cli.js';
import { parseCapabilities } from './src/security/capability-gate.js';
const DENY = parseCapabilities({ capabilities: { actions: [] } });

ok('CLI: stratos eval scores the task trace and writes the scorecard', async () => {
  const { taskPath, kit } = cleanTrace('cli/proj/flow/task1');
  // inject the kit's public key so verify-as-a-criterion runs against the real receipt
  const r = await runCli(['eval', taskPath], { workspacesRoot: ROOT, evalPublicKeyBundle: kit.kp.publicKey });
  assert.strictEqual(r.code, 0, 'eval succeeds');
  const out = r.lines.join('\n');
  assert.ok(out.includes('eval'), 'mentions eval');
  assert.ok(fs.existsSync(path.join(ROOT, 'cli', 'proj', 'flow', 'task1', 'evals', 'task1.md')));
  assert.ok(fs.existsSync(path.join(ROOT, 'cli', 'proj', 'flow', 'task1', 'evals', 'task1.json')));
});

ok('CLI: eval on a task with no trace is an honest error (not a fabricated score)', async () => {
  createTask('cli', 'proj', 'flow', 'untraced', opt);
  const r = await runCli(['eval', 'cli/proj/flow/untraced'], { workspacesRoot: ROOT });
  assert.strictEqual(r.code, 1);
  assert.ok(r.lines.join('\n').toLowerCase().includes('no trace'));
});

ok('CLI: stratos eval is capability-gated deny-by-default; help is ungated', async () => {
  const { taskPath } = cleanTrace('cli/proj/flow/gated');
  assert.strictEqual((await runCli(['eval', taskPath], { workspacesRoot: ROOT, workspaceCaps: DENY })).code, 1, 'denied caps → exit 1');
  assert.strictEqual((await runCli(['eval', 'help'], { workspacesRoot: ROOT, workspaceCaps: DENY })).code, 0, 'help reachable');
});

ok('CLI: eval is in the COMMANDS surface', async () => {
  const { COMMANDS } = await import('./src/cli/stratos-cli.js');
  assert.ok(COMMANDS.includes('eval'), 'COMMANDS has eval');
});

// Run every case in order, then clean up.
for (const [name, fn] of _cases) { await fn(); console.log(`  ✓ ${name}`); pass++; }
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n✅ ${pass}/${pass} eval-engine tests passed — deterministic rubric, verify-as-a-criterion, candidate lessons, judge degrade, gated CLI.`);
