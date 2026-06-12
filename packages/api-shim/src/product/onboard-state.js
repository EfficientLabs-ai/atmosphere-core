/**
 * onboard-state.js — the ATMOS_ONBOARDING_BACKEND §2 state machine, computed from DISK EVIDENCE only.
 *
 * Rule (spec §2): "States advance only on disk-verifiable evidence — the FE checklist must derive
 * checkmarks from these artifacts, never from its own memory." This module is pure: it receives the
 * already-read facts (no I/O except the bounded trace scan helper below) and returns the FURTHEST
 * state whose entry evidence exists on disk.
 *
 * Honesty boundary: RECEIPT_EXPORTED, ACTIVATED and SCORED have NO local evidence artifact today —
 * export writes the bundle wherever the user redirected it, and verification is third-party by
 * design (it never writes back to the node). Those states are therefore reported as unobservable
 * with the reason, never claimed. UNINSTALLED is unrepresentable here: if this API is answering,
 * the binary is installed and running.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The §2 order. PAIRED is optional for the sovereign path (pairing is NOT a gate for steps 4–5). */
export const ONBOARD_STATES = Object.freeze([
  'INSTALLED', 'NODE_CREATED', 'PAIRED', 'MODEL_CONNECTED', 'FIRST_TASK_RUN',
  'RECEIPT_EXPORTED', 'ACTIVATED', 'SCORED',
]);

export const UNOBSERVABLE_STATES = Object.freeze({
  RECEIPT_EXPORTED: 'the bundle lands wherever the user redirected it — no local artifact marks the export',
  ACTIVATED: 'verification is third-party by design (public key only) — it writes nothing on the node',
  SCORED: 'viewing the score is a read — a GET must never write a marker (no write-on-read)',
});

/**
 * Bounded scan for first-task evidence: any `traces/*.json` under the workspace tree
 * (root/<workspace>/<project>/<workflow>/<task>/traces/ — workspace-tree.js layout).
 * Work-bound: visits at most `cap` directory entries so a huge tree can't block the event loop.
 */
/**
 * TRI-STATE (dual-Codex): budget exhaustion is "incomplete scan", never "no
 * evidence" — collapsing it to false made the state regress on large trees
 * depending on directory order. Returns { found, exhausted }.
 */
export function hasTraceEvidence(workspacesRoot, cap = 20000) {
  let budget = cap;
  const walk = (dir, depth) => {
    if (budget <= 0 || depth > 6) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const ent of entries) {
      if (--budget <= 0) return false;
      if (!ent.isDirectory()) continue;
      const p = path.join(dir, ent.name);
      if (ent.name === 'traces') {
        try { if (fs.readdirSync(p).some((f) => f.endsWith('.json'))) return true; } catch { /* unreadable → no evidence */ }
        continue;
      }
      if (walk(p, depth + 1)) return true;
    }
    return false;
  };
  const found = walk(workspacesRoot, 0);
  return { found, exhausted: !found && budget <= 0 };
}

/**
 * Pure state computation from already-read disk facts.
 * @param {object} f
 * @param {string|null} f.nodeDid          derived from node-keys.json, or null
 * @param {boolean} f.configured           agent-config.json `configured`
 * @param {boolean} f.paired               runtime-state pairedOwner present (runtime fact)
 * @param {boolean} f.pairingReceipt       a `pairing` receipt exists on the signed chain (the §2 artifact)
 * @param {boolean} f.modelConnected       local model set OR ≥1 provider key handle
 * @param {number}  f.receiptCount         entries on the receipt chain
 * @param {{found:boolean,exhausted:boolean}|boolean} f.traceScan  hasTraceEvidence() result
 * @returns {{ state: string, evidence: object, unobservable: object, scan_incomplete: boolean }}
 */
export function computeOnboardingState(f = {}) {
  const rawScan = f.traceScan ?? f.traceExists; // traceExists = legacy boolean key
  const scan = typeof rawScan === 'object' && rawScan !== null
    ? rawScan
    : { found: !!rawScan, exhausted: false };
  const evidence = {
    INSTALLED: true, // this API answering IS the evidence — the daemon is installed and running
    NODE_CREATED: !!f.nodeDid && !!f.configured,
    // §2 rule: checkmarks derive from disk ARTIFACTS — the pairing receipt on the signed
    // chain is the artifact (dual-Codex: runtime state alone let the FE show step 3 done
    // with no receipt ever minted). The runtime fact is still exposed for diagnostics.
    PAIRED: !!f.pairingReceipt,
    MODEL_CONNECTED: !!f.modelConnected,
    // exhausted scan = UNKNOWN, not false — the FE must not regress a checkmark on it
    FIRST_TASK_RUN: scan.exhausted && !scan.found ? null : (scan.found && (f.receiptCount ?? 0) > 0),
  };
  // furthest state whose entry evidence exists, in §2 order. PAIRED never blocks the sovereign
  // path: a later state with evidence wins even when PAIRED is false. null (unknown) never
  // advances AND never regresses — it simply doesn't count.
  let state = 'INSTALLED';
  for (const s of ONBOARD_STATES) {
    if (evidence[s] === true) state = s;
  }
  return {
    state,
    evidence: { ...evidence, PAIRED_RUNTIME: !!f.paired },
    unobservable: { ...UNOBSERVABLE_STATES },
    scan_incomplete: scan.exhausted && !scan.found,
  };
}
