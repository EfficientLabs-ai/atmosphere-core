import Corestore from 'corestore';
import Hypercore from 'hypercore';
import Autobase from 'autobase';
import b4a from 'b4a';

/**
 * StorageManager instantiates and orchestrates local and clustered peer-to-peer data grids.
 */
export class StorageManager {
  constructor(storagePath, keyring) {
    this.storagePath = storagePath;
    this.keyring = keyring;
    this.store = null;
    this.autobase = null;
    this.localCore = null;
  }

  /**
   * Start the corestore grid and configure Autobase multi-writer pipelines.
   */
  async start() {
    // Corestore handles directory locking and automatic key derivation securely
    this.store = new Corestore(this.storagePath);

    // Retrieve or initialize the primary sovereign append-only log for this agent
    this.localCore = this.store.get({
      name: 'stratos-agent-feed',
      valueEncoding: 'json'
    });

    await this.localCore.ready();

    // Configure the multi-writer log indexer via Autobase
    // Autobase takes the Corestore as its first argument, and options specifying the primary inputs
    this.autobase = new Autobase(this.store, null, {
      inputs: [this.localCore],
      localInput: this.localCore,
      valueEncoding: 'json'
    });

    await this.autobase.ready();
    return this;
  }

  /**
   * Appends an execution task block or completed Wasm schema safely into the P2P ledger.
   * @param {Object} block - Structural task or binary data trace
   */
  async append(block) {
    if (!this.localCore) throw new Error('Storage manager not started');
    
    const signedBlock = {
      data: block,
      signer: b4a.toString(this.keyring.keypair.publicKey, 'hex'),
      signature: b4a.toString(this.keyring.sign(JSON.stringify(block)), 'hex'),
      timestamp: Date.now()
    };

    return await this.autobase.append(signedBlock);
  }

  /**
   * Replicates corestore streams directly through network socket pipes.
   * Enables seamless P2P file and data sync.
   * @param {Duplex} socket - P2P Network Socket
   */
  replicate(socket) {
    if (!this.store) throw new Error('Storage manager not started');
    
    // Corestore multiplexes all managed cores down a single replication connection
    const stream = this.store.replicate(socket);
    
    // Ensure recovery handles stream errors gracefully
    stream.on('error', () => {});
    return stream;
  }

  async close() {
    if (this.store) {
      await this.store.close();
    }
  }
}
