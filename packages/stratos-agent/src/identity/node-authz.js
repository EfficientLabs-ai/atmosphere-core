/**
 * node-authz.js — GATE 2b: mesh-side command authorization. The ENFORCEMENT half of pairing.
 *
 * Gate 2 paired devices (owner-identity.js). Gate 2b answers the question every mesh message must
 * pass before it can act: "is the node that signed this command one this device actually trusts?"
 *
 * authorizeMeshCommand() is FAIL-CLOSED, deny-by-default. A command is authorized only when ALL hold:
 *   1. it carries a signed envelope (the sender's did + a hybrid signature over the canonical body);
 *   2. the sender is EITHER the pinned owner OR a node in pairedNodes (we pin each peer's public key
 *      at pairing time, so the sender's key is known — never trusted from the message);
 *   3. the sender is NOT in the revocation set;
 *   4. both signature halves verify against the PINNED key for that sender (not the embedded one);
 *   5. (optional) a freshness window rejects stale/replayed envelopes by timestamp + nonce.
 *
 * Anything else — unknown sender, revoked sender, bad signature, missing envelope — is DENIED with a
 * reason. This module holds only public keys and pure verification; it never signs and never reaches
 * the network. Callers (the daemon's mesh ingress) pass the trust set from agent-config runtime
 * state (pairedOwner, pairedNodes, revokedNodes).
 */
import { verifyPayload } from '../security/quantum-crypto.js';
import { originId } from '../memory/skill-seal.js';

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
const decSig = (s) => ({ ed25519Sig: Buffer.from(s.ed25519Sig, 'base64'), mldsaSig: Buffer.from(s.mldsaSig, 'base64') });

/** The canonical signed body of a mesh command envelope — exactly what the sender signed. */
export const commandBody = (e) => canonical({ action: e.action, params: e.params ?? null, sender_did: e.sender_did, ts: e.ts, nonce: e.nonce ?? null });

/**
 * Build the trust index a device uses to authorize peers, from its runtime state.
 * @param {object} state { pairedOwner, pairedNodes, revokedNodes }
 *   - pairedOwner: { owner_did, owner_public_key(base64 bundle) } | null
 *   - pairedNodes: [{ node_did, node_public_key(base64 bundle) }]
 *   - revokedNodes: [ node_did, ... ]
 */
export function buildTrustSet(state = {}) {
  const keyByDid = new Map();
  if (state.pairedOwner?.owner_did && state.pairedOwner.owner_public_key) {
    keyByDid.set(state.pairedOwner.owner_did, { role: 'owner', pub: state.pairedOwner.owner_public_key });
  }
  for (const n of state.pairedNodes || []) {
    if (n?.node_did && n.node_public_key) keyByDid.set(n.node_did, { role: 'node', pub: n.node_public_key });
  }
  const revoked = new Set(state.revokedNodes || []);
  return { keyByDid, revoked };
}

/**
 * FAIL-CLOSED authorization of one mesh command envelope against a trust set.
 * @param {object} envelope { action, params?, sender_did, ts, nonce?, sig:{ed25519Sig,mldsaSig} }
 * @param {object} trust   from buildTrustSet()
 * @param {object} [opts]  { now=Date.now, maxSkewMs=120000, seenNonces:Set }
 * @returns {{ok:boolean, role?:string, reason?:string}}
 */
export function authorizeMeshCommand(envelope, trust, opts = {}) {
  const now = opts.now || Date.now;
  const maxSkewMs = opts.maxSkewMs ?? 120000;
  try {
    if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'no envelope' };
    const { action, sender_did, ts, sig } = envelope;
    if (typeof action !== 'string' || !action) return { ok: false, reason: 'envelope missing action' };
    if (typeof sender_did !== 'string' || !/^did:atmos:[0-9a-f]{40}$/.test(sender_did)) return { ok: false, reason: 'envelope missing/invalid sender_did' };
    if (!sig || typeof sig.ed25519Sig !== 'string' || typeof sig.mldsaSig !== 'string') return { ok: false, reason: 'envelope missing hybrid signature' };

    // (3) revocation BEFORE anything else — a revoked node is dead to us regardless of signature.
    if (trust.revoked.has(sender_did)) return { ok: false, reason: 'sender is REVOKED (fail-closed)' };

    // (2) the sender must be a KNOWN, pinned identity. Unknown sender → deny (no TOFU on commands).
    const known = trust.keyByDid.get(sender_did);
    if (!known) return { ok: false, reason: 'sender is not a paired node or the owner (deny-by-default)' };

    // pin integrity: the pinned key must actually derive the claimed did.
    let pub;
    try { pub = dec(known.pub); } catch { return { ok: false, reason: 'unusable pinned key for sender' }; }
    if (originId(pub) !== sender_did) return { ok: false, reason: 'pinned key does not match sender_did (state corruption)' };

    // (5) freshness — reject envelopes outside the skew window.
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return { ok: false, reason: 'envelope missing/invalid ts' };
    const skew = Math.abs(now() - ts);
    if (skew > maxSkewMs) return { ok: false, reason: `envelope outside freshness window (${Math.round(skew / 1000)}s > ${maxSkewMs / 1000}s)` };

    // (5b) REPLAY protection is MANDATORY (fail-closed): a command must carry a nonce AND the caller
    // must supply a replay store (Set or {has,add}). The only escape is an EXPLICIT opts.idempotent
    // assertion that this command is replay-safe — never a silent default (Codex finding: an opt-in
    // guard the CLI forgot to pass left a replay hole). Freshness window alone is not replay-proof.
    if (!opts.idempotent) {
      if (envelope.nonce == null || envelope.nonce === '') return { ok: false, reason: 'envelope missing nonce (replay protection requires one; pass opts.idempotent only for replay-safe commands)' };
      if (!opts.seenNonces || typeof opts.seenNonces.has !== 'function') return { ok: false, reason: 'no replay store supplied — refusing to authorize a non-idempotent command without replay protection (fail-closed)' };
      const key = `${sender_did}:${envelope.nonce}`;
      if (opts.seenNonces.has(key)) return { ok: false, reason: 'replayed nonce (already seen)' };
    }

    // (4) BOTH signature halves over the canonical body, against the PINNED key.
    if (!verifyPayload(commandBody(envelope), decSig(sig), pub)) {
      return { ok: false, reason: 'command signature failed (tamper or wrong signer)' };
    }

    // Record the nonce ONLY after full success, so a failed auth never burns a nonce.
    if (!opts.idempotent && opts.seenNonces && envelope.nonce != null) opts.seenNonces.add(`${sender_did}:${envelope.nonce}`);
    return { ok: true, role: known.role };
  } catch (e) {
    return { ok: false, reason: 'authorization error: ' + e.message };
  }
}
