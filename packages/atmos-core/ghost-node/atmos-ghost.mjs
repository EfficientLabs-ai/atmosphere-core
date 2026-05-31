#!/usr/bin/env node
/**
 * Atmosphere Ghost Node — sovereign mesh peer.
 *
 * Joins the global Hyperswarm DHT on a shared topic via NAT hole-punching: it opens NO
 * listening port and exposes NO inbound internet surface — the DHT coordinates the punch.
 * It accepts and runs a compute skill ONLY if the skill's hybrid post-quantum seal
 * (ML-DSA-65 + Ed25519) verifies against the PINNED origin public key in config.json.
 * Unsigned, tampered, or wrong-origin skills are refused and never executed.
 *
 * Zero-config: reads config.json (topic + pinned origin key) sitting next to this file.
 *   atmos-ghost.cmd            -> join the mesh and stand by for verified skills
 *   node atmos-ghost.mjs --input 21 --once   -> run one verified skill and exit (proof mode)
 */
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCustomSection, findCustomSectionRange } from './wasm-sections.js';
import { verifyPayload } from './quantum-crypto.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dir, 'config.json'), 'utf8'));

const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const ONCE = argv.includes('--once');
const INPUT = Number(getArg('input', cfg.defaultInput ?? 9));
const TOPIC_NAME = getArg('topic', cfg.topic);

import crypto from 'node:crypto';
const topicKey = crypto.createHash('sha256').update(TOPIC_NAME).digest();

// Pinned origin public key (Der buffers) — the cryptographic trust anchor.
const decB = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, b4a.from(v, 'base64')]));
const pinnedPub = decB(typeof cfg.pinnedPubKey === 'string'
  ? JSON.parse(b4a.toString(b4a.from(cfg.pinnedPubKey, 'base64'), 'utf8'))
  : cfg.pinnedPubKey);

function frameReader(onFrame) {
  let acc = Buffer.alloc(0), need = -1;
  return (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    while (true) {
      if (need < 0) { if (acc.length < 4) return; need = acc.readUInt32BE(0); acc = acc.subarray(4); }
      if (acc.length < need) return;
      const frame = acc.subarray(0, need); acc = acc.subarray(need); need = -1;
      onFrame(frame);
    }
  };
}

function verifySignedSkill(wasm) {
  if (!parseCustomSection(wasm, 'stratos.gsi.pathway')) return false;
  const sigRange = findCustomSectionRange(wasm, 'stratos.gsi.signature');
  if (!sigRange) return false;
  const signedRegion = wasm.subarray(0, sigRange.sectionStart);
  const sig = JSON.parse(sigRange.payload.toString('utf8'));
  const signatureBundle = {
    ed25519Sig: Buffer.from(sig.ed25519Sig, 'base64'),
    mldsaSig: Buffer.from(sig.mldsaSig, 'base64')
  };
  return verifyPayload(signedRegion, signatureBundle, pinnedPub);
}

console.log('👻 Atmosphere Ghost Node starting…');
console.log(`   node id  : ${cfg.nodeLabel || 'ghost'}`);
console.log(`   topic    : ${TOPIC_NAME}`);
console.log('   transport: public Hyperswarm DHT, NAT hole-punch, no open ports');

const swarm = new Hyperswarm();
let executed = 0;
const stop = (code) => swarm.destroy().finally(() => process.exit(code));

swarm.on('connection', (socket, info) => {
  const peer = b4a.toString(info.publicKey, 'hex').slice(0, 16);
  console.log(`🤝 connected to origin peer ${peer}… — awaiting signed skill`);
  socket.on('error', () => {});
  socket.on('data', frameReader((wasm) => {
    if (!verifySignedSkill(wasm)) {
      console.log('⛔ REJECTED: PQC seal invalid / wrong origin — NOT executing.');
      if (ONCE) stop(1);
      return;
    }
    console.log(`✅ VERIFIED: ML-DSA-65 + Ed25519 seal valid (${wasm.length} B from the pinned origin).`);
    WebAssembly.instantiate(wasm).then(({ instance }) => {
      const result = instance.exports.compute(INPUT | 0);
      executed++;
      console.log(`⚡ executed verified skill: compute(${INPUT}) = ${result}`);
      console.log('🎉 This device is now a live, verified node on the Atmosphere mesh.');
      if (ONCE) stop(0);
    }).catch((e) => { console.log('❌ execution failed:', e.message); if (ONCE) stop(1); });
  }));
});

swarm.join(topicKey, { server: true, client: true });
swarm.flush().then(() => console.log('🌐 announced on the DHT — searching for the origin node…'));

if (ONCE) setTimeout(() => { if (!executed) { console.log('⌛ no origin peer found (is the broadcaster up on this topic?).'); stop(3); } }, 90_000);
process.on('SIGINT', () => { console.log('\n👻 ghost node leaving the mesh.'); stop(0); });
