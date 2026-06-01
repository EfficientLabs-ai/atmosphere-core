/**
 * P2P skill-sync ingest gate (Gap 7/#39). Before this, getSynchronizedSkills() returned peer skill
 * blocks WITHOUT verifying their seal — a node could ingest + run a skill from an unauthenticated peer.
 * Now every block passes through verifyBlock(): self-authored OR a hybrid seal that verifies under a
 * PINNED origin. Forged / untrusted / tampered blocks are dropped (fail-closed).
 *
 * Constructs P2pSkillSync WITHOUT init() (no swarm/network) and drives the pure gate directly.
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { P2pSkillSync } from './src/memory/p2p-skill-sync.js';
import { sealSkillBlock } from './src/memory/skill-seal.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const wasmHash = crypto.createHash('sha256').update('real-wasm').digest('hex');
const A = generateHybridKeyPair(); // a trusted origin (pinned)
const B = generateHybridKeyPair(); // an untrusted / attacker origin

const sync = new P2pSkillSync({ storagePath: './.tmp-test', trustedOrigins: [A.publicKey], verbose: false });

console.log('=== a block sealed by the PINNED origin is accepted ===');
const good = sealSkillBlock({ skillId: 'summarize.v1', wasmHash, metadata: { risk: 'low' } }, A);
ok(sync.verifyBlock(good).ok === true, "a block sealed by pinned origin A → accepted");

console.log('\n=== forged / untrusted / tampered blocks are DROPPED (fail-closed) ===');
const fromB = sealSkillBlock({ skillId: 'summarize.v1', wasmHash, metadata: { risk: 'low' } }, B);
ok(sync.verifyBlock(fromB).ok === false, "a block sealed by UNTRUSTED origin B → dropped");
const tamperedHash = wasmHash.slice(0, -1) + (wasmHash.endsWith('a') ? 'b' : 'a'); // always differs
ok(sync.verifyBlock({ ...good, wasmHash: tamperedHash }).ok === false, "tampered wasmHash (swapped WASM) → dropped");
ok(sync.verifyBlock({ skillId: 'x', wasmHash, signatureSeal: null }).ok === false, "no seal → dropped");
ok(sync.verifyBlock(null).ok === false, "empty block → dropped");

console.log('\n=== self-authored local blocks are trusted (the node made them) ===');
ok(sync.verifyBlock({ skillId: 'mine.v1', wasmHash, local: true }).ok === true, "local:true → trusted without an external seal");

console.log('\n=== filterVerifiedSkills + getSynchronizedSkills drop the bad, keep the good ===');
const mixed = [good, fromB, { skillId: 'mine.v1', wasmHash, local: true }];
const kept = sync.filterVerifiedSkills(mixed);
ok(kept.length === 2 && kept.includes(good) && !kept.includes(fromB), "filter keeps pinned + local, drops the untrusted block");
sync.base = {}; sync.skillsLedger = mixed; // simulate a populated ledger without init()
const synced = await sync.getSynchronizedSkills();
ok(synced.length === 2 && !synced.some((b) => b === fromB), "getSynchronizedSkills never returns the unauthenticated peer block");

console.log('\n=== with NO origins pinned, remote blocks are refused (deny-by-default) ===');
const empty = new P2pSkillSync({ trustedOrigins: [], verbose: false });
ok(empty.verifyBlock(good).ok === false, "no pinned origins → even a validly-sealed remote block is refused");
ok(empty.verifyBlock({ skillId: 'mine', wasmHash, local: true }).ok === true, "...but the node still trusts its OWN local skills");

console.log(`\n✅ ALL ${pass} p2p-skill-ingest checks passed.`);
