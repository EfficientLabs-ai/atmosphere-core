import crypto from 'node:crypto';

/**
 * Efficient Labs Sovereign StratosAgent PQC Suite
 * Standardizes hybrid classical-post-quantum operations (FIPS 203 & FIPS 204).
 */

/**
 * Restores a serialized public key bundle into active KeyObjects.
 */
export function importPublicKeyBundle(bundle) {
  return {
    x25519: crypto.createPublicKey({ key: Buffer.from(bundle.x25519Der), format: 'der', type: 'spki' }),
    ed25519: crypto.createPublicKey({ key: Buffer.from(bundle.ed25519Der), format: 'der', type: 'spki' }),
    mlkem: crypto.createPublicKey({ key: Buffer.from(bundle.mlkemDer), format: 'der', type: 'spki' }),
    mldsa: crypto.createPublicKey({ key: Buffer.from(bundle.mldsaDer), format: 'der', type: 'spki' })
  };
}

/**
 * Restores a serialized private key bundle into active KeyObjects.
 */
export function importPrivateKeyBundle(bundle) {
  return {
    x25519: crypto.createPrivateKey({ key: Buffer.from(bundle.x25519Der), format: 'der', type: 'pkcs8' }),
    ed25519: crypto.createPrivateKey({ key: Buffer.from(bundle.ed25519Der), format: 'der', type: 'pkcs8' }),
    mlkem: crypto.createPrivateKey({ key: Buffer.from(bundle.mlkemDer), format: 'der', type: 'pkcs8' }),
    mldsa: crypto.createPrivateKey({ key: Buffer.from(bundle.mldsaDer), format: 'der', type: 'pkcs8' })
  };
}

/**
 * Generates a complete hybrid keypair bundle (classical + post-quantum).
 * Includes:
 *  - X25519 + ML-KEM-768 (Key Exchange)
 *  - Ed25519 + ML-DSA-65 (Signatures)
 */
export function generateHybridKeyPair() {
  // 1. Generate Classical Exchange
  const x25519 = crypto.generateKeyPairSync('x25519');
  
  // 2. Generate Classical Signatures
  const ed25519 = crypto.generateKeyPairSync('ed25519');
  
  // 3. Generate Post-Quantum Exchange (ML-KEM-768 / FIPS 203)
  const mlkem = crypto.generateKeyPairSync('ml-kem-768');
  
  // 4. Generate Post-Quantum Signatures (ML-DSA-65 / FIPS 204)
  const mldsa = crypto.generateKeyPairSync('ml-dsa-65');

  // Export all public parts to DER (SPKI format)
  const publicKeyBundle = {
    x25519Der: x25519.publicKey.export({ type: 'spki', format: 'der' }),
    ed25519Der: ed25519.publicKey.export({ type: 'spki', format: 'der' }),
    mlkemDer: mlkem.publicKey.export({ type: 'spki', format: 'der' }),
    mldsaDer: mldsa.publicKey.export({ type: 'spki', format: 'der' })
  };

  // Export all private parts to DER (PKCS#8 format)
  const privateKeyBundle = {
    x25519Der: x25519.privateKey.export({ type: 'pkcs8', format: 'der' }),
    ed25519Der: ed25519.privateKey.export({ type: 'pkcs8', format: 'der' }),
    mlkemDer: mlkem.privateKey.export({ type: 'pkcs8', format: 'der' }),
    mldsaDer: mldsa.privateKey.export({ type: 'pkcs8', format: 'der' })
  };

  return {
    publicKey: publicKeyBundle,
    privateKey: privateKeyBundle
  };
}

/**
 * Encapsulates a 32-byte hybrid shared secret for a target peer.
 * Alice is the recipient, Bob is the sender. Bob calls this.
 * @param {Object} peerPublicKeyBundle Alice's public key bundle.
 */
export function encapsulateHybridSecret(peerPublicKeyBundle) {
  const alice = importPublicKeyBundle(peerPublicKeyBundle);

  // 1. Bob generates a temporary ephemeral X25519 keypair
  const bobTempX25519 = crypto.generateKeyPairSync('x25519');

  // 2. Perform Classical DH key agreement
  const traditionalSecret = crypto.diffieHellman({
    privateKey: bobTempX25519.privateKey,
    publicKey: alice.x25519
  });

  // 3. Perform Post-Quantum encapsulation (FIPS 203)
  const { sharedKey: pqSharedKey, ciphertext } = crypto.encapsulate(alice.mlkem);

  // 4. Combine both key exchange elements using HKDF-SHA256 (PQC hybrid standard)
  const combinedInput = Buffer.concat([traditionalSecret, pqSharedKey]);
  const hybridSharedSecret = crypto.hkdfSync('sha256', combinedInput, Buffer.alloc(0), Buffer.alloc(0), 32);

  return {
    ciphertext,
    bobX25519PubDer: bobTempX25519.publicKey.export({ type: 'spki', format: 'der' }),
    hybridSecret: Buffer.from(hybridSharedSecret)
  };
}

/**
 * Decapsulates a 32-byte hybrid shared secret sent by a peer.
 * Alice is the recipient. Alice calls this.
 * @param {Object} myPrivateKeyBundle Alice's private key bundle.
 * @param {Buffer} bobX25519PubDer Bob's temporary X25519 public key.
 * @param {Buffer} ciphertext ML-KEM ciphertext.
 */
export function decapsulateHybridSecret(myPrivateKeyBundle, bobX25519PubDer, ciphertext) {
  const my = importPrivateKeyBundle(myPrivateKeyBundle);
  
  // 1. Restore Bob's temporary X25519 public key KeyObject
  const bobX25519Pub = crypto.createPublicKey({
    key: Buffer.from(bobX25519PubDer),
    format: 'der',
    type: 'spki'
  });

  // 2. Perform Classical DH key agreement
  const traditionalSecret = crypto.diffieHellman({
    privateKey: my.x25519,
    publicKey: bobX25519Pub
  });

  // 3. Perform Post-Quantum decapsulation (FIPS 203)
  const pqSharedKey = crypto.decapsulate(my.mlkem, Buffer.from(ciphertext));

  // 4. Combine elements identically using HKDF-SHA256
  const combinedInput = Buffer.concat([traditionalSecret, pqSharedKey]);
  const hybridSharedSecret = crypto.hkdfSync('sha256', combinedInput, Buffer.alloc(0), Buffer.alloc(0), 32);

  return Buffer.from(hybridSharedSecret);
}

/**
 * Signs payload data hybridly (classical Ed25519 + PQC ML-DSA-65).
 */
export function signPayload(data, myPrivateKeyBundle) {
  const my = importPrivateKeyBundle(myPrivateKeyBundle);
  const dataBuf = Buffer.from(data);

  // 1. Classical signature
  const ed25519Sig = crypto.sign(null, dataBuf, my.ed25519);

  // 2. Post-quantum signature (FIPS 204)
  const mldsaSig = crypto.sign(null, dataBuf, my.mldsa);

  return {
    ed25519Sig: Buffer.from(ed25519Sig),
    mldsaSig: Buffer.from(mldsaSig)
  };
}

/**
 * Verifies hybrid signed payloads (classical Ed25519 + PQC ML-DSA-65).
 */
export function verifyPayload(data, signatureBundle, peerPublicKeyBundle) {
  try {
    const peer = importPublicKeyBundle(peerPublicKeyBundle);
    const dataBuf = Buffer.from(data);

    // 1. Verify Classical Ed25519 Signature
    const classicalOk = crypto.verify(null, dataBuf, peer.ed25519, Buffer.from(signatureBundle.ed25519Sig));
    if (!classicalOk) {
      console.warn('⚠️  Classical Ed25519 signature verification failed.');
      return false;
    }

    // 2. Verify Post-Quantum ML-DSA-65 Signature (FIPS 204)
    const pqOk = crypto.verify(null, dataBuf, peer.mldsa, Buffer.from(signatureBundle.mldsaSig));
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
