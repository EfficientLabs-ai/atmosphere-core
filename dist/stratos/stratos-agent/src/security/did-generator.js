import crypto from 'node:crypto';

// Bitcoin base58 alphabet for multibase base58btc encoding
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encodes a buffer to a zero-dependency Base58 string (Bitcoin alphabet)
 * @param {Buffer} buffer - Binary data to encode
 * @returns {string} - The Base58 encoded string
 */
export function base58Encode(buffer) {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let string = '';
  // Handle leading zeros
  for (let k = 0; k < buffer.length && buffer[k] === 0; k++) {
    string += '1';
  }
  for (let q = digits.length - 1; q >= 0; q--) {
    string += ALPHABET[digits[q]];
  }
  return string;
}

/**
 * Derives a did:atmos sovereign identifier from a composite hybrid public key bundle.
 * @param {Object} publicKeyBundle - Public key bundle containing ed25519Der and mldsaDer
 * @returns {string} - W3C method did string
 */
export function deriveAtmosDid(publicKeyBundle) {
  const edDer = publicKeyBundle.ed25519Der || publicKeyBundle.ed25519;
  const mldsaDer = publicKeyBundle.mldsaDer || publicKeyBundle.mldsa;

  if (!edDer || !mldsaDer) {
    throw new Error('⚠️ [did-generator] Invalid public key bundle: must contain ed25519 and mldsa keys.');
  }

  // Concatenate keys for unified SHA-256 hybrid signature identity representation
  const composite = Buffer.concat([Buffer.from(edDer), Buffer.from(mldsaDer)]);
  const hash = crypto.createHash('sha256').update(composite).digest();

  // Prefix with 'z' to satisfy base58btc Multibase standards
  return 'did:atmos:z' + base58Encode(hash);
}

/**
 * Compiles a W3C-compliant JSON-LD DID Document structure.
 * @param {Object} publicKeyBundle - Public key bundle
 * @param {string|null} serviceEndpoint - Optional P2P overlay swarm target
 * @returns {Object} - JSON-LD schema compliant document
 */
export function generateDidDocument(publicKeyBundle, serviceEndpoint = null) {
  const did = deriveAtmosDid(publicKeyBundle);
  
  const edDer = publicKeyBundle.ed25519Der || publicKeyBundle.ed25519;
  const mldsaDer = publicKeyBundle.mldsaDer || publicKeyBundle.mldsa;

  const edPubBase58 = base58Encode(Buffer.from(edDer));
  const mldsaPubBase58 = base58Encode(Buffer.from(mldsaDer));

  const didDoc = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      'https://w3id.org/security/suites/mldsa-2026/v1'
    ],
    'id': did,
    'verificationMethod': [
      {
        'id': `${did}#key-ed25519-1`,
        'type': 'Ed25519VerificationKey2020',
        'controller': did,
        'publicKeyMultibase': 'z' + edPubBase58
      },
      {
        'id': `${did}#key-mldsa65-1`,
        'type': 'Mldsa65VerificationKey2026',
        'controller': did,
        'publicKeyMultibase': 'z' + mldsaPubBase58
      }
    ],
    'authentication': [
      `${did}#key-ed25519-1`,
      `${did}#key-mldsa65-1`
    ],
    'assertionMethod': [
      `${did}#key-ed25519-1`,
      `${did}#key-mldsa65-1`
    ]
  };

  if (serviceEndpoint) {
    didDoc.service = [
      {
        'id': `${did}#p2p-overlay`,
        'type': 'HyperswarmRPCEndpoint',
        'serviceEndpoint': serviceEndpoint
      }
    ];
  }

  return didDoc;
}

/**
 * Appends a self-attestation proof signed by the VaultHost enclave.
 * @param {Object} didDocument - Unsigned DID document
 * @param {VaultHost} vaultHost - Sovereign post-quantum VaultHost instance
 * @returns {Object} - Document updated with attestation proof block
 */
export function signDidDocument(didDocument, vaultHost) {
  const docString = JSON.stringify(didDocument);
  const signature = vaultHost.sign(docString);

  return {
    ...didDocument,
    proof: {
      type: 'HybridQuantumAttestation2026',
      created: new Date().toISOString(),
      verificationMethod: `${didDocument.id}#key-mldsa65-1`,
      proofPurpose: 'assertionMethod',
      proofValue: signature.toString('hex')
    }
  };
}
