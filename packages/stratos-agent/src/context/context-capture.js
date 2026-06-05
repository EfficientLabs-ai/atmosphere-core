/**
 * context-capture.js — the CAPTURE leg of the operating core (Increment 1).
 *
 * "No context lives only in chat." Every meaningful event entering the system becomes a structured
 * context record on disk, in the user's living operational map. This module implements `capture(event)`
 * exactly to the canonical CONTEXT_CAPTURE_SCHEMA.md event record, and persists it the way the schema
 * mandates:
 *   - the RAW input → the task's `data/` (the unprocessed source of truth),
 *   - the STRUCTURED record → the task's `memory/` (the durable context),
 *   - one line appended to a `session.log` at the WORKSPACE level (the chronological index).
 *
 * Pipeline position: `Input → [Capture] → [Classify] → Route → [Store] → … → Trace`. capture() runs
 * Capture+Classify (rule-based) and Store, returning the record so a caller can continue the pipeline.
 *
 * DETERMINISTIC CORE — NO LLM, NO NETWORK. classify(event) is a pure, rule-based mapper (source +
 * coarse intent). An LLM-assisted summarizer is left as an EXPLICIT, OFF-BY-DEFAULT hook (`summarize`
 * option) so the durable layer never silently depends on a model. See TARGET note on `capture`.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { resolveTask } from '../workspace/workspace-tree.js';

/** The canonical source taxonomy (CONTEXT_CAPTURE_SCHEMA.md). Deny-by-default: unknown → "api". */
export const SOURCES = Object.freeze(['chat', 'file', 'email', 'repo', 'terminal', 'browser', 'api', 'mcp']);

/** The full ordered set of fields the schema record carries — the contract this module fills. */
export const RECORD_FIELDS = Object.freeze([
  'id', 'timestamp', 'source', 'repo', 'project', 'workflow', 'task',
  'user_intent', 'raw_input_path', 'summary', 'entities', 'decisions',
  'tools_used', 'outputs', 'next_actions', 'permissions', 'model_used',
  'trace_path', 'eval_path',
]);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const asArray = (v) => (Array.isArray(v) ? v.slice() : v == null ? [] : [v]);
const asStr = (v) => (v == null ? '' : String(v));

/**
 * classify(event) — DETERMINISTIC, rule-based classification of source + a coarse intent. No LLM,
 * no network: it inspects the declared source (normalized to the canonical taxonomy) and keyword-
 * matches the text for a coarse intent bucket. This is the Classify leg's honest, narrow form
 * (general LLM intent classification is TARGET). Returns { source, intent, confidence }.
 */
export function classify(event = {}) {
  const declared = String(event.source || '').toLowerCase().trim();
  const source = SOURCES.includes(declared) ? declared : 'api';

  // Coarse intent from the raw text (or an explicit user_intent if the caller already knows it).
  const text = `${asStr(event.user_intent)} ${asStr(event.text || event.raw || event.summary)}`.toLowerCase();
  const has = (...kw) => kw.some((k) => text.includes(k));
  let intent = 'note';
  if (event.user_intent && typeof event.user_intent === 'string' && event.user_intent.trim()) {
    intent = 'stated'; // the caller supplied an explicit intent — respect it as its own bucket
  } else if (has('?', 'how ', 'what ', 'why ', 'who ', 'when ', 'where ', 'which ')) {
    intent = 'question';
  } else if (has('fix', 'bug', 'error', 'fail', 'broken', 'crash')) {
    intent = 'fix';
  } else if (has('build', 'create', 'add', 'implement', 'write', 'make ', 'scaffold')) {
    intent = 'build';
  } else if (has('decide', 'should we', 'option', 'choose', 'vs ', 'tradeoff')) {
    intent = 'decision';
  } else if (has('plan', 'roadmap', 'next', 'todo', 'milestone')) {
    intent = 'plan';
  } else if (has('review', 'audit', 'check', 'verify', 'inspect')) {
    intent = 'review';
  }
  // Confidence is honest: a stated intent or a clearly-classed source is high; a bare note is low.
  const confidence = intent === 'stated' ? 1 : intent === 'note' ? 0.25 : 0.6;
  return { source, intent, confidence };
}

/**
 * capture(event, opts) — capture ONE event into the operational map, returning the structured record.
 *
 * @param {object} event
 *   @param {string} event.task        REQUIRED slash path "ws/proj/wf/task[/subtask]" (must already exist).
 *   @param {string} [event.source]    one of SOURCES (else normalized to "api").
 *   @param {string} [event.raw|event.text|event.input]  the raw input to persist verbatim to data/.
 *   @param {string} [event.user_intent]  the user's intent (drives classify()).
 *   @param {string} [event.summary]   a summary (else "" — never fabricated; see the summarize hook).
 *   @param {string} [event.repo|event.model_used]  passthrough schema fields.
 *   @param {string[]} [event.entities|decisions|tools_used|outputs|next_actions|permissions]  list fields.
 *   @param {string} [event.trace_path|event.eval_path]  links to the trace / eval (filled later by the trace engine).
 * @param {object} [opts]
 *   @param {string} [opts.root]   workspaces root (default: workspace-tree.defaultRoot()).
 *   @param {function} [opts.now]  injectable clock (ms) for deterministic tests.
 *   @param {function} [opts.id]   injectable id generator for deterministic tests.
 *   @param {function} [opts.summarize]  *** TARGET, OFF BY DEFAULT *** an LLM-assisted summarizer
 *       `(event, classification) => string`. If provided AND `event.summary` is empty, its return
 *       value fills `summary`. The deterministic core NEVER calls a model; this is an explicit,
 *       documented opt-in hook so the durable layer stays model-free unless a caller wires one in.
 * @returns {object} the persisted CONTEXT_CAPTURE_SCHEMA record (every field present).
 */
export function capture(event = {}, opts = {}) {
  if (!event || typeof event !== 'object') throw new Error('capture(event): event must be an object');
  if (!event.task || typeof event.task !== 'string') throw new Error('capture(event): event.task (a "ws/proj/wf/task" path) is required');

  const root = opts.root;
  // Resolve the task — deny-by-default: the task folder (with its eight entries) MUST already exist.
  const t = resolveTask(event.task, root ? { root } : {});

  const now = opts.now ? opts.now() : Date.now();
  const id = opts.id ? String(opts.id()) : (crypto.randomUUID ? crypto.randomUUID() : sha256(String(now) + Math.random()).slice(0, 32));
  const timestamp = new Date(now).toISOString();

  const cls = classify(event);

  // --- persist the RAW input verbatim to the task's data/ (the unprocessed source of truth) -----
  const raw = event.raw ?? event.text ?? event.input ?? '';
  const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  const rawName = `${timestamp.replace(/[:.]/g, '-')}_${id}.raw`;
  const rawPath = path.join(t.dirs.data, rawName);
  fs.writeFileSync(rawPath, rawStr);

  // --- the LLM-assist hook (TARGET, off by default): only invoked if explicitly provided ---------
  let summary = asStr(event.summary);
  if (!summary && typeof opts.summarize === 'function') {
    try { summary = asStr(opts.summarize(event, cls)); } catch { summary = ''; } // honest: a failing hook → no summary, never a fake one
  }

  // --- build the structured record EXACTLY to CONTEXT_CAPTURE_SCHEMA.md --------------------------
  const record = {
    id,
    timestamp,
    source: cls.source,
    repo: asStr(event.repo),
    project: t.project || '',
    workflow: t.workflow || '',
    task: t.subtask || t.task || '',
    user_intent: asStr(event.user_intent) || cls.intent, // explicit intent, else the classified bucket
    raw_input_path: rawPath,
    summary,
    entities: asArray(event.entities),
    decisions: asArray(event.decisions),
    tools_used: asArray(event.tools_used),
    outputs: asArray(event.outputs),
    next_actions: asArray(event.next_actions),
    permissions: asArray(event.permissions),
    model_used: asStr(event.model_used),
    trace_path: asStr(event.trace_path),
    eval_path: asStr(event.eval_path),
  };

  // --- persist the STRUCTURED record to the task's memory/ (the durable context) -----------------
  const recPath = path.join(t.dirs.memory, `${id}.json`);
  fs.writeFileSync(recPath, JSON.stringify(record, null, 2) + '\n');

  // --- append one line to the WORKSPACE session log (the chronological index) --------------------
  // The session.log lives at the workspace root: <root>/<workspace>/session.log (created by
  // workspace-tree.createWorkspace). We derive it from the resolved task path's first segment.
  const workspaceDir = path.resolve(t.path, ...Array(t.parts.length - 1).fill('..'));
  const sessionLog = path.join(workspaceDir, 'session.log');
  const line = JSON.stringify({
    ts: timestamp, id, source: record.source, intent: cls.intent,
    task: event.task, summary: summary || undefined, record_path: recPath,
  }) + '\n';
  try { fs.appendFileSync(sessionLog, line); }
  catch { fs.mkdirSync(workspaceDir, { recursive: true }); fs.appendFileSync(sessionLog, line); }

  return { ...record, _paths: { raw: rawPath, record: recPath, sessionLog }, classification: cls };
}
