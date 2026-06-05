/**
 * composio-toolkits.js — SOVEREIGN TOOLKIT LOADER (Composio Path A).
 *
 * THE MOAT: Composio publishes, under the MIT license, a CATALOG of 1000+ app "toolkits" — each app's
 * slug, display name, category, auth scheme, and the list of action slugs (+ human descriptions). We
 * use THAT open-source catalog as the integration surface. We do NOT import the @composio SDK and we
 * NEVER call backend.composio.dev / api.composio.dev. Auth, token storage, and execution all run on
 * OUR sovereign stack (vault + identity-broker + capability-gate). 1000 integrations where the user's
 * keys never touch a third party.
 *
 * WHERE THE MIT DEFS LIVE (source of truth, read-only):
 *   services/composio/docs/public/data/toolkits.json   — array of 1000 toolkits, each:
 *       { slug, name, logo, description, category, authSchemes:[...], toolCount, tools:[{slug,name,description}] }
 *   (cloned from github.com/ComposioHQ/composio @ MIT; LICENSE in services/composio/LICENSE.)
 *
 * HONEST BOUNDARY — what the MIT catalog does and does NOT give us:
 *   ✓ toolkit metadata + auth scheme (OAUTH2 / API_KEY / BEARER_TOKEN …)
 *   ✓ the full action SLUG list per toolkit (e.g. GITHUB_GET_THE_AUTHENTICATED_USER) + descriptions
 *   ✗ the per-action HTTP endpoint/method/param schema — Composio fetches THAT from its own API at
 *     runtime (COMPOSIO_GET_TOOL_SCHEMAS), the exact phone-home we refuse. So for every action we want
 *     to actually EXECUTE we ship our OWN sovereign action-spec mapping it to the APP's real public API
 *     (api.github.com, gmail.googleapis.com, slack.com/api). getAction() returns that sovereign spec.
 *
 * So: listToolkits()/listActions() reflect the full MIT catalog (discovery of all 1000); getAction()
 * is backed by ACTION_SPECS — the curated, audited set we can run end-to-end (GitHub, Gmail, Slack to
 * start). Adding an action = adding a sovereign spec here, never calling composio.dev.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The MIT catalog path. Override with STRATOS_COMPOSIO_DATA for tests / relocated checkouts. */
export function catalogPath() {
  return (
    process.env.STRATOS_COMPOSIO_DATA ||
    path.resolve(HERE, '../../../../services/composio/docs/public/data/toolkits.json')
  );
}

let _catalog = null;
/** Load + cache the MIT toolkit catalog. Throws (fail-hard) if the source is missing/corrupt. */
function loadCatalog() {
  if (_catalog) return _catalog;
  const p = catalogPath();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`composio MIT catalog unreadable at ${p}: ${e.message}`);
  }
  if (!Array.isArray(raw)) throw new Error('composio catalog: expected an array of toolkits');
  _catalog = new Map();
  for (const t of raw) {
    if (t && typeof t.slug === 'string') _catalog.set(t.slug.toLowerCase(), t);
  }
  return _catalog;
}

/** Reset the cache (tests that swap STRATOS_COMPOSIO_DATA). */
export function _resetCache() { _catalog = null; }

/**
 * SOVEREIGN ACTION SPECS — the curated map action-slug → real APP API call.
 * Each spec: { toolkit, authType, host, method, path(params), query?(params), body?(params),
 *              headers(token,params), validate?(params), scope }.
 *   - `host` is the APP's host (api.github.com, …) — the ONLY host the executor will ever hit. NEVER
 *     composio.dev. The capability-gate + broker audience are bound to this host.
 *   - `headers(token, params)` builds the auth header from the vaulted credential the broker resolves.
 *   - `scope` is the action-level scope minted into the broker assertion (audience = host).
 * `path`/`query`/`body` are pure functions of params (no I/O), so specs are trivially testable.
 */
export const ACTION_SPECS = {
  // ── GitHub (PAT / bearer — simplest, proven end-to-end) ───────────────────────────────────────
  GITHUB_GET_THE_AUTHENTICATED_USER: {
    toolkit: 'github', authType: 'BEARER_TOKEN', host: 'api.github.com',
    method: 'GET', path: () => '/user',
    headers: (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'StratosAgent' }),
    scope: 'github:user:read',
  },
  GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER: {
    toolkit: 'github', authType: 'BEARER_TOKEN', host: 'api.github.com',
    method: 'GET', path: () => '/user/repos',
    query: (p = {}) => {
      const q = {};
      if (p.visibility) q.visibility = String(p.visibility);
      if (p.per_page != null) q.per_page = String(Math.max(1, Math.min(100, Number(p.per_page) | 0)));
      if (p.sort) q.sort = String(p.sort);
      return q;
    },
    headers: (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'StratosAgent' }),
    scope: 'github:repo:read',
  },

  // ── Gmail (OAUTH2 — needs operator-registered Google OAuth app; flow + storage built, creds TODO) ─
  GMAIL_GET_PROFILE: {
    toolkit: 'gmail', authType: 'OAUTH2', host: 'gmail.googleapis.com',
    method: 'GET', path: () => '/gmail/v1/users/me/profile',
    headers: (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' }),
    scope: 'gmail:profile:read',
  },
  GMAIL_SEND_EMAIL: {
    toolkit: 'gmail', authType: 'OAUTH2', host: 'gmail.googleapis.com',
    method: 'POST', path: () => '/gmail/v1/users/me/messages/send',
    validate: (p = {}) => {
      if (!p.raw && !(p.to && p.subject)) throw new Error('GMAIL_SEND_EMAIL needs `raw` (base64url RFC822) or `to`+`subject`');
    },
    body: (p = {}) => {
      if (p.raw) return { raw: String(p.raw) };
      const mime = [`To: ${p.to}`, `Subject: ${p.subject}`, 'Content-Type: text/plain; charset=utf-8', '', String(p.body || '')].join('\r\n');
      return { raw: Buffer.from(mime, 'utf8').toString('base64url') };
    },
    headers: (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    scope: 'gmail:send',
  },

  // ── Slack (OAUTH2 — needs operator-registered Slack app; flow + storage built, creds TODO) ──────
  SLACK_SEND_MESSAGE: {
    toolkit: 'slack', authType: 'OAUTH2', host: 'slack.com',
    method: 'POST', path: () => '/api/chat.postMessage',
    validate: (p = {}) => { if (!p.channel || !p.text) throw new Error('SLACK_SEND_MESSAGE needs `channel` and `text`'); },
    body: (p = {}) => ({ channel: String(p.channel), text: String(p.text) }),
    headers: (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }),
    scope: 'slack:chat:write',
  },
  SLACK_AUTH_TEST: {
    toolkit: 'slack', authType: 'OAUTH2', host: 'slack.com',
    method: 'POST', path: () => '/api/auth.test',
    headers: (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }),
    scope: 'slack:auth:read',
  },
};

/** Slugs of toolkits we can actually EXECUTE (have ≥1 sovereign action spec for). */
export function executableToolkits() {
  return [...new Set(Object.values(ACTION_SPECS).map((s) => s.toolkit))].sort();
}

/**
 * listToolkits({ executableOnly?, category? }) — discovery over the full MIT catalog.
 * Returns metadata only: { slug, name, category, authSchemes, toolCount, executable }.
 */
export function listToolkits({ executableOnly = false, category = null } = {}) {
  const cat = loadCatalog();
  const exec = new Set(executableToolkits());
  const out = [];
  for (const t of cat.values()) {
    if (category && t.category !== category) continue;
    const executable = exec.has(t.slug);
    if (executableOnly && !executable) continue;
    out.push({
      slug: t.slug,
      name: t.name,
      category: t.category || null,
      authSchemes: Array.isArray(t.authSchemes) ? t.authSchemes : [],
      toolCount: t.toolCount ?? (Array.isArray(t.tools) ? t.tools.length : 0),
      executable,
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** getToolkit(slug) — full MIT entry (slug, auth, action list) or null. */
export function getToolkit(slug) {
  if (!slug) return null;
  return loadCatalog().get(String(slug).toLowerCase()) || null;
}

/**
 * listActions(toolkit, { executableOnly? }) — action slugs for a toolkit from the MIT catalog.
 * Each: { slug, name, description, executable } (executable = we ship a sovereign spec for it).
 */
export function listActions(toolkit, { executableOnly = false } = {}) {
  const t = getToolkit(toolkit);
  if (!t) return [];
  const tools = Array.isArray(t.tools) ? t.tools : [];
  const out = tools.map((a) => ({
    slug: a.slug, name: a.name || a.slug, description: a.description || '',
    executable: Object.prototype.hasOwnProperty.call(ACTION_SPECS, a.slug),
  }));
  return executableOnly ? out.filter((a) => a.executable) : out;
}

/**
 * getAction(toolkit, action) -> { toolkit, action, endpoint, method, authType, params, scope, host, spec }
 * Resolves the SOVEREIGN action spec (the runnable definition). Throws if the toolkit/action is not in
 * the MIT catalog, or if we have no sovereign spec to execute it sovereignly.
 */
export function getAction(toolkit, action) {
  const t = getToolkit(toolkit);
  if (!t) throw new Error(`unknown toolkit "${toolkit}" (not in the Composio MIT catalog)`);
  const slug = String(action || '').toUpperCase();
  const known = (Array.isArray(t.tools) ? t.tools : []).some((a) => a.slug === slug);
  if (!known) throw new Error(`unknown action "${slug}" for toolkit "${toolkit}" (not in the MIT catalog)`);
  const spec = ACTION_SPECS[slug];
  if (!spec) {
    throw new Error(
      `action "${slug}" is in the MIT catalog but has no SOVEREIGN spec yet — add it to ACTION_SPECS ` +
        `(map it to the app's real API). We never fetch schemas from composio.dev.`,
    );
  }
  if (spec.toolkit !== toolkit.toLowerCase()) {
    throw new Error(`action "${slug}" belongs to toolkit "${spec.toolkit}", not "${toolkit}"`);
  }
  // Build a representative endpoint string for display/inspection (no params I/O here).
  let endpoint;
  try { endpoint = `https://${spec.host}${spec.path({})}`; } catch { endpoint = `https://${spec.host}/…`; }
  return {
    toolkit: spec.toolkit, action: slug,
    endpoint, host: spec.host, method: spec.method,
    authType: spec.authType, scope: spec.scope,
    params: known, // catalog-known
    spec, // the runnable spec (used by composio-exec.js)
  };
}
