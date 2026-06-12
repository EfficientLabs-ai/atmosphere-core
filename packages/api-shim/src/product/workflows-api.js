/**
 * workflows-api.js — POST /v1/workflows/:id/execute + GET /v1/workflows/:id/runs/:run_id
 * (ATMOS_API_SPEC §2.10, smallest fail-closed slice).
 *
 * Workflow definitions are FILES in the workspace (`<profile>/workflows/<id>.json`) — the dashboard
 * spec's "workflow definition files". Each step declares an `action` sentence and an executor
 * `uses` kind. The spec's risk rule is implemented literally, fail-closed:
 *
 *  - The approval-level classifier is INJECTED (`opts.classify`), because the canonical classifier
 *    (automation-runtime.mjs `classifyApprovalLevel`) lives in the operator plane, outside this
 *    repo — the gateway must CALL the same classification, never reimplement it. With no
 *    classifier wired: dry_run still describes the workflow, but real execution refuses entirely
 *    (unclassified steps never run).
 *  - Per classified step: L5 (protected verbs) ALWAYS refused — founder-only, no standing grant
 *    moves it. L4 refused too (policy-approved execution needs a policy store that does not exist
 *    yet — refusing is the honest gap). L0–L3 execute IF an executor for `uses` is wired;
 *    a step with no executor refuses rather than pretends.
 *  - One `skill-run` receipt PER EXECUTED step, ref=`workflow:<id>#<step.id>` ("run receipt"
 *    column). Refused/skipped steps mint nothing (nothing ran).
 *  - Run records persist to `<profile>/workflow-runs/<run_id>.json` and are served back verbatim.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

const PASSTHROUGH = (req, res, next) => next();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;   // workflow + step ids: single safe segment
const RUN_RE = /^[0-9a-f]{16}$/;                       // run ids are hex we minted — anything else 404s
const MAX_STEPS = 64;

function resolveProfileDir(opts = {}) {
  return opts.profileDir || process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function createWorkflowsRouter(opts = {}) {
  const router = express.Router();
  const auth = opts.auth || PASSTHROUGH;
  const classify = opts.classify || null;   // (step) => { level: 0..5 } — the canonical classifier, injected
  const executors = opts.executors || {};   // { [uses]: (step, ctx) => any } — safe, local step runners
  const record = opts.record || null;       // synchronous receipt recorder (skill-run per executed step)
  const now = opts.now || (() => Date.now());
  const profileDir = resolveProfileDir(opts);
  const workflowsDir = () => opts.workflowsDir || path.join(profileDir, 'workflows');
  const runsDir = () => path.join(profileDir, 'workflow-runs');
  const deny = (res, code, message) => res.status(code).json({ error: { message, type: 'workflows_api' } });

  function loadWorkflow(id) {
    if (!ID_RE.test(id)) return { error: 'invalid workflow id' };
    let def;
    try { def = JSON.parse(fs.readFileSync(path.join(workflowsDir(), id + '.json'), 'utf8')); }
    catch { return { error: 'not_found' }; }
    if (!Array.isArray(def.steps) || def.steps.length === 0 || def.steps.length > MAX_STEPS) {
      return { error: `workflow must declare 1–${MAX_STEPS} steps` };
    }
    for (const s of def.steps) {
      if (!s || typeof s !== 'object' || !ID_RE.test(String(s.id || '')) || typeof s.action !== 'string' || !s.action.trim()) {
        return { error: 'every step needs an id (safe segment) and a declared action sentence' };
      }
    }
    if (new Set(def.steps.map((s) => s.id)).size !== def.steps.length) return { error: 'step ids must be unique' };
    return { def };
  }

  // ── POST /v1/workflows/:id/execute ──
  router.post('/v1/workflows/:id/execute', auth, express.json({ limit: '256kb' }), (req, res) => {
    const { def, error } = loadWorkflow(String(req.params.id));
    if (error === 'not_found') return deny(res, 404, `no workflow definition file for "${req.params.id}" (workflows/<id>.json)`);
    if (error) return deny(res, 400, error);
    const dryRun = req.body?.dry_run === true;
    const inputs = req.body?.inputs && typeof req.body.inputs === 'object' ? req.body.inputs : {};

    // classify EVERY step first — fail-closed: no classifier ⇒ nothing executes, ever.
    const plan = def.steps.map((step) => {
      if (!classify) return { step, level: null, executable: false, reason: 'approval-level classifier unavailable — unclassified steps never execute (fail-closed)' };
      let level;
      try { level = Number(classify(step)?.level); } catch (e) { return { step, level: null, executable: false, reason: 'classifier error: ' + e.message }; }
      if (!Number.isInteger(level) || level < 0 || level > 5) return { step, level: null, executable: false, reason: 'classifier returned no usable level (fail-closed)' };
      if (level >= 5) return { step, level, executable: false, reason: 'L5 protected action — founder-only, refused always' };
      if (level === 4) return { step, level, executable: false, reason: 'L4 needs policy-approved execution — no policy store exists yet (honest refusal)' };
      if (typeof executors[step.uses] !== 'function') return { step, level, executable: false, reason: `no executor wired for "${step.uses ?? '(none declared)'}" — a step never pretends to run` };
      return { step, level, executable: true };
    });

    const run_id = crypto.randomBytes(8).toString('hex');
    const started_at = new Date(now()).toISOString();
    const steps = [];
    const receipts = [];
    let failed = false;

    for (const p of plan) {
      const rec = { id: p.step.id, action: p.step.action, uses: p.step.uses ?? null, level: p.level };
      if (dryRun) {
        rec.decision = p.executable ? 'would_execute' : 'would_refuse';
        if (!p.executable) rec.reason = p.reason;
      } else if (failed) {
        rec.decision = 'skipped'; rec.reason = 'an earlier step failed — remaining steps do not run';
      } else if (!p.executable) {
        rec.decision = 'refused'; rec.reason = p.reason;
      } else {
        try {
          const out = executors[p.step.uses](p.step, { inputs, run_id, workflow_id: req.params.id, profileDir });
          rec.decision = 'executed';
          if (record) {
            rec.receipt_id = record({
              ref: `workflow:${req.params.id}#${p.step.id}`,
              input_hash: sha256(JSON.stringify({ action: p.step.action, with: p.step.with ?? null })),
              output_hash: sha256(out === undefined ? '' : JSON.stringify(out)),
            });
            if (rec.receipt_id) receipts.push(rec.receipt_id);
          }
        } catch (e) {
          rec.decision = 'failed'; rec.reason = e.message; failed = true; // fail-visible, stop the run
        }
      }
      steps.push(rec);
    }

    const executed = steps.filter((s) => s.decision === 'executed').length;
    const status = dryRun ? 'dry_run'
      : failed ? 'failed'
      : executed === steps.length ? 'completed'
      : executed > 0 ? 'partial'
      : 'refused';
    const run = { run_id, workflow_id: String(req.params.id), status, dry_run: dryRun, started_at, finished_at: new Date(now()).toISOString(), steps, receipts };
    try {
      fs.mkdirSync(runsDir(), { recursive: true });
      fs.writeFileSync(path.join(runsDir(), run_id + '.json'), JSON.stringify(run, null, 2));
    } catch (e) { return deny(res, 500, 'run record write failed: ' + e.message); }
    res.status(dryRun ? 200 : 201).json(run);
  });

  // ── GET /v1/workflows/:id/runs/:run_id — the persisted run record, verbatim ──
  router.get('/v1/workflows/:id/runs/:run_id', auth, (req, res) => {
    const runId = String(req.params.run_id);
    if (!RUN_RE.test(runId)) return deny(res, 404, 'unknown run');
    let run;
    try { run = JSON.parse(fs.readFileSync(path.join(runsDir(), runId + '.json'), 'utf8')); }
    catch { return deny(res, 404, 'unknown run'); }
    if (run.workflow_id !== String(req.params.id)) return deny(res, 404, 'unknown run'); // run ids are scoped to their workflow
    res.json(run);
  });

  return router;
}
