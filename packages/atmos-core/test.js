import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { KeyringManager, P2PNetwork, StorageManager, PaymentEngine } from './index.js';

async function runTests() {
  console.log('⚡ Starting Atmos Core Integration Suite...\n');

  // Test 1: Keyring Manager Identity Verification
  console.log('🔄 Test 1: Validating Cryptographic Keyring...');
  const consumerKeyring = new KeyringManager('consumer');
  const keypair = await consumerKeyring.init('test-consumer-seed-for-cryptographic-operations-verification');
  assert.ok(keypair.publicKey, 'Keyring should generate public key');
  
  const msg = 'Decentralize the cloud computing paradigm';
  const sig = consumerKeyring.sign(msg);
  const isVerified = consumerKeyring.verify(msg, sig, keypair.publicKey);
  assert.strictEqual(isVerified, true, 'Cryptographic signature should verify cleanly');
  console.log('✅ Test 1 Passed: Keys and signatures verified successfully.');

  // Test 2: P2P Network Discovery Simulation
  console.log('\n🔄 Test 2: Simulating Hyperswarm Peer Networking & Agent Cards...');
  const net = new P2PNetwork(consumerKeyring);
  await net.start();
  
  // Verify card broadcast interfaces
  net.broadcastAgentCard({ 'scraping-wasm': '1.0.0' });
  console.log('✅ Test 2 Passed: Hyperswarm and Agent Card interface functional.');

  // Test 3: Storage Manager & Append logs
  console.log('\n🔄 Test 3: Appending encrypted logs to Corestore & Autobase...');
  const tmpDir = path.join(process.cwd(), 'tmp-corestore-test');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const storage = new StorageManager(tmpDir, consumerKeyring);
  await storage.start();
  
  await storage.append({ task: 'CDP_SCRAPE', status: 'SUCCESS' });
  console.log('✅ Test 3 Passed: Successfully appended structured blocks into P2P ledger.');

  // Test 4: x402 Micropayments Engine
  console.log('\n🔄 Test 4: Validating x402 Micropayment Invoices...');
  const recipientKeyring = new KeyringManager('consumer');
  const recipientKeys = await recipientKeyring.init('recipient-seed-mock-for-testing');
  const recipientPkHex = recipientKeys.publicKey.toString('hex');

  const payments = new PaymentEngine(consumerKeyring);
  const envelope = payments.generateInvoice(recipientPkHex, 0.0005, 'task-uuid-abc-123');
  assert.strictEqual(envelope.invoice.protocol, 'x402', 'Should follow x402 protocol specification');
  
  const receiverPayments = new PaymentEngine(recipientKeyring);
  // Re-verify the envelope from the perspective of recipient
  const txHash = receiverPayments.verifyInvoice(envelope);
  assert.ok(txHash, 'Micropayment invoice should verify securely');
  console.log('✅ Test 4 Passed: Cryptographic microtransaction completed.');

  // Cleanup
  await net.stop();
  await storage.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {}

  console.log('\n🎉 ALL ATMOS-CORE INTEGRATION TESTS PASSED!');
}

runTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
