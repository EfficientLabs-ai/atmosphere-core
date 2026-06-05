/**
 * model-router.js — ONE simple, honest router (not a four-layer ML routing stack).
 *
 * Codex's correction was explicit: don't stack semantic-router + RouteLLM + vLLM tiering before a
 * stable backend exists. So this is a single, transparent policy that encodes the sovereignty rule:
 *
 *   • LOCAL is the default. Cloud is never the default.
 *   • PRIVACY forces local — a request marked private never leaves this machine (not even the mesh).
 *   • CLOUD is OPT-IN ONLY — it requires an explicit escalate flag AND a configured key AND real
 *     difficulty. It is never silent.
 *   • The MESH (your other machines) absorbs heavy work without leaving your control.
 *
 * The difficulty signal is a simple heuristic, not a model — honest about what it is. The router
 * decides the TIER; model-manager.js then picks the concrete local model within a local tier.
 */

export const TIERS = Object.freeze(['local-fast', 'local-strong', 'mesh', 'frontier']);

const LOCAL_FAMILY = /^(qwen|gemma|llama|mistral|phi|deepseek)/i;
const CLOUD_FAMILY = /^(gpt|o\d|claude|gemini|grok)/i;
// A "vendor/model" slug is always cloud/BYOK (the slash-guard) even if the vendor name also names a
// local family (e.g. deepseek/deepseek-chat). A bare name is cloud only if it's a known cloud family.
const isCloudModel = (m) => {
  if (typeof m !== 'string' || !m) return false;
  if (m.includes('/')) return true;
  return CLOUD_FAMILY.test(m) && !LOCAL_FAMILY.test(m);
};

/** A transparent 0–5 difficulty heuristic. Not an ML classifier; just length + a few markers. */
export function difficulty(prompt) {
  const p = String(prompt || '');
  let s = 0;
  if (p.length > 1200) s += 2; else if (p.length > 400) s += 1;
  if (/\b(prove|derive|refactor|architect|debug|algorithm|optimi[sz]e|step[- ]by[- ]step|reason through|plan)\b/i.test(p)) s += 2;
  if (/```|\bfunction\b|\bclass\b|=>|\bdef \b|\bimport \b/.test(p)) s += 1;          // code
  if (/\bintegral\b|\bmatrix\b|\bequation\b|\bderivative\b|\d+\s*[+\-*/^]\s*\d+/i.test(p)) s += 1; // math
  return Math.min(5, s);
}

/**
 * Difficulty-based auto-escalation to cloud is OPT-IN AT DEPLOY TIME (secure-by-default). Even with a
 * configured BYOK key, a hard prompt does NOT silently escalate unless STRATOS_CLOUD_AUTO_ESCALATE=true.
 * This closes the heuristic-injection vector (untrusted input inflating difficulty to force cloud spend
 * + data egress). A `/force-cloud` directive and a deliberate explicit cloud model are unaffected —
 * those are explicit per-request opt-ins, not an automated threshold.
 */
export function autoEscalateEnabled(env = process.env) {
  return env.STRATOS_CLOUD_AUTO_ESCALATE === 'true';
}

/**
 * @param {object} request { prompt?, model?, private?, escalate? }
 * @param {object} ctx     { hasFrontierKey?, meshAvailable? }
 * @returns {{tier:string, cloud:boolean, model?:string, difficulty:number, reason:string}}
 */
export function route(request = {}, ctx = {}) {
  const { prompt = '', model = null, escalate = false } = request;
  const priv = request.private === true;
  const { hasFrontierKey = false, meshAvailable = false } = ctx;
  const d = difficulty(prompt);

  // 1. Explicit model — honor a DELIBERATE model choice (choosing a cloud model IS the opt-in).
  //    NOTE: this is for callers who pass a model on purpose (e.g. `stratos route --model`, or a
  //    future explicit BYOK channel). The live OpenAI-compatible shim (task-router.js) intentionally
  //    does NOT pass the wire `model` here — clients auto-send one (often a library default like
  //    "gpt-4o"), so treating that as opt-in would silently break sovereignty. See task-router.js §2.
  if (model) {
    if (isCloudModel(model)) {
      if (priv) return { tier: 'local-strong', cloud: false, difficulty: d, reason: `privacy overrides explicit cloud model "${model}" — kept local` };
      return { tier: 'frontier', cloud: true, model, difficulty: d, reason: `explicit cloud model "${model}"` };
    }
    return { tier: d >= 3 ? 'local-strong' : 'local-fast', cloud: false, model, difficulty: d, reason: `explicit local model "${model}"` };
  }

  // 2. Privacy → never leaves THIS machine (not cloud, not mesh).
  if (priv) return { tier: d >= 3 ? 'local-strong' : 'local-fast', cloud: false, difficulty: d, reason: 'privacy: stays on this machine' };

  // 3. Cloud escalation — OPT-IN ONLY: needs the flag AND a key AND real difficulty.
  if (escalate && hasFrontierKey && d >= 4) {
    return { tier: 'frontier', cloud: true, difficulty: d, reason: `opt-in escalation (difficulty ${d})` };
  }

  // 4. Heavy work + mesh available → your other machines (still sovereign).
  if (d >= 4 && meshAvailable) return { tier: 'mesh', cloud: false, difficulty: d, reason: `difficulty ${d} → mesh (your hardware)` };

  // 5. Default: local. Strong local for harder asks, fast local otherwise.
  return { tier: d >= 3 ? 'local-strong' : 'local-fast', cloud: false, difficulty: d, reason: `difficulty ${d} → local (sovereign default)` };
}
