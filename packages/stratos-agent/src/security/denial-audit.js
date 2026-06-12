/**
 * denial-audit.js — persistent, append-only audit of DENIALS (the red-team gap: enforcement
 * points refused things correctly but left no queryable trace — node-authz, capability-gate,
 * gateway 401s and pairing failures all logged to console only, so "show me every failed
 * authorization on this node" had no answer).
 *
 * Design (the tap-failures.jsonl precedent — P1 fail-visible telemetry):
 *   - APPEND-ONLY jsonl at <profile>/denial-audit.jsonl (STRATOS_PROFILE_DIR or .stratos-profile).
 *   - FAIL-OPEN but FAIL-VISIBLE: a failing audit write never blocks or rethrows into the caller —
 *     the denial itself already happened and stays enforced — but the first failure warns once so
 *     a dead sink is never silent.
 *   - SECRET-SAFE by construction: only a fixed field whitelist is ever written (gate, reason,
 *     action, actor, target, route, method), every value is scrubbed against known token shapes
 *     and truncated. Header values, envelopes, and bodies never reach this module.
 *   - DISK-BOUNDED: single-file rotation at maxBytes (file → file.1), so an attacker hammering a
 *     denial path cannot fill the disk through the audit channel (DoS-resistant by bound, not by
 *     dropping — the newest window of denials is always retained).
 *
 * This module is the SINK. Enforcement points stay pure where they are pure:
 * node-authz takes an injected `opts.audit` hook; CapabilityError records at construction
 * (it is only ever constructed to be thrown); gateway-auth records on 401; the pair CLI
 * records ceremony failures.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_FIELD = 300; // defensive truncation — reasons are short by construction
const MAX_BYTES = 5 * 1024 * 1024; // rotate at 5MB → one .1 backup (bounded disk)
// Known credential shapes (mirrors secret-guard's families) — belt-and-braces only; callers
// already pass reasons/ids, never header values.
const SECRET_SHAPE = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[a-z]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{8,})/g;

const FIELDS = ['action', 'actor', 'target', 'route', 'method'];

const scrub = (v) => String(v).replace(SECRET_SHAPE, '[REDACTED]').slice(0, MAX_FIELD);

/** Resolve the sink path from the profile-dir convention (owner-identity/operating-tap parity). */
export function denialAuditPath(profileDir = process.env.STRATOS_PROFILE_DIR || '.stratos-profile') {
  return path.join(profileDir, 'denial-audit.jsonl');
}

let warned = false;

/**
 * Append one denial event. NEVER throws; returns true when the line landed.
 * @param {object} event { gate, reason, action?, actor?, target?, route?, method? }
 * @param {object} [opts] { path?, profileDir?, maxBytes? } — test injection points
 */
export function recordDenial(event, opts = {}) {
  try {
    const file = opts.path || denialAuditPath(opts.profileDir);
    const entry = {
      ts: new Date().toISOString(),
      gate: scrub(event?.gate || 'unknown'),
      reason: scrub(event?.reason || 'unspecified'),
    };
    for (const k of FIELDS) if (event?.[k] != null) entry[k] = scrub(event[k]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const st = fs.statSync(file);
      if (st.size > (opts.maxBytes ?? MAX_BYTES)) fs.renameSync(file, file + '.1');
    } catch { /* first write — no file to rotate */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return true;
  } catch (e) {
    try {
      if (!warned) {
        // eslint-disable-next-line no-console
        console.warn('⚠️  [denial-audit] write failed (audit is best-effort; the denial itself stays enforced):', e.message);
        warned = true;
      }
    } catch { /* a failing warner must never affect the caller */ }
    return false;
  }
}

/** Build an injectable hook for pure modules (node-authz `opts.audit`): pre-binds the gate name. */
export function makeAuditHook(gate, opts = {}) {
  return (d) => recordDenial({ gate, ...(d || {}) }, opts);
}
