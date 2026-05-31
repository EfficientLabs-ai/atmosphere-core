import fs from 'node:fs';
import path from 'node:path';
import { GsiCompiler, parseCustomSection } from './gsi-compiler.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { initializeMemorySchema, insertCognitiveSkill } from './src/memory/vector-bank.js';

console.log('🧪 Starting StratosAgent overnight GSI compilation E2E Harness (Phase 7)...');
console.log('========================================================================');

async function runTest() {
  try {
    // 1. Initialize DB and insert a successful logic graph pathway (success_rate = 1.0)
    console.log('📦 [Step 1] Initializing databases and inserting successful workflow trace...');
    await initializeMemorySchema();

    const mockLogicGraph = {
      engine: 'StratosAgent-1.0',
      description: 'AWS billing summary collection script',
      steps: [
        { type: 'goto', url: 'https://console.aws.amazon.com/billing' },
        { type: 'click', target: '#download-pdf-invoice' },
        { type: 'wait', target: '.invoice-success-indicator' }
      ],
      stateTransitions: [
        { state: 'initial', on: 'load', goto: 'download' },
        { state: 'download', on: 'click', target: '#download-pdf-invoice', goto: 'complete' }
      ]
    };

    const skillId = `aws-billing-summary-${Date.now()}`;
    await insertCognitiveSkill({
      skillId,
      triggerIntent: 'Fetch AWS billing summary and monetary dates',
      astGraph: mockLogicGraph,
      successRate: 1.0 // Evaluator threshold trigger
    });
    console.log(`✅ Success trace for skill "${skillId}" inserted in LanceDB!`);
    console.log('------------------------------------------------------------------------');

    // 2. Generate hybrid keypair
    console.log('🔑 [Step 2] Generating sovereign node keys (X25519/Ed25519 + ML-KEM/ML-DSA)...');
    const { publicKey, privateKey } = generateHybridKeyPair();
    console.log('✅ Post-Quantum State Key pair generated.');
    console.log('------------------------------------------------------------------------');

    // 3. Instantiate GsiCompiler and execute database compilation
    console.log('🌙 [Step 3] Initializing GsiCompiler Night Shift simulation...');
    const compiler = new GsiCompiler({
      distSkillsDir: './dist/skills' // Output locally inside agent workspace for test execution
    });

    console.log('⚙️  [Step 4] Executing compileFromDatabase()...');
    const result = await compiler.compileFromDatabase(privateKey);

    if (!result || !Array.isArray(result.compiled) || result.compiled.length === 0) {
      throw new Error('No files were compiled by GsiCompiler.');
    }
    const targetWasmFile = result.compiled[0].file;
    console.log(`✅ Skill successfully compiled and PQC sealed: ${targetWasmFile}`);
    console.log('------------------------------------------------------------------------');

    // 4. Verify the compiled WebAssembly binary
    console.log('🎯 [Step 5] Reading and verifying compiled WASM skill binary...');
    const wasmBinary = fs.readFileSync(targetWasmFile);

    // Verify magic headers
    const magic = wasmBinary.subarray(0, 4).toString('hex');
    const version = wasmBinary.subarray(4, 8).toString('hex');
    console.log(`🔍 Wasm Binary Magic Header: \\0asm (${magic}) | Version: ${version}`);

    // Parse and verify custom section payloads
    console.log('🔍 Parsing WebAssembly custom sections natively...');
    const parsedPathway = parseCustomSection(wasmBinary, 'stratos.gsi.pathway');
    const parsedSig = parseCustomSection(wasmBinary, 'stratos.gsi.signature');

    console.log(`  - "stratos.gsi.pathway" custom section payload size: ${parsedPathway.length} bytes`);
    console.log(`  - "stratos.gsi.signature" custom section payload size: ${parsedSig.length} bytes`);

    console.log('\n🎯 [Step 6] Running GsiCompiler.verifyWasmSkill()...');
    const isAuthentic = GsiCompiler.verifyWasmSkill(wasmBinary, publicKey);

    console.log(`🏆 Cryptographic Signature Seal Authenticity Check: ${isAuthentic ? '✅ VERIFIED!' : '❌ REJECTED!'}`);
    console.log('========================================================================');

    // Cleanup generated skill test files
    if (fs.existsSync(targetWasmFile)) {
      fs.unlinkSync(targetWasmFile);
    }

    if (isAuthentic) {
      console.log('🎉 PHASE 7 DECENTRALIZED GSI COMPILER CORE FULLY IMMUTABLE & VERIFIED!');
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Critical Verification Error:', err);
    process.exit(1);
  }
}

runTest();
