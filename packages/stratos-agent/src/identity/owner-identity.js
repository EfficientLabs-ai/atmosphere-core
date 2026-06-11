/**
 * owner-identity.js — GATE 2: the CRYPTOGRAPHIC owner identity + the explicit node-pairing ceremony.
 *
 * Gate 1 bound an owner by CHAT ID (agent-config bindOwner — UI-level auth: it stops strangers in a
 * Telegram DM, it is not an authority). Gate 2 gives the owner a REAL identity — the same hybrid
 * post-quantum suite the node itself uses (Ed25519 + ML-DSA-65, both must verify) — and a pairing
 * ceremony that lets a SECOND node join the same owner without blind trust:
 *
 *   node B:  `stratos pair request`             → signed pairing-request (carries B's public key);
 *            the human READS B's fingerprint off B's screen.
 *   node A:  `stratos pair approve <req> --fingerprint <what-the-human-read>`
 *            → the request's signature is verified, the fingerprint MUST match what the human
 *              supplied (no TOFU — the comparison is the ceremony), and the owner key signs a
 *              pairing-grant. The pairing is recorded in runtime state.
 *   node B:  `stratos pair accept <grant> --owner-fingerprint <fp>`
 *            → verifies the grant is for THIS node (replay protection), verifies both signature
 *              halves, compares the OWNER's fingerprint (read off the owner device — required on
 *              first accept; the ceremony is symmetric, no blind trust in EITHER direction), then
 *              PINS the owner's public key; future grants must verify against the pin.
 *
 * FAIL-CLOSED everywhere: a malformed request, a DID that doesn't match its embedded key, a missing
 * or wrong fingerprint, a bad signature half — each refuses loudly. Nothing here touches the
 * network; artifacts are JSON files the human moves between devices (USB, scp, QR — transport is
 * out of scope and untrusted by design: the signatures, not the channel, carry the trust).
 *
 * HONEST SCOPE (Gate 2): identity + ceremony + pinning + storage + CLI. Mesh-side command
 * enforcement against pairedNodes and revocation are Gate 2b — documented, not claimed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signPayload, verifyPayload, generateHybridKeyPair } from '../security/quantum-crypto.js';
import { originId } from '../memory/skill-seal.js';

// Same canonical-JSON construction as skill-seal / capability-receipt: sorted keys, exact bytes.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
const encSig = (s) => ({ ed25519Sig: s.ed25519Sig.toString('base64'), mldsaSig: s.mldsaSig.toString('base64') });
const decSig = (s) => ({ ed25519Sig: Buffer.from(s.ed25519Sig, 'base64'), mldsaSig: Buffer.from(s.mldsaSig, 'base64') });

/**
 * The HUMAN-COMPARABLE fingerprint of a public key bundle: sha256 over the two SIGNING keys
 * (the same bytes originId hashes), first 16 hex chars in 4-char groups — short enough to read
 * aloud across a room, long enough that forging a colliding keypair is not a pairing-time attack.
 */
export function fingerprint(publicKeyBundle) {
  const pk = typeof publicKeyBundle.ed25519Der === 'string' ? dec(publicKeyBundle) : publicKeyBundle;
  const hex = crypto.createHash('sha256')
    .update(Buffer.from(pk.ed25519Der)).update(Buffer.from(pk.mldsaDer))
    .digest('hex').slice(0, 16);
  return hex.match(/.{4}/g).join('-');
}

/**
 * Load (or create on first use) the OWNER keypair — hybrid PQC, persisted 0600, separate from the
 * node keys: the owner identity outlives any one device. STRATOS_OWNER_KEYS overrides the path.
 */
export function loadOrCreateOwnerKeys({
  profileDir = process.env.STRATOS_PROFILE_DIR || '.stratos-profile',
  file = process.env.STRATOS_OWNER_KEYS || null,
} = {}) {
  const keyFile = file || path.join(profileDir, 'owner-keys.json');
  let keys;
  if (fs.existsSync(keyFile)) {
    try { fs.chmodSync(keyFile, 0o600); } catch { /* permission hygiene is best-effort on foreign FS */ }
    const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    keys = { publicKey: dec(raw.publicKey), privateKey: dec(raw.privateKey) };
  } else {
    keys = generateHybridKeyPair();
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, JSON.stringify({ publicKey: enc(keys.publicKey), privateKey: enc(keys.privateKey) }), { mode: 0o600 });
  }
  return { ...keys, ownerDid: originId(keys.publicKey), path: keyFile };
}

const requestBody = (r) => canonical({
  kind: r.kind, node_did: r.node_did, node_public_key: r.node_public_key, requested_at: r.requested_at,
});
const grantBody = (g) => canonical({
  kind: g.kind, owner_did: g.owner_did, owner_public_key: g.owner_public_key,
  node_did: g.node_did, node_public_key: g.node_public_key, granted_at: g.granted_at,
});

/** Node B mints a signed pairing request carrying its OWN public key (self-certifying + signed). */
export function createPairingRequest({ nodeKeys, now = Date.now } = {}) {
  if (!nodeKeys?.publicKey || !nodeKeys?.privateKey) throw new Error('pairing request needs the node keypair');
  const r = {
    kind: 'pairing-request',
    node_did: originId(nodeKeys.publicKey),
    node_public_key: enc(nodeKeys.publicKey),
    requested_at: now(),
  };
  r.sig = encSig(signPayload(requestBody(r), nodeKeys.privateKey));
  return r;
}

/** Fail-closed request check: shape · DID↔key binding · BOTH signature halves. */
export function verifyPairingRequest(request) {
  try {
    if (!request || request.kind !== 'pairing-request' || !request.node_public_key || !request.sig) {
      return { ok: false, reason: 'malformed pairing request' };
    }
    const nodePub = dec(request.node_public_key);
    if (originId(nodePub) !== request.node_did) return { ok: false, reason: 'node_did does not match the embedded public key' };
    if (!verifyPayload(requestBody(request), decSig(request.sig), nodePub)) {
      return { ok: false, reason: 'request signature failed (tamper or wrong key)' };
    }
    return { ok: true, nodeDid: request.node_did, nodeFingerprint: fingerprint(nodePub) };
  } catch (e) {
    return { ok: false, reason: 'unverifiable request: ' + e.message };
  }
}

/**
 * The OWNER approves a pairing — the ceremony's trust step. `expectedFingerprint` is REQUIRED:
 * it is what the human read off the requesting device's screen; approving without comparing it
 * would be blind TOFU, so this function refuses (deny-by-default, like every gate in this repo).
 */
export function approvePairing({ ownerKeys, request, expectedFingerprint, now = Date.now } = {}) {
  if (!ownerKeys?.privateKey) throw new Error('approvePairing needs the owner keypair');
  const v = verifyPairingRequest(request);
  if (!v.ok) throw new Error('refusing to approve: ' + v.reason);
  if (!expectedFingerprint) {
    throw new Error('refusing to approve without a fingerprint — read it off the requesting device and pass it (the comparison IS the ceremony)');
  }
  if (normFp(expectedFingerprint) !== normFp(v.nodeFingerprint)) {
    throw new Error(`fingerprint mismatch: expected ${v.nodeFingerprint}, got "${expectedFingerprint}" — wrong device or an interception attempt; NOT pairing`);
  }
  const g = {
    kind: 'pairing-grant',
    owner_did: originId(ownerKeys.publicKey),
    owner_public_key: enc(ownerKeys.publicKey),
    node_did: request.node_did,
    node_public_key: request.node_public_key,
    granted_at: now(),
  };
  g.sig = encSig(signPayload(grantBody(g), ownerKeys.privateKey));
  return g;
}

const normFp = (s) => String(s).toLowerCase().replace(/[^a-f0-9]/g, '');

/**
 * Verify a pairing grant — the ceremony is SYMMETRIC, no blind trust in either direction:
 *  - `expectedNodeDid` binds the grant to THIS device: a grant minted for node B replayed onto
 *    node C is refused (the accepting CLI always passes its own node identity).
 *  - First accept (no pin yet) REQUIRES `expectedOwnerFingerprint` — the value the human read off
 *    the owner device (`stratos owner`). Without it, an interceptor who saw the request could
 *    self-issue a grant and become the pinned owner; the human comparison closes that, exactly
 *    like the request-side fingerprint closes the reverse direction.
 *  - With `pinnedOwnerPublicKey` (already paired), the grant must be signed by THAT owner — a
 *    different owner key is rejected even if its grant is internally valid.
 */
export function verifyPairingGrant(grant, { pinnedOwnerPublicKey = null, expectedOwnerFingerprint = null, expectedNodeDid = null } = {}) {
  try {
    if (!grant || grant.kind !== 'pairing-grant' || !grant.owner_public_key || !grant.node_public_key || !grant.sig) {
      return { ok: false, reason: 'malformed pairing grant' };
    }
    if (expectedNodeDid && grant.node_did !== expectedNodeDid) {
      return { ok: false, reason: `grant is for a different node (${grant.node_did}) — refusing to accept it here (replay protection)` };
    }
    const ownerPub = pinnedOwnerPublicKey
      ? (typeof pinnedOwnerPublicKey.ed25519Der === 'string' ? dec(pinnedOwnerPublicKey) : pinnedOwnerPublicKey)
      : dec(grant.owner_public_key);
    if (!pinnedOwnerPublicKey) {
      if (!expectedOwnerFingerprint) {
        return { ok: false, reason: 'no pinned owner and no owner fingerprint supplied — refusing first accept without the human comparison (no blind TOFU in either direction)' };
      }
      if (normFp(expectedOwnerFingerprint) !== normFp(fingerprint(ownerPub))) {
        return { ok: false, reason: `owner fingerprint mismatch: grant is signed by ${fingerprint(ownerPub)} — wrong owner or an interception attempt` };
      }
    }
    if (originId(ownerPub) !== grant.owner_did) {
      return { ok: false, reason: pinnedOwnerPublicKey ? 'grant owner_did does not match the PINNED owner key' : 'owner_did does not match the embedded owner key' };
    }
    const nodePub = dec(grant.node_public_key);
    if (originId(nodePub) !== grant.node_did) return { ok: false, reason: 'node_did does not match the embedded node key' };
    if (!verifyPayload(grantBody(grant), decSig(grant.sig), ownerPub)) {
      return { ok: false, reason: 'grant signature failed (tamper or wrong owner)' };
    }
    return {
      ok: true,
      ownerDid: grant.owner_did,
      nodeDid: grant.node_did,
      ownerFingerprint: fingerprint(ownerPub),
      nodeFingerprint: fingerprint(nodePub),
    };
  } catch (e) {
    return { ok: false, reason: 'unverifiable grant: ' + e.message };
  }
}
