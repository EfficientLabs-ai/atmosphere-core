/**
 * attribution-ledger.js — measurement → attribution, BEFORE any rewards.
 *
 * The flywheel turns on attribution, not tokens. Before Efficient Labs can ever reward contributed
 * value, it must be able to answer, verifiably: WHO contributed, WHAT, HOW MUCH, and how it was
 * REUSED. This ledger is that accounting layer — and ONLY that. It MEASURES and ATTRIBUTES. It does
 * NOT price, reward, tokenize, or settle. Rewards are a later, separate system that reads this; an
 * arbitrary reward system built before honest measurement is exactly the mistake to avoid.
 *
 * Tamper-evident by construction: entries are an append-only HASH CHAIN
 *   entry.hash = sha256(canonical(entry-without-hash/sig) + prevHash)
 * so editing or reordering ANY past entry breaks every entry after it (verify() catches it).
 * Each entry is ATTRIBUTED to a content-addressed identity (e.g. did:atmos:… from skill-seal).
 * Signing is OPTIONAL + pluggable (inject a PQC signer/verifier) so the ledger stays pure and the
 * same hash chain works on one machine or, signed, across the untrusted mesh.
 *
 * Units are MEASURED quantities the caller supplies (ms of compute, a count, bytes) — never a
 * price. summarize() aggregates measured units per contributor: the attribution, not a payout.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The contribution types this ledger records. Deny-by-default: an unknown kind is rejected. */
export const ENTRY_KINDS = Object.freeze([
  'compute',          // a node contributed compute to a job
  'skill-authored',   // an origin authored/signed a new skill
  'skill-executed',   // a skill was run (verified) — value derived
  'skill-reused',     // a skill authored by A was reused by B (the nonlinear moat)
  'task-completed',   // a workflow/task finished, naming its contributors
]);

const GENESIS = '0'.repeat(64);

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const bodyOf = (e) => ({ seq: e.seq, ts: e.ts, kind: e.kind, contributor: e.contributor, subject: e.subject, units: e.units, meta: e.meta });
const hashEntry = (e) => sha256(canonical(bodyOf(e)) + e.prev);

export class AttributionLedger {
  /**
   * @param {object} [o]
   * @param {string|null} [o.path]     JSONL file to persist to (append-only). null = in-memory.
   * @param {function|null} [o.signer]   (canonicalBody:string) => signature  — optional PQC signer.
   * @param {function|null} [o.verifier] (canonicalBody:string, sig) => bool   — optional verifier.
   * @param {function|null} [o.now]      injectable clock (returns ms) — for deterministic tests.
   */
  constructor({ path: p = null, signer = null, verifier = null, now = null } = {}) {
    this.path = p; this.signer = signer; this.verifier = verifier; this._now = now;
    this.chain = [];
    if (p && fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim(); if (t) this.chain.push(JSON.parse(t));
      }
    }
  }

  get length() { return this.chain.length; }
  head() { return this.chain.length ? this.chain[this.chain.length - 1].hash : GENESIS; }
  entries() { return this.chain.slice(); }

  /** Record a contribution. Validates kind + contributor; chains the hash; optionally signs; persists. */
  append({ kind, contributor, subject = null, units = 1, meta = {} }) {
    if (!ENTRY_KINDS.includes(kind)) throw new Error(`unknown attribution kind "${kind}"`);
    if (typeof contributor !== 'string' || !contributor) throw new Error('attribution needs a contributor id');
    if (typeof units !== 'number' || !Number.isFinite(units) || units < 0) throw new Error('units must be a non-negative number (measured, not priced)');
    const e = {
      seq: this.chain.length,
      ts: this._now ? this._now() : Date.now(),
      kind, contributor, subject, units, meta,
      prev: this.head(),
    };
    e.hash = hashEntry(e);
    if (this.signer) e.sig = this.signer(canonical(bodyOf(e)));
    this.chain.push(e);
    if (this.path) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.appendFileSync(this.path, JSON.stringify(e) + '\n');
    }
    return e;
  }

  /** Replay the chain: prev-links + hash integrity + (if a verifier is set) signatures. Fail-closed. */
  verify() {
    let prev = GENESIS;
    for (let i = 0; i < this.chain.length; i++) {
      const e = this.chain[i];
      if (e.seq !== i) return { ok: false, brokenAt: i, reason: 'seq out of order' };
      if (e.prev !== prev) return { ok: false, brokenAt: i, reason: 'broken chain link' };
      if (e.hash !== hashEntry(e)) return { ok: false, brokenAt: i, reason: 'entry tampered' };
      if (this.verifier && e.sig && !this.verifier(canonical(bodyOf(e)), e.sig)) return { ok: false, brokenAt: i, reason: 'bad signature' };
      prev = e.hash;
    }
    return { ok: true, length: this.chain.length, head: this.head() };
  }

  /**
   * The ATTRIBUTION VIEW: measured units per contributor, broken out by kind. This is who-did-what
   * and how-much — the input a future, separate reward system would read. It is NOT a payout and
   * assigns no monetary value.
   */
  summarize() {
    const by = {};
    for (const e of this.chain) {
      const c = (by[e.contributor] ||= { contributor: e.contributor, total: 0, byKind: {} });
      c.total += e.units;
      c.byKind[e.kind] = (c.byKind[e.kind] || 0) + e.units;
    }
    return Object.values(by).sort((a, b) => b.total - a.total);
  }
}
