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
  // Identity of THIS relay in the cluster (for leader election). Unique per machine.
  const RELAY_ID = (args['relay-id'] && args['relay-id'] !== true) ? String(args['relay-id']).slice(0, 32) : 'origin';
  const SIGNED_SKILL = (args['signed-skill'] && args['signed-skill'] !== true) ? args['signed-skill'] : null;

  let wasm, keyBundle = null, pinnedB64 = null;
  // The signed skill's affine params + id — set in key-holder mode below so the origin can
  // re-verify each returned result slice and bind the receipt to the exact skill that ran.
  let SKILL_A = Number(args.a ?? 3), SKILL_B = Number(args.b ?? 0), SKILL_ID = 'mesh_affine';
  if (SIGNED_SKILL) {
    // KEYLESS RELAY: serve a pre-signed artifact — NO private key lives on this machine.
    // This is the heart of true multi-machine HA: availability without key duplication.
    wasm = fs.readFileSync(SIGNED_SKILL);
    console.log(`📡 [RELAY ${RELAY_ID}] keyless relay — serving pre-signed skill (${wasm.length} B). No signing key on this host.`);
  } else {
    // KEY-HOLDER: compile + PQC-seal the membership skill, and (optionally) export the signed
    // artifact so keyless relays elsewhere can serve it.
    const { GsiCompiler } = await import('../stratos-agent/gsi-compiler.js');
    const { loadOrCreateNodeKeys } = await import('../stratos-agent/src/evolution/self-evolution.js');
    keyBundle = loadOrCreateNodeKeys(NODE_KEYS);
    const a = Number(args.a ?? 3), b = Number(args.b ?? 0);
    const compiler = new GsiCompiler({ distSkillsDir: path.join(ROOT, 'packages', 'stratos-agent', 'dist', 'skills'), verbose: false });
    SKILL_A = a; SKILL_B = b; // remembered so the origin can re-verify each returned result slice
    const manifest = { id: 'mesh_affine', kind: 'computational', triggerIntent: `apply ${a}x+${b}`, computation: { type: 'affine', a, b } };
    SKILL_ID = manifest.id;
    wasm = await compiler.compile(manifest, keyBundle.privateKey);
    pinnedB64 = b4a.toString(b4a.from(JSON.stringify(encB(keyBundle.publicKey))), 'base64');
    if (args['export-skill'] && args['export-skill'] !== true) {
      fs.writeFileSync(args['export-skill'], wasm);
      console.log(`💾 [ORIGIN ${RELAY_ID}] exported signed skill -> ${args['export-skill']} (distribute to keyless relays for HA).`);
    }
    console.log(`📡 [ORIGIN ${RELAY_ID}] key-holder — sealed skill (${wasm.length} B). self-verify: ${verifySignedSkill(wasm, keyBundle.publicKey) ? '✅' : '❌'}`);
    console.log(`   ad-hoc join test: node packages/atmos-core/mesh-demo.mjs join --topic ${TOPIC_NAME} --input 9 --pubkey ${pinnedB64}`);
  }
  console.log(`   topic: ${TOPIC_NAME}  ·  relay-id: ${RELAY_ID}`);

  // ---- Capability Receipts: the cross-machine PROOF rail -----------------------------
  // For every JOB result a worker returns AND the origin re-verifies (correct compute over the
  // assigned slice), the origin appends a hybrid-PQC-signed, hash-chained `skill-run` receipt:
  // WHO ran WHAT (actor=origin did, ref=skill id), on WHOSE node (node_id = the worker's
  // cryptographic peer key), over WHICH input/output (sha256 hashes only — never content), at
  // WHAT measured cost (cost_units = inputs computed). Verifiable by any third party holding ONLY
  // the origin's PUBLIC key. Key-holder mode only (a keyless relay has no signing key).
  let receiptLog = null, originDid = null;
  if (keyBundle) {
    const { ReceiptLog, makeReceiptSigner, makeReceiptVerifier, hashContent } = await import('../stratos-agent/src/ledger/capability-receipt.js');
    const { originId } = await import('../stratos-agent/src/memory/skill-seal.js');
    originDid = originId(keyBundle.publicKey);
    const receiptsPath = (args['receipts-out'] && args['receipts-out'] !== true) ? args['receipts-out'] : null;
    receiptLog = new ReceiptLog({
      path: receiptsPath, nodeId: originDid,
      signer: makeReceiptSigner(keyBundle.privateKey),
      verifier: makeReceiptVerifier(keyBundle.publicKey), // lets the in-process self-verify check sigs too
    });
    receiptLog._hashContent = hashContent;
    receiptLog._publicKeyBundle = keyBundle.publicKey;
    console.log(`🧾 [ORIGIN ${RELAY_ID}] capability-receipt log armed (origin did ${originDid})${receiptsPath ? ` -> ${receiptsPath}` : ' (in-memory)'}.`);
  }

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
    // Self-verify + export a third-party-verifiable receipt bundle (public key embedded, no secret).
    if (receiptLog && receiptLog.length) {
      const v = receiptLog.verify({ requireSig: true });
      console.log(`🧾 [RECEIPT] chain self-verify: ${v.ok ? `✅ ${receiptLog.length} signed receipt(s)` : '❌ ' + v.reason}`);
      if (args['receipts-bundle'] && args['receipts-bundle'] !== true) {
        try {
          const bundle = receiptLog.exportBundle({ publicKeyBundle: receiptLog._publicKeyBundle });
          fs.writeFileSync(args['receipts-bundle'], JSON.stringify(bundle, null, 2));
        } catch (e) { console.warn('[receipts-bundle] write failed:', e.message); }
      }
    }
    return { jobId, wallMs, done };
  }

  // ---- #3 relay cluster: leader election for multi-machine HA -------------------------
  // Every relay serves membership (redundant). Only the LEADER (lowest live relay-id)
  // dispatches jobs, so there's no duplicate work. Relays heartbeat each other; if the
  // leader goes silent, the next-lowest takes over. Eventually-consistent: a brief overlap
  // during failover only ever causes a duplicate idempotent compute job, never bad execution.
  const HEARTBEAT_MS = 5000, RELAY_TTL_MS = 16000;
  const aliveRelays = new Map([[RELAY_ID, Infinity]]); // self never expires
  let currentLeader = RELAY_ID;
  function recomputeLeader() {
    const now = Date.now();
    for (const [id, seen] of aliveRelays) if (seen !== Infinity && now - seen > RELAY_TTL_MS) aliveRelays.delete(id);
    const leader = [...aliveRelays.keys()].sort()[0];
    if (leader !== currentLeader) {
      currentLeader = leader;
      console.log(`👑 [RELAY ${RELAY_ID}] leader is now '${leader}'${leader === RELAY_ID ? ' — I dispatch jobs' : ' (I am standby)'}. alive: [${[...aliveRelays.keys()].sort().join(', ')}]`);
    }
    return leader;
  }
  const isLeader = () => recomputeLeader() === RELAY_ID;

  const os = await import('node:os');
  const self = {
    nodeLabel: 'origin-vps', platform: process.platform, arch: process.arch,
    cpuModel: os.cpus()[0]?.model?.trim() || 'unknown',
    cores: os.cpus().length,
    ramGB: Math.round(os.totalmem() / 1e9 * 10) / 10
  };
  // A node's self-reported owner wallet is UNTRUSTED input — validate as a Solana address (base58,
  // 32-44 chars, no 0/O/I/l) before storing/attributing. Invalid/absent → null (unattributed). This is
  // a PUBLIC address only (never a key) and is never interpolated into logs/SQL/shell raw — the regex
  // alphabet alone rejects any injection payload.
  const SOLANA_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const sanitizeWallet = (v) => (typeof v === 'string' && SOLANA_BASE58.test(v.trim()) ? v.trim() : null);

  // Validate + clamp an untrusted capability frame. Returns a clean object or null.
  function sanitizeCapability(m) {
    if (!m || m.type !== 'CAPABILITY') return null;
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : 0);
    const mops = num(m.bench?.singleThreadMopsPerSec, 0, 1e7);
    return {
      version: str(m.version, 16) || '?',
      nodeLabel: str(m.nodeLabel, 64) || 'node',
      walletAddress: sanitizeWallet(m.walletAddress), // owner attribution — validated Solana address or null
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
      // Owner wallet (truncated) — attribution at a glance. Origin row has no wallet; nodes that sent
      // no wallet show "unattributed" (never fabricated). Truncation is display-only.
      const wallet = n === self ? '' : (n.walletAddress ? `💰${n.walletAddress.slice(0, 4)}…${n.walletAddress.slice(-4)}` : '○unattributed');
      console.log(`  • ${(n.nodeLabel || 'node').padEnd(12)} ${String(n.cores || '?')+'c'} ${String(n.ramGB||'?')+'GB'}  ${benched}  ${seal}  ${wallet}  ${n.cpuModel || ''}`);
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
    // Announce ourselves as a relay so any relay peer can include us in leader election.
    // Nodes ignore RELAY_HELLO (unknown type); only relays act on it.
    sendFrame(socket, Buffer.from(JSON.stringify({ type: 'RELAY_HELLO', relayId: RELAY_ID })));
    served++;
    sockets.set(peerKey, socket);
    socket.on('error', () => {});
    socket.on('close', () => { fleet.delete(peerKey); lastCapAt.delete(peerKey); challenges.delete(peerKey); sockets.delete(peerKey); });
    socket.on('data', frameReader(socket, (frame) => {
      let msg = null;
      try { msg = JSON.parse(frame.toString('utf8')); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'RELAY_HELLO' && typeof msg.relayId === 'string' && msg.relayId !== RELAY_ID) {
        // A peer relay announced itself — track liveness for leader election (heartbeat).
        const known = aliveRelays.has(msg.relayId.slice(0, 32));
        aliveRelays.set(msg.relayId.slice(0, 32), Date.now());
        if (!known) console.log(`🔗 [RELAY ${RELAY_ID}] discovered peer relay '${msg.relayId.slice(0,32)}'.`);
        recomputeLeader();
        return;
      }

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
          // PROOF rail: re-verify the worker actually computed the signed skill (a*x+b) over its
          // assigned slice, then record a signed Capability Receipt naming the worker's peer key as
          // the compute node. A wrong/forged result fails this check and earns NO receipt.
          if (receiptLog) {
            const correct = job.slice.every((x, i) => msg.results[i] === (SKILL_A * x + SKILL_B));
            if (correct) {
              const inputHash = receiptLog._hashContent(job.slice);
              const outputHash = receiptLog._hashContent(msg.results);
              // Attribute to the worker's OWNER WALLET if it sent a valid one (captured on the fleet
              // entry from its capacity report). No wallet → owner_wallet stays null (unattributed) —
              // never fabricated. The wallet is part of the SIGNED + hash-chained receipt body.
              const ownerWallet = job.node?.walletAddress ?? null;
              const r = receiptLog.append({
                actor_id: originDid,                       // who orchestrated the work (this origin)
                action: 'skill-run',
                ref: SKILL_ID,                             // the exact signed skill that ran
                node_id: 'did:hyper:' + peerKey.slice(0, 40), // the worker node (its DHT identity)
                owner_wallet: ownerWallet,                 // the worker's owner (Solana addr) or null
                input_hash: inputHash,
                output_hash: outputHash,
                cost_units: job.slice.length,              // measured: inputs computed (never a price)
              });
              const attr = ownerWallet ? `→ owner ${ownerWallet.slice(0,4)}…${ownerWallet.slice(-4)}` : '(unattributed)';
              console.log(`🧾 [RECEIPT] skill-run ${r.receipt_id.slice(0,8)} — node ${peer}… ran ${SKILL_ID} over ${job.slice.length} inputs ${attr} (chain head ${r.hash.slice(0,12)}…).`);
            } else {
              console.warn(`🚫 [RECEIPT] result from ${peer}… did NOT match a*x+b — no receipt issued.`);
            }
          }
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

  // #3 relay heartbeat: keep announcing ourselves to every connected peer so the cluster's
  // liveness view stays fresh, and re-evaluate leadership (promotes a standby if the leader died).
  setInterval(() => {
    const hb = Buffer.from(JSON.stringify({ type: 'RELAY_HELLO', relayId: RELAY_ID }));
    for (const s of sockets.values()) { try { sendFrame(s, hb); } catch {} }
    recomputeLeader();
  }, HEARTBEAT_MS);

  // #2 scheduler trigger: only the elected LEADER dispatches, so redundant relays never
  // double-dispatch. Opt-in via --job-interval <seconds> [--job-max <N inputs>].
  if (args['job-interval'] && args['job-interval'] !== true) {
    const everyMs = Math.max(5, Number(args['job-interval'])) * 1000;
    const jobMax = Math.min(Math.max(Number(args['job-max'] || 60), 1), 50_000);
    let busy = false;
    setInterval(async () => {
      if (busy || !isLeader()) return; // standby relays stay idle on dispatch
      busy = true; try { await dispatchJob(jobMax); } catch (e) { console.warn('[JOB] dispatch error:', e.message); } busy = false;
    }, everyMs);
    console.log(`🗂️  [JOB] scheduler armed: every ${everyMs/1000}s the LEADER fans ${jobMax} inputs across ready nodes.`);
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
    socket.on('data', frameReader(socket, (frame) => {
      if (frame.length && frame[0] !== 0x00) return; // skip JSON control frames (RELAY_HELLO etc.)
      const wasm = frame;
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
