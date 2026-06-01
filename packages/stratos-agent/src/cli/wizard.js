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
    : { private: false, note: 'Connected provider → prompts you send to it go to that provider under THEIR terms. Your config + keys stay local (keys encrypted).' };
}

/**
 * The model sources a user can enable in setup. `local` runs open-weights on their machine; the rest are
 * providers reached with the user's OWN API key (stored encrypted in the vault). No "cloud" jargon.
 */
export const MODEL_SOURCES = [
  { value: 'local',      label: 'Local models (Ollama)',     hint: 'private · free · runs on your machine', kind: 'local' },
  { value: 'anthropic',  label: 'Anthropic — Claude',        hint: 'your API key',                          kind: 'provider' },
  { value: 'openai',     label: 'OpenAI — GPT',              hint: 'your API key',                          kind: 'provider' },
  { value: 'gemini',     label: 'Google — Gemini',           hint: 'your API key',                          kind: 'provider' },
  { value: 'openrouter', label: 'OpenRouter — 100+ models',  hint: 'one key, many models',                  kind: 'provider' },
];

/** Pure reducer for the keyboard multi-select (↑/↓ move, space toggles). The raw-mode loop lives in bin. */
export function multiSelectReduce(state, key) {
  const { index, selected, count } = state;
  if (key === 'up') return { ...state, index: (index - 1 + count) % count };
  if (key === 'down') return { ...state, index: (index + 1) % count };
  if (key === 'space') { const s = new Set(selected); s.has(index) ? s.delete(index) : s.add(index); return { ...state, selected: s }; }
  return state; // enter/confirm is handled by the caller
}

/**
 * Resolve each enabled provider's API key from the VAULT into the environment the gateway reads
 * (PROVIDER_API_KEY). Called at daemon start so "drop in your key, Stratos handles the rest" actually
 * works: the key lives encrypted at rest and is only decrypted into the running process. Returns the
 * list of providers wired. Vault injectable for tests.
 */
export function resolveProviderKeysToEnv(config, vault, env = process.env) {
  const providers = config.getModelSources().providers || {};
  const wired = [];
  for (const [provider, p] of Object.entries(providers)) {
    if (!p || !p.keyHandle) continue;
    const key = vault.resolveSecret(p.keyHandle);
    if (key) { env[`${provider.toUpperCase()}_API_KEY`] = key; wired.push(provider); }
  }
  return wired;
}

/**
 * Messaging channels you talk to the agent through. HONEST STATUS: telegram is a real, working two-way
 * channel (node-telegram-bot-api). slack/discord/matrix are on the roadmap — listed so they're visible,
 * marked 'soon', and NOT presented as functional until their adapters ship.
 */
export const CHANNELS = [
  { value: 'telegram', label: 'Telegram', hint: 'ready · bot token + your chat id',           status: 'ready', credLabel: 'bot token', ownerLabel: 'chat id', envKey: 'TELEGRAM_BOT_TOKEN' },
  { value: 'discord',  label: 'Discord',  hint: 'ready · bot token + your user id',           status: 'ready', credLabel: 'bot token', ownerLabel: 'user id', envKey: 'DISCORD_BOT_TOKEN' },
  { value: 'slack',    label: 'Slack',    hint: 'ready · bot + app tokens (Socket Mode)',     status: 'ready', credLabel: 'bot token (xoxb-)', ownerLabel: 'user id', envKey: 'SLACK_BOT_TOKEN',
    extraCred: { label: 'app-level token (xapp-)', kind: 'app-token', envKey: 'SLACK_APP_TOKEN' } },
  { value: 'matrix',   label: 'Matrix',   hint: 'coming soon',                                status: 'soon',  credLabel: 'access token', ownerLabel: 'user id', envKey: 'MATRIX_ACCESS_TOKEN' },
];
export const channelDef = (value) => CHANNELS.find((c) => c.value === value) || null;

/** Resolve enabled channels' bot tokens from the VAULT into the env the bridge reads. Returns wired list. */
export function resolveChannelTokensToEnv(config, vault, env = process.env) {
  const msg = config.getMessaging ? config.getMessaging() : {};
  const wired = [];
  for (const [channel, m] of Object.entries(msg || {})) {
    if (!m || !m.enabled || !m.tokenHandle) continue;
    const def = channelDef(channel);
    const token = vault.resolveSecret(m.tokenHandle);
    if (def && token) {
      env[def.envKey] = token;
      if (m.ownerId) env[`${channel.toUpperCase()}_OWNER_ID`] = String(m.ownerId); // owner-gates the adapter
      // a channel that needs a second credential (Slack's app-level token for Socket Mode)
      if (def.extraCred && m.appTokenHandle) {
        const extra = vault.resolveSecret(m.appTokenHandle);
        if (extra) env[def.extraCred.envKey] = extra;
      }
      wired.push(channel);
    }
  }
  return wired;
}
