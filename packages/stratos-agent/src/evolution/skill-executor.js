import fs from 'node:fs';
import { GsiCompiler, parseCustomSection } from '../../gsi-compiler.js';

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

    // 2a. Computational skill: run the real wasm compute().
    if (manifest.kind === 'computational' || manifest.computation) {
      const wm = await WebAssembly.instantiate(wasm, {});
      const result = wm.instance.exports.compute((input | 0));
      if (this.verbose) console.log(`▶️  [SkillExecutor] computational "${manifest.id}" compute(${input}) = ${result}`);
      return { id: manifest.id, kind: 'computational', verified, input, result };
    }

    // 2b. Automation skill: replay the signed step manifest.
    const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
    const trace = [];
    for (const step of steps) {
      if (this.actionExecutor) {
        const r = await this.actionExecutor(step);
        trace.push({ step, result: r });
      } else {
        trace.push({ step, result: 'planned' }); // honest: verified plan, not a live effect
      }
    }
    if (this.verbose) {
      const mode = this.actionExecutor ? 'executed' : 'planned (no driver bound)';
      console.log(`▶️  [SkillExecutor] automation "${manifest.id}" — ${steps.length} step(s) ${mode}`);
    }
    return { id: manifest.id, kind: 'automation', verified, executed: !!this.actionExecutor, steps: steps.length, trace };
  }
}
