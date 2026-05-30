import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { PaymentEngine } from './src/billing/payment-engine.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

console.log('⚡ Running x402 Ledger Concurrency Stress Test (Micro-Spam Test)...');
console.log('=====================================================================');

// The engine enforces a Proof-of-Work Sybil check: powTarget = sha256(skillId +
// executionHash + nonce) must start with '00'. A real producer mines a nonce that
// satisfies this before signing; the previous harness sent un-mined invoices and
// crashed on the engine's (correct) rejection.
function minePowNonce(skillId, executionHash) {
  let nonce = 0;
  for (;;) {
    const h = crypto.createHash('sha256').update(skillId + executionHash + String(nonce)).digest('hex');
    if (h.startsWith('00')) return String(nonce);
    nonce++;
  }
}

async function runLedgerChaosTest() {
  const NUM_INVOICES = 5000;
  const FEE_SOL = 0.00001;
  const engine = new PaymentEngine({ verbose: false });

  // Off-chain signing keys for the "promise to pay" envelope.
  const { publicKey: peerAPub, privateKey: peerAPriv } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const nodeA = Keypair.generate();
  const nodeB = Keypair.generate();
  const channel = engine.createStateChannel(nodeA.publicKey.toBase58(), nodeB.publicKey.toBase58());
  const channelId = channel.channelId;

  console.log(`📡 Pre-mining valid PoW for ${NUM_INVOICES} micro-invoices of ${FEE_SOL} SOL...`);
  const prepared = [];
  for (let i = 0; i < NUM_INVOICES; i++) {
    const skillId = `stress_skill_${i}`;
    const executionHash = crypto.createHash('sha256').update(`stress-${i}`).digest('hex');
    prepared.push({ skillId, executionHash, nonce: minePowNonce(skillId, executionHash) });
  }

  console.log(`🚀 [CHAOS TRIGGERED] Blasting ${NUM_INVOICES} signed invoices concurrently to channel...`);
  const start = Date.now();
  let rejected = 0;

  // Concurrent settlement to stress memory locks / race conditions / double-spends.
  await Promise.all(prepared.map(async (item) => {
    try {
      const invoice = engine.createMicroInvoice(channelId, item.skillId, item.executionHash, FEE_SOL, item.nonce);
      const signature = engine.signMicroInvoice(invoice, peerAPriv);
      engine.receiveMicroInvoice(invoice, signature, peerAPub);
    } catch (err) {
      rejected++;
    }
  }));

  const duration = Date.now() - start;

  // Auto-settlement resets the live channel counters every time the threshold is
  // crossed, so true totals = sum(settled batches) + un-settled remainder.
  const settledLamports = channel.autoSettledBatches.reduce((s, b) => s + BigInt(b.accumulatedLamports), 0n);
  const settledInvoices = channel.autoSettledBatches.reduce((s, b) => s + b.invoicesCount, 0);
  const totalLamports = settledLamports + channel.accumulatedBalanceLamports;
  const totalInvoices = settledInvoices + channel.ledger.length;
  const expectedLamports = BigInt(NUM_INVOICES) * BigInt(Math.round(FEE_SOL * LAMPORTS_PER_SOL));

  console.log(`\n🏆 Concurrency Audit Parameters:`);
  console.log(`   - Invoices accepted:          ${totalInvoices} / ${NUM_INVOICES} (rejected: ${rejected})`);
  console.log(`   - Auto-settled batches:       ${channel.autoSettledBatches.length}`);
  console.log(`   - Total settled + remainder:  ${totalLamports} lamports`);
  console.log(`   - Expected total:             ${expectedLamports} lamports`);
  console.log(`   - Throughput Duration:        ${duration}ms`);
  console.log(`   - Execution Speed:            ${Math.round(NUM_INVOICES / (duration / 1000))} micro-invoices / sec`);

  // Demonstrate an on-chain rollup of any un-settled remainder.
  if (channel.accumulatedBalanceLamports > 0n) {
    const rollup = await engine.compileBatchRollup(channelId, nodeA, nodeB.publicKey);
    console.log(`   - Remainder rollup tx bytes:  ${rollup.serializedHex.length / 2}`);
  } else {
    console.log(`   - Remainder rollup:           skipped (all balance auto-settled cleanly)`);
  }

  if (totalLamports === expectedLamports && totalInvoices === NUM_INVOICES && rejected === 0) {
    console.log('\n🎉 x402 LEDGER CONCURRENCY STRESS TEST PASSED! ZERO RACE CONDITIONS OR DOUBLE-SPENDS LOGGED.');
    setTimeout(() => process.exit(0), 100);
  } else {
    console.error('❌ x402 Ledger Concurrency Stress test failed: Audit mismatch.');
    setTimeout(() => process.exit(1), 100);
  }
}

runLedgerChaosTest();
