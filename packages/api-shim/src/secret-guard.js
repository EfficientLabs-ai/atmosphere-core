/**
 * secret-guard.js — intercept API keys / tokens in inbound chat BEFORE they reach the model,
 * logs, persistence, or telemetry. Per the Codex review: "never accept API keys in chat, no
 * exception" — secret rejection must happen at the bridge boundary, not after.
 *
 * scanForSecrets() detects key-shaped strings; redactSecrets() scrubs them for any unavoidable
 * logging; SECRET_REFUSAL is the user-facing message. The bridge calls scanForSecrets() FIRST and,
 * on a hit, replies with SECRET_REFUSAL and does NOT forward the message anywhere.
 */

// Provider/token shapes. `match` (not `test`) avoids the /g lastIndex statefulness bug.
// This is DEFENSE-IN-DEPTH, deliberately broad (low-false-positive) but NOT exhaustive — it can't
// recognize every possible secret shape. The PRIMARY control is that config-intents never ingests a
// key into config/persistence regardless (cloud setup always routes the user to env/vault); this
// guard additionally keeps recognizable keys out of the model context and logs.
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,                 // Anthropic
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,           // OpenAI
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,    // Stripe secret/restricted live|test
  /AIza[A-Za-z0-9_-]{30,}/g,                     // Google API key
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                // GitHub PAT
  /\bglpat-[A-Za-z0-9_-]{18,}/g,                // GitLab PAT
  /\bhf_[A-Za-z0-9]{20,}/g,                      // Hugging Face token
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,              // Slack
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,           // Telegram bot token (id:secret)
  /AKIA[0-9A-Z]{16}/g,                          // AWS access key id
  /\bBearer\s+[A-Za-z0-9._\-]{20,}/gi,          // generic Bearer credential
  // Contextual: a secret-named field assigned a 16+ char value (catches AWS secret access keys,
  // client secrets, generic api_key=… that have no fixed prefix). No \b anchors so the keyword can
  // sit inside a longer identifier like `aws_secret_access_key`. Low FP: needs name + assign + value.
  /(?:secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd)[a-z0-9_]*["']?\s*[:=]\s*["']?[A-Za-z0-9/_+.\-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,        // PEM private key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT
];

/** True if the text contains anything key/token-shaped. */
export function scanForSecrets(text) {
  const t = String(text ?? '');
  return PATTERNS.some((re) => t.match(re) !== null);
}

/** Scrub key-shaped strings (for any unavoidable logging path). */
export function redactSecrets(text) {
  let t = String(text ?? '');
  for (const re of PATTERNS) t = t.replace(re, '«redacted-secret»');
  return t;
}

export const SECRET_REFUSAL =
  '🔒 That message looked like it contains an API key or token, so for your safety I did NOT read it, ' +
  'store it, log it, or send it anywhere — please never paste secrets into chat. ' +
  'Add keys to your environment/vault instead (e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY); ' +
  'they\'ll be used securely without ever touching chat or logs.';
