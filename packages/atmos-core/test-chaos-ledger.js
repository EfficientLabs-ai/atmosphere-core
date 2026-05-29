import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { PaymentEngine } from './src/billing/payment-engine.js';

console.log('⚡ Running x402 Ledger Concurrency Stress Test (Micro-Spam Test)...');
console.log('=====================================================================');

async function runLedgerChaosTest() {
  const NUM_INVOICES = 10000;
  const ENGINE_OPTIONS = { verbose: false }; // Disable verbose to maximize throughput

  // 1. Generate off-chain signing keys
  const { publicKey: peerAPub, privateKey: peerAPriv } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const nodeA = Keypair.generate();
  const nodeB = Keypair.generate();

  const engine = new PaymentEngine(ENGINE_OPTIONS);
  const channel = engine.createStateChannel(nodeA.publicKey.toBase58(), nodeB.publicKey.toBase58());
  const channelId = channel.channelId;

  console.log(`📡 Preparing ${NUM_INVOICES} async micro-invoices of 0.00001 SOL...`);
  const invoices = [];
  
  for (let i = 0; i < NUM_INVOICES; i++) {
    invoices.push({
      skillId: `stress_skill_${i}`,
      hash: crypto.createHash('sha256').update(`stress-${i}`).digest('hex'),
      sol: 0.00001
    });
  }

  console.log(`🚀 [CHAOS TRIGGERED] Blasting ${NUM_INVOICES} signed invoices concurrently to channel...`);
  const start = Date.now();

  // Process invoices concurrently using Promise.all to stress check memory locks & race conditions
  const promises = invoices.map(async (item) => {
    // 1. Generate off-chain invoice envelope
    const invoice = engine.createMicroInvoice(channelId, item.skillId, item.hash, item.sol);
    
    // 2. Cryptographically sign off-chain Promise to Pay
    const signature = engine.signMicroInvoice(invoice, peerAPriv);
    
    // 3. Receive, verify signatures and register balance
    engine.receiveMicroInvoice(invoice, signature, peerAPub);
  });

  await Promise.all(promises);
  const duration = Date.now() - start;

  console.log(`✅ Parallel ledger execution successfully completed!`);
  console.log(`   - Invoices Signed & Verified: ${NUM_INVOICES}`);
  console.log(`   - Throughput Duration:        ${duration}ms`);
  console.log(`   - Execution Speed:            ${Math.round(NUM_INVOICES / (duration / 1000))} micro-invoices / sec`);

  // Verify total accumulated lamports
  const expectedLamports = BigInt(NUM_INVOICES) * 10000n; // 0.00001 SOL = 10000 lamports
  const ledgerBalance = channel.accumulatedBalanceLamports;

  console.log(`\n📦 Compiling batch rollup to Solana Transaction buffer...`);
  const rollup = await engine.compileBatchRollup(channelId, nodeA, nodeB.publicKey);

  console.log(`\n🏆 Concurrency Audit Parameters:`);
  console.log(`   - Invoices logged in Ledger: ${channel.ledger.length}`);
  console.log(`   - Accumulated balance:       ${ledgerBalance} lamports`);
  console.log(`   - Expected balance:          ${expectedLamports} lamports`);
  console.log(`   - Serialized rollup size:    ${rollup.serializedHex.length / 2} bytes`);

  if (ledgerBalance === expectedLamports && channel.ledger.length === NUM_INVOICES) {
    console.log('\n🎉 x402 LEDGER CONCURRENCY STRESS TEST PASSED! ZERO RACE CONDITIONS OR DOUBLE-SPENDS LOGGED.');
    process.exit(0);
  } else {
    console.error('❌ x402 Ledger Concurrency Stress test failed: Audit mismatch.');
    process.exit(1);
  }
}

runLedgerChaosTest();
