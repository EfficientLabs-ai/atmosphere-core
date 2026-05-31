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
// Topic precedence: --topic-file (a secret rendezvous string kept off the command line) >
// --topic > the public default. A private high-entropy topic means strangers can't even
// rendezvous with the fleet — defense-in-depth on top of PQC pinning.
let TOPIC_NAME = args.topic || DEFAULT_TOPIC;
if (args['topic-file'] && args['topic-file'] !== true) {
  try { TOPIC_NAME = fs.readFileSync(args['topic-file'], 'utf8').trim(); } catch { /* fall back */ }
}
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
// Length-framed reader with a HARD size cap: an oversized declared length destroys the
// socket before any buffering (DoS guard on an untrusted Noise stream).
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

  // 4. Join the global DHT, serve the signed skill, and aggregate self-reported capacity,
  //    keyed on the peer's cryptographic pubkey with bounds + rate-limits (see below).
  const swarm = new Hyperswarm();
  let served = 0;
  // Fleet is keyed on the Hyperswarm PEER PUBKEY (cryptographic identity), NOT on any
  // attacker-supplied nodeLabel/hostname — so one peer occupies exactly one slot no matter
  // what it claims. Hard ceiling + per-peer rate-limit bound memory and CPU under abuse.
  const fleet = new Map();
  const FLEET_MAX = 4096, CAP_MIN_INTERVAL_MS = 10_000, MAX_CAP_BYTES = 1 << 19; // 512 KiB (holds job RESULT slices)
  const lastCapAt = new Map();
  const challenges = new Map(); // peerKey -> { nonce, iters, sentAtNs }
  const PROOF_ITERS = 1_000_000;
  const LATEST_VERSION = '1.2.0';
  // Recompute the sha256 hash-chain to confirm a node actually did the sequential work.
  function chainDigest(nonceHex, iters) {
    let h = crypto.createHash('sha256').update(nonceHex).digest();
    for (let i = 0; i < iters; i++) h = crypto.createHash('sha256').update(h).digest();
    return h.toString('hex');
  }

  // ---- #2 distributed job scheduler: parallel compute fan-out -------------------------
  const sockets = new Map();   // peerKey -> live socket (worker channel)
  const pending = new Map();   // `${peerKey}:${jobId}` -> { resolve, slice }
  let jobSeq = 0;
  async function dispatchJob(maxInput, JOB_TIMEOUT_MS = 20_000) {
    const workers = [...sockets.entries()].filter(([k]) => fleet.get(k)?.computeReady);
    if (!workers.length) { console.log('🗂️  [JOB] no ready worker nodes connected — skipping dispatch.'); return null; }
    const jobId = `job${++jobSeq}-${crypto.randomBytes(3).toString('hex')}`;
    const inputs = Array.from({ length: maxInput }, (_, i) => i + 1);
    const slices = workers.map(() => []);
    inputs.forEach((x, i) => slices[i % workers.length].push(x)); // round-robin split
    const startNs = process.hrtime.bigint();
    const outputs = new Map(); const perNode = [];
    console.log(`\n🗂️  [JOB ${jobId}] fanning ${maxInput} inputs across ${workers.length} node(s)…`);
    await Promise.all(workers.map(([key, sock], idx) => new Promise((resolve) => {
      const slice = slices[idx]; const node = fleet.get(key);
      const pk = `${key}:${jobId}`;
      const timer = setTimeout(() => { if (pending.delete(pk)) { perNode.push({ node: node?.nodeLabel || key.slice(0,8), count: 0, timedOut: true }); resolve(); } }, JOB_TIMEOUT_MS);
      pending.set(pk, { resolve: () => { clearTimeout(timer); resolve(); }, slice, key, node, outputs, perNode });
      try { sendFrame(sock, Buffer.from(JSON.stringify({ type: 'JOB', jobId, inputs: slice }))); }
      catch { clearTimeout(timer); pending.delete(pk); resolve(); }
    })));
    const wallMs = Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
    const done = perNode.filter(p => !p.timedOut).reduce((a, p) => a + p.count, 0);
    console.log(`✅ [JOB ${jobId}] ${done}/${maxInput} results in ${wallMs} ms (parallel across the fleet):`);
    for (const p of perNode) console.log(`     ${p.node.padEnd(12)} ${p.timedOut ? 'TIMED OUT' : p.count + ' inputs in ' + p.computeMs + ' ms'}`);
    const sample = [...outputs.entries()].slice(0, 5).map(([i, o]) => `${i}->${o}`).join(', ');
    console.log(`     sample: ${sample}${outputs.size > 5 ? ', …' : ''}`);
    if (args['jobs-out'] && args['jobs-out'] !== true) {
      try { fs.writeFileSync(args['jobs-out'], JSON.stringify({ jobId, maxInput, wallMs, workers: perNode, completed: done }, null, 2)); } catch {}
    }
    return { jobId, wallMs, done };
  }
  const os = await import('node:os');
  const self = {
    nodeLabel: 'origin-vps', platform: process.platform, arch: process.arch,
    cpuModel: os.cpus()[0]?.model?.trim() || 'unknown',
    cores: os.cpus().length,
    ramGB: Math.round(os.totalmem() / 1e9 * 10) / 10
  };
  // Validate + clamp an untrusted capability frame. Returns a clean object or null.
  function sanitizeCapability(m) {
    if (!m || m.type !== 'CAPABILITY') return null;
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : 0);
    const mops = num(m.bench?.singleThreadMopsPerSec, 0, 1e7);
    return {
      version: str(m.version, 16) || '?',
      nodeLabel: str(m.nodeLabel, 64) || 'node',
      platform: str(m.platform, 32), arch: str(m.arch, 16),
      cpuModel: str(m.cpuModel, 128) || 'unknown',
      cores: Math.round(num(m.cores, 0, 4096)),
      ramGB: Math.round(num(m.ramGB, 0, 1e6) * 10) / 10,
      bench: { singleThreadMopsPerSec: mops },
      proven: null // set once the node passes the proof-of-capacity challenge
    };
  }
  function printFleet() {
    const nodes = [self, ...fleet.values()];
    const cores = nodes.reduce((a, n) => a + (n.cores || 0), 0);
    const ram = Math.round(nodes.reduce((a, n) => a + (n.ramGB || 0), 0) * 10) / 10;
    const mops = nodes.reduce((a, n) => a + (n.bench?.singleThreadMopsPerSec || 0) * (n.cores || 1), 0);
    const provenNodes = nodes.filter(n => n.proven);
    const provenHps = provenNodes.reduce((a, n) => a + (n.proven.hashesPerSec || 0), 0);
    console.log('\n===== ATMOSPHERE MESH — COLLECTIVE CAPACITY =====');
    for (const n of nodes) {
      const benched = n.bench?.singleThreadMopsPerSec ? n.bench.singleThreadMopsPerSec + ' Mops/s' : '(origin)';
      const seal = n.proven ? `🔐≥${(n.proven.hashesPerSec/1e6).toFixed(2)}M H/s` : (n === self ? '' : '⏳unproven');
      console.log(`  • ${(n.nodeLabel || 'node').padEnd(12)} ${String(n.cores || '?')+'c'} ${String(n.ramGB||'?')+'GB'}  ${benched}  ${seal}  ${n.cpuModel || ''}`);
    }
    console.log(`  SELF-REPORTED: ${nodes.length} nodes · ${cores} cores · ${ram} GB · ~${Math.round(mops)} aggregate Mops/s`);
    console.log(`  PROVEN (challenge-verified): ${provenNodes.length} node(s) · ≥ ${(provenHps/1e6).toFixed(2)}M H/s combined`);
    console.log('=================================================\n');
    if (args['fleet-out'] && args['fleet-out'] !== true) {
      try {
        const snap = { updatedAtMs: Number(process.hrtime.bigint() / 1000000n), totals: { nodes: nodes.length, cores, ramGB: ram, aggMops: Math.round(mops), provenNodes: provenNodes.length, provenHashesPerSec: provenHps }, nodes };
        fs.writeFileSync(args['fleet-out'], JSON.stringify(snap, null, 2));
      } catch (e) { console.warn('[fleet-out] write failed:', e.message); }
    }
  }
  swarm.on('connection', (socket, info) => {
    const peerKey = b4a.toString(info.publicKey, 'hex');
    const peer = peerKey.slice(0, 16);
    console.log(`🤝 [BROADCAST] peer connected: ${peer}… — sending signed skill block`);
    sendFrame(socket, wasm);
    served++;
    sockets.set(peerKey, socket);
    socket.on('error', () => {});
    socket.on('close', () => { fleet.delete(peerKey); lastCapAt.delete(peerKey); challenges.delete(peerKey); sockets.delete(peerKey); });
    socket.on('data', frameReader(socket, (frame) => {
      let msg = null;
      try { msg = JSON.parse(frame.toString('utf8')); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'CAPABILITY') {
        // Per-peer rate-limit: ignore capability spam.
        const now = process.hrtime.bigint();
        const lastNs = lastCapAt.get(peerKey);
        if (lastNs && Number(now - lastNs) / 1e6 < CAP_MIN_INTERVAL_MS) return;
        const cap = sanitizeCapability(msg);
        if (!cap) return;
        lastCapAt.set(peerKey, now);
        if (!fleet.has(peerKey) && fleet.size >= FLEET_MAX) {
          console.warn(`⚠️ [BROADCAST] fleet at capacity (${FLEET_MAX}); ignoring new peer ${peer}.`);
          return;
        }
        const fresh = !fleet.has(peerKey);
        cap.computeReady = true; // node reports capacity only after verifying the skill it can run
        fleet.set(peerKey, cap); // keyed on pubkey — a peer cannot impersonate another
        console.log(`📊 [BROADCAST] capacity from ${cap.nodeLabel} v${cap.version} (${peer}…): ${cap.cores}c ${cap.ramGB}GB ${cap.bench.singleThreadMopsPerSec} Mops/s ${fresh ? '(new node)' : '(updated)'}`);
        if (cap.version !== LATEST_VERSION) {
          sendFrame(socket, Buffer.from(JSON.stringify({ type: 'UPDATE_AVAILABLE', latest: LATEST_VERSION })));
        }
        // Issue a proof-of-capacity challenge. The origin times the round trip itself, so the
        // node cannot inflate its speed — the proven rate is a conservative lower bound.
        const nonce = crypto.randomBytes(16).toString('hex');
        challenges.set(peerKey, { nonce, iters: PROOF_ITERS, sentAtNs: process.hrtime.bigint() });
        sendFrame(socket, Buffer.from(JSON.stringify({ type: 'CHALLENGE', nonce, iters: PROOF_ITERS })));
        printFleet();
        return;
      }

      if (msg.type === 'PROOF') {
        const ch = challenges.get(peerKey);
        const node = fleet.get(peerKey);
        if (!ch || !node || msg.nonce !== ch.nonce) return;
        challenges.delete(peerKey);
        const elapsedMs = Number(process.hrtime.bigint() - ch.sentAtNs) / 1e6;
        const ok = typeof msg.digest === 'string' && msg.digest === chainDigest(ch.nonce, ch.iters);
        if (!ok) { console.warn(`🚫 [BROADCAST] proof FAILED for ${node.nodeLabel} (${peer}…) — capacity stays UNPROVEN.`); return; }
        // Conservative lower bound: hashes / (network + compute) round-trip the origin measured.
        const provenHps = Math.round(ch.iters / (elapsedMs / 1000));
        node.proven = { hashesPerSec: provenHps, roundTripMs: Math.round(elapsedMs) };
        console.log(`🔐 [BROADCAST] proof VERIFIED for ${node.nodeLabel} (${peer}…): ≥ ${provenHps.toLocaleString()} H/s (round-trip ${Math.round(elapsedMs)} ms).`);
        printFleet();
        return;
      }

      if (msg.type === 'RESULT') {
        const pk = `${peerKey}:${msg.jobId}`;
        const job = pending.get(pk);
        if (!job) return;
        pending.delete(pk);
        if (Array.isArray(msg.results) && msg.results.length === job.slice.length) {
          job.slice.forEach((input, i) => job.outputs.set(input, msg.results[i]));
          job.perNode.push({ node: job.node?.nodeLabel || peer, count: msg.results.length, computeMs: msg.computeMs });
        } else {
          job.perNode.push({ node: job.node?.nodeLabel || peer, count: 0, timedOut: true });
        }
        job.resolve();
        return;
      }
    }, MAX_CAP_BYTES));
  });
  swarm.join(topicKey, { server: true, client: true });
  await swarm.flush();
  console.log(`🌐 [BROADCAST] announced on the DHT. Waiting for peers… (served so far: ${served}). Ctrl-C to stop.`);
  printFleet();

  // #2 scheduler trigger: periodically fan a compute job across the fleet (demo/heartbeat of
  // real distributed work). Opt-in via --job-interval <seconds> [--job-max <N inputs>].
  if (args['job-interval'] && args['job-interval'] !== true) {
    const everyMs = Math.max(5, Number(args['job-interval'])) * 1000;
    const jobMax = Math.min(Math.max(Number(args['job-max'] || 60), 1), 50_000);
    let busy = false;
    setInterval(async () => { if (busy) return; busy = true; try { await dispatchJob(jobMax); } catch (e) { console.warn('[JOB] dispatch error:', e.message); } busy = false; }, everyMs);
    console.log(`🗂️  [JOB] scheduler armed: every ${everyMs/1000}s fan ${jobMax} inputs across ready nodes.`);
  }
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
    socket.on('data', frameReader(socket, (wasm) => {
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
    }, 1 << 20)); // cap inbound skill frame at 1 MiB
  });
  swarm.join(topicKey, { server: true, client: true });
  await swarm.flush();
  console.log('🌐 [JOIN] announced on the DHT. Searching for the origin node…');
  setTimeout(() => { if (!done) { console.log('⌛ [JOIN] no origin peer found yet (is the broadcaster running on the same topic?).'); finish(3); } }, 90_000);
}

if (mode === 'broadcast') runBroadcast();
else if (mode === 'join') runJoin();
else { console.error('usage: node mesh-demo.mjs <broadcast|join> [--topic NAME] [--pubkey B64] [--input N]'); process.exit(2); }
