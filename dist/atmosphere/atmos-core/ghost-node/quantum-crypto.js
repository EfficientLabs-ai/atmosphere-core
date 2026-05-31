import crypto from 'node:crypto';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

/**
 * Efficient Labs Sovereign StratosAgent PQC Suite — REAL hybrid classical + post-quantum.
 *
 * Node 22 has no native ML-KEM/ML-DSA, so the post-quantum primitives are provided by
 * @noble/post-quantum (audited, pure-JS FIPS 203/204). The classical halves (X25519/Ed25519)
 * use native node:crypto. Hybrid construction:
 *   - Key exchange:  X25519  +  ML-KEM-768   (combined via HKDF-SHA256)
 *   - Signatures:    Ed25519  +  ML-DSA-65    (both must verify)
 *
 * Bundle fields keep their original names (`mlkemDer`/`mldsaDer`) for caller compatibility,
 * but for the PQC keys they now hold RAW key bytes (noble keys), not DER.
 */

// Robustly coerce Buffer | Uint8Array | number[] | {type:'Buffer',data} | base64-string → Uint8Array.
function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (Buffer.isBuffer(x)) return new Uint8Array(x);
  if (Array.isArray(x)) return Uint8Array.from(x);
  if (x && x.type === 'Buffer' && Array.isArray(x.data)) return Uint8Array.from(x.data);
  if (typeof x === 'string') return new Uint8Array(Buffer.from(x, 'base64'));
  return new Uint8Array(Buffer.from(x));
}

/** Restores a serialized PUBLIC key bundle (classical KeyObjects + raw PQC public bytes). */
export function importPublicKeyBundle(bundle) {
  return {
    x25519: crypto.createPublicKey({ key: Buffer.from(bundle.x25519Der), format: 'der', type: 'spki' }),
    ed25519: crypto.createPublicKey({ key: Buffer.from(bundle.ed25519Der), format: 'der', type: 'spki' }),
    mlkem: toU8(bundle.mlkemDer),   // ML-KEM-768 public key bytes (1184)
    mldsa: toU8(bundle.mldsaDer)    // ML-DSA-65 public key bytes (1952)
  };
}

/** Restores a serialized PRIVATE key bundle (classical KeyObjects + raw PQC secret bytes). */
export function importPrivateKeyBundle(bundle) {
  return {
    x25519: crypto.createPrivateKey({ key: Buffer.from(bundle.x25519Der), format: 'der', type: 'pkcs8' }),
    ed25519: crypto.createPrivateKey({ key: Buffer.from(bundle.ed25519Der), format: 'der', type: 'pkcs8' }),
    mlkem: toU8(bundle.mlkemDer),   // ML-KEM-768 secret key bytes (2400)
    mldsa: toU8(bundle.mldsaDer)    // ML-DSA-65 secret key bytes (4032)
  };
}

/**
 * Generates a complete hybrid keypair bundle:
 *   X25519 + ML-KEM-768 (exchange) and Ed25519 + ML-DSA-65 (signatures).
 */
export function generateHybridKeyPair() {
  const x25519 = crypto.generateKeyPairSync('x25519');
  const ed25519 = crypto.generateKeyPairSync('ed25519');
  const mlkem = ml_kem768.keygen();   // { publicKey, secretKey } raw bytes
  const mldsa = ml_dsa65.keygen();    // { publicKey, secretKey } raw bytes

  return {
    publicKey: {
      x25519Der: x25519.publicKey.export({ type: 'spki', format: 'der' }),
      ed25519Der: ed25519.publicKey.export({ type: 'spki', format: 'der' }),
      mlkemDer: Buffer.from(mlkem.publicKey),
      mldsaDer: Buffer.from(mldsa.publicKey)
    },
    privateKey: {
      x25519Der: x25519.privateKey.export({ type: 'pkcs8', format: 'der' }),
      ed25519Der: ed25519.privateKey.export({ type: 'pkcs8', format: 'der' }),
      mlkemDer: Buffer.from(mlkem.secretKey),
      mldsaDer: Buffer.from(mldsa.secretKey)
    }
  };
}

/**
 * Encapsulates a 32-byte hybrid shared secret for a target peer (sender side).
 */
export function encapsulateHybridSecret(peerPublicKeyBundle) {
  const alice = importPublicKeyBundle(peerPublicKeyBundle);

  // Classical: ephemeral X25519 DH
  const bobTempX25519 = crypto.generateKeyPairSync('x25519');
  const traditionalSecret = crypto.diffieHellman({ privateKey: bobTempX25519.privateKey, publicKey: alice.x25519 });

  // Post-quantum: ML-KEM-768 encapsulation (FIPS 203)
  const enc = ml_kem768.encapsulate(alice.mlkem); // { cipherText, sharedSecret }
  const pqSharedKey = Buffer.from(enc.sharedSecret);
  const ciphertext = Buffer.from(enc.cipherText);

  // Combine both via HKDF-SHA256
  const combined = Buffer.concat([traditionalSecret, pqSharedKey]);
  const hybridSharedSecret = crypto.hkdfSync('sha256', combined, Buffer.alloc(0), Buffer.alloc(0), 32);

  return {
    ciphertext,
    bobX25519PubDer: bobTempX25519.publicKey.export({ type: 'spki', format: 'der' }),
    hybridSecret: Buffer.from(hybridSharedSecret)
  };
}

/**
 * Decapsulates a 32-byte hybrid shared secret sent by a peer (recipient side).
 */
export function decapsulateHybridSecret(myPrivateKeyBundle, bobX25519PubDer, ciphertext) {
  const my = importPrivateKeyBundle(myPrivateKeyBundle);

  const bobX25519Pub = crypto.createPublicKey({ key: Buffer.from(bobX25519PubDer), format: 'der', type: 'spki' });
  const traditionalSecret = crypto.diffieHellman({ privateKey: my.x25519, publicKey: bobX25519Pub });

  // Post-quantum: ML-KEM-768 decapsulation (FIPS 203)
  const pqSharedKey = Buffer.from(ml_kem768.decapsulate(toU8(ciphertext), my.mlkem));

  const combined = Buffer.concat([traditionalSecret, pqSharedKey]);
  const hybridSharedSecret = crypto.hkdfSync('sha256', combined, Buffer.alloc(0), Buffer.alloc(0), 32);
  return Buffer.from(hybridSharedSecret);
}

/**
 * Signs payload data hybridly (Ed25519 + ML-DSA-65).
 */
export function signPayload(data, myPrivateKeyBundle) {
  const my = importPrivateKeyBundle(myPrivateKeyBundle);
  const dataBuf = Buffer.from(data);

  const ed25519Sig = crypto.sign(null, dataBuf, my.ed25519);
  const mldsaSig = ml_dsa65.sign(toU8(dataBuf), my.mldsa); // FIPS 204: sign(message, secretKey)

  return {
    ed25519Sig: Buffer.from(ed25519Sig),
    mldsaSig: Buffer.from(mldsaSig)
  };
}

/**
 * Verifies hybrid signed payloads. BOTH the classical and the post-quantum signatures
 * must verify; any tamper or mismatch fails closed.
 */
export function verifyPayload(data, signatureBundle, peerPublicKeyBundle) {
  try {
    const peer = importPublicKeyBundle(peerPublicKeyBundle);
    const dataBuf = Buffer.from(data);

    const classicalOk = crypto.verify(null, dataBuf, peer.ed25519, Buffer.from(signatureBundle.ed25519Sig));
    if (!classicalOk) {
      console.warn('⚠️  Classical Ed25519 signature verification failed.');
      return false;
    }

    // FIPS 204: verify(signature, message, publicKey). Tampered sigs may throw → treat as invalid.
    let pqOk = false;
    try {
      pqOk = ml_dsa65.verify(toU8(signatureBundle.mldsaSig), toU8(dataBuf), peer.mldsa);
    } catch (e) {
      pqOk = false;
    }
    if (!pqOk) {
      console.warn('⚠️  Post-Quantum ML-DSA-65 signature verification failed.');
      return false;
    }

    return true;
  } catch (err) {
    console.error('❌ Error during hybrid verification:', err.message);
    return false;
  }
}
