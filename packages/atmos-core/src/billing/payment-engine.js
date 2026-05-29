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
      createdAt: new Date().toISOString()
    };

    this.stateChannels.set(channelId, channelState);
    console.log(`🌐 [x402 State Channel] Opened channel ${channelId.slice(0, 16)}... between ${peerA.slice(0, 8)} and ${peerB.slice(0, 8)}.`);
    return channelState;
  }

  /**
   * Generates a signed off-chain x402 micro-invoice for verified WASM execution.
   */
  createMicroInvoice(channelId, skillId, executionHash, amountSol) {
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
      serviceDefinition: 'Decentralized WASM Execution Fee Settlement'
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
    const { channelId, amountLamports, skillId, executionHash } = invoice;
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

    // 3. Log the verified settlement balance
    const amt = BigInt(amountLamports);
    channel.ledger.push({
      invoice,
      signature,
      verifiedAt: new Date().toISOString()
    });
    channel.accumulatedBalanceLamports += amt;

    console.log(`💸 [x402 Ledger] Logged verified execution fee: ${skillId.slice(0, 16)}... | Fee: ${Number(amt) / LAMPORTS_PER_SOL} SOL.`);
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

    // 2. Acquire a mock/simulated blockhash for offline signing compilation
    // In production this fetches from this.connection.getLatestBlockhash()
    const simulatedBlockhash = '11111111111111111111111111111111';
    transaction.recentBlockhash = simulatedBlockhash;
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
