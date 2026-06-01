#!/usr/bin/env node
/**
 * demo-skill-sync.mjs — the federated skill-sync moat, made visible (Task #14, launch asset).
 *
 * Node A learns a skill, SEALS it with its hybrid post-quantum identity, and broadcasts it. Node B,
 * which has PINNED A's origin key, verifies the seal before trusting it — and rejects a block an
 * attacker tampered with in transit. This exercises the REAL seal/verify path (skill-seal.js →
 * quantum-crypto.js, Ed25519 + ML-DSA-65).
 *
 * HONEST SCOPE: the "wire" here is an in-process channel, so the demo proves the cryptographic
 * accept/reject path deterministically without standing up a live DHT. The production transport is
 * p2p-skill-sync.js (Hyperswarm/Autobase); wiring verifySkillBlock() into its ingest is the follow-up.
 */
import crypto from 'node:crypto';
import { sealSkillBlock, verifySkillBlock } from '../packages/stratos-agent/src/memory/skill-seal.js';
import { generateHybridKeyPair } from '../packages/stratos-agent/src/security/quantum-crypto.js';

const log = (s = '') => process.stdout.write(s + '\n');
const wasmHashOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

log('\n🌐  THE ATMOSPHERE — federated skill-sync (sovereign, post-quantum)\n');

// --- Node A: learns a skill on its own hardware, seals it with its PQC identity ---------------------
const A = generateHybridKeyPair();
const skillWasm = Buffer.from('(module ;; compiled "summarize-thread" skill ;; )');
const learned = { skillId: 'summarize-thread.v1', wasmHash: wasmHashOf(skillWasm), metadata: { author: 'node-A', risk: 'low' } };
const sealed = sealSkillBlock(learned, A);
log(`🅰️  Node A learned a skill → "${learned.skillId}"`);
log(`    sealed with A's hybrid identity (Ed25519 + ML-DSA-65), origin ${sealed.origin}`);

// Node B has pinned A's origin key out-of-band (the trust anchor) ------------------------------------
const channel = []; // the "wire"
const Bpins = { 'node-A': A.publicKey };
const broadcast = (block) => channel.push(block);
broadcast(sealed);
log('📡  A broadcast the sealed skill onto the mesh.\n');

// --- Node B: verifies BEFORE trusting/running -------------------------------------------------------
function ingest(label, block) {
  const v = verifySkillBlock(block, Bpins['node-A']);
  if (v.ok) log(`✅  Node B ${label}: seal verified under pinned origin → SAFE to run "${v.skillId}"`);
  else log(`⛔  Node B ${label}: ${v.reason} → REJECTED (skill not run)`);
  return v.ok;
}

log('— honest peer —');
const okPath = ingest('received A\'s skill', channel[0]);

log('\n— malicious peer tampers the block in transit (swaps the WASM the hash points at) —');
const tampered = { ...sealed, wasmHash: wasmHashOf(Buffer.from('(module ;; BACKDOORED payload ;; )')) };
const badPath = ingest('received a tampered block', tampered);

log('\n— malicious peer forges A\'s origin label with its own key —');
const M = generateHybridKeyPair();
const forged = { ...sealSkillBlock(learned, M), origin: sealed.origin };
const forgedPath = ingest('received a forged-origin block', forged);

const allCorrect = okPath === true && badPath === false && forgedPath === false;
log(`\n${allCorrect ? '🎯  DEMO OK' : '❌  DEMO FAILED'} — honest skill verifies; tampered & forged are rejected.`);
log('    (in-process channel; live transport = p2p-skill-sync.js over Hyperswarm — verify-on-ingest is the wiring follow-up)\n');
process.exit(allCorrect ? 0 : 1);
