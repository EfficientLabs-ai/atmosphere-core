/**
 * wizard.js — the testable BRAIN of the setup wizard. All interactive I/O (readline, the boxed visuals)
 * lives in bin/stratos.js; this module holds the pure logic so it can be unit-tested:
 *   - validateModelChoice(): live, honest check of a local model (Ollama) or a BYOK key (injectable).
 *   - applyWizard(): apply the collected answers to config (name, local model, routing, mesh opt-in).
 *   - privacyPosture(): the honest privacy line shown for the chosen brain.
 *
 * Privacy truth surfaced to the user: with a LOCAL brain, prompts + config never leave the machine, so
 * letting Stratos self-configure from chat later is fully private. With a CLOUD (closed) brain, the
 * prompts you send go to that provider under THEIR terms — config still stays local, but it's not the
 * same private guarantee. The wizard states this plainly instead of implying blanket privacy.
 */
import * as realConfig from '../core/agent-config.js';
import { realProbes } from './probes.js';

export const LOCAL_MODEL_RE = /^(qwen|gemma|llama|mistral|phi|deepseek)[a-z0-9.:_-]*$/i;
export const COST_MODES = ['ask', 'auto-local', 'always-spend'];

/** Live, honest validation of a model choice. Returns {ok, state, detail, fix?}. Probes/env injectable. */
export async function validateModelChoice({ provider = 'local', model } = {}, { probes = realProbes, env = process.env } = {}) {
  if (provider === 'local') {
    const m = String(model || '').trim();
    if (!LOCAL_MODEL_RE.test(m)) return { ok: false, state: 'invalid', detail: `'${m}' is not a recognized local open-weights model` };
    const { reachable, models } = await probes.probeOllama();
    if (!reachable) return { ok: false, state: 'ollama-down', detail: 'Ollama is not reachable', fix: 'start it: ollama serve' };
    const installed = models.some((x) => String(x).split(':')[0] === m.split(':')[0]);
    return installed
      ? { ok: true, state: 'ready', detail: `${m} is installed locally` }
      : { ok: false, state: 'not-pulled', detail: `${m} is not pulled yet`, fix: `ollama pull ${m}` };
  }
  // BYOK cloud: we only ever check that YOUR key is present in the environment — never read/store it.
  const keyVar = `${String(provider).toUpperCase()}_API_KEY`;
  return env[keyVar]
    ? { ok: true, state: 'key-present', detail: `${keyVar} is set (BYOK — used directly, never stored by us)` }
    : { ok: false, state: 'no-key', detail: `${keyVar} is not set`, fix: `export ${keyVar}=…  (never pasted into chat or stored by us)` };
}

/** Apply collected wizard answers to config. Pure; config injectable. Returns the resulting config. */
export function applyWizard(answers = {}, config = realConfig) {
  const { agentName, provider = 'local', localModel, saveApiSpend = false, costApproval = 'ask', meshEnroll = false } = answers;
  if (agentName && String(agentName).trim()) config.setAgentName(String(agentName).trim());
  if (provider === 'local' && localModel && LOCAL_MODEL_RE.test(String(localModel).trim())) config.setLocalModel(String(localModel).trim());
  config.setRouting({ saveApiSpend: !!saveApiSpend, costApproval }); // throws on an invalid costApproval mode
  if (meshEnroll) config.setMeshOptIn(true);
  config.markConfigured();
  return config.getConfig();
}

/** The honest privacy line for the chosen brain. */
export function privacyPosture(provider = 'local') {
  return provider === 'local'
    ? { private: true, note: 'Local brain → your prompts and config never leave this machine. Chat self-config later is fully private.' }
    : { private: false, note: 'Cloud (closed) brain → prompts you send go to that provider under THEIR terms. Your config still stays local.' };
}
