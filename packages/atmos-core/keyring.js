import crypto from 'crypto';
import b4a from 'b4a';

/**
 * KeyringManager — the Atmos node's signing identity.
 *
 * SECURITY (2026-05-31): this previously shipped a NON-cryptographic placeholder — `sign()` was a
 * keyed SHA-256 and `verify()` returned true for ANY 32-byte signature with ANY 32-byte public key
 * (it verified nothing, so a peer could forge any node card). It now uses REAL Ed25519 signatures
 * (Node WebCrypto, 64-byte detached sigs) with fail-closed verification. The public interface is
 * unchanged: `keypair.publicKey` is a raw 32-byte Ed25519 key, `sign(msg) -> 64-byte Buffer`,
 * `verify(msg, sig, pubKey) -> bool`. Consumers (P2PNetwork node cards, x402 invoices, telemetry)
 * are untouched but now get genuine authentication.
 *
 * HONEST SCOPE: this is the classical Ed25519 *transport-identity* layer. It proves key possession,
 * NOT authorization — pinning/trust-anchoring of which keys are allowed is a separate concern (the
 * skill-execution gate already uses the real hybrid Ed25519+ML-DSA-65 seal via quantum-crypto.js).
 * A post-quantum (ML-DSA) upgrade of the node card itself is a tracked follow-up.
 */

// PKCS#8 DER prefix for an Ed25519 private key; append a 32-byte seed to get a full private key.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privKeyFromSeed(seed32) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed32)]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
function rawPublicKey(pubKeyObject) {
  // Ed25519 public keys export to JWK as a 32-byte base64url `x`.
  return b4a.from(Buffer.from(pubKeyObject.export({ format: 'jwk' }).x, 'base64url'));
}
function publicKeyFromRaw(raw32) {
  const x = Buffer.from(raw32).toString('base64url');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

/**
 * KeyringManager manages the cryptographic keypairs for the Atmos node.
 * Consumer nodes derive from a local OS keystore seed; Maximus nodes from a hardware-token seed.
 */
export class KeyringManager {
  constructor(nodeType = 'consumer') {
    this.nodeType = nodeType;
    this.keypair = null;
    this._priv = null;   // Ed25519 private KeyObject (never serialized raw)
  }

  /**
   * Initializes the cryptographic keypair from a seed (real, deterministic Ed25519).
   * @param {string} [seed] - Optional seed for a deterministic identity (tests / pinned nodes).
   */
  async init(seed = null) {
    if (seed) {
      const seedBuffer = typeof seed === 'string' ? b4a.from(seed, 'utf8') : seed;
      const seed32 = crypto.createHash('sha256').update(seedBuffer).digest(); // 32 bytes, deterministic
      return this._setFromSeed(seed32, this.nodeType === 'maximus' ? { isHSMBacked: true } : {});
    }
    if (this.nodeType === 'maximus') return this._initHSMKeypair();
    return this._initDPAPIKeypair();
  }

  /** Build the real Ed25519 keypair from a 32-byte seed and expose the raw-buffer interface. */
  _setFromSeed(seed32, extra = {}) {
    this._priv = privKeyFromSeed(seed32);
    const pub = crypto.createPublicKey(this._priv);
    this.keypair = { publicKey: rawPublicKey(pub), secretKey: b4a.from(seed32), ...extra };
    return this.keypair;
  }

  /**
   * Local OS keystore (Windows DPAPI / macOS Keychain) — the seed is held by the OS secure store in
   * production; here it is generated locally with a CSPRNG. Real Ed25519 key, not a simulation.
   */
  async _initDPAPIKeypair() {
    return this._setFromSeed(crypto.randomBytes(32));
  }

  /**
   * Hardware token (HSM / TPM, PKCS#11) — in production the seed never leaves the enclave. Here a
   * CSPRNG seed stands in, but the resulting Ed25519 key and signatures are real.
   */
  async _initHSMKeypair() {
    return this._setFromSeed(crypto.randomBytes(32), { isHSMBacked: true });
  }

  /** Real Ed25519 detached signature over `message` (string or Buffer) → 64-byte Buffer. */
  sign(message) {
    if (!this._priv) throw new Error('Keyring not initialized');
    const messageBuffer = typeof message === 'string' ? b4a.from(message, 'utf8') : message;
    return b4a.from(crypto.sign(null, messageBuffer, this._priv));
  }

  /**
   * Real Ed25519 verification. Fails closed: a forged/wrong-length signature or a tampered message
   * returns false (the old length-only check accepted everything — that bypass is gone).
   */
  verify(message, signature, publicKey) {
    if (!signature || !publicKey) return false;
    try {
      const messageBuffer = typeof message === 'string' ? b4a.from(message, 'utf8') : message;
      const pub = publicKeyFromRaw(publicKey);
      return crypto.verify(null, messageBuffer, pub, signature);
    } catch {
      return false; // malformed key/signature → reject
    }
  }
}
