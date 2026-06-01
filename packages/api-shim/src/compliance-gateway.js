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
import { decideRoute } from './compliance-router.js';
import * as realConfig from '../../stratos-agent/src/core/agent-config.js';

// rough per-call cost estimates + ToS notes shown in the approval prompt (clearly estimates).
const PROVIDERS_INFO = {
  openai: { name: 'OpenAI', estCostUsd: 0.03, tosNote: 'Billed per token under your OpenAI API agreement.' },
  anthropic: { name: 'Anthropic', estCostUsd: 0.04, tosNote: 'Billed per token under your Anthropic API agreement.' },
  gemini: { name: 'Google', estCostUsd: 0.02, tosNote: 'Billed per token under your Google AI agreement.' },
  openrouter: { name: 'OpenRouter', estCostUsd: 0.02, tosNote: 'Billed per token under your OpenRouter account.' },
};
const PROVIDER_MODELS = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'o1', 'o1-mini'],
  anthropic: ['claude-3-5-sonnet', 'claude-3-opus', 'claude-3-haiku', 'claude-sonnet-4', 'claude-opus-4'],
  gemini: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'],
  openrouter: [], // matches by vendor/model slug, handled below
};

/** Build the router's backend list from the user's configured model sources (+ any env-key providers). */
export function buildBackends(modelSources = {}, env = process.env) {
  const backends = [];
  if (modelSources.local?.enabled) {
    backends.push({ id: modelSources.local.name || 'local', useClass: 'local', capabilities: ['simple', 'chat', 'complex'] });
  }
  const configured = Object.keys(modelSources.providers || {});
  // include providers the user configured (vault key) OR already has an env key for (legacy BYOK)
  const known = new Set([...configured, ...Object.keys(PROVIDERS_INFO)]);
  for (const provider of known) {
    const cfg = modelSources.providers?.[provider];
    const hasKey = !!cfg?.keyHandle || !!env[`${provider.toUpperCase()}_API_KEY`];
    if (!hasKey) continue;
    backends.push({
      id: provider, useClass: 'byok-api', provider,
      capabilities: ['simple', 'chat', 'complex', 'vision'],
      allowedTasks: ['simple', 'chat', 'complex', 'vision'], // the user supplied the key → permitted
      models: PROVIDER_MODELS[provider] || [],
    });
  }
  return backends;
}

/** Classify a request into a task class the router reasons about. */
export function classifyTask(messages = []) {
  const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c?.type === 'image_url' || c?.type === 'image'));
  if (hasImage) return 'vision';
  const text = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ');
  if (text.length > 1200 || /```|\bfunction\b|\bclass\b|\bdef \b|\bSELECT \b|\bimport \b/.test(text)) return 'complex';
  return 'simple';
}

// map a requested model name to its provider (so an explicit paid-model request is recognized)
function providerForModel(model, backends) {
  if (!model) return null;
  const m = String(model);
  if (m.includes('/')) return backends.find((b) => b.id === 'openrouter') ? 'openrouter' : null; // vendor/model slug
  for (const [provider, names] of Object.entries(PROVIDER_MODELS)) {
    if (names.some((n) => m.startsWith(n))) return provider;
  }
  return null;
}

/** Pure planner: returns the router decision (or an override-resolved route). Inputs injected. */
export function planComplianceRoute({ messages = [], model } = {}, { modelSources = {}, routing = {}, env = process.env, override } = {}) {
  const backends = buildBackends(modelSources, env);
  const taskClass = classifyTask(messages);
  // resolve an explicit provider-model request to a backend id so the router sees the spend intent
  const reqProvider = providerForModel(model, backends);
  const decision = decideRoute({ request: { taskClass, model: reqProvider || undefined }, policy: routing, backends, providers: PROVIDERS_INFO });

  if (decision.decision === 'approval-required' && override) {
    if (override === 'reroute-local' && decision.alternativeLocal) {
      return { decision: 'route', backend: decision.alternativeLocal, useClass: 'local', spend: false, taskClass, viaApproval: true };
    }
    if (override === 'proceed-spend') {
      return { decision: 'route', backend: decision.wouldSpendOn, useClass: 'byok-api', spend: true, taskClass, viaApproval: true };
    }
  }
  return decision;
}

/**
 * Express gate. Returns true if it HANDLED the request (sent a 402 approval-required response); false to
 * continue to the existing routing. Acts ONLY on approval-required, and only for a configured agent.
 * On a human override it nudges req.body.model (reroute-local → the local model) and continues.
 */
export function complianceApprovalGate(req, res, { config = realConfig } = {}) {
  let cfg;
  try { cfg = config.getConfig(); } catch { return false; }
  if (!cfg?.configured) return false; // legacy/unconfigured daemon → unchanged behavior
  const routing = config.getRouting();
  if (routing.costApproval !== 'ask') return false; // only 'ask' needs the human-in-the-loop gate

  const override = req.headers?.['x-stratos-route']; // a prior human decision, replayed by the channel adapter
  const plan = planComplianceRoute(
    { messages: req.body?.messages, model: req.body?.model },
    { modelSources: config.getModelSources(), routing, override },
  );

  if (plan.decision === 'route' && plan.viaApproval && plan.useClass === 'local') {
    req.body.model = plan.backend; // route the approved-as-local request to the local model
    return false;
  }
  if (plan.decision !== 'approval-required') return false; // route/denied → let existing routing proceed

  // approval needed and no override → ask the human (the channel adapter surfaces this)
  res.status(402).json({
    error: 'approval_required',
    reason: plan.prompt,
    taskClass: plan.taskClass,
    wouldSpendOn: plan.wouldSpendOn,
    estCostUsd: plan.estCostUsd,
    tosNote: plan.tosNote,
    alternativeLocal: plan.alternativeLocal,
    options: plan.options, // ['reroute-local'?, 'proceed-spend'] — replay one via the x-stratos-route header
  });
  return true;
}
