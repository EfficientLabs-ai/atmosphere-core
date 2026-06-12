/**
 * score-api.js — GET /score: the PER-USER-NODE Runtime Score (ATMOS_ONBOARDING_BACKEND §1 step 8).
 *
 * Same `efl.runtime-score.v1` shape as the published company artifact, computed from LOCAL sources
 * ONLY: the heartbeat jsonl (freshness) and the receipt chain (full verify). The hard rule from
 * RUNTIME_SCORE_SPEC §0 applies verbatim: any sub-score lacking a local source returns
 * `not_measured` with a reason string — NEVER a synthetic number. Session/token telemetry and
 * routing telemetry have no local capture wired yet, so they report exactly that.
 *
 * R0 read, strict auth per-route, read-only (no write-on-read — F1 discipline). Carries
 * `generated_at` so the FE's stale-degradation rule (>48h → past tense) can apply.
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
const notMeasured = (reason) => ({ status: 'not_measured', reason });

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

  function heartbeatScore() {
    let lines;
    try { lines = fs.readFileSync(heartbeatFile(), 'utf8').trim().split('\n'); }
    catch { return notMeasured('no heartbeat file yet — the daemon writes it while running (a stale file IS the alarm)'); }
    let beat;
    try { beat = JSON.parse(lines[lines.length - 1]); } catch { return notMeasured('heartbeat file unreadable'); }
    const ageMs = now() - Date.parse(beat.ts);
    if (!Number.isFinite(ageMs)) return notMeasured('heartbeat entry carries no parseable ts');
    const fresh = ageMs >= 0 && ageMs < FRESH_MS;
    return {
      status: 'MEASURED',
      verdict: fresh ? 'ok' : 'fail',
      inputs: { last_beat: beat.ts, age_ms: ageMs, fresh_window_ms: FRESH_MS, uptime_s: beat.uptime_s ?? null },
      method: 'age of the last node-heartbeat.jsonl entry vs the freshness window',
      verify: 'read the last line of node-heartbeat.jsonl and compare its ts yourself',
    };
  }

  function receiptsScore() {
    if (!receipts?.ReceiptLog) return notMeasured('receipt verification module unavailable');
    if (!fs.existsSync(receiptsFile())) return notMeasured('no receipts on the chain yet — run a first task');
    const keys = readJsonSafe(nodeKeysFile());
    if (!keys?.publicKey) return notMeasured('no node public key — a verify without the key would be synthetic');
    let v, count;
    try {
      const pub = Object.fromEntries(Object.entries(keys.publicKey).map(([k, val]) => [k, Buffer.from(val, 'base64')]));
      const log = new receipts.ReceiptLog({ verifier: receipts.makeReceiptVerifier(pub) });
      log.chain = receipts.ReceiptLog.loadChainEntries(receiptsFile()); // segment-aware full history
      count = log.length;
      if (count === 0) return notMeasured('no receipts on the chain yet — run a first task');
      v = log.verify({ requireSig: true });
    } catch (e) { return notMeasured('receipt chain unreadable: ' + e.message); }
    return {
      status: 'MEASURED',
      verdict: v.ok ? 'ok' : 'fail',
      inputs: { receipt_count: count, broken_at: v.ok ? null : (v.brokenAt ?? null), reason: v.ok ? null : (v.reason ?? 'chain verification failed') },
      method: 'full hash-chain + hybrid-signature verify over every receipt (fail-closed)',
      verify: 'stratos receipt export > bundle.json && stratos receipt verify bundle.json',
    };
  }

  // ── GET /score — per-user runtime score from LOCAL sources only ──
  router.get('/score', auth, (req, res) => {
    const scores = {
      heartbeat: heartbeatScore(),
      receipts: receiptsScore(),
      sessions: notMeasured('no local session/token telemetry capture is wired yet (ATMOS_API_SPEC §2.5 TO-BUILD)'),
      routing: notMeasured('no local routing telemetry capture is wired yet (ATMOS_API_SPEC §2.7 visibility tier)'),
    };
    const vals = Object.values(scores);
    const measured = vals.filter((s) => s.status === 'MEASURED');
    const failed = measured.filter((s) => s.verdict === 'fail');
    // hero verdict from MEASURED facts only: any measured failure → RED; nothing measured →
    // NOT_MEASURED; gaps degrade GREEN to YELLOW (the honest "partially measured" middle).
    const verdict = failed.length ? 'RED' : measured.length === 0 ? 'NOT_MEASURED' : measured.length === vals.length ? 'GREEN' : 'YELLOW';
    res.json({
      format: 'efl.runtime-score.v1',
      variant: 'per-user-node', // computed live from THIS node's local sources, not the published company artifact
      generated_at: new Date(now()).toISOString(),
      hero: { verdict, measured: measured.length, not_measured: vals.length - measured.length },
      scores,
    });
  });

  return router;
}
