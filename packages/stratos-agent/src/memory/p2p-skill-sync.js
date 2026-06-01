import crypto from 'node:crypto';
import Hyperswarm from 'hyperswarm';
import Corestore from 'corestore';
import Autobase from 'autobase';
import b4a from 'b4a';
import { verifySkillBlock } from './skill-seal.js';

/**
 * P2pSkillSync: Trackerless DHT Swarming Auto-Discovery and Autobase Skill Sync Overlay
 * Dynamically hooks into Hyperswarm, joins dedicated skills swarms, authenticates
 * peers using post-quantum did:atmos documents, and linearizes skill append-only logs.
 */
export class P2pSkillSync {
  constructor(options = {}) {
    this.storagePath = options.storagePath || './.stratos-p2p-store';
    this.topicSeed = options.topicSeed || 'atmos-sovereign-skill-sync-topic-v1';
    this.verbose = options.verbose !== false;

    // Pinned origins whose sealed skill blocks this node will trust (array of hybrid PUBLIC bundles
    // { ed25519Der, mldsaDer }). Empty = trust no remote origin. requireSeal (default true) makes ingest
    // FAIL-CLOSED: a remote block is dropped unless its hybrid seal verifies under a pinned origin.
    this.trustedOrigins = options.trustedOrigins || [];
    this.requireSeal = options.requireSeal !== false;

    this.swarm = null;
    this.store = null;
    this.base = null;
    this.peers = new Set();
    this.skillsLedger = [];
  }

  /**
   * Initializes Corestore, Hyperswarm, and the local Linearized Autobase stream.
   */
  async init() {
    try {
      // 1. Initialize Corestore
      this.store = new Corestore(this.storagePath);
      await this.store.ready();

      // 2. Initialize Autobase with a local hypercore writer
      const localCore = this.store.get({ name: 'local-skill-writer', valueEncoding: 'json' });
      await localCore.ready();

      this.base = new Autobase(this.store, null, {
        inputs: [localCore],
        localInput: localCore,
        autoweight: true,
        valueEncoding: 'json'
      });
      await this.base.ready();

      // 3. Initialize Hyperswarm and start trackerless peer discovery
      this.swarm = new Hyperswarm();
      
      // Calculate a deterministic 32-byte topic key using the seed
      const topicBuffer = crypto.createHash('sha256').update(this.topicSeed).digest();
      
      this.swarm.on('connection', (socket, peerInfo) => {
        const peerId = b4a.toString(peerInfo.publicKey, 'hex').slice(0, 16);
        if (this.verbose) {
          console.log(`📡 [P2pSkillSync] Secure Noise socket tunnel established with peer [${peerId}]`);
        }
        
        this.peers.add(peerId);

        // Standard stream replication with sparse options enabled to save bandwidth/disk
        this.store.replicate(socket);

        socket.on('error', (err) => {
          if (this.verbose) {
            console.log(`⚠️  [P2pSkillSync] Connection error with peer [${peerId}]:`, err.message);
          }
          this.peers.delete(peerId);
        });

        socket.on('close', () => {
          if (this.verbose) {
            console.log(`🔌 [P2pSkillSync] Disconnected from peer [${peerId}]`);
          }
          this.peers.delete(peerId);
        });
      });

      // Join the P2P swarm topic
      const discovery = this.swarm.join(topicBuffer, { client: true, server: true });
      await discovery.flushed();

      if (this.verbose) {
        console.log(`✅ [P2pSkillSync] P2P Skill Sync active. Joined DHT topic: ${topicBuffer.toString('hex').slice(0, 16)}...`);
      }
      return true;
    } catch (err) {
      if (this.verbose) {
        console.error('❌ [P2pSkillSync] Failed to initialize P2P Skill Sync overlay:', err);
      }
      throw err;
    }
  }

  /**
   * Appends a newly compiled WASM skill or ZK-telemetry rollup metadata block to the shared ledger.
   */
  async appendSkillBlock(skillId, skillMeta, wasmHash, signature) {
    if (!this.base) throw new Error('P2pSkillSync not initialized');

    // NOTE: we deliberately do NOT stamp an in-band "local/trusted" flag here. Such a field would be
    // serialized into the replicated block, and a malicious peer could set it on its OWN block to spoof
    // trust. Self-authorship is decided OUT-OF-BAND at read time by provenance (which core the block came
    // from) — see getSynchronizedSkills(selfAuthored:true) for our own core vs verifyBlock() for remotes.
    const skillBlock = {
      skillId,
      timestamp: new Date().toISOString(),
      metadata: skillMeta,
      wasmHash,
      signatureSeal: signature,
      powTarget: crypto.createHash('sha256').update(skillId + wasmHash).digest('hex')
    };

    // Append to linearized stream
    await this.base.append(skillBlock);
    
    // Cache in memory for quick local lookup
    this.skillsLedger.push(skillBlock);

    if (this.verbose) {
      console.log(`✅ [P2pSkillSync] Skill [${skillId}] appended to local ledger. Hash: ${wasmHash.slice(0, 12)}`);
    }
    return skillBlock;
  }

  /**
   * The INGEST GATE (Gap 7/#39) for a REMOTE block: trusted only if its hybrid seal verifies under one of
   * the pinned trustedOrigins. Pure + fail-closed. NB: there is intentionally NO in-band "trusted" bit —
   * a peer could forge one; self-authorship is established by provenance (the caller), never by the block.
   */
  verifyBlock(block) {
    if (!block || !block.skillId || !block.wasmHash || !block.signatureSeal) return { ok: false, reason: 'malformed block' };
    if (!this.requireSeal) return { ok: true, reason: 'seal check disabled (requireSeal=false)' };
    for (const origin of this.trustedOrigins) {
      const r = verifySkillBlock(block, origin);
      if (r.ok) return { ok: true, origin: r.origin };
    }
    return { ok: false, reason: this.trustedOrigins.length ? 'no pinned origin verifies this block' : 'no trusted origins pinned' };
  }

  /**
   * Filter a list of blocks through the ingest gate. `selfAuthored` is set by the CALLER from the block
   * SOURCE (e.g. this node's own localInput core) — provenance trust that no peer can forge. Remote blocks
   * (selfAuthored:false) must pass verifyBlock(); unverified blocks are dropped (and logged).
   */
  filterVerifiedSkills(blocks = [], { selfAuthored = false } = {}) {
    if (selfAuthored) return blocks.slice(); // provenance: came from our OWN core — trusted by source
    const out = [];
    for (const block of blocks) {
      const v = this.verifyBlock(block);
      if (v.ok) out.push(block);
      else if (this.verbose) console.warn(`⛔ [P2pSkillSync] dropped unverified remote skill block [${block?.skillId ?? '?'}]: ${v.reason}`);
    }
    return out;
  }

  /**
   * Pulls skill blocks from THIS node's own ledger / local core. These are self-authored (provenance
   * trust). When peer-core replication is wired, remote blocks MUST be read separately and passed through
   * filterVerifiedSkills(remote, { selfAuthored:false }) so an unauthenticated peer's block is never run.
   */
  async getSynchronizedSkills() {
    if (!this.base) return [];

    const activeSkills = [];

    // In a production Autobase, we iterate through the linearized view
    // Here we return cached memory records fallbacking to our local cores
    if (this.skillsLedger.length > 0) {
      return this.filterVerifiedSkills(this.skillsLedger, { selfAuthored: true });
    }

    try {
      const core = this.base.localInput;
      const count = core.length;
      for (let i = 0; i < count; i++) {
        const block = await core.get(i);
        if (block) activeSkills.push(block);
      }
    } catch (err) {
      if (this.verbose) {
        console.warn('⚠️  [P2pSkillSync] Failed to read from Autobase hypercores:', err.message);
      }
    }

    return this.filterVerifiedSkills(activeSkills, { selfAuthored: true }); // own localInput core
  }

  /**
   * Gracefully shuts down the P2P DHT Swarm and closes Corestore logs.
   */
  async destroy() {
    if (this.swarm) {
      await this.swarm.destroy();
      if (this.verbose) console.log('💤 [P2pSkillSync] Hyperswarm peer discovery closed.');
    }
    if (this.store) {
      await this.store.close();
      if (this.verbose) console.log('💤 [P2pSkillSync] Corestore sessions closed.');
    }
    this.peers.clear();
  }
}
