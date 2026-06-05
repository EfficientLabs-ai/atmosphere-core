/**
 * model-adapter.js — the UNIFIED model-adapter seam (INCREMENT 4: model-agnostic routing).
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 * HOW THIS COMPOSES WITH THE EXISTING ROUTER (no duplication):
 *
 *   • model-router.js  → ALREADY decides the TIER and the sovereignty law: LOCAL default,
 *     PRIVACY forces local, CLOUD is opt-in only, MESH for heavy work. We DO NOT re-implement any of
 *     that. `selectAndComplete()` calls `route()` once and treats its decision as authoritative for
 *     Privacy + (frontier-)opt-in. If `route()` says `cloud:false`, NO frontier provider can be
 *     chosen here — full stop. The adapter only ever *narrows* what the router already allowed; it
 *     can never widen it.
 *
 *   • model-manager.js → ALREADY picks the concrete LOCAL model + knows the provider PROVIDERS map
 *     (BYOK key gating, OpenAI/Gemini/Anthropic/OpenRouter recognition). We do not duplicate provider
 *     recognition; concrete local-model selection still belongs to selectLocalModel() downstream.
 *
 *   • THIS module is the MISSING seam: a single entry point that takes a task + the available
 *     pluggable provider adapters, applies the policy precedence the policy docs specify —
 *         PRIVACY  >  CAPABILITY  >  COST  >  FALLBACK
 *     (see /opt/efficient-labs/models/routing/{privacy,cost,fallback}_policy.md) — and then drives
 *     the chosen provider's `call()`. The ACTUAL network call lives INSIDE each provider's `call`
 *     (injected); this module + its tests make NO real network calls.
 *
 * A provider adapter is a plain object with a uniform shape:
 *     { id, kind:'frontier'|'openweight'|'user', call(req) -> Promise<result>,
 *       capability?: number,   // 0..5 capability score (higher = more capable)
 *       costClass?: 'local'|'mesh'|'frontier',  // marginal-cost class ($0 local/mesh < frontier)
 *       costHint?: number }    // optional finer $/req tiebreak within a cost class
 *
 * User-provided models are kind:'user' and flow through the EXACT SAME interface + precedence — no
 * special path (they are treated as open-weight-equivalent for capability/privacy unless they declare
 * otherwise). Frontier providers still require the router to have allowed cloud (BYOK + opt-in); the
 * adapter never escalates on its own.
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 */
import { route } from './model-router.js';

const FRONTIER = 'frontier';
const OPENWEIGHT = 'openweight';
const USER = 'user';

// Cost ordering: $0 paths first, frontier last. Lower = cheaper = preferred.
const COST_RANK = { local: 0, mesh: 0, openweight: 0, user: 0, frontier: 2 };
const costRank = (p) => {
  if (typeof p.costClass === 'string' && p.costClass in COST_RANK) return COST_RANK[p.costClass];
  // default by kind: frontier is metered, everything else is $0 marginal (local/mesh/user hardware).
  return p.kind === FRONTIER ? COST_RANK.frontier : 0;
};

// Capability default by kind when a provider doesn't declare one: frontier is the high-reasoning tier.
const capabilityOf = (p) => (typeof p.capability === 'number' ? p.capability : (p.kind === FRONTIER ? 5 : 3));

/**
 * Map a task class hint to a minimum capability and whether it WANTS a frontier-tier provider.
 * High-reasoning classes prefer frontier (when the router allows it); batch/extraction classes are
 * happy on open-weight/local. This is a transparent table, not a classifier — honest about what it is.
 */
const CLASS_TABLE = {
  // high-reasoning / planning / architecture → wants frontier capability (if allowed)
  reasoning: { minCapability: 5, wantsFrontier: true },
  planning: { minCapability: 5, wantsFrontier: true },
  architecture: { minCapability: 5, wantsFrontier: true },
  'high-reasoning': { minCapability: 5, wantsFrontier: true },
  // batch / extraction / classification / summarize → open-weight/local is adequate
  batch: { minCapability: 1, wantsFrontier: false },
  extraction: { minCapability: 1, wantsFrontier: false },
  classification: { minCapability: 1, wantsFrontier: false },
  summarize: { minCapability: 1, wantsFrontier: false },
  general: { minCapability: 2, wantsFrontier: false },
};
const classProfile = (classHint) => CLASS_TABLE[String(classHint || 'general').toLowerCase()] || CLASS_TABLE.general;

/**
 * selectAndComplete — the one unified interface.
 *
 * @param {object} args
 * @param {object} args.task         { prompt, model? } forwarded to route() (the existing router).
 * @param {string} [args.classHint]  task-class hint ('reasoning'|'batch'|'extraction'|… see CLASS_TABLE).
 * @param {boolean}[args.privacy]    explicit privacy flag (mirrors task.private; either pins privacy).
 * @param {object} [args.budget]     { maxCostClass?: 'local'|'mesh'|'frontier' } optional spend cap.
 * @param {Array}  args.providers    pluggable adapters [{id,kind,call,capability?,costClass?,costHint?}].
 * @param {object} [args.ctx]        { hasFrontierKey?, meshAvailable? } forwarded to route().
 * @param {function}[args.log]       optional (event)=>void hop logger (defaults to a collected array).
 * @returns {Promise<{result, provider, tier, cloud, reason, decision, hops}>}
 */
export async function selectAndComplete({ task = {}, classHint = 'general', privacy = false, budget = {}, providers = [], ctx = {}, log } = {}) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('model-adapter: at least one provider adapter is required');
  }
  const hops = [];
  const record = (e) => { hops.push(e); if (typeof log === 'function') log(e); };

  // The request carries privacy from EITHER the explicit flag OR task.private. Then the EXISTING
  // router decides the tier + whether cloud is even allowed. We never second-guess that decision.
  const isPrivate = privacy === true || task.private === true;
  const decision = route({ ...task, private: isPrivate }, ctx);
  record({ stage: 'route', tier: decision.tier, cloud: decision.cloud, reason: decision.reason });

  const prof = classProfile(classHint);
  const cloudAllowed = decision.cloud === true; // router authority: privacy/opt-in already applied

  // ── PRECEDENCE STEP 1 — PRIVACY ──────────────────────────────────────────────────────────────
  // If the router did NOT allow cloud (privacy, or no opt-in), strip every frontier provider. A
  // frontier provider can NEVER be chosen when the router kept us local. This is the hard invariant.
  let candidates = providers.filter((p) => (cloudAllowed ? true : p.kind !== FRONTIER));
  record({ stage: 'privacy', cloudAllowed, kept: candidates.map((p) => p.id) });
  if (candidates.length === 0) {
    throw new Error('model-adapter: no provider survived the privacy filter (no local/open-weight provider available for a non-cloud decision)');
  }

  // ── PRECEDENCE STEP 4 (budget pre-filter, part of cost/fallback envelope) ─────────────────────
  // An optional budget cap removes anything costlier than maxCostClass (e.g. force $0-only).
  if (budget && typeof budget.maxCostClass === 'string') {
    const cap = COST_RANK[budget.maxCostClass] ?? COST_RANK.frontier;
    const capped = candidates.filter((p) => costRank(p) <= cap);
    if (capped.length > 0) candidates = capped; // never empty the chain on a budget alone
    record({ stage: 'budget', maxCostClass: budget.maxCostClass, kept: candidates.map((p) => p.id) });
  }

  // ── PRECEDENCE STEP 2 — CAPABILITY, then STEP 3 — COST ────────────────────────────────────────
  // Order the survivors: capability adequacy + class preference FIRST, cheaper SECOND. The resulting
  // ordered list IS the fallback chain (fallback_policy.md).
  const ordered = [...candidates].sort((a, b) => {
    // (2) capability: prefer providers that MEET the class's minimum capability.
    const aMeets = capabilityOf(a) >= prof.minCapability ? 0 : 1;
    const bMeets = capabilityOf(b) >= prof.minCapability ? 0 : 1;
    if (aMeets !== bMeets) return aMeets - bMeets;
    // (2) class preference: a frontier-wanting class prefers frontier-kind providers (when allowed).
    if (prof.wantsFrontier) {
      const aF = a.kind === FRONTIER ? 0 : 1;
      const bF = b.kind === FRONTIER ? 0 : 1;
      if (aF !== bF) return aF - bF;
    }
    // (3) cost: cheaper cost class first ($0 local/mesh/user before metered frontier).
    const cr = costRank(a) - costRank(b);
    if (cr !== 0) return cr;
    // (3) cost tiebreak: finer per-request hint, cheaper first.
    const ah = typeof a.costHint === 'number' ? a.costHint : 0;
    const bh = typeof b.costHint === 'number' ? b.costHint : 0;
    if (ah !== bh) return ah - bh;
    // stable final tiebreak: higher capability first (better default among equals).
    return capabilityOf(b) - capabilityOf(a);
  });
  record({ stage: 'order', chain: ordered.map((p) => p.id) });

  // ── PRECEDENCE STEP 4 — FALLBACK ──────────────────────────────────────────────────────────────
  // Try each provider in order; on a thrown error OR a falsy/{ok:false} result, log the hop and
  // degrade to the next. Deterministic — no hidden retries. The actual network is INSIDE call().
  for (const p of ordered) {
    try {
      const result = await p.call({ ...task, classHint, tier: decision.tier });
      if (result && (result.ok === undefined || result.ok === true)) {
        record({ stage: 'call', provider: p.id, kind: p.kind, ok: true });
        return { result, provider: p.id, kind: p.kind, tier: decision.tier, cloud: decision.cloud, reason: decision.reason, decision, hops };
      }
      record({ stage: 'call', provider: p.id, kind: p.kind, ok: false, error: (result && result.error) || 'provider returned not-ok' });
    } catch (err) {
      record({ stage: 'call', provider: p.id, kind: p.kind, ok: false, error: err && err.message ? err.message : String(err) });
    }
  }

  // Whole chain exhausted — deterministic, honest failure carrying the full hop log.
  const e = new Error(`model-adapter: all ${ordered.length} provider(s) failed (chain: ${ordered.map((p) => p.id).join(' → ')})`);
  e.hops = hops;
  throw e;
}

// Small helpers exported for callers/tests that want the precedence pieces without driving a call.
export const _internals = { classProfile, costRank, capabilityOf, CLASS_TABLE };
