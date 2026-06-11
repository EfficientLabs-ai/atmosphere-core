/**
 * trace-engine.js — the TRACE leg of the operating core (Increment 1).
 *
 * "Every execution produces a trace." This writes the FULL TRACE_SCHEMA.md operational record to
 * `<task>/traces/{task-id}.json`, logging per step the tool-call fields the schema mandates: who
 * requested it, which model, what data it touched (hashes), what permission allowed it, what output
 * it produced (hash), and whether approval was required.
 *
 * THE RECEIPT IS THE TAMPER-EVIDENT SPINE. On endTrace, this mints a PQC-signed, hash-chained
 * capability-receipt via the EXISTING `ledger/capability-receipt.js` (no new crypto) and stores its
 * location in the trace's `receipt_path`. Per TRACE_SCHEMA.md: "the receipt is its tamper-evident
 * spine. Where they overlap, the receipt is the source of truth." A third party can later verify the
 * receipt with only the node's public key — proving the trace's in/out hashes were not altered.
 *
 * DETERMINISTIC CORE — NO LLM, NO NETWORK. The signer/verifier are INJECTED exactly like ReceiptLog's,
 * so this stays pure and hermetically testable. `eval_path` is left as a TARGET hook (the eval-engine
 * is not built here; the field is honestly carried but not populated).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { resolveTask } from '../workspace/workspace-tree.js';
import { ReceiptLog, hashContent } from '../ledger/capability-receipt.js';

const sha256 = (s) => crypto.createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');

/** Step kinds the schema enumerates (TRACE_SCHEMA.md). Deny-by-default: unknown → "io". */
export const STEP_KINDS = Object.freeze(['plan', 'tool', 'model', 'subagent', 'io']);
/** Model classes the schema enumerates. */
export const MODEL_CLASSES = Object.freeze(['frontier', 'openweight', 'user-provided']);

/**
 * startTrace — begin a trace for a resolved task. Returns a mutable trace handle.
 * @param {object} o
 *   @param {string} o.task          REQUIRED slash path "ws/proj/wf/task[/subtask]" (must exist).
 *   @param {string} [o.root]        workspaces root (default: workspace-tree.defaultRoot()).
 *   @param {string} [o.model_used]  the model that ran this execution.
 *   @param {'frontier'|'openweight'|'user-provided'} [o.model_class]  defaults to 'openweight' (local-first).
 *   @param {string} [o.parent_task] optional parent task id.
 *   @param {boolean} [o.approval_required]
 *   @param {function} [o.now]       injectable clock (ms) for deterministic tests.
 */
export function startTrace(o = {}) {
  if (!o.task || typeof o.task !== 'string') throw new Error('startTrace: task path is required');
  const t = resolveTask(o.task, o.root ? { root: o.root } : {});
  const now = o.now || Date.now;
  const taskId = t.subtask || t.task;
  const trace = {
    task_id: taskId,
    parent_task: o.parent_task || null,
    workspace: t.workspace,
    project: t.project,
    workflow: t.workflow,
    started: new Date(now()).toISOString(),
    ended: null,
    model_used: o.model_used || '',
    model_class: MODEL_CLASSES.includes(o.model_class) ? o.model_class : 'openweight',
    steps: [],
    tools_used: [],
    outputs: [],
    approval_required: !!o.approval_required,
    approved_by: '',
    result: 'partial',
    receipt_path: '',
    eval_path: '', // TARGET: the eval-engine writes evals/{task-id}.md and links it here.
  };
  // Internal handle state (not part of the persisted record).
  return { trace, _task: t, _now: now, _file: path.join(t.dirs.traces, `${taskId}.json`) };
}

/**
 * recordStep — append one step. Logs the full tool-call contract (who/model/data-hash/permission/
 * output-hash/approval). Inputs/outputs are HASHED (privacy-preserving — content never stored, same
 * discipline as the capability receipt). Accepts either raw `input`/`output` (hashed here) or
 * pre-computed `input_hash`/`output_hash`.
 * @param {object} handle  the value returned by startTrace.
 * @param {object} step
 *   @param {'plan'|'tool'|'model'|'subagent'|'io'} step.kind
 *   @param {string} [step.summary]
 *   @param {string} [step.tool]        tool/action name (for kind 'tool').
 *   @param {string} [step.who]         WHO requested it (did/actor) — the schema's "who".
 *   @param {string} [step.model]       WHICH model requested it.
 *   @param {string} [step.permission]  WHAT permission allowed it.
 *   @param {*} [step.input]            data touched (hashed) — or pass step.input_hash directly.
 *   @param {*} [step.output]           output produced (hashed) — or pass step.output_hash directly.
 *   @param {number} [step.cost_units]  MEASURED non-negative cost (never a price).
 *   @param {boolean} [step.approval]   whether approval was required for this step.
 */
export function recordStep(handle, step = {}) {
  if (!handle || !handle.trace) throw new Error('recordStep: invalid trace handle');
  if (handle.trace.ended) throw new Error('recordStep: trace already ended');
  const kind = STEP_KINDS.includes(step.kind) ? step.kind : 'io';
  const cost = typeof step.cost_units === 'number' && Number.isFinite(step.cost_units) && step.cost_units >= 0 ? step.cost_units : 0;
  const rec = {
    i: handle.trace.steps.length,
    kind,
    summary: step.summary == null ? '' : String(step.summary),
    tool: step.tool == null ? '' : String(step.tool),
    who: step.who == null ? '' : String(step.who),          // WHO requested it
    model: step.model == null ? '' : String(step.model),    // WHICH model requested it
    permission: step.permission == null ? '' : String(step.permission), // WHAT permission allowed it
    input_hash: step.input_hash != null ? String(step.input_hash) : hashContent(step.input == null ? '' : step.input),
    output_hash: step.output_hash != null ? String(step.output_hash) : hashContent(step.output == null ? '' : step.output),
    approval: !!step.approval,                               // whether approval was required
    cost_units: cost,
  };
  handle.trace.steps.push(rec);
  if (rec.tool && !handle.trace.tools_used.includes(rec.tool)) handle.trace.tools_used.push(rec.tool);
  return rec;
}

/**
 * endTrace — finalize the trace: set ended/result/outputs, MINT a capability-receipt as the
 * tamper-evident spine, store its path in receipt_path, and write `<task>/traces/{task-id}.json`.
 *
 * The receipt's input_hash/output_hash bind the WHOLE trace (its canonical steps), so the signed,
 * hash-chained receipt is cryptographic evidence that the trace was not altered. The ReceiptLog's
 * signer/verifier/nodeId/actor are injected (no on-disk keys needed for tests).
 *
 * @param {object} handle
 * @param {object} o
 *   @param {'ok'|'error'|'partial'} [o.result]  default 'ok'.
 *   @param {string[]} [o.outputs]
 *   @param {string} [o.approved_by]
 *   @param {ReceiptLog} [o.receiptLog]  an existing ReceiptLog to append to (its signer/verifier are used).
 *   @param {object} [o.receiptLogOpts]  if no receiptLog given, construct one from these
 *       ({ path, signer, verifier, nodeId, now, jti }).
 *   @param {string} [o.actor_id]   the actor (did:atmos) the receipt attests. Required to mint a receipt.
 *   @param {string} [o.node_id]    the compute node (did:atmos). Defaults to the log's nodeId.
 *   @param {string} [o.owner_wallet]  optional Solana address for reward attribution.
 *   @param {number} [o.cost_units] measured cost for the receipt (default: sum of step cost_units).
 *   @param {function} [o.now]      injectable clock (ms).
 * @returns {object} { trace, file, receipt } — receipt is null if no actor/log was supplied (honest no-op).
 */
export function endTrace(handle, o = {}) {
  if (!handle || !handle.trace) throw new Error('endTrace: invalid trace handle');
  if (handle.trace.ended) throw new Error('endTrace: trace already ended');
  const tr = handle.trace;
  const now = o.now || handle._now || Date.now;
  tr.ended = new Date(now()).toISOString();
  tr.result = ['ok', 'error', 'partial'].includes(o.result) ? o.result : 'ok';
  if (Array.isArray(o.outputs)) tr.outputs = o.outputs.slice();
  if (o.approved_by) tr.approved_by = String(o.approved_by);

  // Mint the capability-receipt as the tamper-evident spine, IF a log/actor is available.
  let receipt = null;
  const log = o.receiptLog || (o.receiptLogOpts ? new ReceiptLog(o.receiptLogOpts) : null);
  if (log && o.actor_id) {
    // Bind the receipt's in/out hashes to the trace itself: input = the canonical steps (the work),
    // output = the result + outputs. Any later edit to a step changes input_hash → the signed receipt
    // no longer matches → tamper detected with only the public key.
    const inputHash = hashContent(canonicalSteps(tr));
    const outputHash = hashContent({ result: tr.result, outputs: tr.outputs });
    const totalCost = typeof o.cost_units === 'number' ? o.cost_units : tr.steps.reduce((s, x) => s + (x.cost_units || 0), 0);
    try {
      receipt = log.append({
        actor_id: o.actor_id,
        action: 'skill-run',          // a traced execution is a skill-run in the receipt taxonomy
        ref: tr.task_id,
        node_id: o.node_id || log.nodeId,
        input_hash: inputHash,
        output_hash: outputHash,
        cost_units: totalCost,
        owner_wallet: o.owner_wallet,
      });
      // Store WHERE the receipt lives so a verifier can find it. Prefer the log's file path; else
      // the trace records the receipt id + that it is in-memory (honest).
      tr.receipt_path = log.path ? log.path : `(in-memory)#${receipt.receipt_id}`;
      // Precise locator (rotation-safe): the leaf task_id is NOT unique across tasks/days, so the
      // trace records its receipt's id — eval finds the exact receipt no matter which segment it
      // later lives in.
      tr.receipt_id = receipt.receipt_id;
    } catch {
      // Fail-OPEN emission (same contract as SkillExecutor): a broken signer never breaks the trace.
      receipt = null;
    }
  }

  // Persist the trace record to <task>/traces/{task-id}.json (overwrite — the trace is the final record).
  fs.mkdirSync(handle._task.dirs.traces, { recursive: true });
  fs.writeFileSync(handle._file, JSON.stringify(tr, null, 2) + '\n');
  return { trace: tr, file: handle._file, receipt };
}

/**
 * The canonical step projection the receipt's input_hash binds to. Excludes nothing material: a
 * change to ANY step field changes this string → the receipt's stored input_hash no longer matches a
 * recomputation, and the signature (over the receipt body containing input_hash) catches the forgery.
 */
function canonicalSteps(tr) {
  return tr.steps.map((s) => ({
    i: s.i, kind: s.kind, summary: s.summary, tool: s.tool, who: s.who, model: s.model,
    permission: s.permission, input_hash: s.input_hash, output_hash: s.output_hash,
    approval: s.approval, cost_units: s.cost_units,
  }));
}

/** Recompute the trace's bound input hash — for a verifier to confirm a trace matches its receipt. */
export function traceInputHash(trace) { return hashContent(canonicalSteps(trace)); }
export function traceOutputHash(trace) { return hashContent({ result: trace.result, outputs: trace.outputs }); }

/** Read a persisted trace record back. */
export function readTrace(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
