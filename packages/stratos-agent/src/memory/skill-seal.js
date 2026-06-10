/**
 * skill-seal.js — the VERIFICATION GATE for federated skill-sync (Task #14).
 *
 * WHY THIS EXISTS (honest gap it closes): p2p-skill-sync.js replicates skill blocks over Hyperswarm and
 * stores a `signatureSeal` field, but nothing verifies that seal before the blocks are returned — a
 * node could ingest and run a skill from an unauthenticated peer. This module is the gate that MUST wrap
 * ingest: a remote skill is trusted only if its seal verifies under a PINNED origin key.
 *
 * Built on the repo's REAL hybrid suite (Ed25519 + ML-DSA-65, both must verify — quantum-crypto.js).
 * The seal binds skillId + wasmHash + metadata, so tampering ANY of them (including swapping the WASM
 * the hash points at) breaks verification. Fail-closed throughout.
 *
 * INTEGRATION (done): P2pSkillSync routes every block through verifySkillBlock() — fail-closed
 * requireSeal default, pinned trustedOrigins, provenance-based selfAuthored (never an in-band bit).
 * See p2p-skill-sync.js verifyBlock()/filterVerifiedSkills() + test-p2p-skill-ingest.mjs (15 checks).
 * NB: the PUBLIC StratosAgent copy keeps the "follow-up" wording — the caller is private-only there.
 */
import crypto from 'node:crypto';
import { signPayload, verifyPayload } from '../security/quantum-crypto.js';

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

// compact origin id from the public SIGNING keys — a block names its origin, pinned by the receiver
export function originId(pub) {
  if (!pub?.ed25519Der || !pub?.mldsaDer) throw new Error('origin needs ed25519 + ml-dsa public keys');
  return 'did:atmos:' + crypto.createHash('sha256')
    .update(Buffer.from(pub.ed25519Der)).update(Buffer.from(pub.mldsaDer))
    .digest('hex').slice(0, 40);
}

const sealedBody = (b) => canonical({ skillId: String(b.skillId), wasmHash: String(b.wasmHash), metadata: b.metadata ?? {} });

/** Origin node seals a skill block: hybrid signature over skillId + wasmHash + metadata. */
export function sealSkillBlock({ skillId, wasmHash, metadata = {} }, keyPair) {
  if (!skillId || !wasmHash) throw new Error('skill block needs skillId and wasmHash');
  if (!keyPair?.privateKey || !keyPair?.publicKey) throw new Error('sealSkillBlock needs a hybrid keypair');
  const body = { skillId: String(skillId), wasmHash: String(wasmHash), metadata };
  const sig = signPayload(sealedBody(body), keyPair.privateKey);
  return {
    ...body,
    origin: originId(keyPair.publicKey),
    signatureSeal: { ed25519Sig: sig.ed25519Sig.toString('base64'), mldsaSig: sig.mldsaSig.toString('base64') },
  };
}

/**
 * Receiving node verifies a skill block against the PINNED origin bundle. Fail-closed unless the block
 * names that origin AND the hybrid seal over its exact body verifies. Returns {ok, reason?}.
 */
export function verifySkillBlock(block, pinnedOriginPublicBundle) {
  if (!block || !block.skillId || !block.wasmHash || !block.signatureSeal) return { ok: false, reason: 'malformed block' };
  let expectedOrigin;
  try { expectedOrigin = originId(pinnedOriginPublicBundle); } catch { return { ok: false, reason: 'no/!invalid pinned origin key' }; }
  if (block.origin !== expectedOrigin) return { ok: false, reason: 'block origin does not match the pinned key' };
  let sig;
  try {
    sig = { ed25519Sig: Buffer.from(block.signatureSeal.ed25519Sig, 'base64'), mldsaSig: Buffer.from(block.signatureSeal.mldsaSig, 'base64') };
  } catch { return { ok: false, reason: 'malformed seal encoding' }; }
  if (!verifyPayload(sealedBody(block), sig, pinnedOriginPublicBundle)) {
    return { ok: false, reason: 'seal verification failed (tamper or wrong signer)' };
  }
  return { ok: true, skillId: block.skillId, origin: block.origin };
}
