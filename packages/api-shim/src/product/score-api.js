/**
 * score-api.js — GET /score: the PER-USER-NODE Runtime Score (ATMOS_ONBOARDING_BACKEND §1 step 8).
 *
 * Emits the REAL `efl.runtime-score.v1` contract — the exact shape the FE
 * validator (efficientlabs-web lib/runtime-score.ts isValidRuntimeScore)
 * enforces: six canonical sub-score keys; per-score `label` ∈ {"MEASURED",
 * null}; measured ⇒ `verdict` ∈ GREEN|YELLOW|RED AND the per-key `inputs`
 * shape; `hero.verdict` ∈ verdicts|null (null = nothing measured, the
 * fail-closed grey ring); `not_measured_registry` of {what, reason} strings.
 * A payload that fails that validator falls back to the FE's committed
 * baseline — so contract fidelity here IS the feature (dual-Codex finding).
 *
 * Computed from LOCAL sources ONLY (RUNTIME_SCORE_SPEC §0, MEASURED-only):
 *   - continuity + ownership: full fail-closed chain verify over live-receipts
 *   - runtime: the node's ONE local health check (heartbeat freshness) reported
 *     with its honest denominator — fail/warn/ok counts of real checks (1)
 *   - session / cost / agent_readiness: no local capture wired ⇒ label null
 *     with the reason. Never a synthetic number.
 *
 * R0 read, strict auth per-route, read-only (no write-on-read — F1 discipline).
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const PASSTHROUGH = (req, res, next) => next();
const FRESH_MS = 10 * 60_000; // same freshness window /v1/nodes uses

function resolveProfileDir(opts = {}) {
  return opts.profileDir || process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
}
function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const notMeasured = (reason) => ({ label: null, reason });

export function createScoreRouter(opts = {}) {
  const router = express.Router();
  const auth = opts.auth || PASSTHROUGH;
  const receipts = opts.receipts || null; // { ReceiptLog, makeReceiptVerifier, originId }
  const now = opts.now || (() => Date.now());
  const profileDir = resolveProfileDir(opts);
  const P = (name) => path.join(profileDir, name);
  const heartbeatFile = () => opts.heartbeatPath || P('node-heartbeat.jsonl');
  const receiptsFile = () => process.env.STRATOS_RECEIPTS || P('live-receipts.jsonl');
  const nodeKeysFile = () => process.env.STRATOS_NODE_KEYS || P('node-keys.json');

  /** runtime sub-score: this node has exactly ONE local health check (heartbeat
   *  freshness); the contract's fail/warn/ok counts report that one real check
   *  honestly — the denominator (1 check) is stated in `method`. */
  function runtimeScore() {
    let lines;
    try { lines = fs.readFileSync(heartbeatFile(), 'utf8').trim().split('\n'); }
    catch { return notMeasured('no heartbeat file yet — the daemon writes it while running (a stale file IS the alarm)'); }
    let beat;
    try { beat = JSON.parse(lines[lines.length - 1]); } catch { return notMeasured('heartbeat file unreadable'); }
    const ageMs = now() - Date.parse(beat.ts);
    if (!Number.isFinite(ageMs)) return notMeasured('heartbeat entry carries no parseable ts');
    const fresh = ageMs >= 0 && ageMs < FRESH_MS;
    return {
      label: 'MEASURED',
      updated_at: beat.ts,
      verdict: fresh ? 'GREEN' : 'RED',
      inputs: { heartbeat: { fail: fresh ? 0 : 1, warn: 0, ok: fresh ? 1 : 0 } },
      method: `this node runs exactly 1 local health check (heartbeat freshness, ${FRESH_MS / 60000}m window) — fail/warn/ok count that one real check; GREEN = fresh, RED = stale (the alarm)`,
      verify: 'read the last line of node-heartbeat.jsonl and compare its ts yourself',
    };
  }

  /** one fail-closed chain verify feeds BOTH continuity and ownership. */
  function chainVerify() {
    if (!receipts?.ReceiptLog) return { err: 'receipt verification module unavailable' };
    if (!fs.existsSync(receiptsFile())) return { err: 'no receipts on the chain yet — run a first task' };
    const keys = readJsonSafe(nodeKeysFile());
    if (!keys?.publicKey) return { err: 'no node public key — a verify without the key would be synthetic' };
    try {
      const pub = Object.fromEntries(Object.entries(keys.publicKey).map(([k, val]) => [k, Buffer.from(val, 'base64')]));
      const log = new receipts.ReceiptLog({ verifier: receipts.makeReceiptVerifier(pub) });
      log.chain = receipts.ReceiptLog.loadChainEntries(receiptsFile()); // segment-aware full history
      if (log.length === 0) return { err: 'no receipts on the chain yet — run a first task' };
      const v = log.verify({ requireSig: true });
      // receipts stamp epoch-ms; the contract's updated_at is an ISO string (or null) — normalize
      const rawTs = log.chain[log.chain.length - 1]?.ts ?? null;
      const lastTs = Number.isFinite(rawTs) ? new Date(rawTs).toISOString() : (typeof rawTs === 'string' ? rawTs : null);
      return { count: log.length, intact: !!v.ok, lastTs, detail: v.ok ? null : (v.reason ?? 'chain verification failed') };
    } catch (e) { return { err: 'receipt chain unreadable: ' + e.message }; }
  }

  // ── GET /score — per-user runtime score from LOCAL sources only ──
  router.get('/score', auth, (req, res) => {
    const chain = chainVerify();
    const continuity = chain.err ? notMeasured(chain.err) : {
      label: 'MEASURED',
      updated_at: chain.lastTs,
      verdict: chain.intact && chain.count > 0 ? 'GREEN' : 'RED',
      inputs: { signed_receipts: chain.count, chain_intact: chain.intact },
      method: 'full hash-chain + hybrid-signature verify over every receipt (fail-closed); GREEN when ≥1 receipt sits on an intact chain' + (chain.detail ? ` — broken: ${chain.detail}` : ''),
      verify: 'stratos receipt export > bundle.json && stratos receipt verify bundle.json',
    };
    const ownership = chain.err ? notMeasured(chain.err) : {
      label: 'MEASURED',
      updated_at: chain.lastTs,
      verdict: chain.intact ? 'GREEN' : 'RED',
      inputs: { signed_receipts: chain.count, chain_intact: chain.intact },
      method: 'your evidence is portable when the exported bundle verifies offline with the public key only — the same chain verify, vendor-free',
      verify: 'export the bundle and run the offline verifier on another machine',
    };
    const scores = {
      runtime: runtimeScore(),
      continuity,
      session: notMeasured('no local session/token telemetry capture is wired yet (ATMOS_API_SPEC §2.5 TO-BUILD)'),
      cost: notMeasured('no local routing telemetry capture is wired yet (ATMOS_API_SPEC §2.7 visibility tier)'),
      ownership,
      agent_readiness: notMeasured('no local component-activation tracker on a user node yet — the substrate inventory is an operating-layer artifact'),
    };
    const vals = Object.values(scores);
    const measured = vals.filter((s) => s.label === 'MEASURED');
    // hero verdict = worst among MEASURED only; nothing measured ⇒ null (the
    // FE's designed grey ring — never an invented color or word).
    const order = { RED: 0, YELLOW: 1, GREEN: 2 };
    const verdict = measured.length === 0 ? null
      : measured.reduce((w, s) => (order[s.verdict] < order[w] ? s.verdict : w), 'GREEN');
    const not_measured_registry = Object.entries(scores)
      .filter(([, s]) => s.label === null)
      .map(([k, s]) => ({ what: k.replace(/_/g, ' '), reason: s.reason }));
    res.json({
      format: 'efl.runtime-score.v1',
      variant: 'per-user-node', // additive: computed live from THIS node's local sources
      generated_at: new Date(now()).toISOString(),
      render_rules: 'MEASURED cards render values with verdicts; null cards render not-measured with the reason, greyed, in place. Staleness is shown, never hidden.',
      hero: {
        measured: measured.length,
        total: vals.length,
        verdict,
        method: 'worst verdict among measured sub-scores only; nothing measured ⇒ null (grey ring) — the ring never silently fills in',
      },
      scores,
      not_measured_registry,
    });
  });

  return router;
}
