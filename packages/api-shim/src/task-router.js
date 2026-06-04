import { route, autoEscalateEnabled } from '../../stratos-agent/src/routing/model-router.js';
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

    // 2. An explicit LOCAL model name pins local. A *cloud* model name does NOT force cloud: an
    //    OpenAI-compatible client almost always sends some model (often a library default like
    //    "gpt-4o"), so treating that as "force cloud" would silently break sovereignty for every
    //    client. The named model is only the cloud TARGET if the router decides to escalate.
    const wantsLocalModel = /local|quantized|qwen|llama|gemma|mistral|phi|deepseek/i.test(model || '');
    if (wantsLocalModel) {
      return { decision: 'local', reason: `Explicit local model "${model}".`, targetModel: model };
    }

    // 3. Everything else → the ONE sovereign router, decided from the PROMPT. `/private` pins local.
    //    Cloud escalation needs a configured BYOK key (the only way a cloud call could succeed) AND
    //    deploy-time opt-in (STRATOS_CLOUD_AUTO_ESCALATE=true). Secure-by-default: with the flag off,
    //    a hard prompt stays local — cloud then requires an explicit /force-cloud per request. This
    //    blocks untrusted input from inflating difficulty to force cloud spend/egress.
    const priv = query.includes('/private');
    const keyed = hasFrontierKey();
    const escalate = keyed && autoEscalateEnabled();
    const decision = route(
      { prompt, private: priv, escalate },               // model intentionally NOT passed (see above)
      { hasFrontierKey: keyed, meshAvailable: meshAvailable() },
    );

    if (decision.cloud) {
      return { decision: 'cloud', reason: decision.reason, targetModel: model || 'gpt-4o' };
    }
    // Local tiers (local-fast / local-strong / mesh): server.js calls selectLocalModel() next to pick
    // the concrete Ollama tag, so targetModel here is just a safe default.
    return { decision: 'local', reason: `${decision.reason} [${decision.tier}]`, targetModel: 'qwen2.5:7b' };
  }

  /** Extract the text of the last user message from the message log. */
  extractLastUserMessage(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) return '';
    const userMsgs = messages.filter(m => m.role === 'user');
    if (userMsgs.length === 0) return '';
    const content = userMsgs[userMsgs.length - 1].content;
    if (Array.isArray(content)) return content.map(c => c.text || '').join('\n');
    return content || '';
  }
}
