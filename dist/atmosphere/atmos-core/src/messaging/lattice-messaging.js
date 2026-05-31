import crypto from 'node:crypto';
import { encapsulateHybridSecret, decapsulateHybridSecret } from '../../../stratos-agent/src/security/quantum-crypto.js';

/**
 * LatticeMessaging: Handles post-quantum secure peer-to-peer encrypted messaging.
 * Integrates classical X25519 Diffie-Hellman + FIPS 203 ML-KEM-768 key encapsulation,
 * encrypting raw payloads using AES-256-GCM with manual memory zeroization.
 */
export class LatticeMessaging {
  /**
   * Encrypts a message payload targeting a specific recipient peer.
   * Alice is the recipient, Bob is the sender. Bob calls this.
   * 
   * @param {string|Buffer} message - The plaintext message content to encrypt
   * @param {Object} recipientPublicKeyBundle - Alice's public key bundle (Ed25519, X25519, ML-KEM-768, ML-DSA-65)
   * @returns {Object} - Encrypted messaging packet containing the PQC key encapsulation blocks and AES-GCM payload
   */
  static encryptPeerMessage(message, recipientPublicKeyBundle) {
    const msgBuf = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8');
    
    // 1. Bob generates the 32-byte hybrid shared secret and the ML-KEM encapsulation ciphertext
    const { ciphertext, bobX25519PubDer, hybridSecret } = encapsulateHybridSecret(recipientPublicKeyBundle);

    let cipher = null;
    let encryptedPayload = null;
    let authTag = null;
    const iv = crypto.randomBytes(12); // Standard 12-byte IV for AES-GCM

    try {
      // 2. Encrypt the plaintext payload using AES-256-GCM
      cipher = crypto.createCipheriv('aes-256-gcm', hybridSecret, iv);
      encryptedPayload = Buffer.concat([
        cipher.update(msgBuf),
        cipher.final()
      ]);
      authTag = cipher.getAuthTag();
    } finally {
      // 3. IMMEDIATE ZEROIZATION: Wipe the derived symmetric key from V8 memory instantly
      if (hybridSecret) {
        hybridSecret.fill(0);
      }
    }

    return {
      bobX25519PubDer: Buffer.from(bobX25519PubDer),
      kemCiphertext: Buffer.from(ciphertext),
      iv,
      authTag,
      encryptedPayload
    };
  }

  /**
   * Decrypts a post-quantum encrypted message packet from a peer.
   * Alice is the recipient. Alice calls this.
   * 
   * @param {Object} packet - The encrypted packet (containing bobX25519PubDer, kemCiphertext, iv, authTag, encryptedPayload)
   * @param {Object} myPrivateKeyBundle - Alice's private key bundle
   * @returns {Buffer} - Decrypted plaintext message buffer
   */
  static decryptPeerMessage(packet, myPrivateKeyBundle) {
    const { bobX25519PubDer, kemCiphertext, iv, authTag, encryptedPayload } = packet;

    // 1. Alice decapsulates the hybrid shared secret using her private ML-KEM / X25519 keys
    const hybridSecret = decapsulateHybridSecret(myPrivateKeyBundle, bobX25519PubDer, kemCiphertext);

    let decipher = null;
    let decryptedPayload = null;

    try {
      // 2. Decrypt the AES-256-GCM payload
      decipher = crypto.createDecipheriv('aes-256-gcm', hybridSecret, iv);
      decipher.setAuthTag(authTag);

      decryptedPayload = Buffer.concat([
        decipher.update(encryptedPayload),
        decipher.final()
      ]);
    } finally {
      // 3. IMMEDIATE ZEROIZATION: Wipe the decapsulated symmetric key from V8 memory instantly
      if (hybridSecret) {
        hybridSecret.fill(0);
      }
    }

    return decryptedPayload;
  }
}
