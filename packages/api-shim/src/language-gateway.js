/**
 * language-gateway.js — injects the user's language directive into each request so the agent REPLIES in
 * their language, whatever model handles it. Reads the configured language; no-op for English/unset.
 * Pure `applyLanguageDirective` is unit-tested; `languageGate` is the thin express wrapper (fail-open).
 */
import { languageDirective } from '../../stratos-agent/src/core/languages.js';
import * as realConfig from '../../stratos-agent/src/core/agent-config.js';

/** Prepend/augment a system message with the language directive. Idempotent. Returns the new messages. */
export function applyLanguageDirective(messages, code) {
  const directive = languageDirective(code);
  if (!directive || !Array.isArray(messages)) return messages;
  const head = messages[0];
  if (head && head.role === 'system' && typeof head.content === 'string') {
    if (head.content.includes(directive)) return messages; // already applied
    return [{ role: 'system', content: `${directive}\n\n${head.content}` }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: directive }, ...messages];
}

/** Express helper: rewrite req.body.messages to reply in the configured language. No-op for English. */
export function languageGate(req, { config = realConfig } = {}) {
  try {
    const code = config.getLanguage();
    if (!code || code === 'en') return;
    if (Array.isArray(req.body?.messages)) req.body.messages = applyLanguageDirective(req.body.messages, code);
  } catch { /* fail open — never block a request over language */ }
}
