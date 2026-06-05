/**
 * capability-receipt.js — the SIGNED CAPABILITY RECEIPT: the cross-machine proof rail.
 *
 * WHY THIS IS THE KEYSTONE MOAT: when models are free, the value is no longer the inference — it is the
 * verifiable PROOF of who contributed what compute, for whom, at what cost. Every inference and every
 * verified skill-run emits a receipt that a third party can check holding ONLY the node's PUBLIC key:
 * it proves WHO ran WHAT (actor + action + ref), on WHOSE machine (node_id), over WHICH input/output
 * (sha256 HASHES — never the content, privacy-preserving), at WHAT measured cost (cost_units) — and
 * that the receipt has not been altered, removed, or reordered (a hybrid-PQC-signed hash chain).
 *
 * BUILT ON THE EXISTING SUBSTRATE — NO NEW CRYPTO:
 *  - The append-only, tamper-evident HASH CHAIN is the exact pattern proven in attribution-ledger.js
 *    (canonical(body)+prev → sha256; verify() replays prev-links + per-entry hash + signature).
 *  - Signing is the repo's REAL hybrid suite via skill-seal's body-signer idiom over quantum-crypto's
 *    signPayload/verifyPayload (Ed25519 + ML-DSA-65, BOTH must verify). The signer/verifier are
 *    INJECTED exactly like AttributionLedger's, so this stays pure and the same chain works across the
 *    untrusted mesh once signed.
 *  - did:atmos identities (originId from skill-seal) name the actor and the node.
 *
 * HONEST, like the ledger: cost_units is a MEASURED quantity the caller supplies (token estimate,
 * response length, a count) — NEVER a price. summarize() attributes measured cost per actor and per
 * node; it does not value, reward, or settle. Accounting before rewards.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signPayload, verifyPayload } from '../security/quantum-crypto.js';
import { originId } from '../memory/skill-seal.js';

/** The actions a receipt can attest. Deny-by-default: an unknown action is rejected at append(). */
export const RECEIPT_ACTIONS = Object.freeze(['inference', 'skill-run']);

const GENESIS = '0'.repeat(64);

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** sha256 of arbitrary input — the privacy-preserving fingerprint stored in a receipt (never content). */
export function hashContent(x) {
  if (x == null) return sha256('');
  return sha256(typeof x === 'string' ? x : Buffer.isBuffer(x) ? x : canonical(x));
}

/**
 * The SIGNED body of a receipt — every field that a third party verifies. Excludes hash + sig (the
 * envelope) so the signature covers exactly the claim. prev_hash IS in the body, so a receipt is
 * cryptographically bound to its position in the chain: removing/reordering breaks the next link AND
 * its signature. Keys are explicit + ordered through canonical(), so the same body hashes identically
 * on any machine.
 */
const receiptBody = (r) => ({
  receipt_id: r.receipt_id,
  ts: r.ts,
  actor_id: r.actor_id,
  action: r.action,
  ref: r.ref,
  node_id: r.node_id,
  input_hash: r.input_hash,
  output_hash: r.output_hash,
  cost_units: r.cost_units,
  caller_id: r.caller_id ?? null,
  prev_hash: r.prev_hash,
});
const canonicalBody = (r) => canonical(receiptBody(r));
const hashReceipt = (r) => sha256(canonicalBody(r));

/**
 * Build a single receipt object from caller fields. Validates the action + cost; fills receipt_id/ts
 * from injectable jti/now; chains onto prevHash. Does NOT sign — append() signs (it owns the signer).
 * @param {object} f
 * @param {string} f.actor_id    did:atmos of the caller/subject whose work this attests.
 * @param {'inference'|'skill-run'} f.action
 * @param {string} f.ref         model name (inference) or skill id (skill-run).
 * @param {string} f.node_id     did:atmos of the compute node that ran it.
 * @param {string} f.input_hash  sha256 of the input (HASH, not content).
 * @param {string} f.output_hash sha256 of the output (HASH, not content).
 * @param {number} f.cost_units  MEASURED non-negative cost (tokens / length / count) — never a price.
 * @param {string|null} [f.caller_id]  optional did:atmos of a distinct caller/relayer.
 * @param {object} [opts] { prevHash, now, jti }
 */
export function createReceipt(f = {}, opts = {}) {
  if (!RECEIPT_ACTIONS.includes(f.action)) throw new Error(`unknown receipt action "${f.action}"`);
  if (typeof f.actor_id !== 'string' || !f.actor_id) throw new Error('receipt needs an actor_id (did:atmos)');
  if (typeof f.node_id !== 'string' || !f.node_id) throw new Error('receipt needs a node_id (did:atmos)');
  if (typeof f.cost_units !== 'number' || !Number.isFinite(f.cost_units) || f.cost_units < 0) {
    throw new Error('cost_units must be a non-negative measured number (never a price)');
  }
  const now = opts.now ? opts.now() : Date.now();
  const jti = opts.jti ? opts.jti() : (crypto.randomUUID ? crypto.randomUUID() : sha256(String(now) + Math.random()).slice(0, 32));
  const r = {
    receipt_id: String(jti),
    ts: now,
    actor_id: f.actor_id,
    action: f.action,
    ref: f.ref == null ? null : String(f.ref),
    node_id: f.node_id,
    input_hash: String(f.input_hash ?? hashContent('')),
    output_hash: String(f.output_hash ?? hashContent('')),
    cost_units: f.cost_units,
    caller_id: f.caller_id ?? null,
    prev_hash: opts.prevHash || GENESIS,
  };
  r.hash = hashReceipt(r);
  return r;
}

/**
 * A hybrid-PQC signer/verifier pair bound to a node keypair — the SAME Ed25519+ML-DSA-65 suite the
 * skill seal uses. The signer produces a compact {ed25519Sig, mldsaSig} (base64) over the canonical
 * body; the verifier checks both halves against the node's PUBLIC bundle. Either alone is enough to
 * make ReceiptLog cross-machine verifiable; the verifier needs ONLY the public bundle.
 */
export function makeReceiptSigner(privateKeyBundle) {
  return (body) => {
    const sig = signPayload(body, privateKeyBundle);
    return { ed25519Sig: sig.ed25519Sig.toString('base64'), mldsaSig: sig.mldsaSig.toString('base64') };
  };
}
export function makeReceiptVerifier(publicKeyBundle) {
  return (body, sig) => {
    if (!sig || typeof sig.ed25519Sig !== 'string' || typeof sig.mldsaSig !== 'string') return false;
    let bundle;
    try {
      bundle = { ed25519Sig: Buffer.from(sig.ed25519Sig, 'base64'), mldsaSig: Buffer.from(sig.mldsaSig, 'base64') };
    } catch { return false; }
    return verifyPayload(body, bundle, publicKeyBundle);
  };
}

/**
 * ReceiptLog — append-only, hash-chained, JSONL-persisted log of capability receipts. Mirrors
 * AttributionLedger's proven chain + injected signer/verifier, specialized to the receipt schema.
 */
export class ReceiptLog {
  /**
   * @param {object} [o]
   * @param {string|null} [o.path]        JSONL file (append-only). null = in-memory.
   * @param {function|null} [o.signer]    (canonicalBody:string) => sig — hybrid PQC signer (see makeReceiptSigner).
   * @param {function|null} [o.verifier]  (canonicalBody:string, sig) => bool — verifier (see makeReceiptVerifier).
   * @param {string|null} [o.nodeId]      this node's did:atmos (default node_id for emitted receipts).
   * @param {function|null} [o.now]       injectable clock (ms) — deterministic tests.
   * @param {function|null} [o.jti]       injectable receipt-id generator — deterministic tests.
   */
  constructor({ path: p = null, signer = null, verifier = null, nodeId = null, now = null, jti = null } = {}) {
    this.path = p; this.signer = signer; this.verifier = verifier;
    this.nodeId = nodeId; this._now = now; this._jti = jti;
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

  /**
   * Append a receipt: chain onto the head, sign the canonical body with the node key, persist. The
   * caller supplies actor/action/ref/hashes/cost; node_id defaults to this log's nodeId. Returns the
   * full signed receipt.
   */
  append(fields = {}) {
    const f = { node_id: this.nodeId, ...fields };
    const r = createReceipt(f, { prevHash: this.head(), now: this._now, jti: this._jti });
    if (this.signer) r.sig = this.signer(canonicalBody(r));
    this.chain.push(r);
    if (this.path) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.appendFileSync(this.path, JSON.stringify(r) + '\n');
    }
    return r;
  }

  /**
   * Replay the chain — FAIL-CLOSED. Checks, for every receipt in order:
   *   (1) prev_hash links to the previous receipt's hash (genesis for the first),
   *   (2) the stored hash equals sha256(canonical body) — catches ANY altered field,
   *   (3) (if a verifier is set) the hybrid PQC signature over the canonical body verifies.
   * A removed or reordered receipt breaks (1); an edited field breaks (2) and (3); a forged/foreign
   * signature breaks (3). Returns {ok, brokenAt, reason} on the first failure, never throws on a
   * malformed entry.
   */
  verify({ requireSig = false } = {}) {
    let prev = GENESIS;
    for (let i = 0; i < this.chain.length; i++) {
      const r = this.chain[i];
      if (!r || typeof r !== 'object') return { ok: false, brokenAt: i, reason: 'malformed receipt' };
      if (r.prev_hash !== prev) return { ok: false, brokenAt: i, reason: 'broken chain link (removed/reordered)' };
      if (r.hash !== hashReceipt(r)) return { ok: false, brokenAt: i, reason: 'receipt tampered (field altered)' };
      if (this.verifier) {
        if (!r.sig) {
          if (requireSig) return { ok: false, brokenAt: i, reason: 'missing signature (fail-closed)' };
        } else if (!this.verifier(canonicalBody(r), r.sig)) {
          return { ok: false, brokenAt: i, reason: 'bad signature (tamper or wrong signer)' };
        }
      } else if (requireSig && r.sig) {
        return { ok: false, brokenAt: i, reason: 'no verifier to check signature (fail-closed)' };
      }
      prev = r.hash;
    }
    return { ok: true, length: this.chain.length, head: this.head() };
  }

  /**
   * The ATTRIBUTION VIEW: measured cost + count per ACTOR and per NODE. This is who-ran-what-and-how-
   * much across machines — the input a future, separate reward layer would read. It is NOT a payout
   * and carries NO price field. Honest by construction (same discipline as the attribution ledger).
   */
  summarize() {
    const byActor = {}, byNode = {};
    for (const r of this.chain) {
      const a = (byActor[r.actor_id] ||= { actor_id: r.actor_id, count: 0, cost_units: 0, byAction: {} });
      a.count += 1; a.cost_units += r.cost_units;
      a.byAction[r.action] = (a.byAction[r.action] || 0) + r.cost_units;
      const n = (byNode[r.node_id] ||= { node_id: r.node_id, count: 0, cost_units: 0, byAction: {} });
      n.count += 1; n.cost_units += r.cost_units;
      n.byAction[r.action] = (n.byAction[r.action] || 0) + r.cost_units;
    }
    const sortByCost = (o) => Object.values(o).sort((x, y) => y.cost_units - x.cost_units);
    return { byActor: sortByCost(byActor), byNode: sortByCost(byNode), total: this.chain.length };
  }

  /**
   * A self-contained, third-party-verifiable BUNDLE: the node's PUBLIC key bundle + the receipts
   * (optionally filtered by `since`). A verifier reconstructs makeReceiptVerifier(bundle.public_key)
   * and replays the chain — confirming every signature and the full hash chain with NO private key
   * and NO access to this node. The public bundle is exported base64 so it round-trips through JSON.
   * @param {object} [o] { since:isoString|ms, publicKeyBundle }
   */
  exportBundle({ since = null, publicKeyBundle = null } = {}) {
    let receipts = this.chain.slice();
    if (since != null) {
      const cut = typeof since === 'number' ? since : Date.parse(since);
      if (Number.isFinite(cut)) receipts = receipts.filter((r) => r.ts >= cut);
    }
    const bundle = { format: 'stratos.capability-receipts.v1', exported_at: this._now ? this._now() : Date.now(), receipts };
    if (publicKeyBundle) {
      const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
      bundle.public_key = enc(publicKeyBundle);
      try { bundle.node_id = originId(publicKeyBundle); } catch { /* not a did bundle */ }
    }
    return bundle;
  }
}

/**
 * Verify a self-contained exported bundle holding ONLY its embedded PUBLIC key — the third-party
 * acceptance path. Reconstructs the hybrid verifier from bundle.public_key, replays the FULL chain
 * (a contiguous chain must start at genesis; a `since`-filtered export starts mid-chain, so the first
 * prev_hash is accepted as the anchor and every subsequent link + every signature is still checked).
 * Fail-CLOSED. Returns {ok, brokenAt?, reason?, count, node_id?}.
 */
export function verifyBundle(bundle) {
  if (!bundle || !Array.isArray(bundle.receipts)) return { ok: false, reason: 'malformed bundle' };
  if (!bundle.public_key) return { ok: false, reason: 'bundle carries no public key — cannot verify (fail-closed)' };
  let publicKeyBundle, verifier;
  try {
    publicKeyBundle = Object.fromEntries(Object.entries(bundle.public_key).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    verifier = makeReceiptVerifier(publicKeyBundle);
  } catch (e) { return { ok: false, reason: 'unusable public key: ' + e.message }; }

  const receipts = bundle.receipts;
  let prev = null; // anchor: the first receipt's own prev_hash (supports since-filtered partial chains)
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (!r || typeof r !== 'object') return { ok: false, brokenAt: i, reason: 'malformed receipt' };
    if (prev === null) prev = r.prev_hash; // anchor on the first receipt's declared predecessor
    if (r.prev_hash !== prev) return { ok: false, brokenAt: i, reason: 'broken chain link (removed/reordered)' };
    if (r.hash !== hashReceipt(r)) return { ok: false, brokenAt: i, reason: 'receipt tampered (field altered)' };
    if (!r.sig || !verifier(canonicalBody(r), r.sig)) {
      return { ok: false, brokenAt: i, reason: 'signature failed (tamper, removal, or wrong signer)' };
    }
    prev = r.hash;
  }
  let nodeId;
  try { nodeId = originId(publicKeyBundle); } catch { /* not a did bundle */ }
  return { ok: true, count: receipts.length, node_id: nodeId };
}
