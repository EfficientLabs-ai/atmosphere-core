#!/usr/bin/env node
/**
 * Atmosphere Mesh Node — sovereign mesh peer.
 *
 * Joins the global Hyperswarm DHT on a shared topic via NAT hole-punching: it opens NO
 * listening port and exposes NO inbound internet surface — the DHT coordinates the punch.
 * It accepts and runs a compute skill ONLY if the skill's hybrid post-quantum seal
 * (ML-DSA-65 + Ed25519) verifies against the PINNED origin public key in config.json.
 * Unsigned, tampered, or wrong-origin skills are refused and never executed.
 *
 * Zero-config: reads config.json (topic + pinned origin key) sitting next to this file.
 *   node mesh-node.mjs                       -> join the mesh and stand by for verified skills
 *   node mesh-node.mjs --input 21 --once     -> run one verified skill and exit (proof mode)
 */
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import fs from 'node:fs';
import os from 'node:os';
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

// OWNER WALLET (Solana) — attributes this node's compute to its owner so the day a reward layer lands,
// every node is ALREADY attributed (measurement before rewards). A wallet ADDRESS is PUBLIC and safe to
// bake; this never touches a private key. Precedence: --wallet flag > config.walletAddress. Validated as
// base58, 32-44 chars (no 0/O/I/l): invalid → refuse to start; absent → join unattributed.
const SOLANA_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isValidSolanaAddress = (a) => typeof a === 'string' && SOLANA_BASE58.test(a);
function resolveWallet() {
  const raw = getArg('wallet', cfg.walletAddress);
  if (raw == null || raw === true) return null;          // absent → unattributed (graceful)
  const s = String(raw).trim();
  if (!s) return null;
  if (!isValidSolanaAddress(s)) {
    console.error('✗ invalid --wallet / config.walletAddress: must be a valid Solana address (base58, 32-44 chars, no 0/O/I/l).');
    console.error('  Fix the address or omit it to join unattributed. Refusing to start.');
    process.exit(2);
  }
  return s;
}
const OWNER_WALLET = resolveWallet();

import crypto from 'node:crypto';
const topicKey = crypto.createHash('sha256').update(TOPIC_NAME).digest();

// Pinned origin public key (Der buffers) — the cryptographic trust anchor.
const decB = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, b4a.from(v, 'base64')]));
const pinnedPub = decB(typeof cfg.pinnedPubKey === 'string'
  ? JSON.parse(b4a.toString(b4a.from(cfg.pinnedPubKey, 'base64'), 'utf8'))
  : cfg.pinnedPubKey);

// Length-framed reader with a HARD size cap: a peer that declares an oversized frame gets
// its socket destroyed before we ever buffer/allocate it (DoS guard on an untrusted stream).
function frameReader(socket, onFrame, maxLen) {
  let acc = Buffer.alloc(0), need = -1;
  return (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    while (true) {
      if (need < 0) {
        if (acc.length < 4) return;
        need = acc.readUInt32BE(0);
        if (need > maxLen) { socket.destroy(); return; }
        acc = acc.subarray(4);
      }
      if (acc.length < need) return;
      const frame = acc.subarray(0, need); acc = acc.subarray(need); need = -1;
      onFrame(frame);
    }
  };
}
function sendFrame(socket, buf) {
  const len = Buffer.alloc(4); len.writeUInt32BE(buf.length, 0);
  socket.write(Buffer.concat([len, buf]));
}

// Real capacity report: actual hardware + a live CPU microbenchmark (no spoofed numbers).
// NOTE: specs are self-reported — trustworthy for your own fleet; a public mesh would add a
// challenge-based proof-of-capacity. The benchmark is measured here, not declared.
function microbenchmark() {
  const t0 = process.hrtime.bigint();
  let x = 0;
  for (let i = 0; i < 5_000_000; i++) x = (x + Math.sqrt(i * 2.0 + 1.0)) % 1e9;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // Mops/s on this single-thread loop — a comparable cross-machine score.
  return { singleThreadMopsPerSec: Math.round((5_000_000 / ms) / 1000 * 100) / 100, loopMs: Math.round(ms) };
}
// Built at most ONCE per process and cached — the benchmark is a CPU cost we never want an
// untrusted peer to be able to trigger repeatedly. Drops hostname/loadavg to reduce
// fingerprinting; nodeLabel (operator-chosen) is the only identity we disclose.
let _cap = null;
function getCapabilityOnce() {
  if (_cap) return _cap;
  const cpus = os.cpus() || [];
  _cap = {
    type: 'CAPABILITY',
    version: NODE_VERSION,
    nodeLabel: String(cfg.nodeLabel || 'node').slice(0, 64),
    walletAddress: OWNER_WALLET, // PUBLIC Solana address or null — the origin attributes contribution to it
    platform: process.platform,
    arch: process.arch,
    cpuModel: (cpus[0]?.model?.trim() || 'unknown').slice(0, 128),
    cores: cpus.length,
    ramGB: Math.round(os.totalmem() / 1e9 * 10) / 10,
    bench: microbenchmark()
  };
  return _cap;
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

const NODE_VERSION = '1.2.0'; // bumped when the bundle changes; origin can flag stale nodes.

// Proof-of-capacity: the origin sends a random nonce + iteration count; we run a sha256 hash
// CHAIN that many times (inherently sequential — can't be shortcut) and return the digest +
// wall-time. The origin recomputes the digest to confirm we actually did the work, and the
// time gives a PROVEN lower bound on real throughput. A node can't claim MORE compute than it
// has (it would have to hash faster than physically possible); it can only under-report.
function proveCapacity(nonceHex, iters) {
  const t0 = process.hrtime.bigint();
  let h = crypto.createHash('sha256').update(nonceHex).digest();
  for (let i = 0; i < iters; i++) h = crypto.createHash('sha256').update(h).digest();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { digest: h.toString('hex'), ms: Math.round(ms * 100) / 100, hashesPerSec: Math.round(iters / (ms / 1000)) };
}

console.log('🛰️  Atmosphere Mesh Node starting…');
console.log(`   node id  : ${cfg.nodeLabel || 'node'}  (v${NODE_VERSION})`);
console.log(`   topic    : ${TOPIC_NAME}`);
console.log('   transport: public Hyperswarm DHT, NAT hole-punch, no open ports');
console.log(OWNER_WALLET
  ? `   wallet   : ${OWNER_WALLET.slice(0, 4)}…${OWNER_WALLET.slice(-4)} — compute attributed to this Solana owner`
  : '   wallet   : unattributed (no wallet) — add --wallet <SOL_ADDRESS> to attribute your contribution');

const swarm = new Hyperswarm();
let executed = 0;
const stop = (code) => swarm.destroy().finally(() => process.exit(code));

const MAX_SKILL_BYTES = 1 << 20; // 1 MiB — skills are ~5 KB; anything larger is hostile.
swarm.on('connection', (socket, info) => {
  const peer = b4a.toString(info.publicKey, 'hex').slice(0, 16);
  console.log(`🤝 connected to origin peer ${peer}… — awaiting signed skill`);
  socket.on('error', () => {});
  let reported = false; // disclose capacity at most once per connection, only AFTER auth.
  let computeFn = null; // the verified skill's compute(), reused for dispatched job slices.
  socket.on('data', frameReader(socket, (frame) => {
    // Frames from the origin are either a wasm skill (starts with the \0asm magic byte 0x00)
    // or a JSON control message (proof-of-capacity challenge / update notice).
    if (frame.length && frame[0] !== 0x00) {
      try {
        const msg = JSON.parse(frame.toString('utf8'));
        if (msg.type === 'CHALLENGE' && typeof msg.nonce === 'string') {
          const iters = Math.min(Math.max(msg.iters | 0, 1), 20_000_000);
          const proof = proveCapacity(msg.nonce, iters);
          console.log(`🧮 proof-of-capacity: ${proof.hashesPerSec.toLocaleString()} H/s over ${iters.toLocaleString()} rounds (${proof.ms} ms).`);
          sendFrame(socket, Buffer.from(JSON.stringify({ type: 'PROOF', nonce: msg.nonce, iters, ...proof })));
        } else if (msg.type === 'UPDATE_AVAILABLE') {
          console.log(`⬆️  update available: origin runs v${msg.latest}, this node is v${NODE_VERSION}. Re-run the latest bundle when convenient.`);
        } else if (msg.type === 'JOB' && Array.isArray(msg.inputs)) {
          // Distributed compute slice: run the already-verified skill over our assigned inputs.
          if (!computeFn) { sendFrame(socket, Buffer.from(JSON.stringify({ type: 'RESULT', jobId: msg.jobId, error: 'skill not ready' }))); return; }
          const t0 = process.hrtime.bigint();
          const inputs = msg.inputs.slice(0, 100_000).map(n => n | 0);
          const results = inputs.map(x => computeFn(x));
          const computeMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6 * 100) / 100;
          console.log(`🛠️  job ${String(msg.jobId).slice(0,8)}: computed ${inputs.length} inputs in ${computeMs} ms — returning slice.`);
          sendFrame(socket, Buffer.from(JSON.stringify({ type: 'RESULT', jobId: msg.jobId, count: inputs.length, results, computeMs })));
        }
      } catch { /* ignore non-JSON control frames */ }
      return;
    }
    const wasm = frame;
    if (!verifySignedSkill(wasm)) {
      console.log('⛔ REJECTED: PQC seal invalid / wrong origin — NOT executing.');
      if (ONCE) stop(1);
      return;
    }
    console.log(`✅ VERIFIED: ML-DSA-65 + Ed25519 seal valid (${wasm.length} B from the pinned origin).`);
    // Only NOW — after the peer proved it holds an origin-signed skill — do we spend CPU on
    // the benchmark and disclose specs. An unauthenticated peer can neither make us benchmark
    // nor fingerprint us.
    if (!reported) {
      reported = true;
      try {
        const cap = getCapabilityOnce();
        console.log(`📊 reporting capacity: ${cap.cores} cores, ${cap.ramGB} GB, ${cap.bench.singleThreadMopsPerSec} Mops/s (${cap.cpuModel}).`);
        sendFrame(socket, Buffer.from(JSON.stringify(cap)));
      } catch (e) { console.log('capacity report skipped:', e.message); }
    }
    WebAssembly.instantiate(wasm).then(({ instance }) => {
      computeFn = (x) => instance.exports.compute(x | 0); // cache for dispatched job slices
      const result = computeFn(INPUT);
      executed++;
      console.log(`⚡ executed verified skill: compute(${INPUT}) = ${result}`);
      console.log('🎉 This device is now a live, verified node on the Atmosphere mesh — standing by for jobs.');
      if (ONCE) stop(0);
    }).catch((e) => { console.log('❌ execution failed:', e.message); if (ONCE) stop(1); });
  }, MAX_SKILL_BYTES));
});

swarm.join(topicKey, { server: true, client: true });
swarm.flush().then(() => console.log('🌐 announced on the DHT — searching for the origin node…'));

if (ONCE) setTimeout(() => { if (!executed) { console.log('⌛ no origin peer found (is the broadcaster up on this topic?).'); stop(3); } }, 90_000);
process.on('SIGINT', () => { console.log('\n🛰️  mesh node leaving the mesh.'); stop(0); });
