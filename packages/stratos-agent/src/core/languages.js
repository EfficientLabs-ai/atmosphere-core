/**
 * languages.js — the i18n foundation (dependency-free; used by both the wizard and the gateway).
 *
 * Two layers, both small + load-bearing for going global:
 *  1. LANGUAGES: the catalog the user picks from (code + English label + native name + rtl flag).
 *  2. languageDirective(code): the system-prompt line that makes the agent reply in the user's language,
 *     regardless of the input language — works with ANY model, the cheapest high-impact i18n win.
 *
 * Output-language (the agent speaks your tongue) is live here. UI-string localization is a separate,
 * incremental layer (strings funnelled through one place); this module is the foundation for both.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English',    native: 'English' },
  { code: 'es', label: 'Spanish',    native: 'Español' },
  { code: 'pt', label: 'Portuguese', native: 'Português' },
  { code: 'fr', label: 'French',     native: 'Français' },
  { code: 'de', label: 'German',     native: 'Deutsch' },
  { code: 'ru', label: 'Russian',    native: 'Русский' },
  { code: 'ar', label: 'Arabic',     native: 'العربية', rtl: true },
  { code: 'hi', label: 'Hindi',      native: 'हिन्दी' },
  { code: 'zh', label: 'Chinese',    native: '中文' },
  { code: 'ja', label: 'Japanese',   native: '日本語' },
  { code: 'ko', label: 'Korean',     native: '한국어' },
];

export const languageDef = (code) => LANGUAGES.find((l) => l.code === code) || null;
export const isLanguage = (code) => !!languageDef(code);
export function languageName(code) { const l = languageDef(code); return l ? l.label : null; }

/**
 * The system-prompt directive so the agent replies in the user's language. Returns null for English /
 * unknown (no directive needed — English is the model default). Applied by the gateway before routing.
 */
export function languageDirective(code) {
  const l = languageDef(code);
  if (!l || l.code === 'en') return null;
  return `Always respond to the user in ${l.label} (${l.native}), regardless of the language they write in, unless they explicitly ask for a different language.`;
}
