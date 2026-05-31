/**
 * config-intents.js — "setup shortcuts" (NOT general natural-language config). Per the Codex
 * security review: a tight, negation-guarded phrase grammar; MUTATIONS require the bound owner in
 * a DM; privileged grants (files/network/shell) and cloud-PROVIDER switching are CLI-only (chat
 * explains, never grants); API keys are never accepted in chat (handled by secret-guard upstream).
 *
 * Returns { handled:true, reply } when it owns the message, or { handled:false } to fall through
 * to normal chat.
 */
import { setAgentName, setLocalModel, effectiveCapabilities, isOwner } from '../../stratos-agent/src/core/agent-config.js';

const ownerOnly = (ok) => ok ? null
  : { handled: true, reply: 'Only the bound owner can reconfigure me, and only in a direct message. (Set STRATOS_OWNER_CHAT_ID or run `stratos-ctl bind` locally.)' };

export function handleConfigIntent({ text, chatId, isDM = true, installedModels = [] }) {
  const t = String(text ?? '').trim();
  // Guard against negation / hypotheticals / quoted text — these must NEVER mutate. A trailing '?'
  // also blocks mutation (a question is not an imperative), so "if you use qwen, what happens?" and
  // "should I enable shell?" stay safe. Reads don't consult `blocked`, so "what's your config?" works.
  const blocked = /\b(don'?t|do not|never|should i|would you|could you|can you not|stop|why did|what if|if you|if i|suppose|imagine|what happens|whenever)\b/i.test(t)
    || /["“”']/.test(t)
    || /\?\s*$/.test(t);
  const canMutate = isOwner(chatId) && isDM === true;
  let m;

  // SET NAME — "call yourself X" / "change your name to X"
  if (!blocked && (m = t.match(/\b(?:call yourself|your name is|change your name to|rename yourself to|set your name to)\s+([A-Za-z0-9 _-]{1,40})$/i))) {
    const g = ownerOnly(canMutate); if (g) return g;
    try { setAgentName(m[1].trim()); return { handled: true, reply: `✅ Done — I'm now ${m[1].trim()}.` }; }
    catch (e) { return { handled: true, reply: `Couldn't set that name: ${e.message}` }; }
  }

  // SWITCH LOCAL MODEL — local open-weights only
  if (!blocked && (m = t.match(/\b(?:use|switch to|run)\s+((?:qwen|gemma|llama|mistral|phi|deepseek)[a-z0-9.:_-]*)\b/i))) {
    const g = ownerOnly(canMutate); if (g) return g;
    try { setLocalModel(m[1]); return { handled: true, reply: `✅ Switched my local model to ${m[1].toLowerCase()}.` }; }
    catch (e) { return { handled: true, reply: `That isn't a recognized local model: ${e.message}. (For cloud models, add an API key to your env.)` }; }
  }

  // CLOUD PROVIDER attempt → EXPLAIN, never switch via chat (it changes where your data goes)
  if (!blocked && /\b(?:use|switch to)\s+(claude|gpt|openai|gemini|anthropic|chatgpt)\b/i.test(t)) {
    return { handled: true, reply: `To use a cloud model I need your own API key — and for security I won't take it in chat. Add it to your env/vault (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY), then just request models like gpt-4o, claude-3-5-sonnet, or gemini-1.5-pro directly. (Switching providers is a data-egress change, so it's set in config/CLI, not chat.)` };
  }

  // PRIVILEGED PERMISSION attempt → EXPLAIN, CLI-only
  if (!blocked && /\b(?:enable|allow|grant|turn on|give you)\s+(?:access to\s+)?(shell|files?|filesystem|network|disk|internet)\b/i.test(t)) {
    return { handled: true, reply: `Granting me file, network, or shell access is a privileged change, so I don't do it from chat. Run \`stratos-ctl\` locally to grant it deliberately — everything is off by default for your safety.` };
  }

  // READ config / capabilities (safe; no mutation)
  if (/\b(?:what'?s your (?:config|setup|configuration)|show (?:your )?config|what can you do|your capabilities|how do i (?:set ?up|configure|customize))\b/i.test(t)) {
    const e = effectiveCapabilities({ installedModels });
    return { handled: true, reply:
      `I'm ${e.agentName}. Model: ${e.model.name} (${e.model.state}). ` +
      `Permissions (default-off, CLI-granted): files=${e.permissions.files}, network=${e.permissions.network}, shell=${e.permissions.shell}. ` +
      `Channels: telegram=${e.channels.telegram}, slack=${e.channels.slack}, discord=${e.channels.discord}. Mesh: ${e.meshOptIn ? 'opted-in' : 'off'}.\n` +
      `Customize (owner, in DM): "call yourself <name>", "use <local-model>". Cloud models → add an API key to env. File/network/shell → use the CLI.` };
  }

  return { handled: false };
}
