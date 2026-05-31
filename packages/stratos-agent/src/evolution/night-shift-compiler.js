import fs from 'node:fs';
import { TraceAnalyzer } from './trace-analyzer.js';
import { GsiCompiler } from '../../gsi-compiler.js';

/**
 * NightShiftCompiler: the autonomous self-evolution worker. During off-peak hours it
 * sweeps the LanceDB cognitive_skills store for verified-success pathways, distills and
 * classifies them (TraceAnalyzer), compiles each to a signed .wasm skill via the real
 * GsiCompiler engine, and writes them to the mesh skills directory.
 *
 * This is a thin orchestrator over GsiCompiler.compileFromDatabase — the single source of
 * truth for the harvest -> distill -> dedupe -> compile -> full-wasm-sign pipeline. It
 * exists so the evolution layer has a stable, named entrypoint.
 */
export class NightShiftCompiler {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.analyzer = new TraceAnalyzer({ verbose: this.verbose });

    this.skillsOutputDirectory = options.skillsOutputDirectory || './dist/skills';
    if (!fs.existsSync(this.skillsOutputDirectory)) {
      fs.mkdirSync(this.skillsOutputDirectory, { recursive: true });
    }

    // The compiler writes signed skills into this worker's output directory.
    this.compiler = new GsiCompiler({
      verbose: this.verbose,
      distSkillsDir: this.skillsOutputDirectory
    });
  }

  /**
   * Triggers one overnight evolution cycle. Harvests the real cognitive_skills store,
   * compiles every new/changed verified-success skill to a PQC-sealed wasm module, and
   * returns the compiled-skill records.
   *
   * @param {Object} [_reasoningBank] - retained for API compatibility; the live skill
   *        store (LanceDB cognitive_skills) is the canonical source and is read directly.
   * @param {Object} nodePrivateKeyBundle - hybrid Ed25519 + ML-DSA-65 private key bundle.
   * @param {Object} [opts] - { force } to recompile even unchanged skills.
   * @returns {Promise<Array<Object>>} compiled-skill records {skillId, kind, binaryPath, bytes}
   */
  async runOvernightShift(_reasoningBank, nodePrivateKeyBundle, opts = {}) {
    if (this.verbose) {
      console.log('🌙 [NightShiftCompiler] Initiating autonomous self-evolution Night Shift...');
    }
    if (!nodePrivateKeyBundle) {
      throw new Error('[NightShiftCompiler] nodePrivateKeyBundle is required to sign compiled skills.');
    }

    const result = await this.compiler.compileFromDatabase(nodePrivateKeyBundle, opts);

    if (this.verbose && result.compiled.length === 0 && result.skipped.length === 0) {
      console.log('💤 [NightShiftCompiler] Zero successful pathways awaiting compilation. Night shift idling.');
    }

    // Map to the evolution-layer record shape.
    return result.compiled.map(c => ({
      skillId: c.id,
      kind: c.kind,
      binaryPath: c.file,
      bytes: c.bytes
    }));
  }
}
