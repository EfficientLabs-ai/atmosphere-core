import crypto from 'node:crypto';
import { queryCognitiveSkill, queryAmbientMemory } from '../../stratos-agent/src/memory/vector-bank.js';
import { route } from '../../stratos-agent/src/routing/model-router.js';
import { meshAvailable } from '../../stratos-agent/src/routing/mesh-signal.js';

// Frontier escalation is OPT-IN: only if the operator configured a BYOK key does a hard prompt get
// to leave the machine. With no key, EVERYTHING stays local — the sovereign default.
const FRONTIER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY'];
const hasFrontierKey = () => FRONTIER_KEYS.some((k) => !!process.env[k]);

/**
 * TaskClassifierRouter: a thin adapter over the single sovereign model router (model-router.js).
 * It maps inbound chat messages + manual directives to the router's request shape, then maps the
 * router's tier decision back to this module's {decision, reason, targetModel} contract that the
 * live server depends on. ONE router decides policy; this class just adapts the I/O.
 *
 * The router's law (so it can never silently exfiltrate): LOCAL is the default, PRIVACY forces
 * local, and CLOUD is opt-in only (needs a configured key AND real difficulty). This replaces the
 * old "default to cloud for max intelligence" fallback, which sent general prompts to frontier APIs
 * by default — the opposite of the sovereignty promise.
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
    const prompt = this.extractLastUserMessage(messages);
    const query = prompt.toLowerCase().trim();

    // 1. Manual directives are explicit user intent — honor them verbatim (override the policy).
    if (query.includes('/force-local') || query.includes('/local')) {
      return { decision: 'local', reason: 'Explicit /force-local directive.', targetModel: 'qwen2.5:7b' };
    }
    if (query.includes('/force-cloud') || query.includes('/cloud')) {
      return { decision: 'cloud', reason: 'Explicit /force-cloud directive (user opt-in).', targetModel: model || 'gpt-4o' };
    }

    // 2. Everything else goes through the ONE sovereign router. `/private` pins it to this machine;
    //    escalation is allowed only when a BYOK key is configured (a standing opt-in to use cloud
    //    for genuinely hard prompts). No key ⇒ the router keeps every request local.
    const priv = query.includes('/private');
    const keyed = hasFrontierKey();
    const decision = route(
      { prompt, model, private: priv, escalate: keyed },
      { hasFrontierKey: keyed, meshAvailable: meshAvailable() },
    );

    if (decision.cloud) {
      return { decision: 'cloud', reason: decision.reason, targetModel: decision.model || model || 'gpt-4o' };
    }
    // Local tiers (local-fast / local-strong / mesh): server.js calls selectLocalModel() next to pick
    // the concrete Ollama tag, so targetModel here is just a safe default.
    return { decision: 'local', reason: `${decision.reason} [${decision.tier}]`, targetModel: decision.model || 'qwen2.5:7b' };
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
