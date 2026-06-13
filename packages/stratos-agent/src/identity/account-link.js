/**
 * account-link.js — the NODE → ACCOUNT ownership proof (TRANSPORT_IDENTITY_KEYSTONE second link).
 *
 * Slice 1 built Account → Node (the entitlement signer + the node's offline verifier). This is the
 * inverse: how an Efficient Labs cloud ACCOUNT proves "this node is mine" while holding ONLY the
 * node's PUBLIC material, replay-safely, with no node secret ever leaving the box.
 *
 *   account:  issues a single-use CHALLENGE (a nonce it minted + stored against the logged-in
 *             account/session) and hands it to the node.
 *   node:     signs `account_id + challenge + its own public DID` with the NODE key → an ownership
 *             proof (createNodeAccountProof). The node secret never leaves the function.
 *   account:  verifies the proof with the node's PUBLIC bundle only (verifyNodeAccountProof) and
 *             pins the node DID. account_id binding stops a proof for account A being replayed to
 *             bind account B; the single-use challenge stops the proof being replayed at all.
 *
 * Mostly WIRING of existing identity primitives — NO new crypto. Same hybrid suite (Ed25519 +
 * ML-DSA-65, both must verify), same canonical-JSON, same enc/dec/encSig/decSig idiom as
 * owner-identity.js, same DID derivation (originId), same fail-closed discipline. Sig encoding is
 * BASE64 here (this module's verifier decSig()-decodes BEFORE verifyPayload, exactly like
 * owner-identity.js / node-authz.js) — the byte-array form was forced ONLY in entitlement.js because
 * that verifier calls verifyPayload directly; we control this verifier, so we follow the base64 idiom.
 *
 * SCOPE: this ships the node-side prover + the account-side verifier (pure, exported, tested). The EL
 * cloud account is the NEW surface (future); it imports verifyNodeAccountProof when built — exactly
 * the slice-1 pattern (the node imports the entitlement verifier). Transport is untrusted by design:
 * the signature, not the channel, carries the trust.
 */
import { signPayload, verifyPayload } from '../security/quantum-crypto.js';
import { originId } from '../memory/skill-seal.js';
import { fingerprint } from './owner-identity.js';

const FORMAT = 'efl.node-account-link.v1';
const MAX_ACCOUNT_ID = 256;   // an account id / DID is short; bound it (don't sign unbounded input)
const MAX_CHALLENGE = 512;    // a nonce is ~64 hex chars; 512 is generous headroom

// Same canonical-JSON + base64 helpers as owner-identity.js (module-private there; replicated here
// so this module is self-contained — a divergence is caught by the round-trip test).
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
const encSig = (s) => ({ ed25519Sig: s.ed25519Sig.toString('base64'), mldsaSig: s.mldsaSig.toString('base64') });
const decSig = (s) => ({ ed25519Sig: Buffer.from(s.ed25519Sig, 'base64'), mldsaSig: Buffer.from(s.mldsaSig, 'base64') });

/** The signed body = the proof MINUS its sig. Explicit + ordered through canonical() so it hashes
 *  identically on the node and on the account. Built from explicit fields (never spread from an
 *  untrusted object) so no caller-controlled key can enter the signed body. */
const proofBody = (p) => canonical({
  kind: FORMAT,
  node_did: p.node_did,
  node_public_key: p.node_public_key,
  account_id: p.account_id,
  challenge: p.challenge,
  issued_at: p.issued_at,
});

/**
 * NODE side: mint a signed ownership proof binding this node to `accountId` for this single
 * `challenge`. The node secret never leaves the function; the proof carries only public material.
 * @param {object} a
 * @param {object} a.nodeKeys   the node's hybrid keypair { publicKey, privateKey }
 * @param {string} a.accountId  the EL account this proof binds to (bound into the signature)
 * @param {string} a.challenge  the single-use nonce the account issued (bound into the signature)
 * @param {function} [a.now]    injectable clock (ms)
 * @returns {object} the signed proof { kind, node_did, node_public_key, account_id, challenge, issued_at, sig }
 */
export function createNodeAccountProof({ nodeKeys, accountId, challenge, now = Date.now } = {}) {
  if (!nodeKeys?.publicKey || !nodeKeys?.privateKey) throw new Error('node-account proof needs the node keypair');
  if (typeof accountId !== 'string' || !accountId || accountId.length > MAX_ACCOUNT_ID) {
    throw new Error(`node-account proof needs a non-empty account_id string (<= ${MAX_ACCOUNT_ID} chars)`);
  }
  if (typeof challenge !== 'string' || !challenge || challenge.length > MAX_CHALLENGE) {
    throw new Error(`node-account proof needs a non-empty challenge string (<= ${MAX_CHALLENGE} chars)`);
  }
  const p = {
    kind: FORMAT,
    node_did: originId(nodeKeys.publicKey),
    node_public_key: enc(nodeKeys.publicKey),
    account_id: accountId,
    challenge,
    issued_at: now(),
  };
  p.sig = encSig(signPayload(proofBody(p), nodeKeys.privateKey));
  return p;
}

/**
 * ACCOUNT side: verify an ownership proof, fail-closed, holding only public material. This is the
 * function the EL cloud account ports/imports.
 * @param {object} proof  the proof object (expected JSON-parsed network data — a plain object)
 * @param {object} o
 * @param {string} o.expectedAccountId   the account doing the verifying (the proof MUST bind to it)
 * @param {string} o.expectedChallenge   the exact challenge the account issued (the proof MUST carry it)
 * @param {Set}    [o.seenChallenges]    single-use store: a (account:challenge) seen before is refused
 * @param {number} [o.maxSkewMs=120000]  freshness window around issued_at
 * @param {function} [o.now]             injectable clock
 * @returns {object} { ok, nodeDid?, nodeFingerprint?, accountId?, reason? }
 */
export function verifyNodeAccountProof(proof, opts) {
  try {
    // opts destructured INSIDE the try with a null-safe default — `= {}` only covers `undefined`, so
    // verifyNodeAccountProof(proof, null) must not throw on destructure (dual-Codex: fail-closed API).
    const { expectedAccountId = null, expectedChallenge = null, seenChallenges = null, maxSkewMs = 120_000, now = Date.now } = opts || {};
    if (!proof || typeof proof !== 'object' || proof.kind !== FORMAT || !proof.node_public_key || !proof.sig || typeof proof.sig !== 'object') {
      return { ok: false, reason: 'malformed node-account proof' };
    }
    // INERT SNAPSHOT (dual-Codex round 1): normalize the proof to plain primitives BEFORE any check
    // or body reconstruction, so "what we check" === "what we sign-verify". Scalars must be the right
    // primitive type (NOT coerced — a crafted object whose Number() looks fresh while its serialized
    // bytes differ is rejected outright). node_public_key is rebuilt as a fresh plain object of
    // base64-string leaves (an exotic object that shows key A to originId/verify but key B to the
    // canonical body can no longer exist). The body is then built from this snapshot only.
    const node_did = proof.node_did, account_id = proof.account_id, challenge = proof.challenge, issued_at = proof.issued_at;
    const sigEd = proof.sig.ed25519Sig, sigMl = proof.sig.mldsaSig;
    if (typeof node_did !== 'string' || typeof account_id !== 'string' || typeof challenge !== 'string') {
      return { ok: false, reason: 'proof scalar fields malformed' };
    }
    if (typeof issued_at !== 'number' || !Number.isFinite(issued_at)) {
      return { ok: false, reason: 'issued_at must be a finite number' };
    }
    if (typeof sigEd !== 'string' || typeof sigMl !== 'string') {
      return { ok: false, reason: 'proof signature malformed' };
    }
    const rawNpk = proof.node_public_key;
    if (typeof rawNpk !== 'object' || Array.isArray(rawNpk)) return { ok: false, reason: 'node_public_key malformed' };
    // Object.create(null), NOT {} (dual-Codex round 2): a parsed node_public_key can carry an own
    // `__proto__` key (JSON.parse makes it an own property); assigning it onto a normal object hits
    // the prototype setter and silently drops it, so the snapshot would differ from the signed body.
    // A null-prototype target treats `__proto__` as an ordinary own key (faithful snapshot) AND makes
    // prototype pollution impossible. Every leaf is read ONCE and must be a base64 string.
    const npk = Object.create(null);
    for (const k of Object.keys(rawNpk)) {
      const v = rawNpk[k];
      if (typeof v !== 'string') return { ok: false, reason: 'node_public_key entries must be base64 strings' };
      npk[k] = v;
    }
    // ACCOUNT binding — a proof for account A must never bind account B.
    if (expectedAccountId == null) return { ok: false, reason: 'verify requires expectedAccountId (the account issuing the challenge)' };
    if (account_id !== expectedAccountId) return { ok: false, reason: 'account_id does not match the verifying account (cross-account replay refused)' };
    // CHALLENGE binding — must equal the exact nonce the account issued.
    if (expectedChallenge == null) return { ok: false, reason: 'verify requires expectedChallenge (the nonce the account issued)' };
    if (challenge !== expectedChallenge) return { ok: false, reason: 'challenge does not match the issued challenge' };
    // SINGLE-USE replay protection — INJECTIVE key (dual-Codex: `a+':'+b` collides, e.g. ('a:b','c')
    // vs ('a','b:c') — one bind could burn another valid pair). JSON-array encoding is unambiguous.
    const seenKey = JSON.stringify([account_id, challenge]);
    if (seenChallenges && seenChallenges.has(seenKey)) return { ok: false, reason: 'challenge already used (replay refused)' };
    // FRESHNESS — within the skew window (not stale, not future-dated).
    if (Math.abs(now() - issued_at) > maxSkewMs) return { ok: false, reason: 'proof is outside the freshness window (stale or future-dated)' };
    // DID ↔ KEY binding — the embedded public key must derive the claimed node_did.
    const nodePub = dec(npk);
    if (originId(nodePub) !== node_did) return { ok: false, reason: 'node_did does not match the embedded public key' };
    // SIGNATURE — both hybrid halves must verify over the body rebuilt from the inert snapshot.
    const body = proofBody({ node_did, node_public_key: npk, account_id, challenge, issued_at });
    if (!verifyPayload(body, decSig({ ed25519Sig: sigEd, mldsaSig: sigMl }), nodePub)) {
      return { ok: false, reason: 'proof signature failed (tamper or wrong node key)' };
    }
    if (seenChallenges) seenChallenges.add(seenKey); // consume the challenge — only after full success
    return { ok: true, nodeDid: node_did, nodeFingerprint: fingerprint(nodePub), accountId: account_id };
  } catch (e) {
    return { ok: false, reason: 'unverifiable proof: ' + e.message };
  }
}
