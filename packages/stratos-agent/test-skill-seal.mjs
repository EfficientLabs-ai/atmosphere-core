/**
 * skill-seal tests: a remote skill is trusted ONLY if its hybrid seal verifies under the pinned origin
 * key. Fail-closed against tampered wasmHash/metadata/skillId, forged signer, wrong pinned key, malformed.
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { sealSkillBlock, verifySkillBlock, originId } from './src/memory/skill-seal.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const wasmHash = crypto.createHash('sha256').update('fake-wasm-bytes').digest('hex');

const A = generateHybridKeyPair(); // origin node
const B = generateHybridKeyPair(); // an attacker / different node

console.log('=== a sealed block verifies under the pinned origin key ===');
const block = sealSkillBlock({ skillId: 'summarize.v1', wasmHash, metadata: { author: 'A', risk: 'low' } }, A);
ok(block.origin === originId(A.publicKey) && !!block.signatureSeal, 'block carries its origin id + hybrid seal');
ok(verifySkillBlock(block, A.publicKey).ok === true, "B pins A's key → A's block verifies");

console.log('\n=== fail-closed: tamper any signed field ===');
ok(verifySkillBlock({ ...block, wasmHash: wasmHash.replace(/.$/, '0') }, A.publicKey).ok === false, 'swapping the wasmHash (different WASM) → rejected');
ok(verifySkillBlock({ ...block, skillId: 'malware.v1' }, A.publicKey).ok === false, 'renaming the skill → rejected');
ok(verifySkillBlock({ ...block, metadata: { author: 'A', risk: 'low', backdoor: true } }, A.publicKey).ok === false, 'editing metadata → rejected');

console.log('\n=== fail-closed: wrong / forged signer ===');
ok(verifySkillBlock(block, B.publicKey).ok === false, "pinning the WRONG origin key (B) → rejected (origin mismatch)");
// attacker re-seals the same content with their OWN keys but tries to keep A's origin label
const forged = { ...sealSkillBlock({ skillId: 'summarize.v1', wasmHash, metadata: { author: 'A', risk: 'low' } }, B), origin: block.origin };
ok(verifySkillBlock(forged, A.publicKey).ok === false, "attacker forging A's origin label with B's seal → rejected");

console.log('\n=== malformed inputs fail closed ===');
ok(verifySkillBlock(null, A.publicKey).ok === false, 'null block → rejected');
ok(verifySkillBlock(block, { ed25519Der: Buffer.alloc(2) }).ok === false, 'bogus pinned key → rejected');
ok(verifySkillBlock({ ...block, signatureSeal: { ed25519Sig: '%%', mldsaSig: '%%' } }, A.publicKey).ok === false, 'garbage seal → rejected');

console.log(`\n✅ ALL ${pass} skill-seal checks passed.`);
