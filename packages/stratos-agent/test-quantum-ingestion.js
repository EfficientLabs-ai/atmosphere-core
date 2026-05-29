import { translateLegacyScript } from './src/ingestion/claw-translator.js';
import {
  generateHybridKeyPair,
  encapsulateHybridSecret,
  decapsulateHybridSecret,
  signPayload,
  verifyPayload
} from './src/security/quantum-crypto.js';

console.log('🧪 Starting StratosAgent E2E Verification Harness (Phase 5)...');
console.log('==================================================================');

// 1. Define high-fidelity mock legacy script workflow (OpenClaw / Playwright DSL)
const mockLegacyScript = `
  // OpenClaw Legacy Integration Script
  page.goto("https://efficientlabs.ai/login");
  page.type("#username", "founding-member");
  page.type("#password", "quantum-safe-mesh-2026");
  page.click("button[type='submit']");
  page.waitForSelector(".dashboard-view");

  /* Multi-line transition DFA blocks */
  state("login-screen", { on: "load", goto: "authentication" });
  state("authentication", { on: "click", target: "button[type='submit']", goto: "dashboard" });
`;

console.log('📡 [Step 1] Ingesting legacy OpenClaw script...');
console.log('--------------------------------------------------');
console.log(mockLegacyScript.trim());
console.log('--------------------------------------------------');

// 2. Translate the legacy script safely into JSON via AST syntax compiler
console.log('⚡ [Step 2] Executing AST lexical translation (claw-translator.js)...');
const workflowJson = translateLegacyScript(mockLegacyScript);

console.log('✅ AST Translation Complete! Sanitized Workflow Manifest:');
console.log(JSON.stringify(workflowJson, null, 2));
console.log('--------------------------------------------------');

// 3. Generate sovereign hybrid classical-post-quantum keyring keypairs
console.log('🔑 [Step 3] Generating Hybrid Classical-Post-Quantum Keypairs...');
const { publicKey, privateKey } = generateHybridKeyPair();

console.log('✅ Quantum-Hardened Keypair generated successfully!');
console.log(`🔒 X25519 Classical Pub Key DER Length: ${publicKey.x25519Der.length} bytes`);
console.log(`🔒 Ed25519 Signature Pub Key DER Length: ${publicKey.ed25519Der.length} bytes`);
console.log(`🔒 ML-KEM-768 Post-Quantum Pub Key DER Length: ${publicKey.mlkemDer.length} bytes`);
console.log(`🔒 ML-DSA-65 Post-Quantum Pub Key DER Length: ${publicKey.mldsaDer.length} bytes`);
console.log('--------------------------------------------------');

// 4. Test hybrid key exchange (X25519 + FIPS 203 ML-KEM-768)
console.log('📡 [Step 4] Simulating Hybrid Key Encapsulation (Bob -> Alice)...');
const { ciphertext, bobX25519PubDer, hybridSecret: bobSecret } = encapsulateHybridSecret(publicKey);
console.log('✅ Secret encapsulated successfully.');
console.log(`📦 ML-KEM-768 Ciphertext Length: ${ciphertext.length} bytes`);
console.log(`📦 Ephemeral X25519 Pub Key DER Length: ${bobX25519PubDer.length} bytes`);
console.log(`🔑 Bob's Derived Hybrid Secret (hex): ${bobSecret.toString('hex')}`);

console.log('\n📡 [Step 5] Simulating Hybrid Key Decapsulation (Alice)...');
const aliceSecret = decapsulateHybridSecret(privateKey, bobX25519PubDer, ciphertext);
console.log(`🔑 Alice's Decapsulated Hybrid Secret (hex): ${aliceSecret.toString('hex')}`);

const keyExchangeMatched = bobSecret.equals(aliceSecret);
console.log(`🏆 Hybrid Key Agreement Verification: ${keyExchangeMatched ? '✅ MATCHED!' : '❌ MATCH FAILED'}`);
console.log('--------------------------------------------------');

// 5. Sign the sanitized JSON workflow using hybrid signature scheme (Ed25519 + FIPS 204 ML-DSA-65)
console.log('✍️ [Step 6] Signing workflow manifest with hybrid quantum signature...');
const payloadString = JSON.stringify(workflowJson);
const signatureBundle = signPayload(payloadString, privateKey);

console.log('✅ Hybrid signature generated!');
console.log(`🖊️ Ed25519 Signature Length: ${signatureBundle.ed25519Sig.length} bytes`);
console.log(`🖊️ ML-DSA-65 Post-Quantum Signature Length: ${signatureBundle.mldsaSig.length} bytes`);
console.log('--------------------------------------------------');

// 6. Cryptographically verify the hybrid signed payload
console.log('🎯 [Step 7] Verifying signed workflow payload mathematical integrity...');
const isSignatureValid = verifyPayload(payloadString, signatureBundle, publicKey);

console.log(`🏆 Hybrid Post-Quantum Signature Verification: ${isSignatureValid ? '✅ VERIFIED!' : '❌ VALIDATION FAILED'}`);
console.log('==================================================================');

if (keyExchangeMatched && isSignatureValid && workflowJson.steps.length === 5 && workflowJson.stateTransitions.length === 2) {
  console.log('🎉 PHASE 5 SOVEREIGN PQC & AST TRANSLATOR FULLY SECURED!');
  process.exit(0);
} else {
  console.error('❌ Validation pipeline mismatch or missing elements.');
  process.exit(1);
}
