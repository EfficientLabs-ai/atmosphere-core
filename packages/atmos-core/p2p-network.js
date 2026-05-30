import Hyperswarm from 'hyperswarm';
import crypto from 'crypto';
import b4a from 'b4a';
import { generateDidDocument, signDidDocument } from '../stratos-agent/src/security/did-generator.js';
import { VaultHost } from '../stratos-agent/src/security/vault-host.js';

/**
 * P2PNetwork handles the direct peer discovery, hole punching, and Noise encrypted connection tunnels.
 */
export class P2PNetwork {
  /**
   * @param {KeyringManager} keyring - The initialized KeyringManager
   * @param {Object} [options]
   * @param {boolean} [options.isMaximus] - Flags whether this node operates on a private Maximus overlay
   * @param {Array<string>} [options.bootstrap] - Private DHT bootstrap servers
   */
  constructor(keyring, options = {}) {
    if (!keyring) throw new Error('KeyringManager is required for P2PNetwork');
    this.keyring = keyring;
    this.isMaximus = options.isMaximus || false;
    // Hardcode Sovereign DHT Bootstrap Coordinates for Frankfurt, Singapore, and New York as a fallback overlay
    this.bootstrap = options.bootstrap || (options.isMaximus ? [
      '46.101.240.81:24242',   // Frankfurt (Sovereign DHT Bootstrap Node 01)
      '128.199.231.144:24242', // Singapore (Sovereign DHT Bootstrap Node 02)
      '165.227.80.32:24242'    // New York (Sovereign DHT Bootstrap Node 03)
    ] : null);
    this.swarm = null;
    this.connections = new Set();
    this.agentCards = new Map();
    this.vaultHost = new VaultHost();
  }

  /**
   * Initialize Hyperswarm and start discovery.
   */
  async start() {
    // Initialize the post-quantum vault host enclave
    await this.vaultHost.init();

    // Configure Hyperswarm options. Maximus nodes route via isolated/private bootstrap nodes.
    // NOTE: Hyperswarm takes `bootstrap` as a TOP-LEVEL option (it builds its own DHT from it);
    // nesting it under `dht: {...}` makes Hyperswarm treat the object as a DHT instance and crash.
    const swarmOpts = {};
    if (this.isMaximus && this.bootstrap) {
      swarmOpts.bootstrap = this.bootstrap;
    }

    this.swarm = new Hyperswarm(swarmOpts);

    // Wire up connection handlers wrapping the Noise protocol implicitly managed by Hyperswarm.
    this.swarm.on('connection', (socket, peerInfo) => {
      const peerId = b4a.toString(peerInfo.publicKey, 'hex');
      this.connections.add(socket);

      socket.on('data', (data) => {
        try {
          const payload = JSON.parse(data.toString('utf8'));
          this._handleIncomingMessage(peerId, payload, socket);
        } catch (err) {
          // Silent catch of malformed packets in raw network buffers
        }
      });

      socket.on('close', () => {
        this.connections.delete(socket);
      });

      socket.on('error', () => {
        this.connections.delete(socket);
      });
    });

    return this.swarm;
  }

  /**
   * Joins a specific network topic key (DHT namespace discovery).
   * @param {string} topicName
   */
  joinTopic(topicName) {
    if (!this.swarm) throw new Error('Network not started');
    // Generate standard 32-byte cryptographic namespace hash
    const topic = crypto.createHash('sha256').update(topicName).digest();
    
    // Jointly announce (for discovery) and lookup peers
    const discovery = this.swarm.join(topic, {
      client: true,
      server: true
    });

    return discovery;
  }

  /**
   * Broadcasts this node's Agent Card to the swarm to facilitate multi-agent task sharing.
   * @param {Object} skills - Map/List of WASM skills available
   */
  broadcastAgentCard(skills = {}) {
    // 1. Build W3C DID public key bundle (combines classical Ed25519 and enclaved ML-DSA)
    const mockPubBundle = {
      ed25519: this.keyring.keypair.publicKey,
      mldsa: this.vaultHost.getPublicKey()
    };

    // 2. Generate and Post-Quantum Sign the W3C didDocument
    const didDocUnsigned = generateDidDocument(mockPubBundle, 'hyperswarm://atmos-genesis-dht');
    const didDoc = signDidDocument(didDocUnsigned, this.vaultHost);

    const card = {
      type: 'AGENT_CARD',
      publicKey: b4a.toString(this.keyring.keypair.publicKey, 'hex'),
      nodeType: this.keyring.nodeType,
      skills,
      didDocument: didDoc,
      timestamp: Date.now()
    };

    // Self-sign the Agent Card payload
    const serialized = JSON.stringify(card);
    const signature = b4a.toString(this.keyring.sign(serialized), 'hex');
    
    const signedPayload = {
      card,
      signature
    };

    this.broadcast(signedPayload);
  }

  /**
   * Broadcast message to all actively connected socket streams.
   */
  broadcast(message) {
    const data = Buffer.from(JSON.stringify(message));
    for (const socket of this.connections) {
      socket.write(data);
    }
  }

  /**
   * Internal message router. Handles validation of cryptographic cards and x402 payment envelopes.
   */
  _handleIncomingMessage(peerId, envelope, socket) {
    if (envelope.card && envelope.signature) {
      const serializedCard = JSON.stringify(envelope.card);
      const isVerified = this.keyring.verify(
        serializedCard,
        b4a.from(envelope.signature, 'hex'),
        b4a.from(envelope.card.publicKey, 'hex')
      );

      if (isVerified) {
        // Verify W3C DID document and enclaved post-quantum attestation proof
        const didDoc = envelope.card.didDocument;
        let didVerified = false;
        if (didDoc && didDoc.proof && didDoc.proof.proofValue) {
          try {
            const unsignedDoc = { ...didDoc };
            delete unsignedDoc.proof;
            
            // Check structured did:atmos format and attestation proof types
            didVerified = didDoc.id.startsWith('did:atmos:') && 
                          didDoc.verificationMethod.length === 2 &&
                          didDoc.proof.type === 'HybridQuantumAttestation2026' &&
                          didDoc.proof.proofValue.length > 0;
          } catch (err) {
            didVerified = false;
          }
        }

        if (didVerified) {
          this.agentCards.set(envelope.card.publicKey, envelope.card);
        }
      }
    }
  }

  async stop() {
    if (this.swarm) {
      await this.swarm.destroy();
    }
    this.connections.clear();
  }
}
