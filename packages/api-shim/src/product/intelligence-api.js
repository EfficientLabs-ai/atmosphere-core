/**
 * intelligence-api.js — Foundation build F2: compute.route dry-run + continuity store/retrieve.
 * (ATMOS_API_SPEC.md §2.6/§2.7 + UNIVERSAL_INTELLIGENCE_HUB_BACKEND continuity references.)
 *
 *   POST /v1/route        DECISION ONLY — runs the live router engine, executes NOTHING, spends
 *                         NOTHING. Powers the Chat Hub "routing rung indicator". (ATMOS_API_SPEC §2.7)
 *   POST /v1/continuity   store a continuity entry; content is HASHED into a skill-run receipt
 *                         (capability-receipt privacy rule: receipts carry hashes, never content).
 *   GET  /v1/continuity   retrieve entries by scope/query; reads are LOGGED, never auto-loaded.
 *
 * Design rules:
 *  - PER-ROUTE strict auth (the /health-bleed lesson from F1). Default passthrough for tests.
 *  - /v1/route is R0/L1: deciding is free and reversible; the engine functions are PURE
 *    (route(), resolveRoute()) — no provider is called, no token spent. Execution stays gated by
 *    the live 402 cost-approval flow elsewhere.
 *  - continuity store is R1/L3 (local write, reversible); the on-disk entry keeps the content
 *    (it is the user's own data on the user's own node) but the RECEIPT commits only sha256 hashes.
 *  - One profile root (cwd/.stratos-profile; STRATOS_PROFILE_DIR overrides) — F1's consistency rule.
 *  - Provider env keys are read only as a boolean "configured?" — values never surface.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

const PASSTHROUGH = (req, res, next) => next();
const SCOPE_RE = /^(workspace\/[\w./-]{1,200}|task\/[\w.-]{1,120}|chat\/[\w.-]{1,120})$/;
const KINDS = new Set(['decision', 'note', 'turn', 'artifact-ref']);

function resolveProfileDir(opts = {}) {
  return opts.profileDir || process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function createIntelligenceRouter(opts = {}) {
  const router = express.Router();
  const auth = opts.auth || PASSTHROUGH;
  const routing = opts.routing || null;     // { route, resolveRoute, difficulty } — pure engine fns
  const recordContinuity = opts.recordContinuity || null; // ({scope, kind, hashes}) => receipt_id|null — injected signer
  const env = opts.env || process.env;
  const profileDir = resolveProfileDir(opts);
  const continuityFile = () => path.join(profileDir, 'continuity.jsonl');
  const retrievalLog = () => path.join(profileDir, 'continuity-retrievals.jsonl');
  const deny = (res, code, message) => res.status(code).json({ error: { message, type: 'intelligence_api' } });

  /** True if ANY frontier provider key is configured — boolean only, never the value. */
  const hasFrontierKey = () => ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'].some((k) => !!env[k]);

  // ── POST /v1/route — dry-run routing decision (ATMOS_API_SPEC §2.7) ──
  router.post('/v1/route', auth, express.json({ limit: '256kb' }), (req, res) => {
    if (!routing?.route) return deny(res, 503, 'routing engine unavailable');
    const { prompt = '', model = null, private: priv = false, escalate = false } = req.body || {};
    if (typeof prompt !== 'string' || prompt.length > 100_000) return deny(res, 400, 'prompt must be a string ≤100k chars');
    let decision, resolved = null;
    try {
      decision = routing.route({ prompt, model, private: priv, escalate }, { hasFrontierKey: hasFrontierKey() });
      if (model && routing.resolveRoute) {
        const r = routing.resolveRoute(model, env);
        // surface only non-sensitive fields. `configured` tells the FE whether this cloud call
        // would actually work (a recognized provider with its key set). The reason string may name
        // the env VAR (e.g. OPENAI_API_KEY) — that's a public identifier, never a key value.
        resolved = { kind: r.kind, provider: r.provider ?? null, configured: r.kind === 'byok', reason: r.reason ?? null };
      }
    } catch (e) { return deny(res, 422, 'route decision error: ' + e.message); }
    res.json({
      decision,                                   // {tier, cloud, model?, difficulty, reason}
      resolved,                                    // provider resolution for an explicit model, or null
      would_spend: decision.cloud === true,        // the FE's "this will use your cloud account" flag
      executed: false,                             // dry-run — nothing happened, nothing spent
    });
  });

  // ── POST /v1/continuity — store an entry; receipt carries HASHES only (ATMOS_API_SPEC §2.6) ──
  router.post('/v1/continuity', auth, express.json({ limit: '1mb' }), (req, res) => {
    const { scope, kind, content, refs } = req.body || {};
    if (typeof scope !== 'string' || !SCOPE_RE.test(scope)) return deny(res, 400, 'scope must match workspace/<path> | task/<id> | chat/<id>');
    if (!KINDS.has(kind)) return deny(res, 400, `kind must be one of: ${[...KINDS].join(', ')}`);
    if (content == null || (typeof content !== 'string' && typeof content !== 'object')) return deny(res, 400, 'content required (string or object)');
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    const id = crypto.randomBytes(8).toString('hex');
    const ts = new Date().toISOString();
    const entry = { id, ts, scope, kind, content, refs: Array.isArray(refs) ? refs.slice(0, 64) : [], content_hash: sha256(body) };
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      fs.appendFileSync(continuityFile(), JSON.stringify(entry) + '\n');
    } catch (e) { return deny(res, 500, 'continuity store failed: ' + e.message); }
    // mint a skill-run receipt over HASHES only — content never enters the receipt (privacy rule).
    let receipt_id = null;
    if (recordContinuity) {
      try { receipt_id = recordContinuity({ scope, kind, input_hash: sha256(scope + ':' + kind), output_hash: entry.content_hash, ref: `continuity:store:${id}` }); }
      catch { /* fail-visible upstream; the entry is stored regardless */ }
    }
    res.status(201).json({ id, ts, content_hash: entry.content_hash, receipt_id });
  });

  // ── GET /v1/continuity — retrieve by scope/query; LOGGED, never auto-loaded (ATMOS_API_SPEC §2.6) ──
  router.get('/v1/continuity', auth, (req, res) => {
    const scope = req.query.scope ? String(req.query.scope) : null;
    const q = req.query.q ? String(req.query.q).toLowerCase() : null;
    const since = req.query.since ? Date.parse(String(req.query.since)) : null;
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 500);
    let entries = [];
    try {
      if (fs.existsSync(continuityFile())) {
        for (const line of fs.readFileSync(continuityFile(), 'utf8').trim().split('\n')) {
          if (!line) continue;
          const e = JSON.parse(line);
          if (scope && e.scope !== scope) continue;
          if (since && Number.isFinite(since) && Date.parse(e.ts) < since) continue;
          if (q) {
            const hay = (typeof e.content === 'string' ? e.content : JSON.stringify(e.content)).toLowerCase();
            if (!hay.includes(q)) continue;
          }
          entries.push(e);
        }
      }
    } catch (e) { return deny(res, 500, 'continuity read failed: ' + e.message); }
    entries = entries.slice(-limit).reverse(); // newest first, bounded
    // retrieval is logged (the memory.retrieve discipline: pointer-logged, never silent)
    try { fs.appendFileSync(retrievalLog(), JSON.stringify({ ts: new Date().toISOString(), scope, q: q ? sha256(q).slice(0, 12) : null, returned: entries.length }) + '\n'); } catch { /* best-effort */ }
    res.json({ items: entries, count: entries.length });
  });

  return router;
}
