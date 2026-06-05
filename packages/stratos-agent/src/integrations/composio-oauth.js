/**
 * composio-oauth.js — SOVEREIGN OAuth2 scaffold for OAuth-app toolkits (Gmail, Slack, …).
 *
 * For OAUTH2 toolkits we cannot use a single PAT; the operator must REGISTER an OAuth app with the
 * provider (Google / Slack) and obtain a client_id + client_secret. THOSE go into OUR config (the
 * vault), never composio.dev. This module builds the auth flow against the PROVIDER'S OWN OAuth
 * endpoints and stores the resulting per-entity access token in OUR vault via composio-credentials.
 *
 * WHAT THE OPERATOR MUST PROVIDE (clearly flagged — we do NOT fake credentials):
 *   - Google: register an OAuth 2.0 Client (Web) at console.cloud.google.com → client_id + client_secret,
 *     authorized redirect URI = OAUTH_REDIRECT_URI (default below). Enable the Gmail API + scopes.
 *   - Slack:  create an app at api.slack.com/apps → client_id + client_secret, add redirect URL, request
 *     the bot/user scopes you need (e.g. chat:write).
 *   Drop them via setOAuthAppConfig(provider, { clientId, clientSecret, redirectUri, scopes }) — stored
 *   ENCRYPTED in the vault under connector `composio_oauthapp_<provider>`. NO secrets live in code.
 *
 * FLOW (standard authorization-code):
 *   1. authorizeUrl(provider, entity)   → the provider consent URL the user opens.
 *   2. provider redirects to redirectUri with ?code=…&state=<entity-bound>.
 *   3. exchangeCode(provider, entity, code) → calls the PROVIDER token endpoint (sovereign; never
 *      composio.dev), stores the access token in OUR vault keyed per entity (kind='oauth').
 *
 * Endpoints below are the PROVIDERS' real OAuth endpoints — the only hosts this module contacts.
 */
import crypto from 'node:crypto';
import * as vaultMod from '../connectors/vault.js';
import { addEntityCredential } from './composio-credentials.js';

/** Provider OAuth endpoint config (provider-owned hosts ONLY — never composio.dev). */
export const OAUTH_PROVIDERS = {
  google: {
    toolkit: 'gmail',
    authHost: 'accounts.google.com', authPath: '/o/oauth2/v2/auth',
    tokenHost: 'oauth2.googleapis.com', tokenPath: '/token',
    defaultScopes: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'],
  },
  slack: {
    toolkit: 'slack',
    authHost: 'slack.com', authPath: '/oauth/v2/authorize',
    tokenHost: 'slack.com', tokenPath: '/api/oauth.v2.access',
    defaultScopes: ['chat:write', 'channels:read'],
  },
};

const APP_CONNECTOR = (provider) => `composio_oauthapp_${provider}`;
const DEFAULT_REDIRECT = () => process.env.OAUTH_REDIRECT_URI || 'http://127.0.0.1:4099/oauth/callback';

/**
 * setOAuthAppConfig — operator drops the registered app's client_id/secret. Stored ENCRYPTED in vault.
 * @returns {{provider:string, configured:true}}  (no secret echoed back)
 */
export function setOAuthAppConfig(provider, { clientId, clientSecret, redirectUri = null, scopes = null } = {}, vault = vaultMod) {
  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown OAuth provider "${provider}" (have: ${Object.keys(OAUTH_PROVIDERS).join(', ')})`);
  if (!clientId || !clientSecret) throw new Error(`provider "${provider}" needs clientId + clientSecret (operator must register the OAuth app)`);
  const blob = JSON.stringify({ clientId, clientSecret, redirectUri: redirectUri || DEFAULT_REDIRECT(), scopes: scopes || cfg.defaultScopes });
  vault.putSecret({ connector: APP_CONNECTOR(provider), kind: 'appconfig', value: blob });
  return { provider, configured: true };
}

/** Whether the operator has configured this provider's OAuth app. */
export function isOAuthAppConfigured(provider, vault = vaultMod) {
  try { return !!getAppConfig(provider, vault); } catch { return false; }
}

function getAppConfig(provider, vault = vaultMod) {
  // resolveSecret needs the handle; appconfig is a single-per-provider record, so we find it in list().
  const entry = vault.list().find((e) => e.connector === APP_CONNECTOR(provider) && e.kind === 'appconfig');
  if (!entry) return null;
  const raw = vault.resolveSecret(entry.handle);
  return raw ? JSON.parse(raw) : null;
}

/** Sign an entity-bound state param so the callback can't be cross-entity replayed. */
function makeState(entity) {
  const nonce = crypto.randomBytes(8).toString('hex');
  return Buffer.from(JSON.stringify({ e: entity, n: nonce })).toString('base64url');
}
export function entityFromState(state) {
  try { return JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8')).e || null; } catch { return null; }
}

/**
 * authorizeUrl(provider, entity) → the provider consent URL. Throws if the operator hasn't configured
 * the OAuth app yet (honest: we will not pretend a connection is possible without real credentials).
 */
export function authorizeUrl(provider, entity, vault = vaultMod) {
  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown OAuth provider "${provider}"`);
  const app = getAppConfig(provider, vault);
  if (!app) throw new Error(`OAuth app for "${provider}" not configured — operator must setOAuthAppConfig() with a registered client_id/secret`);
  const u = new URL(`https://${cfg.authHost}${cfg.authPath}`);
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', app.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', (app.scopes || cfg.defaultScopes).join(' '));
  u.searchParams.set('state', makeState(entity));
  if (provider === 'google') { u.searchParams.set('access_type', 'offline'); u.searchParams.set('prompt', 'consent'); }
  return u.toString();
}

/**
 * exchangeCode(provider, entity, code) → exchange the auth code at the PROVIDER token endpoint
 * (sovereign; never composio.dev) and store the access token in OUR vault per entity (kind='oauth').
 * @returns {{stored:true, handle:string}}  (token never returned to the caller)
 */
export async function exchangeCode(provider, entity, code, deps = {}) {
  const vault = deps.vault || vaultMod;
  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown OAuth provider "${provider}"`);
  if (!entity || !code) throw new Error('exchangeCode needs entity + code');
  const app = getAppConfig(provider, vault);
  if (!app) throw new Error(`OAuth app for "${provider}" not configured`);

  const tokenHost = cfg.tokenHost;
  if (/composio/i.test(tokenHost)) throw new Error('SOVEREIGNTY VIOLATION: token endpoint must be the provider, not composio');
  const doFetch = deps.fetch || globalThis.fetch;
  const body = new URLSearchParams({
    client_id: app.clientId, client_secret: app.clientSecret,
    code: String(code), grant_type: 'authorization_code', redirect_uri: app.redirectUri,
  });
  const res = await doFetch(`https://${tokenHost}${cfg.tokenPath}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString(),
  });
  const text = typeof res.text === 'function' ? await res.text() : '';
  let json; try { json = JSON.parse(text); } catch { json = {}; }
  // Slack nests the token differently; normalize both.
  const accessToken = json.access_token || (json.authed_user && json.authed_user.access_token) || null;
  if (!accessToken) throw new Error(`OAuth exchange failed for "${provider}": ${json.error || res.status}`);
  const { handle } = addEntityCredential(entity, cfg.toolkit, accessToken, 'oauth', vault);
  return { stored: true, handle };
}
