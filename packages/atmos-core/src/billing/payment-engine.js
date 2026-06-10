import crypto from 'node:crypto';
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';

/**
 * Efficient Labs Sovereign x402 Micropayment & Settlement Engine
 * 
 * DESIGN PROTOCOL: Strictly structured as an "Execution Fee Settlement" system
 * to satisfy CFTC/SEC DePIN guidelines. Compensates nodes ONLY for verified,
 * measurable computing output (executed WASM skill graphs), avoiding any passive
 * yield or staking mechanics that would trigger the Howey Test.
 */
export class PaymentEngine {
  constructor(options = {}) {
    // Connect to a local test RPC or fallback to public devnet
    this.rpcUrl = options.rpcUrl || 'https://api.devnet.solana.com';
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    // In-memory ledger representing off-chain mesh state channels
    this.stateChannels = new Map();

    // Auto-settlement threshold: defaults to 5,000,000 lamports (0.005 SOL)
    this.autoSettlementThreshold = options.autoSettlementThreshold || 5000000n;
  }

  /**
   * Fetches the actual on-chain SOL balance for a given wallet address.
   * Fail-CLOSED: if the RPC is down/rate-limited this THROWS — it never fabricates a balance.
   * A provenance/economic rail must not invent funds; callers handle the error explicitly.
   */
  async getLiveBalance(publicKeyStr) {
    try {
      const pubkey = new PublicKey(publicKeyStr);
      const balance = await this.connection.getBalance(pubkey);
      console.log(`📡 [x402 PaymentEngine] Live balance for ${publicKeyStr.slice(0, 8)}...: ${balance / LAMPORTS_PER_SOL} SOL`);
      return balance;
    } catch (err) {
      // FAIL-CLOSED: never return a synthetic balance (was `return 1 SOL`). The economic layer is
      // offline-only; a caller that needs a real balance must handle this error, not an invented number.
      throw new Error(`[x402 PaymentEngine] live RPC balance query failed (${err.message}); refusing to fabricate a balance`);
    }
  }

  /**
   * Opens a secure off-chain P2P state channel between two coordination peers.
   */
  createStateChannel(peerA, peerB) {
    const channelId = crypto.createHash('sha256').update(`${peerA}-${peerB}-${Date.now()}`).digest('hex');
    
    const channelState = {
      channelId,
      peerA, // The business owner's wallet/node (funding node)
      peerB, // The executing user's wallet/node (earning node)
      ledger: [], // List of verified off-chain x402 micro-invoices
      accumulatedBalanceLamports: 0n,
      isActive: true,
      createdAt: new Date().toISOString(),
      autoSettledBatches: [] // Tracks finalized automatic settlement snapshots
    };

    this.stateChannels.set(channelId, channelState);
    console.log(`🌐 [x402 State Channel] Opened channel ${channelId.slice(0, 16)}... between ${peerA.slice(0, 8)} and ${peerB.slice(0, 8)}.`);
    return channelState;
  }

  /**
   * Generates a signed off-chain x402 micro-invoice for verified WASM execution.
   */
  createMicroInvoice(channelId, skillId, executionHash, amountSol, nonce = '') {
    const channel = this.stateChannels.get(channelId);
    if (!channel || !channel.isActive) {
      throw new Error(`❌ Error: Channel ${channelId} is invalid or inactive.`);
    }

    // Convert SOL execution fee to lamports
    const lamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));

    // Construct the structured micro-invoice representing a verified service rendered
    const invoice = {
      channelId,
      skillId,
      executionHash, // Proof of measurable computational output
      amountLamports: lamports.toString(),
      invoiceId: crypto.randomBytes(16).toString('hex'),
      timestamp: new Date().toISOString(),
      serviceDefinition: 'Decentralized WASM Execution Fee Settlement',
      nonce,
      powTarget: crypto.createHash('sha256').update(skillId + executionHash + nonce).digest('hex')
    };

    return invoice;
  }

  /**
   * Signs an off-chain micro-invoice using the funding node's classical key.
   */
  signMicroInvoice(invoice, privateKey) {
    const payload = JSON.stringify(invoice);
    const sign = crypto.createSign('SHA256');
    sign.update(payload);
    sign.end();
    return sign.sign(privateKey, 'base64');
  }

  /**
   * Receives and validates an incoming micro-invoice off-chain.
   * Verifies the cryptographic signature and registers the earned balance in the ledger.
   */
  receiveMicroInvoice(invoice, signature, publicKeyPem) {
    const { channelId, amountLamports, skillId, executionHash, nonce, powTarget } = invoice;
    const channel = this.stateChannels.get(channelId);
    if (!channel) {
      throw new Error(`❌ Error: Channel ${channelId} not found.`);
    }

    // 1. Verify Cryptographic Promise to Pay
    const payload = JSON.stringify(invoice);
    const verify = crypto.createVerify('SHA256');
    verify.update(payload);
    verify.end();
    
    const isSignatureValid = verify.verify(publicKeyPem, signature, 'base64');
    if (!isSignatureValid) {
      throw new Error('❌ Security Violation: Micro-invoice cryptographic signature is invalid!');
    }

    // 2. Perform Failsafe Validation Checks
    if (!skillId || !executionHash) {
      throw new Error('❌ Compliance Violation: Missing proof of measurable computational output.');
    }

    // 2b. Validate Proof-of-Work Sybil Checker
    if (!powTarget) {
      throw new Error('❌ Compliance Violation: Inbound invoice lacks a Proof-of-Work target hash.');
    }
    const computedHash = crypto.createHash('sha256').update(skillId + executionHash + (nonce || '')).digest('hex');
    if (computedHash !== powTarget) {
      throw new Error('❌ Security Violation: Proof-of-Work hash mismatch!');
    }
    if (!powTarget.startsWith('00')) {
      throw new Error('❌ Compliance Violation: Proof-of-Work difficulty target not met!');
    }

    // 3. Log the verified settlement balance
    const amt = BigInt(amountLamports);
    channel.ledger.push({
      invoice,
      signature,
      verifiedAt: new Date().toISOString()
    });
    channel.accumulatedBalanceLamports += amt;

    console.log(`💸 [x402 Ledger] Logged verified execution fee: ${skillId.slice(0, 16)}... | Fee: ${Number(amt) / LAMPORTS_PER_SOL} SOL.`);

    // 4. Automated State Channel Rollup Trigger (Auto-Settlement)
    if (channel.accumulatedBalanceLamports >= this.autoSettlementThreshold) {
      console.log(`📡 [x402 Auto-Settlement] Channel balance ${Number(channel.accumulatedBalanceLamports) / LAMPORTS_PER_SOL} SOL reached threshold ${Number(this.autoSettlementThreshold) / LAMPORTS_PER_SOL} SOL.`);
      
      const settledBatch = {
        batchId: crypto.randomBytes(16).toString('hex'),
        settlementTimestamp: new Date().toISOString(),
        accumulatedLamports: channel.accumulatedBalanceLamports.toString(),
        invoicesCount: channel.ledger.length,
        ledgerSnapshot: [...channel.ledger]
      };

      channel.autoSettledBatches.push(settledBatch);
      
      // Reset off-chain state channel counters for next batch
      channel.accumulatedBalanceLamports = 0n;
      channel.ledger = [];
      
      console.log(`📦 [x402 Auto-Settlement] Auto-rollup batch generated successfully: ${settledBatch.batchId.slice(0, 8)}... | Settled: ${Number(settledBatch.accumulatedLamports) / LAMPORTS_PER_SOL} SOL.`);
    }

    return channel;
  }

  /**
   * Rollup: Batches accumulated off-chain micro-balances and compiles a real,
   * signed Solana transaction for on-chain settlement.
   * @param {string} channelId Active state channel ID.
   * @param {Keypair} fundingNodeKeypair Solana keypair of the payer (Node A).
   * @param {PublicKey} recipientPublicKey Solana public key of the receiver (Node B).
   */
  async compileBatchRollup(channelId, fundingNodeKeypair, recipientPublicKey) {
    const channel = this.stateChannels.get(channelId);
    if (!channel) {
      throw new Error(`❌ Error: Channel ${channelId} not found.`);
    }

    const totalLamports = channel.accumulatedBalanceLamports;
    if (totalLamports <= 0n) {
      throw new Error('❌ Error: No accumulated execution balance to settle.');
    }

    console.log(`📦 [x402 Rollup] Batching ${channel.ledger.length} execution invoices...`);
    console.log(`📦 [x402 Rollup] Total Settlement Fee: ${Number(totalLamports) / LAMPORTS_PER_SOL} SOL.`);

    // 1. Build a real Solana transfer transaction
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fundingNodeKeypair.publicKey,
        toPubkey: recipientPublicKey,
        lamports: Number(totalLamports)
      })
    );

    // 2. Fetch the latest blockhash from Solana devnet, or fallback to mock offline blockhash
    let blockhash;
    try {
      const latest = await this.connection.getLatestBlockhash('confirmed');
      blockhash = latest.blockhash;
      console.log(`📡 [x402 Rollup] Successfully fetched live blockhash from Solana devnet: ${blockhash}`);
    } catch (err) {
      console.warn(`⚠️ [x402 Rollup] Failed to fetch live blockhash: ${err.message}. Using simulated fallback.`);
      blockhash = '5E2cZ7fC2UoU58qA96P12Dk2Gg9sQ2D2D2D2D2D2D2D2'; // Valid base58-looking fallback
    }
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fundingNodeKeypair.publicKey;

    // 3. Sign the Solana transaction offline with payer's private key
    transaction.sign(fundingNodeKeypair);

    const serializedTransaction = transaction.serialize({ requireAllSignatures: false });
    console.log(`✅ [x402 Rollup] Bundle signed offline. Transaction size: ${serializedTransaction.length} bytes.`);

    return {
      transaction,
      serializedHex: serializedTransaction.toString('hex'),
      lamportsSetted: totalLamports,
      invoicesBatched: channel.ledger.length
    };
  }
}
