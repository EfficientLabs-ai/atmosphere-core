import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GsiCompiler, parseCustomSection } from '../../gsi-compiler.js';
import { SkillExecutor } from './skill-executor.js';
import { SkillInductionEngine } from './skill-induction.js';
import { generateHybridKeyPair } from '../security/quantum-crypto.js';
import { insertCognitiveSkill, queryCognitiveSkill, getCognitiveSkillById } from '../memory/vector-bank.js';

/**
 * SelfEvolutionEngine — the integration layer that wires the five components built
 * separately (induction, compiler, executor, PQC, P2P sync) into ONE coherent loop:
 *
 *   OBSERVE   captureSuccess()   record a successful task + its input/output examples
 *   LEARN     runNightShift()    induce spec (Tier A) -> compile -> full-module PQC seal
 *   DISTRIBUTE broadcastSkill()  append the signed skill to the P2P mesh ledger
 *   VERIFY    ingestRemoteSkill() re-verify a peer's seal before trusting it (zero-trust)
 *   EXECUTE   resolveAndExecute() run a matching verified wasm skill instead of the LLM
 *
 * Design guardrails (matching the sovereignty/security thesis):
 *  - OBSERVE and EXECUTE NEVER throw into the request path — a failure degrades to "no
 *    skill", so the LLM fallback always answers. Self-evolution can't break serving.
 *  - EXECUTE is gated by `executeEnabled` (default OFF) AND by signature verification AND
 *    by a strict semantic-match distance — a skill runs only if it is sealed, valid, and
 *    confidently the right one.
 *  - VERIFY checks every inbound peer skill against the ORIGIN node's pinned public key
 *    (not ours) — quantum-resistant, tamper-evident, no implicit trust.
 */

function safeName(id) { return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_'); }
function skillIdForIntent(intent) {
  return 'auto_' + crypto.createHash('sha1').update(String(intent || '')).digest('hex').slice(0, 12);
}

// ---- node identity key persistence (stable signer identity across restarts) --------
function serializeBundle(kp) {
  const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  return { publicKey: enc(kp.publicKey), privateKey: enc(kp.privateKey) };
}
function reviveBundle(raw) {
  const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  return { publicKey: dec(raw.publicKey), privateKey: dec(raw.privateKey) };
}

/**
 * Load the node's hybrid signing identity from `file`, creating + persisting one (0600)
 * if absent. The private key is written to a gitignored path and never logged.
 */
export function loadOrCreateNodeKeys(file) {
  try {
    return reviveBundle(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    const kp = generateHybridKeyPair();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(serializeBundle(kp)), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return kp;
  }
}

export class SelfEvolutionEngine {
  constructor(opts = {}) {
    this.keyBundle = opts.keyBundle || generateHybridKeyPair();
    this.distSkillsDir = opts.distSkillsDir || './dist/skills';
    this.verbose = opts.verbose !== false;
    this.enabled = opts.enabled !== false;        // OBSERVE/LEARN master switch
    this.executeEnabled = !!opts.executeEnabled;  // EXECUTE gate (default OFF — opt-in)
    this.matchMaxDistance = opts.matchMaxDistance ?? 0.25; // strict: only run a confident match
    this.p2pSync = opts.p2pSync || null;
    this.trustedPeers = new Map();                // peerId -> publicKeyBundle (pinned)

    this.compiler = new GsiCompiler({ distSkillsDir: this.distSkillsDir, verbose: this.verbose });
    this.inducer = new SkillInductionEngine({ verbose: this.verbose });
    this.executor = new SkillExecutor({ publicKeyBundle: this.keyBundle.publicKey, verbose: this.verbose });
  }

  // ---- OBSERVE -----------------------------------------------------------------
  /**
   * Record a successful task outcome and its input/output examples so the night shift
   * can induce + compile a skill from it. Safe: returns null on any failure, never throws.
   * @param {Object} o - { intent, examples?:[{input,output}], computation?, steps? }
   */
  async captureSuccess(o = {}) {
    if (!this.enabled) return null;
    try {
      const intent = (o.intent || '').toString();
      if (!intent) return null;
      const skillId = skillIdForIntent(intent);
      const ast = { id: skillId };

      // Accumulate examples across captures: a transform needs MANY observations before the
      // night-shift inducer can trust it (≥2 distinct inputs). Merge the new example(s) into
      // whatever this skill id already learned, deduping by input (latest output wins).
      let mergedExamples = Array.isArray(o.examples) ? [...o.examples] : [];
      if (mergedExamples.length) {
        try {
          const prior = await getCognitiveSkillById(skillId);
          const priorAst = prior?.ast_graph ? JSON.parse(prior.ast_graph) : null;
          if (priorAst && Array.isArray(priorAst.examples)) {
            const byInput = new Map();
            for (const ex of [...priorAst.examples, ...mergedExamples]) {
              const key = JSON.stringify(ex.input ?? ex.in ?? ex.x);
              byInput.set(key, ex); // later (new) observation overrides an older one
            }
            mergedExamples = [...byInput.values()];
          }
        } catch { /* corrupt prior row — fall back to the new examples only */ }
        ast.examples = mergedExamples;
      }
      if (o.computation) ast.computation = o.computation;
      if (Array.isArray(o.steps) && o.steps.length) ast.steps = o.steps;
      if (!ast.examples && !ast.computation && !ast.steps) return null; // nothing learnable
      await insertCognitiveSkill({ skillId, triggerIntent: intent, astGraph: ast, successRate: 1.0 });
      if (this.verbose) console.log(`👁️  [SelfEvolution] captured success "${intent}" (${skillId}, ${ast.examples?.length || 0} ex)`);
      return skillId;
    } catch (e) {
      if (this.verbose) console.warn('[SelfEvolution] capture failed:', e.message);
      return null;
    }
  }

  // ---- LEARN (+ optional DISTRIBUTE) ------------------------------------------
  async runNightShift(opts = {}) {
    const result = await this.compiler.compileFromDatabase(this.keyBundle.privateKey, opts);
    if (this.p2pSync) {
      for (const c of result.compiled) {
        try { await this.broadcastSkill(c); }
        catch (e) { if (this.verbose) console.warn('[SelfEvolution] broadcast failed:', e.message); }
      }
    }
    return result;
  }

  /** Start the nightly cron (LEARN). startNightShift lazily imports node-cron, so handle the promise. */
  startScheduler(schedule) {
    if (schedule) this.compiler.cronSchedule = schedule;
    return Promise.resolve(this.compiler.startNightShift(this.keyBundle.privateKey))
      .catch((err) => console.error('❌ [SelfEvolution] night-shift scheduler failed to start:', err.message));
  }
  stopScheduler() { this.compiler.stopNightShift(); }

  // ---- DISTRIBUTE -------------------------------------------------------------
  /** Append a compiled, signed skill to the P2P mesh ledger for agent-to-agent sharing. */
  async broadcastSkill(compiledRecord) {
    if (!this.p2pSync) return null;
    const wasm = fs.readFileSync(compiledRecord.file);
    const wasmHash = crypto.createHash('sha256').update(wasm).digest('hex');
    const sigBytes = parseCustomSection(wasm, 'stratos.gsi.signature');
    const signature = sigBytes ? sigBytes.toString('base64') : '';
    await this.p2pSync.appendSkillBlock(
      compiledRecord.id,
      { kind: compiledRecord.kind, bytes: wasm.length },
      wasmHash,
      signature
    );
    if (this.verbose) console.log(`📡 [SelfEvolution] broadcast "${compiledRecord.id}" to mesh ledger`);
    return wasmHash;
  }

  // ---- VERIFY (inbound, zero-trust) -------------------------------------------
  /** Pin a peer's public key as trusted (the trust root; DID/SD-JWT pinning is future work). */
  trustPeer(peerId, publicKeyBundle) { this.trustedPeers.set(peerId, publicKeyBundle); }

  /**
   * Accept a peer's skill ONLY if its hybrid PQC seal verifies against that peer's pinned
   * public key. Refuses unsigned/tampered/unknown-signer skills before persisting them.
   * @returns {boolean} whether the skill was accepted + written to local dist.
   */
  ingestRemoteSkill(peerId, skillId, wasmBuffer) {
    const peerKey = this.trustedPeers.get(peerId);
    if (!peerKey) { if (this.verbose) console.warn(`[SelfEvolution] reject "${skillId}": untrusted peer ${peerId}`); return false; }
    const ok = GsiCompiler.verifyWasmSkill(wasmBuffer, peerKey);
    if (!ok) { if (this.verbose) console.warn(`[SelfEvolution] reject "${skillId}": signature invalid`); return false; }
    const file = path.join(this.distSkillsDir, `skill_${safeName(skillId)}.wasm`);
    fs.mkdirSync(this.distSkillsDir, { recursive: true });
    fs.writeFileSync(file, wasmBuffer);
    if (this.verbose) console.log(`✅ [SelfEvolution] accepted verified peer skill "${skillId}" from ${peerId}`);
    return true;
  }

  // ---- EXECUTE ----------------------------------------------------------------
  /**
   * If a sealed, valid, confidently-matching skill exists for `intent`, run it and return
   * its result; otherwise return null so the caller falls back to the LLM. Never throws.
   */
  async resolveAndExecute(intent, input = 0) {
    if (!this.executeEnabled) return null;
    try {
      const matches = await queryCognitiveSkill(intent, 1);
      if (!matches || !matches.length) return null;
      const m = matches[0];
      if (m._distance != null && m._distance > this.matchMaxDistance) return null; // not confident
      const file = path.join(this.distSkillsDir, `skill_${safeName(m.skill_id)}.wasm`);
      if (!fs.existsSync(file)) return null;
      const out = await this.executor.run(file, input); // verify-gated inside
      if (!out || out.verified !== true) return null;
      if (this.verbose) console.log(`⚡ [SelfEvolution] served "${intent}" from skill ${m.skill_id} (dist=${m._distance?.toFixed?.(3)})`);
      return { skillId: m.skill_id, distance: m._distance, ...out };
    } catch (e) {
      if (this.verbose) console.warn('[SelfEvolution] execute failed:', e.message);
      return null;
    }
  }
}
