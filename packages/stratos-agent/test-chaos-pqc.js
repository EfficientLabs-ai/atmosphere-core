import fs from 'node:fs';
import path from 'node:path';
import { GsiCompiler } from './gsi-compiler.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';

console.log('⚡ Running PQC Security Breach Stress Test (WASM Tamper Test)...');
console.log('===================================================================');

async function runPqcChaosTest() {
  const tmpDir = path.join(process.cwd(), 'tmp-pqc-stress');
  const quarantineDir = path.join(tmpDir, 'quarantine');

  try {
    // 1. Initialize directories
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    if (!fs.existsSync(quarantineDir)) fs.mkdirSync(quarantineDir);

    // 2. Generate secure post-quantum sovereign keys
    console.log('🔑 [Step 1] Initializing secure post-quantum Ed25519 + ML-DSA keypair...');
    const { publicKey, privateKey } = generateHybridKeyPair();

    // 3. Compile a valid, signed WASM skill
    console.log('⚙️  [Step 2] Compiling and cryptographically sealing a valid WASM skill...');
    const mockWorkflow = {
      engine: 'StratosAgent-1.0',
      description: 'Sovereign database indexing script',
      steps: [
        { type: 'database_scan', database: 'vector_bank' }
      ]
    };

    const compiler = new GsiCompiler({ distSkillsDir: tmpDir });
    const wasmBinary = await compiler.compile(mockWorkflow, privateKey);
    
    const validWasmPath = path.join(tmpDir, 'skill_valid_secure.wasm');
    fs.writeFileSync(validWasmPath, wasmBinary);
    console.log(`✅ Signed skill saved: ${path.basename(validWasmPath)} (${wasmBinary.length} bytes)`);

    // Verify initial authenticity
    console.log('🎯 [Step 3] Running GsiCompiler.verifyWasmSkill() on original module...');
    const isOriginalValid = GsiCompiler.verifyWasmSkill(wasmBinary, publicKey);
    console.log(`   - Authenticity Status: ${isOriginalValid ? '✅ SECURE & VERIFIED' : '❌ CORRUPTED'}`);
    
    if (!isOriginalValid) {
      throw new Error('Original WASM file verification failed before tampering.');
    }
    console.log('-------------------------------------------------------------------');

    // 4. Artificially tamper with one single byte in the signed Wasm binary
    console.log('💥 [Step 4] Artificially altering one single byte of the binary payload (tamper)...');
    
    const tamperedBinary = Buffer.from(wasmBinary);
    
    // We target a byte in the middle of the "stratos.gsi.pathway" payload section
    // Let's find an index inside the Wasm buffer that isn't the magic header (e.g. index 25)
    const targetTamperIndex = 25;
    const originalByteValue = tamperedBinary[targetTamperIndex];
    
    // Flip a bit to alter the content
    tamperedBinary[targetTamperIndex] = originalByteValue ^ 0xFF;
    
    console.log(`   - Altered byte at index: ${targetTamperIndex} | ${originalByteValue.toString(16)} -> ${tamperedBinary[targetTamperIndex].toString(16)}`);

    const tamperedWasmPath = path.join(tmpDir, 'skill_malicious_tampered.wasm');
    fs.writeFileSync(tamperedWasmPath, tamperedBinary);
    console.log(`✅ Tampered malicious skill saved: ${path.basename(tamperedWasmPath)}`);
    console.log('-------------------------------------------------------------------');

    // 5. Run verification engine and assert mismatch detection
    console.log('🎯 [Step 5] Running verification scanner on the tampered module...');
    const isTamperedValid = GsiCompiler.verifyWasmSkill(tamperedBinary, publicKey);
    console.log(`   - Authenticity Status: ${isTamperedValid ? '❌ WEAKNESS DETECTED: TAMPER SUCCESSFUL' : '✅ THREAT DETECTED: ML-DSA-65 SEAL BREACHED'}`);

    if (isTamperedValid) {
      throw new Error('❌ Security Failure: The signature verification engine failed to detect the binary tamper.');
    }
    console.log('-------------------------------------------------------------------');

    // 6. Execute instant Quarantine protocols
    console.log('🛡️  [Step 6] Activating sovereign quarantine containment protocol...');
    
    if (!isTamperedValid) {
      console.warn('⚠️  [SECURITY BREACH] Malicious binary modification detected!');
      const quarantinedPath = path.join(quarantineDir, path.basename(tamperedWasmPath));
      
      // Instantly move tampered file to quarantine storage
      fs.renameSync(tamperedWasmPath, quarantinedPath);
      console.log(`✅ Isolated: Moved tampered file to quarantine bucket: ${quarantinedPath}`);
    }

    console.log('\n🏆 Security Chaos Audit Results:');
    console.log('   - Verified untampered files:       100% PASS');
    console.log('   - Detected visual byte modifications: 100% SUCCESS');
    console.log('   - Quarantine containment:          ACTIVE');

    console.log('\n🎉 PQC SECURITY BREACH CHAOS TEST PASSED! VERIFICATION DISALLOWED THE ATTACK.');
    cleanup(tmpDir);
    setTimeout(() => process.exit(0), 100);

  } catch (err) {
    console.error('❌ PQC Chaos Test Failed:', err);
    cleanup(tmpDir);
    setTimeout(() => process.exit(1), 100);
  }
}

function cleanup(tmpDir) {
  console.log('\n🧹 Cleaning temporary security stress files...');
  try {
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        const filePath = path.join(tmpDir, file);
        if (fs.statSync(filePath).isDirectory()) {
          const subFiles = fs.readdirSync(filePath);
          for (const sf of subFiles) fs.unlinkSync(path.join(filePath, sf));
          fs.rmdirSync(filePath);
        } else {
          fs.unlinkSync(filePath);
        }
      }
      fs.rmdirSync(tmpDir);
    }
  } catch (e) {
    console.warn('⚠️ Cleanup warning:', e.message);
  }
}

runPqcChaosTest();
