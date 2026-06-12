/**
 * product-api.js — Foundation build F1: the FE-unblocking read APIs + onboarding state.
 * (ATMOS_API_SPEC.md TO-BUILD #1/#2/#6 + ATMOS_ONBOARDING_BACKEND.md `GET /onboard/state`.)
 *
 *   GET  /v1/runtime-score        the published efl.runtime-score.v1 artifact, verbatim + ETag
 *   POST /v1/receipts/verify      HTTP wrapper over verifyBundle() — third-party verify, public-key-only
 *   GET  /v1/nodes                this node's honest status (single entry; never fakes a fleet)
 *   GET  /onboard/state           the FE checklist's single source of truth (derived from real artifacts)
 *
 * Design rules (all four are R0 reads):
 *  - STRICTLY READ-ONLY: state is read by parsing the on-disk JSON DIRECTLY (read-only, default {}
 *    on absence) — NOT through agent-config's accessors, which write a default config on first read
 *    (Codex finding). A GET must never create state.
 *  - ONE profile root: keys, receipts, config, runtime-state all resolve from the SAME profileDir
 *    (`<cwd>/.stratos-profile`, the root agent-config owns; STRATOS_PROFILE_DIR overrides) — so a
 *    response can never mix artifacts from two roots (Codex finding).
 *  - PER-ROUTE auth: the strict gateway middleware is applied to each route, NOT app-wide — mounting
 *    it at the app root bled onto /health (Codex finding). Default passthrough for hermetic tests.
 *  - Provider key HANDLES never leave the node: only provider NAMES are surfaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { computeOnboardingState, hasTraceEvidence } from './onboard-state.js';

const PASSTHROUGH = (req, res, next) => next();

/** The one profile root — matches agent-config (`<cwd>/.stratos-profile`), STRATOS_PROFILE_DIR overrides. */
function resolveProfileDir(opts = {}) {
  return opts.profileDir || process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
}

/** Read + parse a JSON file read-only; missing/garbage → fallback (NEVER writes). */
function readJsonSafe(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function runtimeScorePath(opts = {}) {
  if (opts.runtimeScorePath) return opts.runtimeScorePath;
  if (process.env.ATMOS_RUNTIME_SCORE) return process.env.ATMOS_RUNTIME_SCORE;
  return path.join(process.env.HOME || '', 'efficientlabs-web', 'data', 'runtime-score.json');
}

export function createProductRouter(opts = {}) {
  const router = express.Router();
  const auth = opts.auth || PASSTHROUGH;               // strict gateway middleware in production
  const receipts = opts.receipts || null;              // { verifyBundle, ReceiptLog, originId } — pure fns
  const profileDir = resolveProfileDir(opts);
  const P = (name) => path.join(profileDir, name);
  const nodeKeysFile = () => process.env.STRATOS_NODE_KEYS || P('node-keys.json');
  const receiptsFile = () => process.env.STRATOS_RECEIPTS || P('live-receipts.jsonl');
  const heartbeatFile = () => opts.heartbeatPath || P('node-heartbeat.jsonl');
  const deny = (res, code, message) => res.status(code).json({ error: { message, type: 'product_api' } });

  // read-only state readers (direct file reads — no agent-config write-on-read)
  const nodeDid = () => {
    try {
      const raw = readJsonSafe(nodeKeysFile(), null);
      if (!raw?.publicKey || !receipts?.originId) return null;
      const pub = Object.fromEntries(Object.entries(raw.publicKey).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
      return receipts.originId(pub);
    } catch { return null; }
  };
  const runtime = () => readJsonSafe(P('runtime-state.json'), {});
  const config = () => readJsonSafe(P('agent-config.json'), {});
  const receiptCount = () => {
    try { return (fs.existsSync(receiptsFile()) && receipts?.ReceiptLog) ? receipts.ReceiptLog.loadChainEntries(receiptsFile()).length : 0; }
    catch { return 0; }
  };
  // §2 artifact for the PAIRED checkmark (dual-Codex round 2): a `pairing` receipt that sits on
  // THIS node's VERIFIED chain — an unverified line is just text; a copied/tampered/stale entry
  // must not light the checkmark. Full fail-closed verify (same discipline as GET /score).
  const hasPairingReceipt = () => {
    try {
      if (!fs.existsSync(receiptsFile()) || !receipts?.ReceiptLog || !receipts?.makeReceiptVerifier) return false;
      const keysRaw = JSON.parse(fs.readFileSync(nodeKeysFile(), 'utf8'));
      if (!keysRaw?.publicKey) return false;
      const pub = Object.fromEntries(Object.entries(keysRaw.publicKey).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
      const log = new receipts.ReceiptLog({ verifier: receipts.makeReceiptVerifier(pub) });
      log.chain = receipts.ReceiptLog.loadChainEntries(receiptsFile());
      if (!log.chain.some((e) => e.action === 'pairing')) return false;
      return log.verify({ requireSig: true }).ok === true; // broken chain → no checkmark, fail-closed
    } catch { return false; }
  };
  const lastBeat = () => {
    try {
      if (!fs.existsSync(heartbeatFile())) return null;
      const lines = fs.readFileSync(heartbeatFile(), 'utf8').trim().split('\n');
      return JSON.parse(lines[lines.length - 1]);
    } catch { return null; }
  };

  // ── GET /v1/runtime-score — serve the published artifact verbatim (ATMOS_API_SPEC §2.4) ──
  router.get('/v1/runtime-score', auth, (req, res) => {
    let raw;
    try { raw = fs.readFileSync(runtimeScorePath(opts), 'utf8'); } catch { return deny(res, 404, 'runtime-score artifact not published yet (the 30-min publisher writes it)'); }
    let doc;
    try { doc = JSON.parse(raw); } catch { return deny(res, 502, 'runtime-score artifact is unreadable JSON'); }
    const etag = '"' + crypto.createHash('sha256').update(String(doc.generated_at || raw)).digest('hex').slice(0, 16) + '"';
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.set('ETag', etag).set('Cache-Control', 'no-cache').json(doc);
  });

  // ── POST /v1/receipts/verify — HTTP wrapper over verifyBundle (ATMOS_API_SPEC §2.3) ──
  // express.json() is idempotent behind the global bodyParser.json() (the `_body` guard skips a
  // second parse) AND lets this route work standalone. HONEST LIMIT NOTE: in the daemon the global
  // parser runs first, so ITS limit governs in production — a larger bundle yields 413 upstream;
  // this inner limit only governs standalone callers.
  router.post('/v1/receipts/verify', auth, express.json({ limit: '8mb' }), (req, res) => {
    if (!receipts?.verifyBundle) return deny(res, 503, 'receipt verification module unavailable');
    const bundle = req.body?.bundle ?? req.body; // accept {bundle} or a bare bundle
    if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.receipts)) {
      return deny(res, 400, 'body must be a stratos.capability-receipts.v1 export (or {bundle:…})');
    }
    let v;
    try { v = receipts.verifyBundle(bundle); } catch (e) { return deny(res, 422, 'verification error: ' + e.message); }
    res.json(v); // verifyBundle is fail-closed; no receipt minted (verification IS the act)
  });

  // ── GET /v1/nodes — this node's honest status (ATMOS_API_SPEC §2.9; single entry, never faked) ──
  router.get('/v1/nodes', auth, (req, res) => {
    const node = { node_id: nodeDid(), name: config().agentName ?? null, paired: !!runtime().pairedOwner, heartbeat: null, last_seen: null };
    const beat = lastBeat();
    if (beat) {
      const ageMs = Date.now() - Date.parse(beat.ts);
      node.heartbeat = { fresh: ageMs >= 0 && ageMs < 10 * 60_000, age_ms: ageMs, uptime_s: beat.uptime_s, peers: beat.peers };
      node.last_seen = beat.ts;
    }
    res.json({ nodes: [node], measured: 'single node — fleet counts are not measured (single-node deployment)' });
  });

  // ── GET /onboard/state — FE checklist single source of truth (ATMOS_ONBOARDING_BACKEND §3) ──
  router.get('/onboard/state', auth, (req, res) => {
    const rt = runtime();
    const cfg = config();
    const did = nodeDid();
    const paired = !!rt.pairedOwner;
    const ownerDid = rt.pairedOwner?.owner_did ?? rt.pairedOwner?.ownerDid ?? null;
    const ms = cfg.modelSources || {};
    const local = ms.local?.enabled ? (ms.local.name || true) : null;
    const providers = Object.keys(ms.providers || {}); // NAMES ONLY — never key handles/values
    const count = receiptCount();
    const configured = !!cfg.configured;
    // §2 state machine — same artifacts, same read-only discipline (the trace scan is bounded).
    const workspacesRoot = process.env.STRATOS_WORKSPACES_DIR || P('workspaces');
    const modelConnected = local != null || providers.length > 0;
    const machine = computeOnboardingState({
      nodeDid: did, configured, paired, pairingReceipt: hasPairingReceipt(), modelConnected,
      receiptCount: count, traceScan: hasTraceEvidence(workspacesRoot),
    });
    res.json({
      state: machine.state,                       // ATMOS_ONBOARDING_BACKEND §2, disk-evidenced only
      state_evidence: machine.evidence,           // per-state booleans the FE can render directly
      state_unobservable: machine.unobservable,   // states with no local artifact — never claimed
      scan_incomplete: machine.scan_incomplete,   // budgeted trace scan ran dry: FIRST_TASK_RUN is UNKNOWN, not false — never regress a checkmark on it
      nodeDid: did,
      ownerDid,
      paired,
      revoked: rt.revokedNodes || [],
      model: { local, providers },
      receipts: { count },
      // checklist derives from the SAME machine evidence as `state` — one source of truth
      // (dual-Codex: the legacy did||configured / paired||configured derivations contradicted
      // the machine and could resurrect the honesty bug through the older field).
      checklist: {
        installed: machine.evidence.INSTALLED,            // this API answering IS the evidence
        node_created: machine.evidence.NODE_CREATED,
        paired_or_sovereign: machine.evidence.PAIRED || machine.evidence.NODE_CREATED, // verified artifact OR proceeding sovereign (V2 rule)
        model_connected: machine.evidence.MODEL_CONNECTED,
        first_receipt: count > 0, // the activation evidence
      },
    });
  });

  return router;
}
