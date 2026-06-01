/**
 * compliance-router.js — the pluggable, policy-driven model router (the "diversification" engine).
 *
 * It decides WHERE a request runs based on (1) the task class, (2) each backend's declared USE-CLASS and
 * the tasks it is PERMITTED for, and (3) the user's policy. Crucially it is a POLICY ENGINE, never a
 * puppeteer: it only ever routes to backends the operator has declared, and it DEFAULT-DENIES a paid /
 * subscription backend for any task not explicitly permitted on it.
 *
 * Use-classes:
 *   - local / mesh      → sovereign open-weight; free; permitted for anything they're capable of.
 *   - byok-api          → the user's OWN official API key; legal pay-per-use; PERMITTED ONLY for the tasks
 *                         the operator lists (allowedTasks) — deny-by-default.
 *   - frontier-tool     → a frontier tool (Claude Code/Codex) reached via its OFFICIAL interface; same
 *                         deny-by-default permitting. (We never automate a consumer subscription.)
 *
 * The cost/ToS gate (the user's requirement): when a request would incur cloud API spend, the router
 * honors policy.costApproval —
 *   'ask'          → returns { decision:'approval-required', ... } so the gateway can NOTIFY the user and
 *                    ask: reroute to a capable local model, or proceed and spend. (Reuses the write-
 *                    approval human-on-the-loop pattern.)
 *   'auto-local'   → silently prefer a capable local model; only spend if NONE can do the task.
 *   'always-spend' → proceed as requested.
 *
 * Pure + injectable: backends, policy, and provider ToS/pricing info are all passed in. No I/O.
 */

const PAID = new Set(['byok-api', 'frontier-tool']); // use-classes that cost money / touch a provider's terms
const isPaid = (b) => PAID.has(b.useClass);

// a backend is PERMITTED for a task if: free (local/mesh) and capable, OR paid and the task is explicitly
// allow-listed on it (deny-by-default for anything that spends / touches a subscription's terms).
function permitted(b, taskClass) {
  if (!(b.capabilities || []).includes(taskClass)) return false;
  if (!isPaid(b)) return true;
  return Array.isArray(b.allowedTasks) && b.allowedTasks.includes(taskClass);
}

function spendInfo(backend, providers) {
  const p = providers[backend.provider] || {};
  return { provider: backend.provider || backend.id, estCostUsd: p.estCostUsd ?? null, tosNote: p.tosNote || null };
}

export function decideRoute({ request = {}, policy = {}, backends = [], providers = {} } = {}) {
  const taskClass = request.taskClass || 'general';
  const costApproval = ['ask', 'auto-local', 'always-spend'].includes(policy.costApproval) ? policy.costApproval : 'ask';

  const candidates = backends.filter((b) => permitted(b, taskClass));
  if (!candidates.length) return { decision: 'denied', taskClass, reason: 'no capable, permitted backend for this task' };

  const free = candidates.filter((b) => !isPaid(b));
  const paid = candidates.filter(isPaid);

  // did the user explicitly ask for a specific (paid) model?
  const requested = request.model
    ? candidates.find((b) => b.id === request.model || (Array.isArray(b.models) && b.models.includes(request.model)))
    : null;
  const requestedPaid = requested && isPaid(requested) ? requested : null;

  const route = (backend, extra = {}) => ({ decision: 'route', backend: backend.id, useClass: backend.useClass, spend: isPaid(backend), taskClass, ...extra });

  // --- a capable FREE/local backend exists → we can avoid spend -------------------------------------
  if (free.length) {
    if (requestedPaid) {
      // the user named a paid model, but a local one can do it → the cost gate kicks in
      if (costApproval === 'always-spend') return route(requestedPaid, { reason: 'honoring explicit model request' });
      if (costApproval === 'auto-local') return route(free[0], { rerouted: true, reason: 'auto-local: a capable local model is preferred' });
      return { // 'ask'
        decision: 'approval-required', taskClass,
        wouldSpendOn: requestedPaid.id, ...spendInfo(requestedPaid, providers),
        alternativeLocal: free[0].id,
        options: ['reroute-local', 'proceed-spend'],
        prompt: `"${requestedPaid.id}" (${requestedPaid.provider || 'cloud'}) would incur API spend under that provider's terms. Reroute to local "${free[0].id}" (free, sovereign), or proceed and spend?`,
      };
    }
    return route(free[0], { reason: policy.saveApiSpend ? 'save-api-spend: capable local model' : 'capable local model available' });
  }

  // --- only a PAID backend can do this task ---------------------------------------------------------
  const target = requestedPaid || paid[0];
  if (costApproval === 'always-spend' || costApproval === 'auto-local') {
    // auto-local "spends only if needed" — and here it IS needed (no local can do it)
    return route(target, { reason: costApproval === 'auto-local' ? 'no capable local model; spending only because needed' : 'proceeding as requested' });
  }
  return { // 'ask' and no local alternative
    decision: 'approval-required', taskClass,
    wouldSpendOn: target.id, ...spendInfo(target, providers),
    alternativeLocal: null,
    options: ['proceed-spend'],
    prompt: `This task needs "${target.id}" (${target.provider || 'cloud'}), which incurs API spend under that provider's terms. No local model can do it. Proceed and spend, or cancel?`,
  };
}
