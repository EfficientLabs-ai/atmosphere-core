/**
 * TraceAnalyzer: Evaluates historical on-device developer action logs and prompts
 * from LanceDB memory banks. Isolates high-confidence success patterns (success_rate = 1.0)
 * and prepares them for dynamic WASM compilation, replacing legacy mutation mechanics (DSPy).
 */
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
}
