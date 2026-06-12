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
// 'term-session' (2026-06-12): terminal session lifecycle events (start/attach/detach/end) join the
// receipt rail — the ref field carries the event. Verification is enum-agnostic (hash chain +
// signatures), so bundles containing the new action verify with pre-existing verifiers.
export const RECEIPT_ACTIONS = Object.freeze(['inference', 'skill-run', 'term-session']);

const GENESIS = '0'.repeat(64);

/**
 * Solana base58 address validator — the OWNER WALLET that a node's compute is attributed to.
 * A wallet ADDRESS is PUBLIC and safe to store/advertise; this never touches a private key.
 * Solana addresses are base58-encoded 32-byte public keys: 32–44 chars from the Bitcoin/Solana
 * base58 alphabet (NO 0, O, I, l). We validate shape only (length + alphabet) — strict enough to
 * reject typos and any injection attempt (no whitespace, no shell/SQL metachars survive), and we
 * never interpolate the raw value into logs/SQL/shell. Returns true/false; never throws.
 */
const SOLANA_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isValidSolanaAddress(addr) {
  return typeof addr === 'string' && SOLANA_BASE58.test(addr);
}
/**
 * Normalize a caller-supplied wallet to a clean attribution value: a valid address, or null
 * (unattributed). Trims surrounding whitespace, then validates. An invalid non-empty string is
 * a CALLER error here (createReceipt rejects it); absent/empty → null (graceful "unattributed").
 */
export function normalizeWallet(addr) {
  if (addr == null) return null;
  const s = String(addr).trim();
  if (!s) return null;
  return isValidSolanaAddress(s) ? s : false; // false = present-but-invalid (caller decides)
}

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
// BODY VERSIONING (legacy v0): receipts persisted before `owner_wallet` entered the schema carry
// NO owner_wallet key — their hash and BOTH signature halves cover the body WITHOUT it.
// Verification reconstructs the body the writer actually signed, keyed on field PRESENCE.
// Tamper-safe in both directions: stripping the key from a current receipt (or adding it to a
// legacy one) changes the canonical string, so the stored hash AND the hybrid signature both
// fail. createReceipt() always sets owner_wallet, so every receipt written today is current-format.
const receiptBody = (r) => {
  const body = {
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
  };
  if (Object.hasOwn(r, 'owner_wallet')) body.owner_wallet = r.owner_wallet ?? null; // absent OWN key = legacy v0
  return body;
};
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
 * @param {string|null} [f.owner_wallet]  optional Solana address of the node OWNER this contribution
 *   is attributed to. PUBLIC address only (never a key). Absent/empty → null (unattributed); a present-
 *   but-invalid address is REJECTED (never fabricated, never silently dropped). Part of the SIGNED body.
 * @param {object} [opts] { prevHash, now, jti }
 */
export function createReceipt(f = {}, opts = {}) {
  if (!RECEIPT_ACTIONS.includes(f.action)) throw new Error(`unknown receipt action "${f.action}"`);
  if (typeof f.actor_id !== 'string' || !f.actor_id) throw new Error('receipt needs an actor_id (did:atmos)');
  if (typeof f.node_id !== 'string' || !f.node_id) throw new Error('receipt needs a node_id (did:atmos)');
  if (typeof f.cost_units !== 'number' || !Number.isFinite(f.cost_units) || f.cost_units < 0) {
    throw new Error('cost_units must be a non-negative measured number (never a price)');
  }
  const wallet = normalizeWallet(f.owner_wallet);
  if (wallet === false) throw new Error('owner_wallet must be a valid Solana address (base58, 32-44 chars) or absent');
  const now = opts.now ? opts.now() : Date.now();
  const jti = opts.jti ? opts.jti() : (crypto.randomUUID ? crypto.randomUUID() : sha256(String(now) + Math.random()).slice(0, 32));
  const r = {
    receipt_id: String(jti),
    ts: now,
    actor_id: f.actor_id,
    action: f.action,
    ref: f.ref == null ? null : String(f.ref),
    node_id: f.node_id,
    owner_wallet: wallet, // valid Solana address or null (unattributed) — signed + hash-chained
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
   * @param {number} [o.rotateMaxBytes]   OPT-IN size-based rotation: when the active file already
   *   exceeds this many bytes at the START of an append, it is renamed to `<path>.<ts>.segment` and
   *   a fresh active file begins with a SIGNED control line
   *   `{"_rotated_from":..., "_prev_head":..., "_sig":{ed25519Sig,mldsaSig}}` recording the lineage
   *   (the same hybrid suite that signs receipts signs the anchor — an edited control line fails
   *   verification exactly like an edited receipt). Rotation requires a signer; a signer-less log
   *   NEVER rotates (an unsigned anchor would weaken prefix-truncation detection). The hash chain
   *   continues unbroken across segments; archived segments verify as anchored partial chains —
   *   the SAME trust model as `exportBundle({since})`. 0/absent = never rotate (default).
   */
  constructor({ path: p = null, signer = null, verifier = null, nodeId = null, now = null, jti = null, rotateMaxBytes = 0 } = {}) {
    this.path = p; this.signer = signer; this.verifier = verifier;
    this.nodeId = nodeId; this._now = now; this._jti = jti;
    this.rotateMaxBytes = Number(rotateMaxBytes) || 0;
    this.chain = [];
    // Anchor for a rotated ACTIVE file: the head hash of the previous segment, from the SIGNED
    // control line. verify() (a) checks the control line's signature when a verifier is present —
    // fail-closed — and (b) requires the first loaded receipt to chain onto the anchor, so a
    // truncated/head-spliced active file fails even if _prev_head is rewritten to match.
    this._anchor = GENESIS;
    this._anchorLine = null; // the parsed control line, kept for verify()
    if (p && fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim(); if (!t) continue;
        const obj = JSON.parse(t);
        if (obj && typeof obj._prev_head === 'string') { this._anchor = obj._prev_head; this._anchorLine = obj; continue; }
        this.chain.push(obj);
      }
    }
  }

  get length() { return this.chain.length; }
  head() { return this.chain.length ? this.chain[this.chain.length - 1].hash : this._anchor; }
  entries() { return this.chain.slice(); }

  /** Canonical signed body of a rotation control line (lineage claim, envelope excluded). */
  static _controlBody(c) { return canonical({ _rotated_from: c._rotated_from, _prev_head: c._prev_head }); }

  /**
   * Append a receipt: chain onto the head, sign the canonical body with the node key, persist. The
   * caller supplies actor/action/ref/hashes/cost; node_id defaults to this log's nodeId. Returns the
   * full signed receipt. With rotateMaxBytes set, rotation happens BEFORE the write when the active
   * file is already over the threshold — the just-minted receipt always lands in the (possibly
   * fresh) active file, so the trace pointer recorded against this log's path stays correct for it.
   */
  append(fields = {}) {
    const f = { node_id: this.nodeId, ...fields };
    const r = createReceipt(f, { prevHash: this.head(), now: this._now, jti: this._jti });
    if (this.signer) r.sig = this.signer(canonicalBody(r));
    if (this.path) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      this._maybeRotate();
      fs.appendFileSync(this.path, JSON.stringify(r) + '\n');
    }
    this.chain.push(r);
    return r;
  }

  /**
   * Size-based segment rotation (pre-append). The oversized active file is renamed to
   * `<path>.<ts>.segment` (a valid anchored-partial-chain JSONL a verifier can export/replay) and a
   * fresh active file begins with the SIGNED lineage control line. The in-memory chain is trimmed to
   * keep RAM bounded too — the hash chain itself is NOT broken: the next append links onto the
   * preserved head. Requires a signer (unsigned anchors are refused by design).
   */
  _maybeRotate() {
    if (!this.rotateMaxBytes || !this.signer) return;
    let size = 0;
    try { size = fs.statSync(this.path).size; } catch { return; } // no file yet → nothing to rotate
    if (size <= this.rotateMaxBytes) return;
    const stamp = new Date(this._now ? this._now() : Date.now()).toISOString().replace(/[:.]/g, '-');
    const segment = `${this.path}.${stamp}.segment`;
    const control = { _rotated_from: path.basename(segment), _prev_head: this.head() };
    control._sig = this.signer(ReceiptLog._controlBody(control));
    fs.renameSync(this.path, segment);
    fs.writeFileSync(this.path, JSON.stringify(control) + '\n');
    this._anchor = control._prev_head;
    this._anchorLine = control;
    this.chain = []; // segment receipts live on disk; the chain continues from the anchored head
  }

  /**
   * Load EVERY receipt for a rotated log — archived segments (oldest first) then the active file —
   * skipping control lines. Returns plain receipt objects forming one genesis-rooted chain; put them
   * on an in-memory ReceiptLog to verify/export/summarize full history. This is what segment-aware
   * readers (CLI export/summary, metrics) use so rotation never silently shrinks history.
   */
  static loadChainEntries(p) {
    const dir = path.dirname(p), base = path.basename(p);
    const files = [];
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(base + '.') && f.endsWith('.segment')) files.push(path.join(dir, f));
      }
    }
    files.sort(); // ISO stamps in the name → lexicographic = chronological
    if (fs.existsSync(p)) files.push(p);
    const entries = [];
    for (const file of files) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const t = line.trim(); if (!t) continue;
        const obj = JSON.parse(t);
        if (obj && typeof obj._prev_head === 'string') continue; // lineage control line, not a receipt
        entries.push(obj);
      }
    }
    return entries;
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
    // A rotation control line is a lineage CLAIM — with a verifier present it must carry a valid
    // hybrid signature or the whole file fails closed (an attacker rewriting _prev_head to bless a
    // truncated prefix breaks this signature exactly like editing a receipt).
    if (this._anchorLine && this.verifier) {
      const c = this._anchorLine;
      if (!c._sig || !this.verifier(ReceiptLog._controlBody(c), c._sig)) {
        return { ok: false, brokenAt: -1, reason: 'rotation control line failed verification (fail-closed)' };
      }
    }
    let prev = this._anchor; // GENESIS normally; the previous segment's head after a rotation reload
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
   * The ATTRIBUTION VIEW: measured cost + count per ACTOR, per NODE, and per OWNER WALLET. This is
   * who-ran-what-and-how-much across machines — the input a future, separate reward layer would read.
   * It is NOT a payout and carries NO price field. Honest by construction (same discipline as the
   * attribution ledger).
   *
   * byWallet is the REWARD-ATTRIBUTION view: total measured cost_units per owner_wallet — so the day a
   * reward layer lands, every contributing node is ALREADY attributed and rewardable, on the basis of
   * measured contribution alone. Receipts with no owner_wallet (null) are summed under the explicit
   * UNATTRIBUTED bucket — never invented, never dropped.
   */
  summarize() {
    const byActor = {}, byNode = {}, byWallet = {};
    const UNATTRIBUTED = '(unattributed)';
    for (const r of this.chain) {
      const a = (byActor[r.actor_id] ||= { actor_id: r.actor_id, count: 0, cost_units: 0, byAction: {} });
      a.count += 1; a.cost_units += r.cost_units;
      a.byAction[r.action] = (a.byAction[r.action] || 0) + r.cost_units;
      const n = (byNode[r.node_id] ||= { node_id: r.node_id, count: 0, cost_units: 0, byAction: {} });
      n.count += 1; n.cost_units += r.cost_units;
      n.byAction[r.action] = (n.byAction[r.action] || 0) + r.cost_units;
      const wkey = r.owner_wallet || UNATTRIBUTED;
      const w = (byWallet[wkey] ||= { owner_wallet: r.owner_wallet ?? null, attributed: !!r.owner_wallet, count: 0, cost_units: 0, byAction: {} });
      w.count += 1; w.cost_units += r.cost_units;
      w.byAction[r.action] = (w.byAction[r.action] || 0) + r.cost_units;
    }
    const sortByCost = (o) => Object.values(o).sort((x, y) => y.cost_units - x.cost_units);
    return { byActor: sortByCost(byActor), byNode: sortByCost(byNode), byWallet: sortByCost(byWallet), total: this.chain.length };
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
