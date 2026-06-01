/**
 * controller-identity.js — verifiable identity + signed job receipts for a SOVEREIGN EXEC CONTROLLER
 * (Task #16, first increment). An exec controller is whatever runs a job (a CLI, an agent step) on
 * your/mesh compute. This primitive gives each controller a real HYBRID post-quantum identity and lets
 * it sign tamper-evident receipts for the jobs it runs, so an orchestrator can prove WHICH controller
 * ran WHICH exact spec — without trusting the controller's own word.
 *
 * Built on the repo's REAL hybrid suite (Ed25519 + ML-DSA-65, both must verify — quantum-crypto.js).
 * No placeholder crypto. The identity is CONTENT-ADDRESSED: the controller id is a hash of its public
 * signing keys, so it cannot be claimed without the matching private keys.
 */
import crypto from 'node:crypto';
import { generateHybridKeyPair, signPayload, verifyPayload } from '../security/quantum-crypto.js';

// stable, recursive key-sorted serialization so a receipt commits to EXACTLY these bytes
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

// controller id = sha256 over the public SIGNING keys (ed25519 + ml-dsa). Possession-bound, not claimable.
function controllerIdFromPublic(pub) {
  return 'exec:' + crypto.createHash('sha256')
    .update(Buffer.from(pub.ed25519Der)).update(Buffer.from(pub.mldsaDer))
    .digest('hex').slice(0, 40);
}

/** Hash a job spec so a receipt commits to the exact spec that ran (image, args, mounts, policy…). */
export function specHash(spec) {
  return crypto.createHash('sha256').update(canonical(spec)).digest('hex');
}

export function createExecController(keyPair = generateHybridKeyPair()) {
  const id = controllerIdFromPublic(keyPair.publicKey);
  return {
    id,
    publicBundle: keyPair.publicKey, // shareable; the orchestrator pins this to trust the controller
    /**
     * Sign a receipt for a completed/attempted job. Binds controller id + the EXACT spec hash + status
     * + a caller-supplied monotonic timestamp (no Date.now() here — pass it in, keeps it deterministic).
     */
    issueReceipt({ jobId, spec, status, ts } = {}) {
      if (!jobId || !status || ts == null) throw new Error('receipt needs jobId, status, ts');
      const body = { controllerId: id, jobId: String(jobId), specHash: specHash(spec ?? {}), status: String(status), ts };
      const sig = signPayload(canonical(body), keyPair.privateKey);
      return { body, sig: { ed25519Sig: sig.ed25519Sig.toString('base64'), mldsaSig: sig.mldsaSig.toString('base64') } };
    },
  };
}

/**
 * Verify a receipt against a PINNED public bundle. Returns false (fail-closed) unless:
 *  - the receipt names the controller that owns this bundle (content-addressed id matches), AND
 *  - the hybrid signature over the exact receipt body verifies (Ed25519 AND ML-DSA-65).
 * Optionally pass expectedSpec to confirm the receipt is for the spec you think ran.
 */
export function verifyReceipt(receipt, publicBundle, { expectedSpec } = {}) {
  if (!receipt || typeof receipt.body !== 'object' || !receipt.sig) return false;
  if (!publicBundle?.ed25519Der || !publicBundle?.mldsaDer) return false;
  if (receipt.body.controllerId !== controllerIdFromPublic(publicBundle)) return false; // wrong/forged signer
  if (expectedSpec !== undefined && receipt.body.specHash !== specHash(expectedSpec)) return false; // not that spec
  let sig;
  try {
    sig = { ed25519Sig: Buffer.from(receipt.sig.ed25519Sig, 'base64'), mldsaSig: Buffer.from(receipt.sig.mldsaSig, 'base64') };
  } catch { return false; }
  return verifyPayload(canonical(receipt.body), sig, publicBundle);
}
