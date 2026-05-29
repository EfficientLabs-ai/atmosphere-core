import { KeyringManager } from './keyring.js';
import { P2PNetwork } from './p2p-network.js';
import { VaultHost } from '../stratos-agent/src/security/vault-host.js';
import { SmtTransactionEnclave } from './src/billing/smt-transaction-enclave.js';
import { LatticeMessaging } from './src/messaging/lattice-messaging.js';
import { generateHybridKeyPair } from '../stratos-agent/src/security/quantum-crypto.js';
import { deriveAtmosDid } from '../stratos-agent/src/security/did-generator.js';

async function runSovereignPhasesTest() {
  console.log('========================================================================');
  console.log('🌌 EFFICIENT LABS - THE ATMOSPHERE P2P GRID');
  console.log('🧪 RUNNING MASTER SOVEREIGN PHASES TEST SUITE (PHASES 19, 20, 21)');
  console.log('========================================================================\n');

  // --- INITIALIZATION ---
  console.log('✨ [System Setup] Initializing keyrings, enclaves, and cryptographic hosts...');
  
  const aliceKeyring = new KeyringManager('consumer');
  const bobKeyring = new KeyringManager('maximus');
  await aliceKeyring.init();
  await bobKeyring.init();

  const aliceVault = new VaultHost();
  const bobVault = new VaultHost();
  await aliceVault.init();
  await bobVault.init();

  console.log('🔑 Keyrings and Vault Hosts successfully initialized.');
  console.log(`   - Alice Keyring PK: ${aliceKeyring.keypair.publicKey.toString('hex').slice(0, 16)}...`);
  console.log(`   - Bob Keyring PK:   ${bobKeyring.keypair.publicKey.toString('hex').slice(0, 16)}...`);
  console.log(`   - Vault ML-DSA PK:  ${aliceVault.getPublicKey().toString('hex').slice(0, 16)}...\n`);


  // --- PHASE 19: W3C DID DOCUMENT & DHT SWARMING ---
  console.log('📡 [PHASE 19] Verifying W3C did:atmos DHT Swarming...');
  
  const aliceP2P = new P2PNetwork(aliceKeyring);
  const bobP2P = new P2PNetwork(bobKeyring);
  await aliceP2P.start();
  await bobP2P.start();

  let aliceCardIntercepted = null;
  let bobCardIntercepted = null;

  // Intercept the broadcast stream to simulate local P2P network delivery offline
  aliceP2P.broadcast = (signedPayload) => {
    aliceCardIntercepted = signedPayload;
  };
  bobP2P.broadcast = (signedPayload) => {
    bobCardIntercepted = signedPayload;
  };

  // Broadcast cards
  aliceP2P.broadcastAgentCard({ 'data-transformation': 'wasm' });
  bobP2P.broadcastAgentCard({ 'crypto-signing': 'wasm', 'smt-solving': 'wasm' });

  if (!aliceCardIntercepted || !bobCardIntercepted) {
    throw new Error('❌ Phase 19 Failed: Agent Cards were not generated/intercepted correctly.');
  }

  console.log('✅ Success: Agent Cards successfully generated and serialized.');

  // Validate Alice's W3C DID document inside her card
  const aliceDidDoc = aliceCardIntercepted.card.didDocument;
  console.log(`🔍 Inspecting Alice's W3C did:atmos Document:`);
  console.log(`   - ID: ${aliceDidDoc.id}`);
  console.log(`   - Verification Methods:`);
  aliceDidDoc.verificationMethod.forEach(method => {
    console.log(`     * ID: ${method.id} (${method.type})`);
  });
  console.log(`   - Attestation Proof Type: ${aliceDidDoc.proof.type}`);
  console.log(`   - Attestation Proof Value: ${aliceDidDoc.proof.proofValue.slice(0, 32)}...\n`);

  if (!aliceDidDoc.id.startsWith('did:atmos:')) {
    throw new Error('❌ Phase 19 Failed: DID document ID is not in did:atmos namespace.');
  }
  if (aliceDidDoc.verificationMethod.length !== 2) {
    throw new Error('❌ Phase 19 Failed: DID document must contain composite classical and quantum keys.');
  }
  if (aliceDidDoc.proof.type !== 'HybridQuantumAttestation2026') {
    throw new Error('❌ Phase 19 Failed: DID document lacks secure enclaved attestation proof.');
  }

  // Bob receives Alice's card via incoming Noise socket stream
  console.log('📥 Delivering Alice\'s Agent Card to Bob\'s P2P network receiver...');
  bobP2P._handleIncomingMessage(
    aliceCardIntercepted.card.publicKey,
    aliceCardIntercepted,
    null
  );

  const bobStoredAliceCard = bobP2P.agentCards.get(aliceCardIntercepted.card.publicKey);
  if (!bobStoredAliceCard) {
    throw new Error('❌ Phase 19 Failed: Bob rejected Alice\'s card during DID and attestation verification.');
  }
  console.log('✅ Success: Bob successfully verified and accepted Alice\'s W3C DID document and post-quantum attestation proof!\n');

  // Alice receives Bob's card
  console.log('📥 Delivering Bob\'s Agent Card to Alice\'s P2P network receiver...');
  aliceP2P._handleIncomingMessage(
    bobCardIntercepted.card.publicKey,
    bobCardIntercepted,
    null
  );

  const aliceStoredBobCard = aliceP2P.agentCards.get(bobCardIntercepted.card.publicKey);
  if (!aliceStoredBobCard) {
    throw new Error('❌ Phase 19 Failed: Alice rejected Bob\'s card during DID and attestation verification.');
  }
  console.log('✅ Success: Alice successfully verified and accepted Bob\'s W3C DID document and post-quantum attestation proof!\n');


  // --- PHASE 20: AUTONOMOUS ENCLAVED WORKFLOWS & Z3 SMT VERIFICATION ---
  console.log('🔒 [PHASE 20] Verifying Autonomous Transaction Enclave & Z3 SMT Solver Invariants...');

  const txEnclave = new SmtTransactionEnclave({ maxAmount: 1000 });
  const bobDid = bobDidDoc().id;

  // Authorize Bob's DID in the enclave registry
  txEnclave.authorizeDid(bobDid);
  console.log(`✅ Success: Registered Bob's identity '${bobDid}' as an authorized node coordinator.`);

  // Helpers to fetch DID from Bob's actual document
  function bobDidDoc() {
    return bobCardIntercepted.card.didDocument;
  }

  // --- Test Case 20.1: SAT State (Valid Transaction) ---
  console.log('\n📝 Test Case 20.1: Processing COMPLIANT transaction (250 USDC <= 1000 USDC Limit)...');
  const txSat = {
    amount: 250,
    recipientDid: bobDid,
    timestamp: Date.now()
  };

  const satResult = txEnclave.processTransaction(txSat, aliceVault);
  console.log(`   SMT Solver Output: ${satResult.status}`);
  console.log(`   Transaction Status: ${satResult.success ? 'APPROVED' : 'QUARANTINED'}`);
  if (!satResult.success) {
    throw new Error('❌ Phase 20 Failed: Compliant transaction was rejected.');
  }
  console.log(`   Post-Quantum ML-DSA-65 Enclaved Signature: ${satResult.signature.slice(0, 32)}...`);
  console.log('   Formal SMT-LIB Verification Model generated successfully:');
  console.log('------------------------------------------------------------------------');
  console.log(satResult.smtLibModel.split('\n').slice(0, 16).join('\n'));
  console.log('   ... [Truncated for brevity] ...');
  console.log('------------------------------------------------------------------------');

  // --- Test Case 20.2: UNSAT State (Limit Breach) ---
  console.log('\n🚨 Test Case 20.2: Processing INVARIANT BREACH (5000 USDC > 1000 USDC Limit)...');
  const txUnsatLimit = {
    amount: 5000,
    recipientDid: bobDid,
    timestamp: Date.now()
  };

  const unsatLimitResult = txEnclave.processTransaction(txUnsatLimit, aliceVault);
  console.log(`   SMT Solver Output: ${unsatLimitResult.status}`);
  console.log(`   Transaction Status: ${unsatLimitResult.success ? 'APPROVED' : 'QUARANTINED'}`);
  if (unsatLimitResult.success) {
    throw new Error('❌ Phase 20 Failed: Violation was approved.');
  }
  console.log('   Violations Reported:', unsatLimitResult.violations);

  // --- Test Case 20.3: UNSAT State (Identity Registry Breach) ---
  console.log('\n🚨 Test Case 20.3: Processing INVARIANT BREACH (Unauthorized Recipient Identity)...');
  const txUnsatIdentity = {
    amount: 100,
    recipientDid: 'did:atmos:zUnauthorizedPeerIdentityWithoutActiveKeyCapabilities',
    timestamp: Date.now()
  };

  const unsatIdResult = txEnclave.processTransaction(txUnsatIdentity, aliceVault);
  console.log(`   SMT Solver Output: ${unsatIdResult.status}`);
  console.log(`   Transaction Status: ${unsatIdResult.success ? 'APPROVED' : 'QUARANTINED'}`);
  if (unsatIdResult.success) {
    throw new Error('❌ Phase 20 Failed: Unauthorized identity transfer was approved.');
  }
  console.log('   Violations Reported:', unsatIdResult.violations);

  // --- Test Case 20.4: UNSAT State (Replay Protection Time Window Breach) ---
  console.log('\n🚨 Test Case 20.4: Processing INVARIANT BREACH (Replay Attack - Timestamp 1 Hour Ago)...');
  const txUnsatTime = {
    amount: 50,
    recipientDid: bobDid,
    timestamp: Date.now() - 60 * 60 * 1000 // 1 hour ago
  };

  const unsatTimeResult = txEnclave.processTransaction(txUnsatTime, aliceVault);
  console.log(`   SMT Solver Output: ${unsatTimeResult.status}`);
  console.log(`   Transaction Status: ${unsatTimeResult.success ? 'APPROVED' : 'QUARANTINED'}`);
  if (unsatTimeResult.success) {
    throw new Error('❌ Phase 20 Failed: Expired timestamp transaction was approved.');
  }
  console.log('   Violations Reported:', unsatTimeResult.violations);

  // --- Quarantine Registry Audit ---
  const quarantined = txEnclave.getQuarantinedTransactions();
  console.log(`\n🛡️  Auditing Transaction Enclave Quarantine Registry:`);
  console.log(`   Total Quarantined Violations: ${quarantined.length} transactions`);
  if (quarantined.length !== 3) {
    throw new Error(`❌ Phase 20 Failed: Expected 3 quarantined violations, got ${quarantined.length}`);
  }

  // Verify memory zeroization
  console.log('🧹 Executing memory sweep and zeroing out transaction logs...');
  txEnclave.wipeMemory();
  if (txEnclave.getQuarantinedTransactions().length !== 0) {
    throw new Error('❌ Phase 20 Failed: Memory zeroization did not clear the quarantine logs.');
  }
  console.log('✅ Success: Sovereign Transaction Enclave safely verified invariants, quarantined all 3 violations, and successfully zeroized heap logs!\n');


  // --- PHASE 21: LATTICE-BASED E2E PEER MESSAGING ---
  console.log('🔐 [PHASE 21] Verifying Lattice-Based E2E Peer Encrypted Messaging...');

  // 1. Generate hybrid key bundles (Classical X25519 + ML-KEM-768)
  console.log('⏳ Generating hybrid X25519 + ML-KEM-768 key pairs for Alice and Bob...');
  const aliceKeys = generateHybridKeyPair();
  const bobKeys = generateHybridKeyPair();

  const secretPayload = '🚨 URGENT CORE ROUTER STATE REALLOCATION TRANSACTION PROPOSAL - LEVEL 5';
  console.log(`💬 Original secret message: "${secretPayload}"`);

  // 2. Alice encrypts the message targeting Bob's public key bundle
  console.log('🔒 Alice encrypting message using Bob\'s hybrid public key bundle...');
  const packet = LatticeMessaging.encryptPeerMessage(secretPayload, bobKeys.publicKey);

  console.log('📦 Encrypted packet structure constructed:');
  console.log(`   - bobX25519PubDer: ${packet.bobX25519PubDer.toString('hex').slice(0, 16)}...`);
  console.log(`   - kemCiphertext:   ${packet.kemCiphertext.toString('hex').slice(0, 16)}...`);
  console.log(`   - IV:              ${packet.iv.toString('hex')}`);
  console.log(`   - Auth Tag:        ${packet.authTag.toString('hex')}`);
  console.log(`   - Ciphertext:      ${packet.encryptedPayload.toString('hex').slice(0, 16)}...`);

  if (!packet.bobX25519PubDer || !packet.kemCiphertext || !packet.iv || !packet.authTag || !packet.encryptedPayload) {
    throw new Error('❌ Phase 21 Failed: Encrypted packet has incomplete blocks.');
  }

  // 3. Bob decapsulates the hybrid keys and decrypts the AES-GCM envelope using his private key bundle
  console.log('🔓 Bob decrypting message using Bob\'s private key bundle...');
  const decryptedBuf = LatticeMessaging.decryptPeerMessage(packet, bobKeys.privateKey);
  const decryptedText = decryptedBuf.toString('utf8');

  console.log(`💬 Decrypted message: "${decryptedText}"`);
  if (decryptedText !== secretPayload) {
    throw new Error('❌ Phase 21 Failed: Decrypted text does not match the original secret payload.');
  }

  console.log('✅ Success: Lattice E2EE message encryption & decryption roundtrip perfectly verified with flawless parity!');

  // Cleanup P2P connections
  await aliceP2P.stop();
  await bobP2P.stop();

  console.log('\n========================================================================');
  console.log('🎉 ALL THREE PHASES VERIFIED SUCCESSFULLY (100% CORRECTNESS)');
  console.log('========================================================================');
}

runSovereignPhasesTest().catch(err => {
  console.error('\n❌ TEST SUITE RUN ENCOUNTERED CRITICAL ERROR:', err);
  process.exit(1);
});
