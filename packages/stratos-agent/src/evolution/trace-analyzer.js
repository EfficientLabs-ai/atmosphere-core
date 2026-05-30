/**
 * TraceAnalyzer: Evaluates historical on-device developer action logs and prompts
 * from LanceDB memory banks. Isolates high-confidence success patterns (success_rate = 1.0)
 * and prepares them for dynamic WASM compilation, replacing legacy mutation mechanics (DSPy).
 */
import crypto from 'node:crypto';
import { induceComputation } from './skill-induction.js';

export class TraceAnalyzer {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.successThreshold = options.successThreshold || 1.0;
  }

  /**
   * Evaluates a set of raw behavioral traces from LanceDB vector tables.
   * Scrapes step durations, selector patterns, and state transitions.
   * 
   * @param {Array<Object>} records - Raw logs from ambient_memory and cognitive_skills
   * @returns {Object} - Compiled traces ready for compilation, labeled with quality scores
   */
  analyzeTraces(records) {
    if (this.verbose) {
      console.log(`🌙 [TraceAnalyzer] Evaluating ${records.length} behavioral logs for GSI evolution...`);
    }

    const highQualityTraces = [];

    for (const record of records) {
      // Filter strictly for verified success pathways
      const successRate = record.success_rate || record.successRate || 0.0;
      if (successRate < this.successThreshold) {
        if (this.verbose) {
          console.log(`  - [Trace Dropped] record: [${record.skill_id || record.id}] below threshold: ${successRate}`);
        }
        continue;
      }

      // Analyze step patterns and compile an optimized step list
      const rawSteps = record.ast_graph ? JSON.parse(record.ast_graph).steps : (record.steps || []);
      const sanitizedSteps = this.sanitizeStepFlow(rawSteps);

      highQualityTraces.push({
        id: record.skill_id || record.id,
        triggerIntent: record.trigger_intent || record.intent || '',
        steps: sanitizedSteps,
        qualityScore: this.calculateQualityMetric(sanitizedSteps, successRate),
        timestamp: Date.now()
      });
    }

    if (this.verbose) {
      console.log(`✅ [TraceAnalyzer] Ingestion audit complete. Isolated ${highQualityTraces.length} high-fidelity traces.`);
    }

    return {
      traces: highQualityTraces,
      averageQuality: highQualityTraces.length > 0 
        ? highQualityTraces.reduce((sum, t) => sum + t.qualityScore, 0) / highQualityTraces.length 
        : 0
    };
  }

  /**
   * Sanitizes step listings to strip duplicate hover coordinates and dead-clicks.
   */
  sanitizeStepFlow(steps) {
    if (!Array.isArray(steps)) return [];
    
    // Deduplicate consecutive identical selector actions (e.g. repeated focus/hover events)
    const result = [];
    let lastStep = null;
    
    for (const step of steps) {
      if (lastStep && lastStep.type === step.type && lastStep.target === step.target && step.type === 'hover') {
        continue; // Strip redundant hovers
      }
      result.push(step);
      lastStep = step;
    }
    
    return result;
  }

  /**
   * Calculates a custom complexity-based quality score.
   */
  calculateQualityMetric(steps, successRate) {
    // Base score represents success, bonus awarded for logical complexity density
    let score = successRate * 100;
    
    // Reward structured steps
    score += steps.length * 1.5;
    
    // Clamp between 0 and 150
    return Math.min(Math.round(score), 150);
  }

  /**
   * Classifies a raw skill record into the kind of artifact it can become:
   *   - 'computational': the trace encodes a deterministic transform (a `computation`
   *     spec such as {type:'affine',a,b} or {type:'const',value}). These compile to
   *     REAL executing wasm whose `compute` returns the correct value.
   *   - 'automation': a browser/DOM workflow (steps). These cannot run as sandboxed wasm,
   *     so they become a signed, replayable manifest (+ an integrity `compute`).
   */
  classify(record) {
    let ast = {};
    try { ast = record.ast_graph ? JSON.parse(record.ast_graph) : (record.astGraph || {}); }
    catch { ast = {}; }

    if (ast.computation && typeof ast.computation === 'object' && ast.computation.type) {
      return { kind: 'computational', computation: ast.computation, steps: null };
    }

    // No hand-supplied spec? Try to SYNTHESIZE one from observed input→output examples
    // (Tier A deterministic induction). This is what removes "you supply the spec".
    if (Array.isArray(ast.examples) && ast.examples.length) {
      const induced = induceComputation(ast.examples);
      if (induced) {
        if (this.verbose) {
          console.log(`🔬 [TraceAnalyzer] Induced ${induced.type} computation from ${ast.examples.length} examples.`);
        }
        return { kind: 'computational', computation: induced, steps: null, induced: true };
      }
    }

    const steps = this.sanitizeStepFlow(ast.steps || record.steps || []);
    return { kind: 'automation', computation: null, steps };
  }

  /**
   * Deterministic content hash over a skill's *meaning* (kind + computation + steps +
   * intent). Used to dedupe across nightly runs: an unchanged skill yields the same hash,
   * so it is not recompiled. Stable key ordering → reproducible digests.
   */
  contentHash(spec) {
    const canonical = JSON.stringify({
      kind: spec.kind,
      computation: spec.computation || null,
      steps: spec.steps || null,
      triggerIntent: spec.triggerIntent || ''
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Distills raw success traces into normalized, classified, content-addressed skill
   * descriptors ready for compilation. Each descriptor carries a clean `manifest` that
   * becomes the signed `stratos.gsi.pathway` section of the compiled wasm.
   *
   * @param {Array<Object>} records - rows from cognitive_skills (success_rate, ast_graph, ...)
   * @returns {Array<{id,kind,contentHash,qualityScore,manifest}>}
   */
  distill(records) {
    const out = [];
    for (const record of records || []) {
      const successRate = record.success_rate ?? record.successRate ?? 0;
      if (successRate < this.successThreshold) continue;

      const id = record.skill_id || record.id;
      const triggerIntent = record.trigger_intent || record.intent || '';
      const cls = this.classify(record);
      const contentHash = this.contentHash({ ...cls, triggerIntent });

      const manifest = {
        id,
        kind: cls.kind,
        triggerIntent,
        computation: cls.computation,
        steps: cls.steps,
        contentHash
      };
      const qualityScore = this.calculateQualityMetric(cls.steps || [], successRate);
      out.push({ id, kind: cls.kind, contentHash, qualityScore, manifest });
    }
    if (this.verbose) {
      const comp = out.filter(d => d.kind === 'computational').length;
      console.log(`🧪 [TraceAnalyzer] Distilled ${out.length} skills (${comp} computational, ${out.length - comp} automation).`);
    }
    return out;
  }
}
