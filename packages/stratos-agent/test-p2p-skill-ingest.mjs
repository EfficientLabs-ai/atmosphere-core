/**
 * P2P skill-sync ingest gate (Gap 7/#39). Before this, getSynchronizedSkills() returned peer skill
 * blocks WITHOUT verifying their seal — a node could ingest + run a skill from an unauthenticated peer.
 *
 * Trust model (after Codex review of #46): self-authorship is established by PROVENANCE (the block came
 * from this node's own core — the CALLER passes selfAuthored:true), NEVER by an in-band field a peer
 * could forge. A REMOTE block is trusted only if its hybrid Ed25519+ML-DSA seal verifies under a PINNED
 * origin. The critical regression here is the spoof: a remote block that sets local:true must STILL drop.
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

console.log('=== a REMOTE block sealed by the PINNED origin is accepted ===');
const good = sealSkillBlock({ skillId: 'summarize.v1', wasmHash, metadata: { risk: 'low' } }, A);
ok(sync.verifyBlock(good).ok === true, 'a block sealed by pinned origin A → verifies');

console.log('\n=== forged / untrusted / tampered REMOTE blocks are DROPPED (fail-closed) ===');
const fromB = sealSkillBlock({ skillId: 'summarize.v1', wasmHash, metadata: { risk: 'low' } }, B);
ok(sync.verifyBlock(fromB).ok === false, 'a block sealed by UNTRUSTED origin B → dropped');
const tamperedHash = wasmHash.slice(0, -1) + (wasmHash.endsWith('a') ? 'b' : 'a');
ok(sync.verifyBlock({ ...good, wasmHash: tamperedHash }).ok === false, 'tampered wasmHash (swapped WASM) → dropped');
ok(sync.verifyBlock({ skillId: 'x', wasmHash, signatureSeal: null }).ok === false, 'no seal → dropped (malformed)');
ok(sync.verifyBlock(null).ok === false, 'empty block → dropped');

console.log('\n=== THE SPOOF (Codex #46): in-band local:true must be INERT — isolate it as the only variable ===');
// fromB is a REAL, validly-sealed block (by untrusted origin B) — dropped purely because B is not pinned.
// Adding local:true is the ONLY change; if local:true granted trust (the old bug) this block would pass.
// It must drop IDENTICALLY, proving local:true is inert — not a tautology of an otherwise-broken block.
const fromBNoLocal = sync.verifyBlock(fromB).ok;                       // false (untrusted origin)
const fromBWithLocal = sync.verifyBlock({ ...fromB, local: true }).ok; // must ALSO be false
ok(fromBNoLocal === false && fromBWithLocal === false, 'a validly-sealed-but-untrusted block drops the SAME with/without local:true (the flag changes nothing)');
ok(sync.filterVerifiedSkills([{ ...fromB, local: true }], { selfAuthored: false }).length === 0, 'as a REMOTE block, {...validSeal-by-B, local:true} is still dropped — local:true grants no trust');
const spoof = { skillId: 'evil.v1', wasmHash, signatureSeal: { ed25519Sig: 'AA', mldsaSig: 'AA' }, local: true, origin: 'did:atmos:whatever' };
ok(sync.verifyBlock(spoof).ok === false, 'an unsealed forgery with local:true is also rejected');
ok(sync.filterVerifiedSkills([spoof], { selfAuthored: false }).length === 0, 'as a REMOTE block, the local:true forgery is dropped');

console.log('\n=== provenance: self-authored (own core) blocks are trusted by SOURCE, not by content ===');
const selfBlock = { skillId: 'mine.v1', wasmHash, signatureSeal: 'plain-sig-from-writer' };
ok(sync.filterVerifiedSkills([selfBlock], { selfAuthored: true }).length === 1, 'a block from our OWN core is kept (provenance trust, no seal needed)');
ok(sync.filterVerifiedSkills([selfBlock], { selfAuthored: false }).length === 0, 'the SAME block treated as remote (no valid seal) is dropped — trust is the source, not the block');

console.log('\n=== filter + getSynchronizedSkills (own ledger = self-authored) ===');
ok(sync.filterVerifiedSkills([good, fromB], { selfAuthored: false }).length === 1, 'remote set: keeps pinned-A, drops untrusted-B');
sync.base = {}; sync.skillsLedger = [good, fromB, selfBlock]; // own ledger → all self-authored by provenance
const synced = await sync.getSynchronizedSkills();
ok(synced.length === 3, 'getSynchronizedSkills returns our OWN ledger (self-authored) intact');

console.log('\n=== with NO origins pinned, REMOTE blocks are refused (deny-by-default) ===');
const empty = new P2pSkillSync({ trustedOrigins: [], verbose: false });
ok(empty.verifyBlock(good).ok === false, 'no pinned origins → even a validly-sealed remote block is refused');
ok(empty.filterVerifiedSkills([good, spoof], { selfAuthored: false }).length === 0, 'no pinned origins → all remote blocks (incl. the spoof) dropped');

console.log(`\n✅ ALL ${pass} p2p-skill-ingest checks passed.`);
