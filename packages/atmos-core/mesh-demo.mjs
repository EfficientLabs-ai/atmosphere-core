#!/usr/bin/env node
/**
 * mesh-demo.mjs — REAL cross-machine proof for the Atmosphere global mesh.
 *
 * Architecture (locked 2026-05-31): public Hyperswarm DHT + NAT hole-punching, no firewall
 * change. Nodes find each other on a shared topic and connect peer-to-peer via the global
 * decentralized DHT — no node opens a listening port; the DHT coordinates a hole-punch.
 * Trust is cryptographic, not perimeter-based: a joiner accepts a skill ONLY if its hybrid
 * PQC seal (ML-DSA-65 + Ed25519) verifies against the PINNED origin public key.
 *
 *   broadcast (VPS / origin)  — compile + PQC-sign a real wasm skill, join the topic, and
 *                               send the signed module to every peer that connects.
 *   join      (device / world)— join the same topic, receive the module, VERIFY the seal
 *                               against the pinned origin key, then really execute compute(x).
 *
 * The joiner deliberately imports only dependency-free section parsers + the verify routine
 * (no wabt/lancedb), so it stays light enough to run on any device with the repo.
 *
 * Usage:
 *   node mesh-demo.mjs broadcast [--topic NAME] [--a 3 --b 0]
 *   node mesh-demo.mjs join --topic NAME --pubkey <base64> [--input 9]
 */
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCustomSection, findCustomSectionRange } from '../stratos-agent/src/core/wasm-sections.js';
import { verifyPayload } from '../stratos-agent/src/security/quantum-crypto.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');
const NODE_KEYS = process.env.STRATOS_NODE_KEYS || path.join(ROOT, '.stratos-profile', 'node-keys.json');
const DEFAULT_TOPIC = 'atmosphere-genesis-mesh-v1';

// ---- arg parsing -------------------------------------------------------------------
const [, , mode, ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { args[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i]; }
}
const TOPIC_NAME = args.topic || DEFAULT_TOPIC;
const topicKey = crypto.createHash('sha256').update(TOPIC_NAME).digest(); // 32-byte DHT namespace

// ---- key bundle (de)serialization (base64 per field) -------------------------------
const encB = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, b4a.toString(b4a.from(v), 'base64')]));
const decB = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, b4a.from(v, 'base64')]));

// ---- length-framed messaging over the Noise duplex stream --------------------------
function sendFrame(socket, buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  socket.write(Buffer.concat([len, buf]));
}
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

// ---- the actual PQC skill verification (same logic as GsiCompiler.verifyWasmSkill, but
//      with only the light dependency-free parsers — safe for any device) -------------
function verifySignedSkill(wasm, publicKeyBundle) {
  if (!parseCustomSection(wasm, 'stratos.gsi.pathway')) return false;
  const sigRange = findCustomSectionRange(wasm, 'stratos.gsi.signature');
  if (!sigRange) return false;
  const signedRegion = wasm.subarray(0, sigRange.sectionStart); // code + manifest, exactly as signed
  const sig = JSON.parse(sigRange.payload.toString('utf8'));
  const signatureBundle = {
    ed25519Sig: Buffer.from(sig.ed25519Sig, 'base64'),
    mldsaSig: Buffer.from(sig.mldsaSig, 'base64')
  };
  return verifyPayload(signedRegion, signatureBundle, publicKeyBundle);
}

async function runBroadcast() {
  // 1. Load this node's signing identity (created by the self-evolution wiring).
  const { GsiCompiler } = await import('../stratos-agent/gsi-compiler.js');
  const { loadOrCreateNodeKeys } = await import('../stratos-agent/src/evolution/self-evolution.js');
  const keyBundle = loadOrCreateNodeKeys(NODE_KEYS);

  // 2. Compile a REAL signed wasm skill: y = a*x + b (default 3x). Full-module PQC seal.
  const a = Number(args.a ?? 3), b = Number(args.b ?? 0);
  const compiler = new GsiCompiler({ distSkillsDir: path.join(ROOT, 'packages', 'stratos-agent', 'dist', 'skills'), verbose: false });
  const manifest = { id: 'mesh_affine', kind: 'computational', triggerIntent: `apply ${a}x+${b}`, computation: { type: 'affine', a, b } };
  const wasm = await compiler.compile(manifest, keyBundle.privateKey);

  // 3. Publish the pinned public key + the exact device command (out-of-band trust anchor).
  const pinnedPub = JSON.stringify(encB(keyBundle.publicKey));
  const pinnedB64 = b4a.toString(b4a.from(pinnedPub), 'base64');
  console.log('📡 [BROADCAST] Atmosphere origin node — public Hyperswarm DHT (hole-punch, no open ports)');
  console.log(`   topic     : ${TOPIC_NAME}`);
  console.log(`   skill     : y = ${a}x + ${b}  (${wasm.length} B, ML-DSA-65 + Ed25519 sealed)`);
  console.log(`   self-verify: ${verifySignedSkill(wasm, keyBundle.publicKey) ? '✅' : '❌'}`);
  console.log('\n   ── Run THIS on your device (from the repo root) ──');
  console.log(`   node packages/atmos-core/mesh-demo.mjs join --topic ${TOPIC_NAME} --input 9 --pubkey ${pinnedB64}\n`);

  // 4. Join the global DHT, serve the signed skill, and AGGREGATE real capacity reports.
  //    fleet keyed by nodeLabel@hostname (stable) so reconnects/my-own-tests don't double-count.
  const swarm = new Hyperswarm();
  let served = 0;
  const fleet = new Map();
  const os = await import('node:os');
  const self = {
    nodeLabel: 'origin-vps', hostname: os.hostname(),
    platform: process.platform, arch: process.arch,
    cpuModel: os.cpus()[0]?.model?.trim() || 'unknown',
    cores: os.cpus().length,
    ramGB: Math.round(os.totalmem() / 1e9 * 10) / 10
  };
  function printFleet() {
    const nodes = [self, ...fleet.values()];
    const cores = nodes.reduce((a, n) => a + (n.cores || 0), 0);
    const ram = Math.round(nodes.reduce((a, n) => a + (n.ramGB || 0), 0) * 10) / 10;
    const mops = nodes.reduce((a, n) => a + (n.bench?.singleThreadMopsPerSec || 0) * (n.cores || 1), 0);
    console.log('\n===== ATMOSPHERE MESH — MEASURED COLLECTIVE CAPACITY =====');
    for (const n of nodes) {
      console.log(`  • ${(n.nodeLabel || 'node').padEnd(12)} ${String(n.cores || '?')+'c'} ${String(n.ramGB||'?')+'GB'}  ${n.bench ? n.bench.singleThreadMopsPerSec+' Mops/s' : '(origin, not benched)'}  ${n.cpuModel || ''}`);
    }
    console.log(`  TOTAL: ${nodes.length} nodes · ${cores} cores · ${ram} GB RAM · ~${Math.round(mops)} aggregate Mops/s (cores×single-thread)`);
    console.log('==========================================================\n');
  }
  swarm.on('connection', (socket, info) => {
    const peer = b4a.toString(info.publicKey, 'hex').slice(0, 16);
    console.log(`🤝 [BROADCAST] peer connected: ${peer}… — sending signed skill block`);
    sendFrame(socket, wasm);
    served++;
    socket.on('error', () => {});
    socket.on('data', frameReader((frame) => {
      try {
        const msg = JSON.parse(frame.toString('utf8'));
        if (msg && msg.type === 'CAPABILITY') {
          const key = `${msg.nodeLabel}@${msg.hostname}`;
          const fresh = !fleet.has(key);
          fleet.set(key, msg);
          console.log(`📊 [BROADCAST] capacity from ${key}: ${msg.cores}c ${msg.ramGB}GB ${msg.bench?.singleThreadMopsPerSec} Mops/s ${fresh ? '(new node)' : '(updated)'}`);
          printFleet();
        }
      } catch { /* not a capability frame */ }
    }));
  });
  swarm.join(topicKey, { server: true, client: true });
  await swarm.flush();
  console.log(`🌐 [BROADCAST] announced on the DHT. Waiting for peers… (served so far: ${served}). Ctrl-C to stop.`);
  printFleet();
}

async function runJoin() {
  if (!args.pubkey || args.pubkey === true) { console.error('❌ join requires --pubkey <base64> (printed by the broadcaster)'); process.exit(2); }
  const input = Number(args.input ?? 9);
  const pinnedPub = decB(JSON.parse(b4a.toString(b4a.from(args.pubkey, 'base64'), 'utf8')));

  console.log('🛰️  [JOIN] connecting to Atmosphere mesh via public DHT hole-punch (no open ports)…');
  console.log(`   topic: ${TOPIC_NAME}`);

  const swarm = new Hyperswarm();
  let done = false;
  const finish = (code) => { if (done) return; done = true; swarm.destroy().finally(() => process.exit(code)); };

  swarm.on('connection', (socket, info) => {
    const peer = b4a.toString(info.publicKey, 'hex').slice(0, 16);
    console.log(`🤝 [JOIN] connected to origin peer ${peer}… — awaiting signed skill block`);
    socket.on('error', () => {});
    socket.on('data', frameReader((wasm) => {
      const ok = verifySignedSkill(wasm, pinnedPub);
      if (!ok) {
        console.log('⛔ [JOIN] REJECTED: PQC seal did NOT verify against the pinned origin key. Not executing.');
        return finish(1);
      }
      console.log(`✅ [JOIN] VERIFIED: ML-DSA-65 + Ed25519 seal valid (${wasm.length} B from a trusted origin).`);
      WebAssembly.instantiate(wasm).then(({ instance }) => {
        const result = instance.exports.compute(input | 0);
        console.log(`⚡ [JOIN] executed locally: compute(${input}) = ${result}`);
        console.log('🎉 [JOIN] First real cross-machine Atmosphere link CONFIRMED — verified skill ran on this device.');
        finish(0);
      }).catch((e) => { console.log('❌ [JOIN] wasm execution failed:', e.message); finish(1); });
    }));
  });
  swarm.join(topicKey, { server: true, client: true });
  await swarm.flush();
  console.log('🌐 [JOIN] announced on the DHT. Searching for the origin node…');
  setTimeout(() => { if (!done) { console.log('⌛ [JOIN] no origin peer found yet (is the broadcaster running on the same topic?).'); finish(3); } }, 90_000);
}

if (mode === 'broadcast') runBroadcast();
else if (mode === 'join') runJoin();
else { console.error('usage: node mesh-demo.mjs <broadcast|join> [--topic NAME] [--pubkey B64] [--input N]'); process.exit(2); }
