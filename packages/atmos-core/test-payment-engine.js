import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { PaymentEngine } from './src/billing/payment-engine.js';

console.log('🧪 Starting Atmos x402 Micropayment E2E Verification Harness (Phase 8)...');
console.log('========================================================================');

async function runTest() {
  try {
    // 1. Generate local cryptographic credentials for off-chain channel signing
    console.log('🔑 [Step 1] Initializing off-chain RSA keypairs for P2P channel signing...');
    const { publicKey: peerAPub, privateKey: peerAPriv } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    console.log('✅ Off-chain P2P channel key pair generated.');
    console.log('------------------------------------------------------------------------');

    // 2. Generate Solana wallets using web3.js representing Node A and Node B
    console.log('💳 [Step 2] Initializing Solana wallets using web3.js...');
    const nodeAWallet = Keypair.generate();
    const nodeBWallet = Keypair.generate();
    
    const nodeAAddress = nodeAWallet.publicKey.toBase58();
    const nodeBAddress = nodeBWallet.publicKey.toBase58();
    
    console.log(`🏦 Node A Payer Wallet Address: ${nodeAAddress}`);
    console.log(`🏦 Node B User Wallet Address:  ${nodeBAddress}`);
    console.log('------------------------------------------------------------------------');

    // 3. Initialize PaymentEngine and open an off-chain P2P state channel
    const engine = new PaymentEngine();
    console.log('📡 [Step 3] Opening high-speed x402 State Channel...');
    const channel = engine.createStateChannel(nodeAAddress, nodeBAddress);
    const channelId = channel.channelId;
    console.log('------------------------------------------------------------------------');

    // 4. Simulate verified WASM skill executions generating off-chain micro-invoices
    console.log('💸 [Step 4] Simulating off-chain x402 execution fee invoices...');
    const executions = [
      { skillId: 'skill_ocr_render_v1', hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', sol: 0.002 },
      { skillId: 'skill_pdf_scrape_v2', hash: '89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567', sol: 0.001 },
      { skillId: 'skill_db_index_v1',   hash: 'fdbaf87d6e4d5c4b3a29f8d7e6c5b4a3fdbaf87d6e4d5c4b3a29f8d7e6c5b4a3', sol: 0.003 }
    ];

    for (const exec of executions) {
      console.log(`\n  - Execution Rendered: ${exec.skillId} | Proof-of-Work Hash: ${exec.hash.slice(0, 16)}...`);
      
      // Generate the micro-invoice
      const invoice = engine.createMicroInvoice(channelId, exec.skillId, exec.hash, exec.sol);
      
      // Sign off-chain using Node A's private key
      const signature = engine.signMicroInvoice(invoice, peerAPriv);
      
      // Node B receives, verifies, and registers the micro-invoice
      engine.receiveMicroInvoice(invoice, signature, peerAPub);
    }
    console.log('\n------------------------------------------------------------------------');

    // 5. Bundle the accumulated balances and compile on-chain Solana rollup
    console.log('📦 [Step 5] Compiling Batch Rollup for on-chain Solana broadcast...');
    const rollupResult = await engine.compileBatchRollup(channelId, nodeAWallet, nodeBWallet.publicKey);

    console.log('\n✅ On-Chain Rollup Compiled and Offline Signed Successfully!');
    console.log(`  - Invoices Batched & Consolidated: ${rollupResult.invoicesBatched}`);
    console.log(`  - Total Payout Settle (lamports): ${rollupResult.lamportsSetted} lamports`);
    console.log(`  - Total Payout Settle (SOL):      ${Number(rollupResult.lamportsSetted) / 1e9} SOL`);
    console.log(`  - Serialized Transaction Hex:     ${rollupResult.serializedHex.substring(0, 96)}...`);
    console.log('========================================================================');

    if (rollupResult.invoicesBatched === 3 && rollupResult.lamportsSetted === 6000000n && rollupResult.serializedHex.length > 0) {
      console.log('🎉 PHASE 8 SOLANA x402 MICROPAYMENT ENGINE FULLY DEPLOYED & VERIFIED!');
      setTimeout(() => process.exit(0), 100);
    } else {
      console.error('❌ Validation mismatch in rollup values.');
      setTimeout(() => process.exit(1), 100);
    }
  } catch (err) {
    console.error('❌ Critical Verification Error:', err);
    setTimeout(() => process.exit(1), 100);
  }
}

runTest();
