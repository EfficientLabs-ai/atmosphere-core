import crypto from 'node:crypto';
import { queryCognitiveSkill, queryAmbientMemory } from '../../../packages/stratos-agent/src/memory/vector-bank.js';

/**
 * TaskClassifierRouter: Advanced context-aware intelligence classifier
 * that automatically categorizes incoming developer prompts into either
 * "local" (on-device Ollama) or "cloud" (frontier APIs) routing targets
 * based on syntax density, semantic complexity, and LanceDB RAG matching.
 */
export class TaskClassifierRouter {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
  }

  /**
   * Semantically evaluates the input messages and requested model to make a routing decision.
   * Returns a decision object containing:
   *  - decision: 'local' | 'cloud'
   *  - reason: Concise architectural rationale
   *  - targetModel: Mapped model identifier
   */
  async classify(messages, model = '') {
    const lastUserMsg = this.extractLastUserMessage(messages);
    const query = lastUserMsg.toLowerCase().trim();

    // 1. Respect Explicit Manual Force Directives
    if (query.includes('/force-local') || query.includes('/local')) {
      return {
        decision: 'local',
        reason: 'Explicit manual route directive "/force-local" detected.',
        targetModel: 'qwen2.5:7b'
      };
    }
    if (query.includes('/force-cloud') || query.includes('/cloud')) {
      return {
        decision: 'cloud',
        reason: 'Explicit manual route directive "/force-cloud" detected.',
        targetModel: model || 'gpt-4o'
      };
    }

    // 2. Route Explicit Local Model targets
    const isExplicitLocalModel = model && (
      model.includes('local') ||
      model.includes('quantized') ||
      model.includes('qwen') ||
      model.includes('llama')
    );
    if (isExplicitLocalModel) {
      return {
        decision: 'local',
        reason: `Explicit local model target "${model}" requested.`,
        targetModel: 'qwen2.5:7b'
      };
    }

    // 3. Simple Factual, Syntactic, or System Check Filtering
    const isSystemOrSimple = this.checkSimpleTriggers(query);
    if (isSystemOrSimple) {
      return {
        decision: 'local',
        reason: 'Simple factual coding query, greeting, or sovereign system check detected.',
        targetModel: 'qwen2.5:7b'
      };
    }

    // 4. Advanced Logical Reasoning & Code Complexity Detection (Frontier Required)
    const complexityScore = this.evaluateComplexityScore(query);
    if (complexityScore >= 5) {
      return {
        decision: 'cloud',
        reason: `High complexity density detected (Complexity Score: ${complexityScore}/10). Requiring frontier reasoning core.`,
        targetModel: model || 'gpt-4o'
      };
    }

    // 5. LanceDB RAG Match Score Synergy (Sovereign Context matching)
    const hasLocalRAGSynergy = await this.probeLocalRAGSynergy(query);
    if (hasLocalRAGSynergy) {
      return {
        decision: 'local',
        reason: 'High-confidence historical matches found inside LanceDB vector memory. Resolving via context-augmented RAG.',
        targetModel: 'qwen2.5:7b'
      };
    }

    // Default Fallback Routing: For general conversational topics or medium tasks,
    // we default to Cloud to ensure maximum intelligence unless explicitly toggling save cost.
    return {
      decision: 'cloud',
      reason: 'General conversational or medium-complexity prompt. Routing to frontier model for high-fidelity response.',
      targetModel: model || 'gpt-4o'
    };
  }

  /**
   * Extracts text content of the last user message from the message logs.
   */
  extractLastUserMessage(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) return '';
    const userMsgs = messages.filter(m => m.role === 'user');
    if (userMsgs.length === 0) return '';
    const content = userMsgs[userMsgs.length - 1].content;
    if (Array.isArray(content)) {
      return content.map(c => c.text || '').join('\n');
    }
    return content || '';
  }

  /**
   * Evaluates simple triggers suited for local open-weights resolution.
   */
  checkSimpleTriggers(query) {
    // Standard developer greetings
    const greetings = /^(hello|hi|hey|greetings|good morning|good afternoon|howdy)/i;
    if (greetings.test(query)) return true;

    // Sovereign system, P2P mesh, and ledger actions
    const systemKeywords = [
      'mesh status', 'p2p status', 'pm2 logs', 'stratos-ctl',
      'solana balance', 'solana wallet', 'x402 payments',
      'micropayments', 'off-chain state channels', '/status', '/balance', '/vision', '/compile'
    ];
    if (systemKeywords.some(kw => query.includes(kw))) return true;

    // Simple language reference or syntax queries
    const syntaxKeywords = [
      'syntax of', 'how to write simple', 'regex for', 'convert to es6',
      'what is array.map', 'difference between let and const', 'simple html template'
    ];
    if (syntaxKeywords.some(kw => query.includes(kw))) return true;

    return false;
  }

  /**
   * Computes a complexity score (0-10) based on logic indicators, multi-file structures, and architectural tasks.
   */
  evaluateComplexityScore(query) {
    let score = 0;

    // Multi-file architecture indicators
    if (query.match(/(?:multi-file|across files|whole project|entire codebase|refactor all|module architecture)/i)) score += 5;

    // High logical reasoning / advanced CS topics
    if (query.match(/(?:multi-threaded|concurrency|race condition|deadlock|quantum|post-quantum|ml-kem|ml-dsa|cryptographic signature|zero-knowledge|zk-proof|zkp)/i)) score += 5;

    // Deep architectural auditing
    if (query.match(/(?:security audit|vulnerabilities|leakage|memory leak|heap dump|distill AST|compiler optimization|heap snapshot)/i)) score += 4;

    // Long descriptive prompts indicating complex workflows
    if (query.length > 800) score += 3;
    else if (query.length > 400) score += 1;

    return Math.min(score, 10);
  }

  /**
   * Probes LanceDB vector storage for semantically matching skills or contexts.
   * If a high-confidence record is matched locally, returns true.
   */
  async probeLocalRAGSynergy(query) {
    try {
      // Limit to 1 match check to satisfy low-latency lookup parameters
      const skills = await queryCognitiveSkill(query, 1).catch(() => []);
      if (skills.length > 0) {
        if (this.verbose) {
          console.log(`🎯 [TCR Router] Found active matching cognitive skill reference in LanceDB: ${skills[0].skill_id}`);
        }
        return true;
      }

      const ambient = await queryAmbientMemory(query, 1).catch(() => []);
      if (ambient.length > 0) {
        if (this.verbose) {
          console.log(`🎯 [TCR Router] Found matching ambient memory reference in LanceDB: ${ambient[0].source}`);
        }
        return true;
      }
    } catch (err) {
      // Safe fallback on database locks or errors
    }
    return false;
  }
}
