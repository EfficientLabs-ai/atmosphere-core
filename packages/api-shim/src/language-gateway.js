/**
 * language-gateway.js — injects the user's language directive into each request so the agent REPLIES in
 * their language, whatever model handles it. Reads the configured language; no-op for English/unset.
 * Pure `applyLanguageDirective` is unit-tested; `languageGate` is the thin express wrapper (fail-open).
 */
import { languageDirective } from '../../stratos-agent/src/core/languages.js';
import * as realConfig from '../../stratos-agent/src/core/agent-config.js';

/**
 * Prepend the language directive as its OWN system message (never merged into caller-controlled content,
 * which a caller could pre-include to suppress, or override with conflicting text — Codex). It is a
 * separate message the caller can't edit; idempotent on an exact match of our directive.
 */
export function applyLanguageDirective(messages, code) {
  const directive = languageDirective(code);
  if (!directive || !Array.isArray(messages)) return messages;
  if (messages.some((m) => m && m.role === 'system' && m.content === directive)) return messages; // already ours
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
