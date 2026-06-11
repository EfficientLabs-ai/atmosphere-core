/**
 * eval-engine.js — the EVALUATE leg of the operating core (Increment 2).
 *
 * "Every trace gets scored." This is the `trace → evaluation → lesson → instruction → skill` loop's
 * second hop (TRACE_SCHEMA.md §Self-improvement; SELF_IMPROVEMENT_LOOP.md). It takes a finished trace
 * record (the one trace-engine.js writes + the capability-receipt it chained as the tamper-evident
 * spine) and produces an EvalRecord: a deterministic, rubric-driven scorecard written BOTH human-
 * readable (`<task>/evals/{task-id}.md`) and structured (`<task>/evals/{task-id}.json`), and links the
 * eval back into the trace (`trace.eval_path`) so the trace ↔ eval relationship is bidirectional.
 *
 * THE RUBRIC IS DETERMINISTIC. A rubric is an array of criteria; each criterion has a pure
 * `checker(trace, ctx) -> {pass, score, detail}`. The DEFAULT rubric scores ANY trace on five axes:
 *   result-ok · no-error-steps · outputs-present · cost-within-budget · TRACE-INTEGRITY.
 * TRACE-INTEGRITY is the load-bearing one: it re-runs the SAME verify path the receipt uses
 * (ReceiptLog.verify + traceInputHash from trace-engine) — "verify-as-a-criterion" — so a tampered
 * trace/receipt fails the eval, fail-closed. No criterion calls a model or the network.
 *
 * LESSON HOOKS (the seam for Increment 3). Each FAILED criterion emits a structured candidate lesson
 * `{ criterion, detail, suggested_instruction, severity }`. Increment 3 (self-improvement) will consume
 * these to propose updated instructions / new skills. This module ONLY emits them — it does not learn.
 *
 * PLUGGABLE LLM-JUDGE (honest TARGET, OFF by default). `opts.judge` may add subjective criteria; a
 * throwing or absent judge degrades to deterministic-only and NEVER fabricates a score. The durable
 * score is always reproducible from the deterministic rubric alone.
 *
 * DETERMINISTIC CORE — NO LLM, NO NETWORK. Same discipline as workspace-tree / context-capture /
 * trace-engine: pure node:fs + the existing receipt verify path; injectable clock for tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveTask } from '../workspace/workspace-tree.js';
import { traceInputHash, traceOutputHash, readTrace } from '../trace/trace-engine.js';
import { ReceiptLog, makeReceiptVerifier } from '../ledger/capability-receipt.js';

/** The fields an EvalRecord carries — the contract the .json file fills (and the .md mirrors). */
export const EVAL_FIELDS = Object.freeze([
  'task_id', 'workspace', 'project', 'workflow',
  'evaluated', 'rubric', 'criteria', 'score', 'max_score', 'normalized', 'passed',
  'trace_path', 'receipt_path', 'lessons', 'judge',
]);

/** Severity buckets a failed criterion can carry (deny-by-default: unknown → 'medium'). */
export const SEVERITIES = Object.freeze(['low', 'medium', 'high']);

const clamp01 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const asStr = (v) => (v == null ? '' : String(v));

/**
 * A criterion: { id, weight, severity, suggest, checker }.
 *  - id        stable identifier (used in the scorecard + the lesson).
 *  - weight    relative weight in the aggregate (default 1).
 *  - severity  how bad a failure is, surfaced in the lesson (default 'medium').
 *  - suggest   `(detail, trace) => string` — the suggested_instruction for a FAILED criterion.
 *  - checker   `(trace, ctx) => { pass:boolean, score:0..1, detail:string }` — DETERMINISTIC, pure.
 * The checker's `score` is a 0..1 quality measure; `pass` is the boolean gate. ctx carries
 * { budget, receiptVerify } so a criterion can read the optional budget + the receipt verify result.
 */

/** result === 'ok' (the trace declared success). */
const critResultOk = {
  id: 'result-ok', weight: 1, severity: 'high',
  suggest: (d) => `The execution did not finish OK (${d}). Re-plan the failing step or add a recovery path before retrying.`,
  checker: (tr) => {
    const ok = tr.result === 'ok';
    return { pass: ok, score: ok ? 1 : 0, detail: `result="${asStr(tr.result) || '(none)'}"` };
  },
};

/** No step recorded an error (kind 'error', or a summary flagged as an error). */
const critNoErrorSteps = {
  id: 'no-error-steps', weight: 1, severity: 'high',
  suggest: (d) => `An execution step errored (${d}). Inspect that step's tool/permission and handle the failure deterministically.`,
  checker: (tr) => {
    const steps = Array.isArray(tr.steps) ? tr.steps : [];
    const bad = steps.filter((s) => s && (s.kind === 'error' || /\berror\b|\bfailed\b|\bexception\b/i.test(asStr(s.summary))));
    const ok = bad.length === 0;
    return {
      pass: ok,
      score: steps.length ? 1 - bad.length / steps.length : 1,
      detail: ok ? `${steps.length} step(s), none errored` : `${bad.length}/${steps.length} step(s) errored (i=${bad.map((s) => s.i).join(',')})`,
    };
  },
};

/** Outputs are present (the execution actually produced something). */
const critOutputsPresent = {
  id: 'outputs-present', weight: 1, severity: 'medium',
  suggest: () => 'The execution produced no outputs. Ensure the task writes its result to outputs/ and records it on the trace.',
  checker: (tr) => {
    const outs = Array.isArray(tr.outputs) ? tr.outputs.filter((o) => asStr(o).trim()) : [];
    const ok = outs.length > 0;
    return { pass: ok, score: ok ? 1 : 0, detail: ok ? `${outs.length} output(s)` : 'no outputs recorded' };
  },
};

/**
 * Cost within an OPTIONAL budget. If no budget is supplied this criterion is informational and always
 * passes (score 1) — honest: we never invent a budget. With a budget, pass iff total measured
 * cost_units <= budget; score degrades linearly past it (never negative).
 */
const critCostBudget = {
  id: 'cost-within-budget', weight: 1, severity: 'low',
  suggest: (d) => `Measured cost exceeded the budget (${d}). Route more of this task to a cheaper/local tier, or split it.`,
  checker: (tr, ctx) => {
    const total = (Array.isArray(tr.steps) ? tr.steps : []).reduce((s, x) => s + (Number(x && x.cost_units) || 0), 0);
    const budget = ctx && typeof ctx.budget === 'number' && Number.isFinite(ctx.budget) ? ctx.budget : null;
    if (budget == null) return { pass: true, score: 1, detail: `cost=${total}u (no budget set — informational)` };
    const ok = total <= budget;
    return { pass: ok, score: ok ? 1 : clamp01(budget / Math.max(total, 1)), detail: `cost=${total}u vs budget=${budget}u` };
  },
};

/**
 * TRACE-INTEGRITY — verify-as-a-criterion. Re-runs the EXACT receipt verify path:
 *  (a) the trace's canonical steps still hash to the receipt's input_hash (traceInputHash), AND
 *  (b) the capability-receipt chain + signature verify with the node's PUBLIC key (ReceiptLog.verify).
 * Fail-CLOSED: any tamper (edited step, forged receipt field, wrong signer, broken chain) FAILS this
 * criterion. If no receipt/verifier is available it is honestly reported as "unverified" and does NOT
 * pass (the proof is the point — absence of proof is not a pass).
 */
const critTraceIntegrity = {
  id: 'trace-integrity', weight: 2, severity: 'high',
  suggest: (d) => `The trace's tamper-evident receipt did not verify (${d}). Do NOT trust this run's outputs; re-execute and re-sign.`,
  checker: (tr, ctx) => {
    const rv = ctx && ctx.receiptVerify;
    if (!rv || rv.available === false) {
      return { pass: false, score: 0, detail: rv && rv.reason ? `unverified: ${rv.reason}` : 'no receipt available to verify (unproven)' };
    }
    const hashOk = rv.inputHashMatches === true;
    const sigOk = rv.chainOk === true;
    const ok = hashOk && sigOk;
    const why = [];
    if (!hashOk) why.push('trace steps no longer match receipt input_hash');
    if (!sigOk) why.push(rv.reason || 'receipt chain/signature failed');
    return { pass: ok, score: ok ? 1 : 0, detail: ok ? 'receipt verifies (chain + signature + input-hash match)' : why.join('; ') };
  },
};

/** The DEFAULT rubric — scores ANY trace. Order is the scorecard order. */
export const DEFAULT_RUBRIC = Object.freeze([
  critResultOk, critNoErrorSteps, critOutputsPresent, critCostBudget, critTraceIntegrity,
]);

/**
 * Build the receiptVerify context a criterion reads. DETERMINISTIC, no network. Re-derives the trace's
 * bound input hash and (if a receipt + verifier is available) replays the receipt chain with ONLY the
 * public key — the same fail-closed path trace-engine documented. Returns a plain, serializable result.
 *
 * @param {object} trace        the trace record being evaluated.
 * @param {object} [o]
 *   @param {object} [o.receipt]            the minted capability-receipt (as returned by endTrace).
 *   @param {ReceiptLog} [o.receiptLog]     a ReceiptLog whose chain holds the receipt (preferred — lets
 *                                          us run the real .verify()). If absent but `receipt` + verifier
 *                                          are given, a throwaway log is reconstructed from [receipt].
 *   @param {function} [o.verifier]         a receipt verifier (makeReceiptVerifier(publicBundle)).
 *   @param {object} [o.publicKeyBundle]    a public key bundle to build a verifier from (if no verifier).
 */
export function computeReceiptVerify(trace, o = {}) {
  const result = { available: false, inputHashMatches: null, chainOk: null, reason: '' };
  try {
    // (a) does the trace still hash to the receipt's bound input_hash?
    const receipt = o.receipt || null;
    if (receipt && typeof receipt.input_hash === 'string') {
      result.inputHashMatches = traceInputHash(trace) === receipt.input_hash;
    }
    // (b) replay the receipt chain with the public key only (fail-closed).
    const verifier = o.verifier || (o.publicKeyBundle ? makeReceiptVerifier(o.publicKeyBundle) : null);
    let log = o.receiptLog || null;
    if (!log && receipt && verifier) { log = new ReceiptLog({ verifier }); log.chain = [receipt]; }
    if (log) {
      result.available = true;
      const v = verifier ? log.verify({ requireSig: true }) : log.verify();
      result.chainOk = v.ok === true;
      if (!v.ok) result.reason = v.reason || 'chain verify failed';
      // If a verifier exists but we never compared the hash (no receipt object passed), locate the
      // TRACE'S OWN receipt precisely — never by log head (stale the moment newer traffic lands;
      // doubly wrong after rotation) and never by leaf task_id (not unique across tasks/days):
      //   1. by the receipt_id the trace recorded at minting (traces written since rotation landed);
      //   2. else by exact content binding: does ANY receipt in this VERIFIED chain carry this
      //      trace's input hash? A tampered trace hashes differently → nothing matches → false.
      if (result.inputHashMatches === null && log.chain.length) {
        const want = traceInputHash(trace);
        const byId = trace && trace.receipt_id
          ? log.chain.find((r) => r && r.receipt_id === trace.receipt_id) : null;
        result.inputHashMatches = byId
          ? byId.input_hash === want
          : log.chain.some((r) => r && typeof r.input_hash === 'string' && r.input_hash === want);
      }
    } else if (receipt) {
      // We have a receipt but no way to check its signature — input-hash only (honest partial).
      result.available = true;
      result.chainOk = false;
      result.reason = 'no verifier/public key supplied — signature unchecked (fail-closed)';
    } else {
      result.reason = 'no receipt supplied';
    }
  } catch (e) {
    result.available = false;
    result.reason = `verify error: ${e && e.message ? e.message : 'unknown'}`;
  }
  return result;
}

/**
 * Run ONE criterion safely. A throwing checker is treated as a FAIL with score 0 (never crashes the
 * eval, never fabricates a pass). Returns the normalized criterion result.
 */
function runCriterion(c, trace, ctx) {
  const base = { id: asStr(c.id) || 'criterion', weight: typeof c.weight === 'number' && c.weight >= 0 ? c.weight : 1,
    severity: SEVERITIES.includes(c.severity) ? c.severity : 'medium' };
  let r;
  try { r = c.checker(trace, ctx); } catch (e) { r = { pass: false, score: 0, detail: `checker threw: ${e && e.message ? e.message : 'error'}` }; }
  if (!r || typeof r !== 'object') r = { pass: false, score: 0, detail: 'checker returned no result' };
  return { ...base, pass: !!r.pass, score: clamp01(r.score), detail: asStr(r.detail) };
}

/**
 * The pluggable LLM-judge hook (TARGET, OFF by default). If `judge` is a function it is called ONCE as
 * `judge(trace, ctx) -> [{ id, pass, score, detail, severity?, suggest? }]` (or a single object). A
 * throwing/absent/malformed judge degrades to NO subjective criteria — never a fabricated score. Judge
 * criteria are tagged `judge:true` and kept SEPARATE from the deterministic ones in the aggregate split
 * so the durable score is always reproducible without a model.
 */
function runJudge(judge, trace, ctx) {
  if (typeof judge !== 'function') return [];
  let out;
  try { out = judge(trace, ctx); } catch { return []; }
  if (!out) return [];
  const arr = Array.isArray(out) ? out : [out];
  const judged = [];
  for (const j of arr) {
    if (!j || typeof j !== 'object') continue;
    judged.push({
      id: asStr(j.id) || 'judge', weight: typeof j.weight === 'number' && j.weight >= 0 ? j.weight : 1,
      severity: SEVERITIES.includes(j.severity) ? j.severity : 'medium',
      pass: !!j.pass, score: clamp01(j.score), detail: asStr(j.detail), judge: true,
      _suggest: typeof j.suggest === 'function' ? j.suggest : null,
    });
  }
  return judged;
}

/** Emit a structured candidate lesson for a FAILED criterion (the seam Increment 3 consumes). */
function lessonFor(criterion, trace) {
  let suggested = '';
  try {
    if (criterion._suggest) suggested = asStr(criterion._suggest(criterion.detail, trace));        // judge-supplied
    else {
      const def = DEFAULT_RUBRIC.find((c) => c.id === criterion.id);
      if (def && typeof def.suggest === 'function') suggested = asStr(def.suggest(criterion.detail, trace));
      else if (typeof criterion.suggest === 'function') suggested = asStr(criterion.suggest(criterion.detail, trace));
    }
  } catch { suggested = ''; }
  return {
    criterion: criterion.id,
    severity: criterion.severity,
    detail: criterion.detail,
    suggested_instruction: suggested,
    source: criterion.judge ? 'judge' : 'rubric',
  };
}

const fmtPct = (n) => `${Math.round(n * 100)}%`;

/** Render the human-readable scorecard markdown from an EvalRecord. */
function renderMarkdown(rec) {
  const lines = [];
  lines.push(`# Eval: ${rec.task_id}`);
  lines.push('');
  lines.push(`> ${[rec.workspace, rec.project, rec.workflow, rec.task_id].filter(Boolean).join(' / ')}`);
  lines.push('');
  lines.push(`**Verdict:** ${rec.passed ? '✅ PASS' : '❌ FAIL'}  ·  **Score:** ${rec.score}/${rec.max_score} (${fmtPct(rec.normalized)})  ·  **Evaluated:** ${rec.evaluated}`);
  lines.push('');
  lines.push('## Criteria');
  lines.push('');
  lines.push('| Criterion | Result | Score | Weight | Detail |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of rec.criteria) {
    lines.push(`| ${c.id}${c.judge ? ' _(judge)_' : ''} | ${c.pass ? '✅' : '❌'} | ${fmtPct(c.score)} | ${c.weight} | ${c.detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  if (rec.lessons.length) {
    lines.push('## Candidate lessons');
    lines.push('');
    lines.push('_The seam into self-improvement (Increment 3) — emitted, not yet applied._');
    lines.push('');
    for (const l of rec.lessons) {
      lines.push(`- **${l.criterion}** _(${l.severity})_ — ${l.detail}`);
      if (l.suggested_instruction) lines.push(`  - → ${l.suggested_instruction}`);
    }
    lines.push('');
  } else {
    lines.push('## Candidate lessons');
    lines.push('');
    lines.push('_None — every criterion passed._');
    lines.push('');
  }
  lines.push('## Provenance');
  lines.push('');
  lines.push(`- trace: \`${rec.trace_path || '(none)'}\``);
  lines.push(`- receipt: \`${rec.receipt_path || '(none)'}\``);
  lines.push(`- rubric: ${rec.rubric}`);
  lines.push(`- judge: ${rec.judge.used ? `used (${rec.judge.criteria} criterion/criteria)` : 'off (deterministic-only)'}`);
  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * evaluate({ taskPath, trace, rubric?, ... }) — score a finished trace, write the scorecard (.md) +
 * structured record (.json) to `<task>/evals/{task-id}.json|.md`, and link the eval back into the trace
 * (`trace.eval_path`, persisted if the trace file is on disk). Returns { record, mdFile, jsonFile, trace }.
 *
 * @param {object} o
 *   @param {string} [o.taskPath]   slash path "ws/proj/wf/task[/subtask]" (must exist). Defaults from
 *                                  the trace's workspace/project/workflow/task_id if omitted.
 *   @param {object} [o.trace]      the trace record (as returned by endTrace().trace / readTrace()).
 *   @param {string} [o.traceFile]  alternatively, a path to a persisted trace JSON to read + evaluate.
 *   @param {Array}  [o.rubric]     criteria array (default: DEFAULT_RUBRIC).
 *   @param {string} [o.root]       workspaces root (default: workspace-tree.defaultRoot()).
 *   @param {number} [o.budget]     OPTIONAL measured-cost budget for the cost criterion.
 *   @param {object} [o.receipt]    the minted capability-receipt (for trace-integrity).
 *   @param {ReceiptLog} [o.receiptLog]  the receipt log (preferred — runs the real verify()).
 *   @param {function} [o.verifier]      a receipt verifier (public-key-only).
 *   @param {object} [o.publicKeyBundle] a public key bundle to build a verifier from.
 *   @param {function} [o.judge]    *** TARGET, OFF BY DEFAULT *** subjective LLM-judge hook.
 *   @param {number} [o.passThreshold]  normalized score required to PASS (default 1.0 — every
 *                                      deterministic criterion must pass). Range 0..1.
 *   @param {function} [o.now]      injectable clock (ms) for deterministic tests.
 * @returns {object} { record, mdFile, jsonFile, trace }
 */
export function evaluate(o = {}) {
  if (!o || typeof o !== 'object') throw new Error('evaluate(o): options object required');
  let trace = o.trace || null;
  if (!trace && o.traceFile) trace = readTrace(o.traceFile);
  if (!trace || typeof trace !== 'object') throw new Error('evaluate: a trace record (o.trace) or o.traceFile is required');
  if (!Array.isArray(trace.steps)) throw new Error('evaluate: trace.steps must be an array (not a valid trace record)');

  // Resolve the task — deny-by-default: the task folder must already exist (evals/ lives there).
  const taskPath = o.taskPath
    || [trace.workspace, trace.project, trace.workflow, trace.task_id].filter(Boolean).join('/');
  const t = resolveTask(taskPath, o.root ? { root: o.root } : {});
  const taskId = t.subtask || t.task;

  const now = o.now || Date.now;
  const rubric = Array.isArray(o.rubric) && o.rubric.length ? o.rubric : DEFAULT_RUBRIC;

  // Build the deterministic verify context ONCE (no network).
  const receiptVerify = computeReceiptVerify(trace, {
    receipt: o.receipt, receiptLog: o.receiptLog, verifier: o.verifier, publicKeyBundle: o.publicKeyBundle,
  });
  const ctx = { budget: o.budget, receiptVerify, taskPath, task: t };

  // Run the deterministic rubric, then the (off-by-default) judge — kept separate in the split.
  const det = rubric.map((c) => runCriterion(c, trace, ctx));
  const judged = runJudge(o.judge, trace, ctx);
  const criteria = [...det, ...judged];

  // Aggregate: weighted score over ALL criteria; max = sum of weights. Normalized 0..1.
  const maxScore = criteria.reduce((s, c) => s + c.weight, 0) || 1;
  const rawScore = criteria.reduce((s, c) => s + c.weight * c.score, 0);
  const normalized = clamp01(rawScore / maxScore);
  const score = Math.round(rawScore * 1000) / 1000; // stable, deterministic rounding

  // PASS gate: every criterion must pass AND the normalized score must meet the threshold.
  const threshold = typeof o.passThreshold === 'number' ? clamp01(o.passThreshold) : 1;
  const allPass = criteria.every((c) => c.pass);
  const passed = allPass && normalized >= threshold;

  // Lessons: one candidate lesson per FAILED criterion (the seam for Increment 3).
  const lessons = criteria.filter((c) => !c.pass).map((c) => lessonFor(c, trace));

  const record = {
    task_id: taskId,
    workspace: t.workspace,
    project: t.project,
    workflow: t.workflow,
    evaluated: new Date(now()).toISOString(),
    rubric: rubric === DEFAULT_RUBRIC ? 'default' : 'custom',
    criteria: criteria.map((c) => ({ id: c.id, pass: c.pass, score: c.score, weight: c.weight, severity: c.severity, detail: c.detail, judge: !!c.judge })),
    score,
    max_score: maxScore,
    normalized: Math.round(normalized * 1000) / 1000,
    passed,
    trace_path: asStr(trace.receipt_path && t.path ? path.join(t.dirs.traces, `${taskId}.json`) : (o.traceFile || path.join(t.dirs.traces, `${taskId}.json`))),
    receipt_path: asStr(trace.receipt_path),
    lessons,
    judge: { used: judged.length > 0, criteria: judged.length },
  };

  // Persist BOTH artifacts to <task>/evals/.
  fs.mkdirSync(t.dirs.evals, { recursive: true });
  const jsonFile = path.join(t.dirs.evals, `${taskId}.json`);
  const mdFile = path.join(t.dirs.evals, `${taskId}.md`);
  fs.writeFileSync(jsonFile, JSON.stringify(record, null, 2) + '\n');
  fs.writeFileSync(mdFile, renderMarkdown(record));

  // Link the eval back into the trace (bidirectional). If the trace lives on disk, persist the link.
  trace.eval_path = mdFile;
  const traceFile = o.traceFile || path.join(t.dirs.traces, `${taskId}.json`);
  try {
    if (fs.existsSync(traceFile)) {
      const onDisk = readTrace(traceFile);
      onDisk.eval_path = mdFile;
      fs.writeFileSync(traceFile, JSON.stringify(onDisk, null, 2) + '\n');
    }
  } catch { /* the in-memory link is still set; an unreadable trace file is non-fatal */ }

  return { record, mdFile, jsonFile, trace };
}

/** Read a persisted EvalRecord back. */
export function readEval(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
