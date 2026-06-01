/**
 * compliance-gateway.js — wires the compliance router (decideRoute) into the live gateway.
 *
 * It turns the user's WIZARD CONFIG (model sources + routing/costApproval) into the router's inputs,
 * classifies each request, and — when a request would incur cloud spend under costApproval:'ask' — the
 * gate returns an approval-required signal so the caller (a channel adapter, where the human is) can ask:
 * reroute to a free local model, or proceed and spend. Honors an override from a prior human decision.
 *
 * SAFE BY DESIGN: the express gate only ACTS on `approval-required`. Every other decision (route local,
 * route a provider, auto-local, always-spend) falls through to the existing routing untouched. It engages
 * only for a wizard-configured agent, so the legacy/unconfigured daemon behaves exactly as before.
 */
import crypto from 'node:crypto';
import { decideRoute } from './compliance-router.js';
import { resolveRoute } from './model-manager.js';
import * as realConfig from '../../stratos-agent/src/core/agent-config.js';

// rough per-call cost estimates + ToS notes shown in the approval prompt (clearly estimates).
const PROVIDERS_INFO = {
  openai: { name: 'OpenAI', estCostUsd: 0.03, tosNote: 'Billed per token under your OpenAI API agreement.' },
  google: { name: 'Google', estCostUsd: 0.02, tosNote: 'Billed per token under your Google AI agreement.' },
  gemini: { name: 'Google', estCostUsd: 0.02, tosNote: 'Billed per token under your Google AI agreement.' },
  anthropic: { name: 'Anthropic', estCostUsd: 0.04, tosNote: 'Billed per token under your Anthropic API agreement.' },
  openrouter: { name: 'OpenRouter', estCostUsd: 0.02, tosNote: 'Billed per token under your OpenRouter account.' },
};

// single-use cost-approval tokens — a `proceed-spend` retry must present a token minted by a prior 402,
// so a bare header can't force spend (Codex HIGH). Bound to the model + short TTL; consumed on use.
const APPROVAL_TTL_MS = 10 * 60_000;
const pendingApprovals = new Map(); // token -> { model, ts }
function mintApprovalToken(model) {
  const token = crypto.randomBytes(18).toString('hex');
  pendingApprovals.set(token, { model: String(model || ''), ts: Date.now() });
  return token;
}
function consumeApprovalToken(token, model) {
  const a = token && pendingApprovals.get(token);
  if (!a) return false;
  pendingApprovals.delete(token); // single-use
  if (Date.now() - a.ts > APPROVAL_TTL_MS) return false;
  return a.model === String(model || '');
}

// the provider ids the wizard/config uses. resolveRoute() uses 'google' for Gemini → normalize to 'gemini'.
const KNOWN_PROVIDERS = ['openai', 'anthropic', 'gemini', 'openrouter'];
const NORMALIZE_PROVIDER = { google: 'gemini' };

/** Build the router's backend list from the user's configured model sources (+ any env-key providers). */
export function buildBackends(modelSources = {}, env = process.env) {
  const backends = [];
  if (modelSources.local?.enabled) {
    backends.push({ id: modelSources.local.name || 'local', useClass: 'local', capabilities: ['simple', 'chat', 'complex'] });
  }
  const configured = Object.keys(modelSources.providers || {});
  // include providers the user configured (vault key) OR already has an env key for (legacy BYOK)
  for (const provider of new Set([...configured, ...KNOWN_PROVIDERS])) {
    const cfg = modelSources.providers?.[provider];
    const hasKey = !!cfg?.keyHandle || !!env[`${provider.toUpperCase()}_API_KEY`];
    if (!hasKey) continue;
    backends.push({
      id: provider, useClass: 'byok-api', provider,
      capabilities: ['simple', 'chat', 'complex', 'vision'],
      allowedTasks: ['simple', 'chat', 'complex', 'vision'], // the user supplied the key → permitted
    });
  }
  return backends;
}

/** Classify a request into a task class. Defensive — tolerates a malformed messages array (fail-closed). */
export function classifyTask(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const hasImage = list.some((m) => m && Array.isArray(m.content) && m.content.some((c) => c?.type === 'image_url' || c?.type === 'image'));
  if (hasImage) return 'vision';
  const text = list.map((m) => (m && typeof m.content === 'string' ? m.content : '')).join(' ');
  if (text.length > 1200 || /```|\bfunction\b|\bclass\b|\bdef \b|\bSELECT \b|\bimport \b/.test(text)) return 'complex';
  return 'simple';
}

/**
 * Recognize whether a requested model would route to a PAID provider — using the SAME logic the real
 * router uses (resolveRoute), so families like o3, new claude and gemini variants are all caught (Codex
 * CRITICAL: a static list let unlisted paid models bypass the gate). Returns the (normalized) provider id, or null.
 */
export function providerForModel(model) {
  if (!model) return null;
  let route;
  try { route = resolveRoute(model); } catch { return null; }
  if (route.kind === 'byok' || route.kind === 'error') return NORMALIZE_PROVIDER[route.provider] || route.provider;
  return null; // local / unknown family
}

/** Pure planner: returns the router decision (or an override-resolved route). Inputs injected. */
export function planComplianceRoute({ messages = [], model } = {}, { modelSources = {}, routing = {}, env = process.env, override, approvalOk = false } = {}) {
  const backends = buildBackends(modelSources, env);
  const taskClass = classifyTask(messages);
  // resolve an explicit provider-model request to a backend id so the router sees the spend intent
  const reqProvider = providerForModel(model);
  const decision = decideRoute({ request: { taskClass, model: reqProvider || undefined }, policy: routing, backends, providers: PROVIDERS_INFO });

  if (decision.decision === 'approval-required' && override) {
    // reroute-to-local is FREE → safe with just the header. proceed-spend requires a valid approval token.
    if (override === 'reroute-local' && decision.alternativeLocal) {
      return { decision: 'route', backend: decision.alternativeLocal, useClass: 'local', spend: false, taskClass, viaApproval: true };
    }
    if (override === 'proceed-spend' && approvalOk) {
      return { decision: 'route', backend: decision.wouldSpendOn, useClass: 'byok-api', spend: true, taskClass, viaApproval: true };
    }
  }
  return decision; // unauthorized proceed-spend falls back to approval-required (re-prompts)
}

// would this request, as-is, spend on a paid model? used to fail CLOSED when the gate can't evaluate.
export function wouldSpend(req, env = process.env) {
  try { return !!providerForModel(req?.body?.model) && !!resolveRoute(req.body.model)?.envKey && !!env[resolveRoute(req.body.model).envKey]; }
  catch { return false; }
}

/**
 * Express gate. Returns true if it HANDLED the request (sent a 402). FAIL-CLOSED: if the agent is in
 * 'ask' mode and the request would spend, an error/approval blocks it — spend is never best-effort.
 */
export function complianceApprovalGate(req, res, { config = realConfig } = {}) {
  let cfg, routing;
  try { cfg = config.getConfig(); routing = config.getRouting(); }
  catch { return failClosed(req, res); } // config unreadable → don't silently allow spend
  if (!cfg?.configured) return false;                 // legacy/unconfigured daemon → unchanged behavior
  if (routing.costApproval !== 'ask') return false;   // only 'ask' needs the human-in-the-loop gate

  let plan;
  try {
    const override = req.headers?.['x-stratos-route']; // a prior human decision, replayed by the channel
    const approvalOk = consumeApprovalToken(req.headers?.['x-stratos-approval'], req.body?.model); // single-use token
    plan = planComplianceRoute(
      { messages: req.body?.messages, model: req.body?.model },
      { modelSources: config.getModelSources(), routing, override, approvalOk },
    );
  } catch { return failClosed(req, res); } // any gate error → fail closed (don't spend), not open

  if (plan.decision === 'route' && plan.viaApproval && plan.useClass === 'local') {
    req.body.model = plan.backend; // route the approved-as-local request to the local model
    return false;
  }
  if (plan.decision !== 'approval-required') return false; // route/denied → let existing routing proceed

  // approval needed → mint a single-use token; the channel asks the human, then retries with x-stratos-approval
  res.status(402).json({
    error: 'approval_required',
    reason: plan.prompt,
    taskClass: plan.taskClass,
    wouldSpendOn: plan.wouldSpendOn,
    estCostUsd: plan.estCostUsd,
    tosNote: plan.tosNote,
    alternativeLocal: plan.alternativeLocal,
    options: plan.options,                 // ['reroute-local'?, 'proceed-spend']
    approvalToken: mintApprovalToken(req.body?.model), // replay via x-stratos-approval to proceed-spend
  });
  return true;
}

// fail-closed helper: if the request would spend, block with a 402; otherwise let it through (no spend at risk).
function failClosed(req, res) {
  if (!wouldSpend(req)) return false;
  res.status(402).json({ error: 'approval_required', reason: 'Cost gate could not be evaluated; blocking a paid call to be safe. Use a local model or retry.' });
  return true;
}
