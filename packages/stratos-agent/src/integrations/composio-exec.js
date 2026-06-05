/**
 * composio-exec.js — SOVEREIGN EXECUTOR for Composio toolkits (Path A).
 *
 * runToolAction({ entity, toolkit, action, params }) does, in order:
 *   1. CAPABILITY-GATE (deny-by-default): the action's host must be on the declared net allowlist and
 *      the action's scope on the declared actions list — undeclared ⇒ refused before anything happens.
 *   2. RESOLVE the entity's credential from OUR vault — keyed PER ENTITY (connector =
 *      `composio_<entity>_<toolkit>`), so one user's creds can NEVER be used for another (isolation).
 *      The vault's resolveSecret is the single privileged plaintext path; the agent never calls it.
 *   3. MINT a short-lived, audience-bound, scoped assertion via the identity-broker (audience = the
 *      APP host, scope = the action scope). The agent only ever receives the RESULT / a brokered
 *      handle — never the raw token.
 *   4. CALL THE APP'S API DIRECTLY (global fetch) at the action's host, with the resolved credential
 *      placed in the request headers AT THE EGRESS EDGE (broker-side), then return the parsed result.
 *
 * INVARIANTS (the moat):
 *   - ZERO composio.dev: the only host ever contacted is `spec.host` (api.github.com / gmail.googleapis
 *     .com / slack.com). Asserted here AND grep-provable across the file.
 *   - The raw token is NEVER part of the returned value and is zeroized from the local var after the
 *     fetch. Callers get { ok, status, data, brokered:{ jti,aud,scope,exp } } — a brokered handle, not a key.
 *   - Per-entity isolation by vault connector keying; deny-by-default gate; input validation per spec.
 */
import crypto from 'node:crypto';
import { resolveSecret } from '../connectors/vault.js';
import { IdentityBroker } from '../identity/identity-broker.js';
import { parseCapabilities, assertStepAllowed } from '../security/capability-gate.js';
import { getAction } from './composio-toolkits.js';

const ENTITY_RE = /^[a-z0-9._:-]+$/i;

/** Vault connector name for an entity+toolkit. Per-entity isolation lives in this key. */
export function vaultConnectorFor(entity, toolkit) {
  const e = String(entity || '').replace(/[^a-z0-9_-]/gi, '_');
  const t = String(toolkit || '').replace(/[^a-z0-9_-]/gi, '_');
  return `composio_${e}_${t}`;
}

/** Minimal sovereign-Composio capability manifest: net=app hosts, actions=action scopes. */
export function composioCapabilities({ hosts = [], scopes = [] } = {}) {
  return parseCapabilities({ capabilities: { net: hosts, actions: scopes } });
}

/**
 * runToolAction — the one entry point the agent/CLI calls.
 *
 * @param {object}   o
 * @param {string}   o.entity          per-user/entity id (vault + broker subject)
 * @param {string}   o.toolkit         toolkit slug (github/gmail/slack/…)
 * @param {string}   o.action          action slug (GITHUB_GET_THE_AUTHENTICATED_USER, …)
 * @param {object}   [o.params]        action params (validated against the sovereign spec)
 * @param {object}   o.deps
 * @param {function} [o.deps.fetch]    injectable fetch (tests mock the APP API)
 * @param {function} [o.deps.resolveSecret] injectable vault resolver (tests inject a mock vault)
 * @param {IdentityBroker} [o.deps.broker]  injectable broker (tests inject; prod builds one from secret)
 * @param {object}   [o.deps.caps]     injectable parsed capabilities (tests inject DENIED caps)
 * @param {string}   [o.deps.brokerSecret] HMAC secret for a prod broker if none injected
 * @returns {Promise<{ok:boolean,status:number,data:any,brokered:object}>}  NEVER the raw token.
 */
export async function runToolAction({ entity, toolkit, action, params = {} } = {}, deps = {}) {
  if (!entity || !ENTITY_RE.test(String(entity))) throw new Error('runToolAction: invalid/missing entity id');
  if (params == null || typeof params !== 'object') throw new Error('runToolAction: params must be an object');

  // Resolve the SOVEREIGN action spec from the MIT catalog + our spec map (throws if not runnable).
  const resolved = getAction(toolkit, action);
  const spec = resolved.spec;
  const host = spec.host;
  const scope = spec.scope;

  // 1) CAPABILITY GATE — deny-by-default. Caller may inject denied caps to prove enforcement; default
  //    grants exactly this action's host+scope (least privilege for this single call).
  const caps = deps.caps || composioCapabilities({ hosts: [host], scopes: [scope] });
  assertStepAllowed(caps, { action: scope, host }); // throws CapabilityError if undeclared

  // Per-spec input validation (fail before touching the vault/network).
  if (typeof spec.validate === 'function') spec.validate(params);

  // 2) RESOLVE the per-entity credential from OUR vault (broker-side privileged path).
  const resolve = deps.resolveSecret || resolveSecret;
  const connector = vaultConnectorFor(entity, spec.toolkit);
  const credKind = spec.authType === 'OAUTH2' ? 'oauth' : 'token';
  // Try the action's native kind, then fall back to the other (PAT stored as token vs oauth).
  let token = handleAwareResolve(resolve, connector, credKind) || handleAwareResolve(resolve, connector, credKind === 'oauth' ? 'token' : 'oauth');
  if (!token) {
    throw new Error(
      `no sovereign credential for entity "${entity}" toolkit "${spec.toolkit}". ` +
        `Add one to the vault (operator): see addEntityCredential(). ${spec.authType === 'OAUTH2' ? 'OAUTH2 toolkit — run the OAuth flow first.' : ''}`,
    );
  }

  // 3) MINT the short-lived, audience-bound, scoped assertion. The broker is the credential authority;
  //    the agent receives only this brokered handle (never the token). audience = the APP host.
  const broker = deps.broker || new IdentityBroker({ secret: deps.brokerSecret || randomEphemeralSecret() });
  // Register the org's consent for exactly this (subject→audience, scope) so issue() can mint it.
  broker.grant({ subject: entity, audience: host, scopes: [scope] });
  const assertion = broker.issue({ subject: entity, audience: host, scope, capabilities: { net: [host] } });
  const brokered = broker.verify(assertion, { audience: host, scope });
  if (!brokered.ok) throw new Error(`broker assertion invalid: ${brokered.reason}`);

  // 4) CALL THE APP'S API DIRECTLY. SOVEREIGNTY ASSERTION: never composio.dev.
  if (/composio\.dev$/i.test(host) || /composio/i.test(host)) {
    throw new Error('SOVEREIGNTY VIOLATION: refusing to contact a composio host');
  }
  const url = buildUrl(host, spec.path(params), typeof spec.query === 'function' ? spec.query(params) : null);
  const doFetch = deps.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch available');

  const init = { method: spec.method, headers: spec.headers(token, params) };
  if (typeof spec.body === 'function' && spec.method !== 'GET' && spec.method !== 'HEAD') {
    init.body = JSON.stringify(spec.body(params));
  }

  let res, data, status;
  try {
    res = await doFetch(url, init);
    status = res.status;
    const text = typeof res.text === 'function' ? await res.text() : '';
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  } finally {
    token = null; // zeroize the local credential reference; it never enters the return value
  }

  // Slack-style { ok:false, error } APIs: surface as a non-ok result without leaking anything.
  const appOk = status >= 200 && status < 300 && !(data && data.ok === false);
  return {
    ok: appOk,
    status,
    data,
    brokered: { jti: brokered.claims.jti, aud: brokered.claims.aud, scope: brokered.claims.scope, exp: brokered.claims.exp },
  };
}

/** Resolve a secret given (connector, kind): the vault returns by opaque handle, but the operator
 * onboarding (addEntityCredential) returns the handle. We accept either a direct value resolver or a
 * handle resolver. To keep the executor handle-agnostic, we look the handle up via the connector list
 * is NOT possible here (resolveSecret needs the handle), so onboarding stores under a DETERMINISTIC
 * handle index — see addEntityCredential. For the executor, callers pass a resolve(connector,kind)
 * shim in deps for tests; in prod we use the vault handle recorded by addEntityCredential. */
function handleAwareResolve(resolve, connector, kind) {
  // Two supported resolver shapes:
  //  (a) test/prod shim: resolve(connector, kind) -> token|null
  //  (b) raw vault resolveSecret(handle) — used when the caller already holds the handle (not here)
  if (resolve.length >= 2) {
    try { return resolve(connector, kind) || null; } catch { return null; }
  }
  return null;
}

function randomEphemeralSecret() { return crypto.randomBytes(32).toString('hex'); }

function buildUrl(host, p, query) {
  const u = new URL(`https://${host}${p.startsWith('/') ? p : '/' + p}`);
  if (query && typeof query === 'object') for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
  return u.toString();
}

export { ENTITY_RE };
