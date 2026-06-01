/**
 * write-approval.js — the human-on-the-loop WRITE GATE for connectors / MCP (Task #13).
 *
 * THE CONTRACT: a connector WRITE (send email, post message, create issue, charge, delete…) is NEVER
 * executed on the model's say-so. The model can only PROPOSE; a write executes only after the human
 * OWNER approves the exact proposal out-of-band (CLI / Telegram DM), and each approval is single-use.
 * This is the safety half of "infinite autonomy you control" — the model is OUT of the approval loop.
 *
 * Properties (all tested):
 *  - DENY BY DEFAULT: a proposed write is not executable until approved.
 *  - NONCE-BOUND: approval requires the per-proposal nonce — the model never sees it, so it can't self-approve.
 *  - SINGLE-USE: consuming an approval deletes it — no replay of one yes across many writes.
 *  - TTL: approvals/proposals expire; stale yeses don't execute.
 *  - TAMPER-EVIDENT: the approved action is fingerprinted; if the args change after approval, it won't execute.
 *
 * Storage note: this in-memory ledger is owned by the OWNER-facing process (CLI / bot), NOT the model
 * process. Like the vault's resolveSecret, the cross-process boundary is the broker (Task #12); this
 * module is the gate's decision logic, unit-tested in isolation.
 */
import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 120_000;
const pending = new Map(); // id -> record

// deterministic, recursive key-sorted serialization (so {a,b} and {b,a} hash identically, but a changed
// value anywhere in the args tree changes the hash). NOTE: JSON.stringify's array-replacer filters keys
// at EVERY level — it cannot be used here, or nested args values would be silently dropped.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function fingerprint(connector, account, action, args) {
  // stable hash of WHAT was approved — re-checked at consume time so post-approval arg edits fail closed
  return crypto.createHash('sha256').update(stableStringify({ connector, account, action, args })).digest('hex');
}

function summarize(connector, action, args) {
  const parts = Object.entries(args || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)}`);
  return `${connector}.${action}(${parts.join(', ')})`;
}

/** MODEL-FACING: register an intended write. Returns a proposal the owner reviews; NOT executable yet. */
export function proposeWrite({ connector, account = 'default', action, args = {}, scopes = [], ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!/^[a-z0-9_.-]+$/i.test(String(connector || ''))) throw new Error('invalid connector');
  if (!/^[a-z0-9_.-]+$/i.test(String(action || ''))) throw new Error('invalid action');
  const id = crypto.randomBytes(8).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex'); // owner-only secret; gates approval
  const fp = fingerprint(connector, account, action, args);
  pending.set(id, { id, nonce, fp, connector, account, action, scopes, status: 'pending', createdAt: Date.now(), ttlMs });
  // returned to the model only WITHOUT the nonce; the owner channel gets the nonce separately
  return { id, connector, account, action, scopes, summary: summarize(connector, action, args), ttlMs, requiresApproval: true };
}

/** OWNER-FACING (out-of-band): the nonce is delivered to the owner; returns it for the owner channel. */
export function approvalChallenge(id) {
  const r = pending.get(id);
  if (!r || r.status !== 'pending') return null;
  return { id, nonce: r.nonce, summary: `${r.connector}.${r.action}`, scopes: r.scopes };
}

function expired(r) { return Date.now() - r.createdAt > r.ttlMs; }

/** OWNER-FACING: approve a specific proposal with its nonce. Wrong nonce / expired / unknown → rejected. */
export function approve(id, nonce) {
  const r = pending.get(id);
  if (!r) return { ok: false, reason: 'unknown proposal' };
  if (r.status !== 'pending') return { ok: false, reason: `already ${r.status}` };
  if (expired(r)) { r.status = 'expired'; return { ok: false, reason: 'expired' }; }
  if (typeof nonce !== 'string' || nonce.length !== r.nonce.length || !crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(r.nonce))) {
    return { ok: false, reason: 'bad nonce' }; // wrong approver / guess / replay of a different proposal
  }
  r.status = 'approved'; r.approvedAt = Date.now();
  return { ok: true, id };
}

export function deny(id) {
  const r = pending.get(id);
  if (!r || r.status !== 'pending') return false;
  r.status = 'denied'; return true;
}

/**
 * BROKER-FACING: call immediately before executing the write. Verifies it was approved, not expired,
 * and that the action STILL matches what was approved (fingerprint). Consumes the approval (single-use).
 */
export function consumeApproval({ id, connector, account = 'default', action, args = {} } = {}) {
  const r = pending.get(id);
  if (!r) return { ok: false, reason: 'unknown' };
  if (r.status !== 'approved') return { ok: false, reason: `not approved (${r.status})` };
  if (expired(r)) { r.status = 'expired'; return { ok: false, reason: 'expired' }; }
  if (r.fp !== fingerprint(connector, account, action, args)) {
    r.status = 'tampered'; return { ok: false, reason: 'action changed after approval' }; // fail closed
  }
  pending.delete(id); // single-use: no replay
  return { ok: true };
}

export function listPending() {
  return [...pending.values()].filter((r) => r.status === 'pending' && !expired(r))
    .map((r) => ({ id: r.id, connector: r.connector, action: r.action, scopes: r.scopes }));
}

export function _reset() { pending.clear(); } // test hook
