/**
 * acp-core.js — REAL agent-to-agent (ACP) authentication + authorization (Task #15).
 *
 * Replaces the acp-proxy.js scaffold, which only checked that an `intentSig` field EXISTED (it verified
 * nothing — any peer could send intentSig:"x" and pass; the same "verify nothing" bug the keyring had).
 *
 * This is a real, minimal, deny-by-default A2A layer:
 *   - Every envelope is HYBRID-SIGNED (Ed25519 + ML-DSA-65) by the sender; receiveTask VERIFIES it
 *     against the sender's PINNED public bundle. Forged/tampered envelopes are rejected.
 *   - CAPABILITY GRANTS are per-peer and explicit (no ambient authority, no hardcoded action list): an
 *     action runs only if it was granted to THAT peer. Default = deny.
 *   - REPLAY protection: each envelope carries a single-use nonce; a replayed nonce is rejected.
 *   - NO transitive forwarding: receiveTask hands off to a local handler and never auto-forwards; every
 *     hop re-checks grants.
 *
 * HONEST SCOPE: this is ALPHA, single-hop, human-on-the-loop. It authenticates agents and authorizes
 * actions; it is NOT a 24/7 autonomous agent fleet. Actions that perform real WRITES should additionally
 * route through the connector write-approval gate — wiring that in is the follow-up.
 */
import crypto from 'node:crypto';
import { signPayload, verifyPayload } from '../../../stratos-agent/src/security/quantum-crypto.js';

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

export function didOf(pub) {
  if (!pub?.ed25519Der || !pub?.mldsaDer) throw new Error('did needs ed25519 + ml-dsa public keys');
  return 'did:atmos:' + crypto.createHash('sha256')
    .update(Buffer.from(pub.ed25519Der)).update(Buffer.from(pub.mldsaDer))
    .digest('hex').slice(0, 40);
}

const envBody = (e) => canonical({ sender: e.sender, recipient: e.recipient, action: String(e.action), payload: e.payload ?? {}, ts: e.ts, nonce: e.nonce });

export function createAcpNode({ keyPair, name = 'node' } = {}) {
  if (!keyPair?.privateKey || !keyPair?.publicKey) throw new Error('createAcpNode needs a hybrid keypair');
  const myDid = didOf(keyPair.publicKey);
  const peers = new Map();       // did -> { publicBundle, grants:Set<string> }
  const seenNonces = new Set();  // single-use nonce replay guard

  /** Pin a peer's public bundle + the EXACT set of actions granted to them (deny-by-default otherwise). */
  function registerPeer(publicBundle, grants = []) {
    const did = didOf(publicBundle);
    peers.set(did, { publicBundle, grants: new Set(grants.map(String)) });
    return did;
  }
  function revokePeer(did) { return peers.delete(did); }
  function grant(did, action) { const p = peers.get(did); if (p) p.grants.add(String(action)); return !!p; }

  /** Build a hybrid-signed envelope addressed to a peer. ts is passed in (deterministic, testable). */
  function createEnvelope({ toDid, action, payload = {}, ts, nonce } = {}) {
    if (ts == null) throw new Error('envelope needs a ts');
    if (!toDid || !action) throw new Error('envelope needs toDid and action');
    const body = { sender: myDid, recipient: String(toDid), action: String(action), payload, ts, nonce: nonce || crypto.randomBytes(12).toString('hex') };
    const sig = signPayload(envBody(body), keyPair.privateKey);
    return { ...body, sig: { ed25519Sig: sig.ed25519Sig.toString('base64'), mldsaSig: sig.mldsaSig.toString('base64') } };
  }

  /** Verify + authorize an inbound envelope. Deny-by-default at every step. */
  function receiveTask(env, handler) {
    if (!env || !env.sig || !env.sender || !env.action || env.nonce == null) return { ok: false, reason: 'malformed envelope' };
    if (env.recipient !== myDid) return { ok: false, reason: 'not addressed to this node' };
    const peer = peers.get(env.sender);
    if (!peer) return { ok: false, reason: 'sender is not a registered peer' };
    let sig;
    try { sig = { ed25519Sig: Buffer.from(env.sig.ed25519Sig, 'base64'), mldsaSig: Buffer.from(env.sig.mldsaSig, 'base64') }; }
    catch { return { ok: false, reason: 'malformed signature encoding' }; }
    // REAL verification against the pinned peer key (the scaffold only checked existence → forgery bypass)
    if (!verifyPayload(envBody(env), sig, peer.publicBundle)) return { ok: false, reason: 'signature verification failed (forged/tampered)' };
    if (!peer.grants.has(String(env.action))) return { ok: false, reason: `action '${env.action}' not granted to this peer` };
    const nk = env.sender + ':' + env.nonce;
    if (seenNonces.has(nk)) return { ok: false, reason: 'replayed nonce' };
    seenNonces.add(nk);
    // authorized — hand to the local handler. NO auto-forward; a downstream hop must re-check its own grants.
    const result = handler ? handler({ sender: env.sender, action: env.action, payload: env.payload ?? {} }) : { accepted: true };
    return { ok: true, result };
  }

  return { name, did: myDid, publicBundle: keyPair.publicKey, registerPeer, revokePeer, grant, createEnvelope, receiveTask };
}
