import fs from 'node:fs';
import { GsiCompiler, parseCustomSection } from '../../gsi-compiler.js';
import { parseCapabilities, assertComputeAllowed, assertStepAllowed } from '../security/capability-gate.js';
import { hashContent } from '../ledger/capability-receipt.js';

/**
 * SkillExecutor: loads a compiled .wasm skill, VERIFIES its post-quantum seal before
 * doing anything, then runs it according to its kind:
 *
 *   - computational : instantiates the wasm and calls the real `compute(input)` export,
 *                     returning the genuinely-computed result.
 *   - automation    : replays the signed `stratos.gsi.pathway` step manifest through a
 *                     pluggable `actionExecutor`. With a real executor bound (e.g. a
 *                     Playwright/browser-harness driver) the steps run for real; with none
 *                     bound it returns the verified plan (honest dry-run) rather than
 *                     pretending DOM effects happened.
 *
 * The verify-before-execute gate is the security boundary: an unsigned or tampered skill
 * (code OR manifest altered) is refused — it never reaches WebAssembly.instantiate or the
 * action executor.
 */
export class SkillExecutor {
  constructor(options = {}) {
    this.publicKeyBundle = options.publicKeyBundle || null;
    this.actionExecutor = options.actionExecutor || null; // async (step) => result
    this.verbose = options.verbose !== false;
    this.requireSignature = options.requireSignature !== false;
    // Least-privilege: when on, a signed skill may do ONLY what its (sealed) manifest declares.
    // Default off for now so existing skills (no declared caps) keep running; flip on once the
    // compiler stamps capabilities into manifests. The gate itself is deny-by-default.
    this.enforceCapabilities = options.enforceCapabilities === true;
    // Trifecta wiring (all optional, backward-compatible):
    //  - ledger: record each verified run as a 'skill-executed' attribution entry.
    //  - broker: mint a SHORT-LIVED brokered token for a credentialed step (host+scope) so the
    //    skill never holds a raw credential — and only for hosts its capabilities declared.
    //  - contributorId: this node's did:atmos identity, the attributed contributor.
    this.ledger = options.ledger || null;
    this.broker = options.broker || null;
    this.contributorId = options.contributorId || null;
    // Capability-receipt log (cross-machine proof rail): each verified run also emits a 'skill-run'
    // receipt, PQC-signed + hash-chained, third-party-verifiable. Optional + FAIL-OPEN — a missing or
    // broken receipt log degrades to "no receipt" and never affects the run (same contract as ledger).
    this.receiptLog = options.receiptLog || null;
  }

  _record(kind, manifest, units, meta) {
    if (!this.ledger || !this.contributorId) return;
    try { this.ledger.append({ kind, contributor: this.contributorId, subject: manifest?.id ?? null, units, meta }); }
    catch (e) { if (this.verbose) console.warn(`⚠️  [SkillExecutor] ledger record failed: ${e.message}`); }
  }

  /**
   * Emit a signed 'skill-run' capability receipt alongside the ledger record. FAIL-OPEN: any error
   * (no node key, broken signer, unwritable log) is swallowed — the verified run is never blocked or
   * slowed by receipt emission. input/output are HASHED (privacy), cost_units is a measured count.
   */
  _emitReceipt(manifest, input, result, units) {
    if (!this.receiptLog || !this.contributorId) return;
    try {
      this.receiptLog.append({
        actor_id: this.contributorId,
        action: 'skill-run',
        ref: manifest?.id ?? null,
        input_hash: hashContent(input),
        output_hash: hashContent(result),
        cost_units: typeof units === 'number' && Number.isFinite(units) && units >= 0 ? units : 1,
      });
    } catch (e) { if (this.verbose) console.warn(`⚠️  [SkillExecutor] receipt emit skipped: ${e.message}`); }
  }

  /** Reads the signed pathway manifest out of a wasm skill. */
  loadManifest(wasmBinary) {
    const bytes = parseCustomSection(wasmBinary, 'stratos.gsi.pathway');
    if (!bytes) throw new Error('skill has no stratos.gsi.pathway manifest');
    return JSON.parse(bytes.toString('utf8'));
  }

  /**
   * Verify + execute a skill.
   * @param {Buffer|string} wasmInput - the wasm bytes or a path to a .wasm file.
   * @param {number} [input=0] - argument for computational skills' compute(x).
   */
  async run(wasmInput, input = 0) {
    const wasm = Buffer.isBuffer(wasmInput) ? wasmInput : fs.readFileSync(wasmInput);

    // 1. SECURITY GATE — verify the hybrid PQC seal over code+manifest first.
    let verified = false;
    if (this.publicKeyBundle) {
      verified = GsiCompiler.verifyWasmSkill(wasm, this.publicKeyBundle);
      if (!verified && this.requireSignature) {
        throw new Error('SECURITY: skill signature invalid — refusing to execute');
      }
    } else if (this.requireSignature) {
      throw new Error('SECURITY: no publicKeyBundle provided — cannot verify skill, refusing to execute');
    }

    const manifest = this.loadManifest(wasm);
    const caps = parseCapabilities(manifest);

    // 2a. Computational skill: run the real wasm compute().
    if (manifest.kind === 'computational' || manifest.computation) {
      if (this.enforceCapabilities) assertComputeAllowed(caps);
      const wm = await WebAssembly.instantiate(wasm, {});
      const result = wm.instance.exports.compute((input | 0));
      if (this.verbose) console.log(`▶️  [SkillExecutor] computational "${manifest.id}" compute(${input}) = ${result}`);
      this._record('skill-executed', manifest, 1, { kind: 'computational', verified });
      this._emitReceipt(manifest, input, result, 1);
      return { id: manifest.id, kind: 'computational', verified, input, result };
    }

    // 2b. Automation skill: replay the signed step manifest.
    const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
    const trace = [];
    for (const step of steps) {
      if (this.enforceCapabilities) assertStepAllowed(caps, step);
      // Brokered credentials: a step targeting a host+scope gets a SHORT-LIVED brokered token,
      // never a raw credential — and only for hosts the skill's caps declared (deny-by-default).
      let dispatched = step;
      if (this.broker && step && step.host && step.scope) {
        const token = this.broker.issue({ subject: this.contributorId, audience: step.host, scope: step.scope, capabilities: caps });
        dispatched = { ...step, brokeredToken: token };
      }
      if (this.actionExecutor) {
        const r = await this.actionExecutor(dispatched);
        trace.push({ step, result: r });
      } else {
        trace.push({ step, result: 'planned' }); // honest: verified plan, not a live effect
      }
    }
    if (this.verbose) {
      const mode = this.actionExecutor ? 'executed' : 'planned (no driver bound)';
      console.log(`▶️  [SkillExecutor] automation "${manifest.id}" — ${steps.length} step(s) ${mode}`);
    }
    this._record('skill-executed', manifest, steps.length || 1, { kind: 'automation', executed: !!this.actionExecutor });
    this._emitReceipt(manifest, { input, steps: steps.length }, trace, steps.length || 1);
    return { id: manifest.id, kind: 'automation', verified, executed: !!this.actionExecutor, steps: steps.length, trace };
  }
}
