// test-operating-core.mjs — INCREMENT 1: the FILES-FIRST OPERATIONAL CORE.
//
// Hermetic: pure fs + crypto in an isolated tmp dir — no network, no Ollama, no daemon, no on-disk
// keys (the node keypair is generated in-process and injected). Proves the durable layer the whole
// thesis rests on:
//   1. workspace-tree   — create/resolve/list the Workspace>…>Task tree; a Task scaffolds EXACTLY the
//                          eight canonical entries; path-traversal is rejected; re-create is idempotent.
//   2. context-capture  — capture() writes a record matching EVERY CONTEXT_CAPTURE_SCHEMA field,
//                          persists raw→data/, structured→memory/, appends the workspace session log;
//                          classify() is deterministic.
//   3. trace-engine     — start→steps→end writes a valid TRACE_SCHEMA record, chains a capability-
//                          receipt that VERIFIES with the public key, and tampering fails CLOSED.
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspace, createProject, createWorkflow, createTask, createSubtask,
  resolveTask, listTree, listWorkspaces, safeSegment, TASK_SCAFFOLD, TASK_DIRS,
} from './src/workspace/workspace-tree.js';
import { capture, classify, RECORD_FIELDS, SOURCES } from './src/context/context-capture.js';
import { startTrace, recordStep, endTrace, readTrace, traceInputHash, STEP_KINDS } from './src/trace/trace-engine.js';
import { ReceiptLog, makeReceiptSigner, makeReceiptVerifier } from './src/ledger/capability-receipt.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { originId } from './src/memory/skill-seal.js';

let pass = 0;
const _cases = [];
const ok = (name, fn) => { _cases.push([name, fn]); };

// One isolated workspaces root for the whole run — NEVER touches the repo's real .stratos-profile.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'opcore-'));
const opt = { root: ROOT };

console.log('operating core — files-first workspace · deterministic capture · receipt-chained trace\n');

// ── 1. workspace-tree ──────────────────────────────────────────────────────────────────────────

ok('createTask scaffolds EXACTLY the 8 canonical entries (idempotent, never clobbers)', () => {
  const r = createTask('acme', 'webapp', 'onboard', 'signup', opt);
  assert.strictEqual(r.created, true);
  const entries = fs.readdirSync(r.path).sort();
  assert.deepStrictEqual(entries, [...TASK_SCAFFOLD].sort(), 'exactly the 8 entries, nothing more');
  // dirs are real dirs, files are real files
  for (const d of TASK_DIRS) assert.ok(fs.statSync(path.join(r.path, d)).isDirectory(), `${d} is a dir`);
  assert.ok(fs.statSync(path.join(r.path, 'instructions.md')).isFile());
  assert.ok(fs.statSync(path.join(r.path, 'tools.json')).isFile());
  // tools.json is valid JSON with a deny-by-default capabilities block
  const tools = JSON.parse(fs.readFileSync(path.join(r.path, 'tools.json'), 'utf8'));
  assert.deepStrictEqual(tools.capabilities.actions, []);
});

ok('createTask is idempotent — a re-create adds nothing and preserves user edits', () => {
  const file = path.join(ROOT, 'acme', 'webapp', 'onboard', 'signup', 'instructions.md');
  fs.writeFileSync(file, '# my edited instructions\n');
  const r2 = createTask('acme', 'webapp', 'onboard', 'signup', opt);
  assert.strictEqual(r2.created, false, 'already existed');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '# my edited instructions\n', 'user edit preserved');
});

ok('resolveTask returns the path + named parts + scaffold OK', () => {
  const t = resolveTask('acme/webapp/onboard/signup', opt);
  assert.strictEqual(t.scaffold.ok, true);
  assert.deepStrictEqual(t.scaffold.missing, []);
  assert.deepStrictEqual([t.workspace, t.project, t.workflow, t.task], ['acme', 'webapp', 'onboard', 'signup']);
  assert.ok(t.dirs.memory.endsWith(path.join('signup', 'memory')));
});

ok('resolveTask on an incomplete folder fails deny-by-default', () => {
  fs.mkdirSync(path.join(ROOT, 'acme', 'webapp', 'onboard', 'bare'), { recursive: true });
  assert.throws(() => resolveTask('acme/webapp/onboard/bare', opt), /incomplete|missing/);
  // with requireScaffold:false it reports rather than throws
  const t = resolveTask('acme/webapp/onboard/bare', { ...opt, requireScaffold: false });
  assert.strictEqual(t.scaffold.ok, false);
  assert.ok(t.scaffold.missing.length > 0);
});

ok('subtask is itself a fully-scaffolded task nested under its parent', () => {
  const r = createSubtask('acme', 'webapp', 'onboard', 'signup', 'email-verify', opt);
  assert.deepStrictEqual(fs.readdirSync(r.path).sort(), [...TASK_SCAFFOLD].sort());
  const t = resolveTask('acme/webapp/onboard/signup/email-verify', opt);
  assert.strictEqual(t.scaffold.ok, true);
  assert.strictEqual(t.subtask, 'email-verify');
});

ok('path-traversal is REJECTED everywhere (the load-bearing security check)', () => {
  for (const bad of ['..', '../evil', 'a/b', 'a\\b', 'foo\0bar', '.', '.hidden', '', '   ']) {
    assert.throws(() => safeSegment(bad), /string|empty|separator|invalid|valid path/, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => createWorkspace('../escape', opt), /separator|invalid/);
  assert.throws(() => createTask('acme', '..', 'wf', 'tk', opt), /valid path|invalid/);
  assert.throws(() => resolveTask('../../etc/passwd/x', opt), /valid path|invalid|separator/);
  // a resolved path can never land outside the root
  const t = resolveTask('acme/webapp/onboard/signup', opt);
  assert.ok(path.resolve(t.path).startsWith(path.resolve(ROOT) + path.sep), 'inside root');
});

ok('the parent chain is auto-created; listTree types task nodes correctly', () => {
  createTask('acme', 'mobile', 'auth', 'login', opt); // brand-new project+workflow
  assert.ok(fs.existsSync(path.join(ROOT, 'acme', 'mobile', 'auth', 'login', 'tools.json')));
  const tree = listTree('acme', opt);
  assert.strictEqual(tree.type, 'workspace');
  assert.strictEqual(tree.name, 'acme');
  const find = (n, name) => n.name === name ? n : n.children.map((c) => find(c, name)).find(Boolean);
  const login = find(tree, 'login');
  assert.strictEqual(login.type, 'task', 'a folder with the 8 entries is a task');
  // task content dirs (data/, memory/, …) are NOT walked as tree children
  assert.deepStrictEqual(login.children, []);
});

ok('listWorkspaces + listTree(absent) are honest', () => {
  assert.deepStrictEqual(listWorkspaces(opt), ['acme']);
  assert.strictEqual(listTree('does-not-exist', opt), null);
});

// ── 2. context-capture ───────────────────────────────────────────────────────────────────────

ok('classify() is deterministic: source taxonomy + coarse intent', () => {
  assert.strictEqual(classify({ source: 'CHAT' }).source, 'chat');     // normalized
  assert.strictEqual(classify({ source: 'nonsense' }).source, 'api');   // unknown → api (deny-by-default)
  assert.strictEqual(classify({ source: 'chat', raw: 'how do I fix the login bug?' }).intent, 'question');
  assert.strictEqual(classify({ source: 'repo', raw: 'fix the crash' }).intent, 'fix');
  assert.strictEqual(classify({ source: 'chat', raw: 'build a signup form' }).intent, 'build');
  assert.strictEqual(classify({ source: 'chat', user_intent: 'ship v1' }).intent, 'stated');
  // pure function — same input, same output
  assert.deepStrictEqual(classify({ source: 'file', raw: 'review the audit' }), classify({ source: 'file', raw: 'review the audit' }));
  assert.ok(SOURCES.includes('mcp'));
});

ok('capture() writes a record matching EVERY CONTEXT_CAPTURE_SCHEMA field', () => {
  const rec = capture({
    task: 'acme/webapp/onboard/signup',
    source: 'chat',
    raw: 'how do I fix the login bug?',
    repo: 'efficientlabs-web',
    entities: ['login'], decisions: ['use OAuth'], tools_used: ['grep'],
    outputs: ['patch.diff'], next_actions: ['test'], permissions: ['fs.read'],
    model_used: 'gemma2:2b',
  }, { ...opt, now: () => 1700000000000, id: () => 'cap-1' });

  for (const f of RECORD_FIELDS) assert.ok(f in rec, `record has field "${f}"`);
  assert.strictEqual(rec.id, 'cap-1');
  assert.strictEqual(rec.timestamp, new Date(1700000000000).toISOString());
  assert.strictEqual(rec.source, 'chat');
  assert.strictEqual(rec.project, 'webapp');
  assert.strictEqual(rec.workflow, 'onboard');
  assert.strictEqual(rec.task, 'signup');
  assert.strictEqual(rec.user_intent, 'question'); // classified (no explicit intent)
  assert.deepStrictEqual(rec.entities, ['login']);
  assert.deepStrictEqual(rec.permissions, ['fs.read']);
});

ok('capture() persists raw→data/, structured→memory/, appends the workspace session log', () => {
  const rec = capture({ task: 'acme/webapp/onboard/signup', source: 'terminal', raw: 'RAW PAYLOAD ABC' },
    { ...opt, now: () => 1700000001000, id: () => 'cap-2' });
  // raw is verbatim in data/
  assert.ok(rec._paths.raw.includes(path.join('signup', 'data')));
  assert.strictEqual(fs.readFileSync(rec._paths.raw, 'utf8'), 'RAW PAYLOAD ABC');
  // structured record JSON in memory/
  assert.ok(rec._paths.record.includes(path.join('signup', 'memory')));
  const onDisk = JSON.parse(fs.readFileSync(rec._paths.record, 'utf8'));
  assert.strictEqual(onDisk.id, 'cap-2');
  // session log at the WORKSPACE level, one JSON line per capture
  assert.strictEqual(rec._paths.sessionLog, path.join(ROOT, 'acme', 'session.log'));
  const lines = fs.readFileSync(rec._paths.sessionLog, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 2, 'a line per capture accrued');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.id, 'cap-2');
  assert.strictEqual(last.task, 'acme/webapp/onboard/signup');
});

ok('capture() requires an existing task (deny-by-default) and a task field', () => {
  assert.throws(() => capture({ source: 'chat', raw: 'x' }, opt), /task/);
  assert.throws(() => capture({ task: 'no/such/task/here', raw: 'x' }, opt), /incomplete|no task/);
});

ok('the LLM-assist summarizer is a TARGET hook — OFF by default, never fabricated', () => {
  // default: no summarize → empty summary (honest, never invented)
  const a = capture({ task: 'acme/webapp/onboard/signup', source: 'chat', raw: 'hello' },
    { ...opt, now: () => 1700000002000, id: () => 'cap-3' });
  assert.strictEqual(a.summary, '');
  // explicit opt-in hook: only THEN does a summary appear
  const b = capture({ task: 'acme/webapp/onboard/signup', source: 'chat', raw: 'hello' },
    { ...opt, now: () => 1700000003000, id: () => 'cap-4', summarize: () => 'a synthesized summary' });
  assert.strictEqual(b.summary, 'a synthesized summary');
  // a throwing hook degrades to no summary, never a fake one
  const c = capture({ task: 'acme/webapp/onboard/signup', source: 'chat', raw: 'hi' },
    { ...opt, now: () => 1700000004000, id: () => 'cap-5', summarize: () => { throw new Error('model down'); } });
  assert.strictEqual(c.summary, '');
});

// ── 3. trace-engine ──────────────────────────────────────────────────────────────────────────

function freshTraceKit() {
  const kp = generateHybridKeyPair();
  const nodeId = originId(kp.publicKey);
  let t = 5000; const now = () => (t += 1);
  let n = 0; const jti = () => `rcpt-${++n}`;
  const log = new ReceiptLog({ signer: makeReceiptSigner(kp.privateKey), verifier: makeReceiptVerifier(kp.publicKey), nodeId, now, jti });
  return { kp, nodeId, now, log };
}

ok('start→steps→end writes a valid TRACE_SCHEMA record with full tool-call step fields', () => {
  const { nodeId, now, log } = freshTraceKit();
  const h = startTrace({ task: 'acme/webapp/onboard/signup', model_used: 'gemma2:2b', model_class: 'openweight', root: ROOT, now });
  recordStep(h, { kind: 'plan', summary: 'plan it', who: nodeId, model: 'gemma2:2b', permission: 'plan' });
  recordStep(h, { kind: 'tool', tool: 'fs.write', who: nodeId, model: 'gemma2:2b', permission: 'fs.write', input: 'in', output: 'out', cost_units: 4, approval: true });
  const res = endTrace(h, { result: 'ok', outputs: ['done'], receiptLog: log, actor_id: nodeId, now });
  const tr = readTrace(res.file);

  const schemaFields = ['task_id', 'parent_task', 'workspace', 'project', 'workflow', 'started', 'ended',
    'model_used', 'model_class', 'steps', 'tools_used', 'outputs', 'approval_required', 'approved_by', 'result', 'receipt_path', 'eval_path'];
  for (const f of schemaFields) assert.ok(f in tr, `trace has field "${f}"`);
  assert.strictEqual(tr.task_id, 'signup');
  assert.strictEqual(tr.result, 'ok');
  assert.strictEqual(tr.model_class, 'openweight');
  assert.deepStrictEqual(tr.tools_used, ['fs.write']);
  // every step logs who/model/data-hash/permission/output-hash/approval
  const stepFields = ['i', 'kind', 'summary', 'tool', 'who', 'model', 'permission', 'input_hash', 'output_hash', 'approval', 'cost_units'];
  for (const f of stepFields) assert.ok(f in tr.steps[0], `step has field "${f}"`);
  assert.strictEqual(tr.steps[1].approval, true);
  assert.strictEqual(tr.steps[1].permission, 'fs.write');
  assert.ok(STEP_KINDS.includes(tr.steps[0].kind));
  // the file is at <task>/traces/{task-id}.json
  assert.ok(res.file.endsWith(path.join('signup', 'traces', 'signup.json')));
});

ok('endTrace mints a capability-receipt as the tamper-evident spine; receipt_path is stored', () => {
  const { nodeId, now, log } = freshTraceKit();
  const h = startTrace({ task: 'acme/webapp/onboard/signup', model_used: 'gemma2:2b', root: ROOT, now });
  recordStep(h, { kind: 'model', summary: 'infer', who: nodeId, model: 'gemma2:2b', permission: 'model', input: 'p', output: 'a', cost_units: 7 });
  const res = endTrace(h, { result: 'ok', outputs: ['answer'], receiptLog: log, actor_id: nodeId, now });
  assert.ok(res.receipt, 'a receipt was minted');
  assert.strictEqual(res.receipt.action, 'skill-run');
  assert.strictEqual(res.receipt.ref, 'signup');
  assert.strictEqual(res.receipt.cost_units, 7, 'defaults to summed step cost');
  // the receipt binds the trace: input_hash = hash of the canonical steps
  assert.strictEqual(res.receipt.input_hash, traceInputHash(res.trace));
  // the trace records WHERE the receipt lives
  assert.match(res.trace.receipt_path, /in-memory|receipts/);
});

ok('the receipt chain VERIFIES with ONLY the public key (third-party-verifiable spine)', () => {
  const kp = generateHybridKeyPair();
  const nodeId = originId(kp.publicKey);
  const log = new ReceiptLog({ signer: makeReceiptSigner(kp.privateKey), verifier: makeReceiptVerifier(kp.publicKey), nodeId });
  const h = startTrace({ task: 'acme/webapp/onboard/signup', model_used: 'gemma2:2b', root: ROOT });
  recordStep(h, { kind: 'io', who: nodeId, model: 'gemma2:2b', permission: 'fs.write', input: 'a', output: 'b', cost_units: 2 });
  endTrace(h, { result: 'ok', outputs: ['ok'], receiptLog: log, actor_id: nodeId });
  // a verifier holding only the PUBLIC key confirms the signature + chain
  const pubOnlyVerifier = makeReceiptVerifier(kp.publicKey);
  const replay = new ReceiptLog({ verifier: pubOnlyVerifier });
  replay.chain = log.entries();
  assert.strictEqual(replay.verify({ requireSig: true }).ok, true, 'verifies with public key alone');
  // a DIFFERENT node's key cannot verify it
  const other = makeReceiptVerifier(generateHybridKeyPair().publicKey);
  const wrong = new ReceiptLog({ verifier: other });
  wrong.chain = log.entries();
  assert.strictEqual(wrong.verify({ requireSig: true }).ok, false, 'wrong signer rejected');
});

ok('tampering the trace/receipt fails CLOSED', () => {
  const { nodeId, now, log } = freshTraceKit();
  const h = startTrace({ task: 'acme/webapp/onboard/signup', model_used: 'gemma2:2b', root: ROOT, now });
  recordStep(h, { kind: 'tool', tool: 'fs.write', who: nodeId, model: 'gemma2:2b', permission: 'fs.write', input: 'a', output: 'b', cost_units: 3 });
  const res = endTrace(h, { result: 'ok', outputs: ['x'], receiptLog: log, actor_id: nodeId, now });

  // (a) tamper a receipt field → hash mismatch caught (mutate the in-memory chain, re-verify)
  log.chain[0].cost_units = 999999;
  assert.strictEqual(log.verify().ok, false, 'altered receipt field fails closed');

  // (b) tamper the persisted TRACE so its steps no longer hash to the receipt's input_hash → mismatch
  const tr = readTrace(res.file);
  tr.steps[0].cost_units = 111; // forge the recorded work
  assert.notStrictEqual(traceInputHash(tr), res.receipt.input_hash,
    'an edited trace no longer matches the signed receipt input_hash (tamper-evident)');
});

ok('endTrace is fail-OPEN: a throwing signer never breaks the trace (just no receipt)', () => {
  const kp = generateHybridKeyPair();
  const nodeId = originId(kp.publicKey);
  const log = new ReceiptLog({ signer: () => { throw new Error('signer exploded'); }, verifier: makeReceiptVerifier(kp.publicKey), nodeId });
  const h = startTrace({ task: 'acme/webapp/onboard/signup', model_used: 'gemma2:2b', root: ROOT });
  recordStep(h, { kind: 'io', who: nodeId, input: 'a', output: 'b' });
  let res;
  assert.doesNotThrow(() => { res = endTrace(h, { result: 'ok', receiptLog: log, actor_id: nodeId }); });
  assert.strictEqual(res.receipt, null, 'no receipt when the signer fails');
  assert.ok(fs.existsSync(res.file), 'but the trace is still written (fail-open)');
});

// ── 4. CLI exercisers (workspace · task · capture · trace) — capability-gated deny-by-default ───

import { run as runCli } from './src/cli/stratos-cli.js';
import { parseCapabilities } from './src/security/capability-gate.js';

const DENY = parseCapabilities({ capabilities: { actions: [] } }); // no actions granted

ok('CLI: workspace create + tree + task create scaffold under the injected root', async () => {
  const r1 = await runCli(['workspace', 'create', 'cli-ws'], { workspacesRoot: ROOT });
  assert.strictEqual(r1.code, 0);
  assert.ok(fs.existsSync(path.join(ROOT, 'cli-ws', 'session.log')));
  const r2 = await runCli(['task', 'create', 'cli-ws/proj/flow/task1'], { workspacesRoot: ROOT });
  assert.strictEqual(r2.code, 0);
  assert.ok(fs.existsSync(path.join(ROOT, 'cli-ws', 'proj', 'flow', 'task1', 'tools.json')));
  const r3 = await runCli(['workspace', 'tree', 'cli-ws'], { workspacesRoot: ROOT });
  assert.strictEqual(r3.code, 0);
  assert.ok(r3.lines.join('\n').includes('task1'));
});

ok('CLI: capture writes a record + classifies via the command path', async () => {
  const r = await runCli(['capture', 'cli-ws/proj/flow/task1', 'how do I fix this?'], { workspacesRoot: ROOT });
  assert.strictEqual(r.code, 0);
  assert.ok(r.lines.join('\n').includes('captured'));
  // a record landed in memory/
  assert.ok(fs.readdirSync(path.join(ROOT, 'cli-ws', 'proj', 'flow', 'task1', 'memory')).length >= 1);
});

ok('CLI: trace exerciser writes a trace + a verifiable signed receipt', async () => {
  const r = await runCli(['trace', 'cli-ws/proj/flow/task1'], { workspacesRoot: ROOT });
  assert.strictEqual(r.code, 0);
  const out = r.lines.join('\n');
  assert.ok(out.includes('trace written'));
  assert.ok(out.includes('verified'), 'receipt verified with the public key only');
  assert.ok(fs.existsSync(path.join(ROOT, 'cli-ws', 'proj', 'flow', 'task1', 'traces', 'task1.json')));
});

ok('CLI: the operating-core surface is capability-gated deny-by-default', async () => {
  const denied = { workspacesRoot: ROOT, workspaceCaps: DENY };
  assert.strictEqual((await runCli(['workspace', 'create', 'nope'], denied)).code, 1);
  assert.strictEqual((await runCli(['task', 'create', 'nope/a/b/c'], denied)).code, 1);
  assert.strictEqual((await runCli(['capture', 'cli-ws/proj/flow/task1', 'x'], denied)).code, 1);
  assert.strictEqual((await runCli(['trace', 'cli-ws/proj/flow/task1'], denied)).code, 1);
  // help is always reachable (no gate)
  assert.strictEqual((await runCli(['workspace', 'help'], denied)).code, 0);
});

ok('CLI: the new commands are in the COMMANDS surface', async () => {
  const { COMMANDS } = await import('./src/cli/stratos-cli.js');
  for (const c of ['workspace', 'task', 'capture', 'trace']) assert.ok(COMMANDS.includes(c), `COMMANDS has ${c}`);
});

// Run every registered case in order, then clean up the isolated root.
for (const [name, fn] of _cases) { await fn(); console.log(`  ✓ ${name}`); pass++; }
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\n✅ ${pass}/${pass} operating-core tests passed — files-first map, deterministic capture, receipt-chained trace, fail-closed/fail-open.`);
