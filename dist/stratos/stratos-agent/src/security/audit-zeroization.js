import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { decryptSeed } from './vault-host.js';
import { pbkdf2Sync, createCipheriv, randomBytes } from 'node:crypto';

console.log('🛡️ Starting Zero-Trust Cryptographic Memory Auditing Suite...');
console.log('================================================================');

async function runMemoryAudit() {
  let hasFailed = false;

  try {
    // Test 1: Validate String Input Rejection (Type Check Defense)
    console.log('🔒 [Test 1] Testing String Input Rejection (Type Check)...');
    const mockEncryptedData = Buffer.alloc(60, 0x11);
    const mockSalt = Buffer.alloc(16, 0x22);
    
    try {
      decryptSeed(mockEncryptedData, 'immutable_string_passcode_123', mockSalt);
      console.error('❌ Security Failure: decryptSeed accepted a standard string passcode!');
      hasFailed = true;
    } catch (err) {
      if (err instanceof TypeError && err.message.includes('immutable leakage')) {
        console.log('✅ Success: String passcode input was strictly blocked with TypeError.');
      } else {
        console.error('❌ Unexpected error on string input:', err.message);
        hasFailed = true;
      }
    }
    console.log('----------------------------------------------------------------');

    // Test 2: Validate Buffer Zeroization behavior
    console.log('🔒 [Test 2] Testing Buffer zero-fill erasure logic...');
    
    // Dynamically build a highly unique passcode to prevent hardcoded source indexing
    // The bytes below correspond to a specific high-entropy security token
    const passcodeBytes = [83, 117, 112, 101, 114, 83, 101, 99, 114, 101, 116, 95, 80, 97, 115, 115, 95, 57, 57, 56, 56];
    const passcodeBuf = Buffer.from(passcodeBytes);
    const passcodeCopy = Buffer.from(passcodeBuf);
    
    const testSeed = Buffer.alloc(32, 0xAA);
    const testSalt = Buffer.alloc(16, 0x77);
    
    // Encrypt the seed using the passcode copy
    const derivedKey = pbkdf2Sync(passcodeCopy, testSalt, 100000, 32, 'sha256');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
    const ciphertext = Buffer.concat([cipher.update(testSeed), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encryptedPayload = Buffer.concat([iv, tag, ciphertext]);
    
    // Clean up temporary variables
    passcodeCopy.fill(0);
    derivedKey.fill(0);

    // Call decryptSeed using the original passcodeBuf
    console.log('   - Running decryptSeed...');
    const decrypted = decryptSeed(encryptedPayload, passcodeBuf, testSalt);

    // Verify passcode buffer is zeroed
    const isPasscodeZeroed = passcodeBuf.every(b => b === 0);
    console.log(`   - Input passcode buffer zeroed out: ${isPasscodeZeroed ? '✅ YES' : '❌ NO'}`);
    if (!isPasscodeZeroed) {
      console.error('❌ Security Failure: Input passcode buffer was NOT zeroed out!');
      hasFailed = true;
    }

    // Verify decrypted seed was returned correctly
    const isSeedCorrect = decrypted.equals(testSeed);
    console.log(`   - Plaintext seed retrieved correctly: ${isSeedCorrect ? '✅ YES' : '❌ NO'}`);
    
    // Explicitly clean up decrypted buffer
    decrypted.fill(0);
    
    if (!isPasscodeZeroed || !isSeedCorrect) {
      hasFailed = true;
    }
    console.log('----------------------------------------------------------------');

    // Test 3: Live V8 Heap Snapshot String table Scan
    console.log('🔒 [Test 3] Triggering live V8 Heap Snapshot leak sweep...');
    
    // Force garbage collection to sweep temporary references
    if (global.gc) {
      console.log('   - Forcing synchronous garbage collection...');
      global.gc();
      global.gc();
    } else {
      console.warn('⚠️  [Warning] Node.js not run with --expose-gc. Skipping synchronous garbage collection.');
    }

    // Capture the heap snapshot stream programmatically
    console.log('   - Capturing live V8 heap snapshot stream...');
    const snapshotStream = v8.getHeapSnapshot();
    
    // Pipe the snapshot stream chunks into a large buffer
    const chunks = [];
    for await (const chunk of snapshotStream) {
      chunks.push(Buffer.from(chunk));
    }
    const snapshotText = Buffer.concat(chunks).toString('utf8');
    
    // Check if the unique passcode search string exists in the heap snapshot text
    // Build the leak search token dynamically from character codes so it is NEVER present in compiled script text
    const leakSearchToken = String.fromCharCode(...passcodeBytes);
    const leakFound = snapshotText.includes(leakSearchToken);
    
    console.log(`   - Scan results: Unique Passcode Token leaked: ${leakFound ? '❌ YES (Security Breach!)' : '✅ NO (Protected!)'}`);
    
    if (leakFound) {
      console.error('❌ Security Failure: Passcode was found leaked in the V8 heap snapshot string table!');
      hasFailed = true;
    } else {
      console.log('🎉 Memory zeroization verify check completed successfully!');
    }
    console.log('================================================================');

    if (hasFailed) {
      process.exit(1);
    } else {
      process.exit(0);
    }

  } catch (err) {
    console.error('❌ Memory audit exception:', err);
    process.exit(1);
  }
}

runMemoryAudit();
