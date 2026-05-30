import fs from 'node:fs';
import path from 'node:path';
import { TraceAnalyzer } from './trace-analyzer.js';
import { GsiCompiler } from '../../gsi-compiler.js';
import { signPayload } from '../security/quantum-crypto.js';

/**
 * NightShiftCompiler: Automatically sweeps successful developer workflows during off-peak
 * hours, executes TraceAnalyzer scoring, compiles Wasm skill blocks, and seals them
 * with ML-DSA-65 post-quantum digital signatures.
 */
export class NightShiftCompiler {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.analyzer = new TraceAnalyzer({ verbose: this.verbose });
    this.compiler = new GsiCompiler({ verbose: this.verbose });
    
    this.skillsOutputDirectory = options.skillsOutputDirectory || './dist/skills';
    if (!fs.existsSync(this.skillsOutputDirectory)) {
      fs.mkdirSync(this.skillsOutputDirectory, { recursive: true });
    }
  }

  /**
   * Triggers a comprehensive overnight evolution cycle.
   * Sweeps LanceDB, processes logs, generates compiled Wasm skills, and signs them.
   * 
   * @param {ReasoningBank} reasoningBank - The initialized LanceDB bank instance
   * @param {Object} nodePrivateKeyBundle - Ed25519 + ML-DSA-65 key bundle
   * @returns {Promise<Array<Object>>} - Array of compiled, signed WASM skill records
   */
  async runOvernightShift(reasoningBank, nodePrivateKeyBundle) {
    if (this.verbose) {
      console.log('🌙 [NightShiftCompiler] Initiating 2:00 AM dynamic self-evolution Night Shift...');
    }

    // 1. Fetch matching historical traces from LanceDB
    const mockVector = [1, 0, 0];
    const records = await reasoningBank.vectorSearch('knowledge-base', mockVector, 50);

    // 2. Evaluate and score success pathways using the TraceAnalyzer
    const audit = this.analyzer.analyzeTraces(records);
    if (audit.traces.length === 0) {
      if (this.verbose) {
        console.log('💤 [NightShiftCompiler] Zero successful new pathways awaiting compilation. Night shift idling.');
      }
      return [];
    }

    const compiledSkills = [];

    // 3. Compile and Seal each validated trace
    for (const trace of audit.traces) {
      if (this.verbose) {
        console.log(`⚙️  [NightShiftCompiler] Compiling: [${trace.id}] | Trigger: "${trace.triggerIntent}"`);
      }

      // Convert trace steps into sandboxed Wasm structure using the GsiCompiler
      const { signature, signedBlock } = await this.compiler.compile(trace.steps);

      // 4. Generate post-quantum hybrid signatures
      const pqcSignature = signPayload(signedBlock, nodePrivateKeyBundle);

      // Write compiled binary module to skill registry
      const outputFilename = `skill_${trace.id}_${Date.now()}.wasm`;
      const outputPath = path.join(this.skillsOutputDirectory, outputFilename);
      
      fs.writeFileSync(outputPath, signedBlock);

      compiledSkills.push({
        skillId: trace.id,
        triggerIntent: trace.triggerIntent,
        binaryPath: outputPath,
        signature: pqcSignature,
        qualityScore: trace.qualityScore
      });

      if (this.verbose) {
        console.log(`✅ [NightShiftCompiler] Cryptographically sealed and saved: ${outputFilename}`);
      }
    }

    return compiledSkills;
  }
}
