/**
 * product-api.js — Foundation build F1: the FE-unblocking read APIs + onboarding state.
 * (ATMOS_API_SPEC.md TO-BUILD #1/#2/#6 + ATMOS_ONBOARDING_BACKEND.md `GET /onboard/state`.)
 *
 * All four are R0 reads, strict-auth (fail-closed, denials audited by the middleware), no spend,
 * no entitlement check (single-tenant loopback today — the spec's TO-BUILD #10), no protected
 * surface. They compose EXISTING truth sources verbatim — nothing here recomputes or synthesizes:
 *
 *   GET  /v1/runtime-score        the published efl.runtime-score.v1 artifact, verbatim + ETag
 *   POST /v1/receipts/verify      HTTP wrapper over verifyBundle() — third-party verify, public-key-only
 *   GET  /v1/nodes                this node's honest status (single entry; never fakes a fleet)
 *   GET  /onboard/state           the FE checklist's single source of truth (derived from real artifacts)
 *
 * Everything is dependency-injected for hermetic tests. Mounted under requireGatewaySecretStrict.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

const profileDir = () => process.env.STRATOS_PROFILE_DIR || path.join(os.homedir(), '.stratos-profile');

/** Locate the runtime-score artifact: env override → the web repo's published copy → none. */
function runtimeScorePath(opts = {}) {
  if (opts.runtimeScorePath) return opts.runtimeScorePath;
  if (process.env.ATMOS_RUNTIME_SCORE) return process.env.ATMOS_RUNTIME_SCORE;
  // the publisher writes this; the API serves it verbatim (the generator owns truth)
  return path.join(os.homedir(), 'efficientlabs-web', 'data', 'runtime-score.json');
}

export function createProductRouter(opts = {}) {
  const router = express.Router();
  const deny = (res, code, message) => res.status(code).json({ error: { message, type: 'product_api' } });
  // injectable readers (real modules in production; fakes in tests)
  const cfg = opts.config || null;        // { getConfig, getModelSources, getPairedOwner, getRevokedNodes }
  const receipts = opts.receipts || null; // { loadChainEntries, verifyBundle, originId, ReceiptLog }
  const heartbeatPath = opts.heartbeatPath || path.join(profileDir(), 'node-heartbeat.jsonl');

  // ── GET /v1/runtime-score — serve the published artifact verbatim (ATMOS_API_SPEC §2.4) ──
  router.get('/v1/runtime-score', (req, res) => {
    const p = runtimeScorePath(opts);
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch { return deny(res, 404, 'runtime-score artifact not published yet (the 30-min publisher writes it)'); }
    let doc;
    try { doc = JSON.parse(raw); } catch { return deny(res, 502, 'runtime-score artifact is unreadable JSON'); }
    const etag = '"' + crypto.createHash('sha256').update(String(doc.generated_at || raw)).digest('hex').slice(0, 16) + '"';
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.set('ETag', etag).set('Cache-Control', 'no-cache').json(doc); // verbatim — no recompute
  });

  // ── POST /v1/receipts/verify — HTTP wrapper over verifyBundle (ATMOS_API_SPEC §2.3) ──
  router.post('/v1/receipts/verify', express.json({ limit: '8mb' }), (req, res) => {
    if (!receipts?.verifyBundle) return deny(res, 503, 'receipt verification module unavailable');
    const bundle = req.body?.bundle ?? req.body; // accept {bundle} or a bare bundle
    if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.receipts)) {
      return deny(res, 400, 'body must be a stratos.capability-receipts.v1 export (or {bundle:…})');
    }
    let v;
    try { v = receipts.verifyBundle(bundle); } catch (e) { return deny(res, 422, 'verification error: ' + e.message); }
    // verifyBundle is fail-closed; surface its exact verdict. No receipt minted (verification IS the act).
    res.json(v);
  });

  // ── GET /v1/nodes — this node's honest status (ATMOS_API_SPEC §2.9; single entry, never faked) ──
  router.get('/v1/nodes', (req, res) => {
    const node = { node_id: null, name: null, owner: null, heartbeat: null, last_seen: null, paired: false };
    try {
      const keyFile = process.env.STRATOS_NODE_KEYS || path.join(profileDir(), 'node-keys.json');
      if (fs.existsSync(keyFile) && receipts?.originId) {
        const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
        const pub = Object.fromEntries(Object.entries(raw.publicKey).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
        node.node_id = receipts.originId(pub);
      }
    } catch { /* no identity yet — node_id stays null, honestly */ }
    try { node.name = cfg?.getConfig?.().agentName ?? null; } catch { /* default */ }
    try { node.paired = !!cfg?.getPairedOwner?.(); } catch { /* default false */ }
    // heartbeat freshness from the node-heartbeat.jsonl (PR #110); absent = honest null, never faked alive
    try {
      if (fs.existsSync(heartbeatPath)) {
        const lines = fs.readFileSync(heartbeatPath, 'utf8').trim().split('\n');
        const last = JSON.parse(lines[lines.length - 1]);
        const ageMs = Date.now() - Date.parse(last.ts);
        node.heartbeat = { fresh: ageMs >= 0 && ageMs < 10 * 60_000, age_ms: ageMs, uptime_s: last.uptime_s, peers: last.peers };
        node.last_seen = last.ts;
      }
    } catch { /* no heartbeat file — single-node-no-mesh, honest null */ }
    res.json({ nodes: [node], measured: 'single node — fleet counts are not measured (single-node deployment)' });
  });

  // ── GET /onboard/state — FE checklist single source of truth (ATMOS_ONBOARDING_BACKEND §3) ──
  router.get('/onboard/state', (req, res) => {
    const state = { nodeDid: null, ownerDid: null, paired: false, revoked: [], model: { local: null, providers: [] }, receipts: { count: 0 }, checklist: {} };
    try {
      const keyFile = process.env.STRATOS_NODE_KEYS || path.join(profileDir(), 'node-keys.json');
      if (fs.existsSync(keyFile) && receipts?.originId) {
        const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
        const pub = Object.fromEntries(Object.entries(raw.publicKey).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
        state.nodeDid = receipts.originId(pub);
      }
    } catch { /* not created yet */ }
    try {
      const po = cfg?.getPairedOwner?.();
      if (po) { state.paired = true; state.ownerDid = po.owner_did || po.ownerDid || null; }
      state.revoked = cfg?.getRevokedNodes?.() || [];
    } catch { /* sovereign path — paired stays false (NOT a gate, V2 rule) */ }
    try {
      const ms = cfg?.getModelSources?.() || {};
      state.model.local = ms.local?.enabled ? (ms.local.name || true) : null;
      state.model.providers = Object.keys(ms.providers || {}); // NAMES ONLY — never key handles/values
    } catch { /* default empty */ }
    try {
      const logPath = process.env.STRATOS_RECEIPTS || path.join(profileDir(), 'live-receipts.jsonl');
      if (fs.existsSync(logPath) && receipts?.ReceiptLog) {
        state.receipts.count = receipts.ReceiptLog.loadChainEntries(logPath).length;
      }
    } catch { /* no receipts yet */ }
    let configured = false;
    try { configured = !!cfg?.getConfig?.().configured; } catch { /* default */ }
    // the 5 checklist booleans, each derived from a real artifact (§2.4: from artifacts, never memory)
    state.checklist = {
      installed: state.nodeDid != null || configured,           // identity minted or config marked
      node_created: state.nodeDid != null && configured,        // keys + applyInit
      paired_or_sovereign: state.paired || configured,          // paired OR proceeding sovereign (V2)
      model_connected: state.model.local != null || state.model.providers.length > 0,
      first_receipt: state.receipts.count > 0,                  // the activation evidence
    };
    res.json(state);
  });

  return router;
}
