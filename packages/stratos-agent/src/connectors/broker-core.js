/**
 * broker-core.js — the deterministic CONNECTOR BROKER's security boundary (Task #12).
 *
 * This is the pure request handler that runs INSIDE the broker process (the socket/IPC wrapper that
 * frames newline-delimited JSON lives in broker.js). It is the single chokepoint between the model and
 * the outside world, and it enforces the four controls the connector design requires:
 *
 *   1. CAPABILITY TOKEN — every verb requires the per-session token (timing-safe compare). The model
 *      receives it only over the broker's authenticated socket handshake; it is not derivable.
 *   2. READ-ONLY SUBSET — listTools exposes ONLY risk:'read' tools. write/destructive tools are never
 *      advertised to the model; they exist only behind the approval path.
 *   3. WRITE → HUMAN APPROVAL — a non-read tool executes only after write-approval.consumeApproval()
 *      confirms a single-use, scope-bound, owner-approved proposal matching this exact call.
 *   4. SECRET ISOLATION + NO AUTO-CHAIN — credentials are resolved from the vault INSIDE the broker, at
 *      connector-connect time, and bound to the transport's connection to its PINNED server. Plaintext
 *      never returns to the model; only tool CONTENT does, flagged untrusted, and the broker never feeds
 *      that output back into another tool call by itself.
 *   5. DESTINATION CONTROL — the broker, not the model, owns where an auth-bearing credential is sent. A
 *      model-supplied url/host/endpoint arg on an auth-bearing tool is rejected unless the tool declares
 *      an explicit origin allow-list AND the value matches it (private/link-local hosts always rejected).
 *      Closes the SSRF / credential-redirect exfil primitive (Codex CRITICAL).
 *
 * ENFORCED OUTSIDE THIS MODULE (documented so it is not forgotten — Codex HIGH):
 *   - PEER BINDING: the socket wrapper (broker.js) connects model↔broker over an inherited socketpair
 *     (no named socket → no same-UID process can connect) and expires the cap token on disconnect/idle.
 *   - SIDECAR TRUST: each connector's MCP sidecar binary + version is PINNED (command + hash) in
 *     `connectors[*]`; risk tags come ONLY from this broker-owned registry, NEVER from the server's
 *     tools/list. The sidecar still sees the credential it must use — that residual is bounded by pinning.
 *   - OUTPUT TAINT: connector CONTENT is untrusted — callers must not persist/embed/log/export it or reuse
 *     it in an approval prompt. The {untrusted:true} flag is the contract; the memory/export layers honor it.
 */
import crypto from 'node:crypto';
import * as vaultMod from './vault.js';
import * as approvalMod from './write-approval.js';

const READ = 'read';
// arg keys that could redirect where an auth-bearing credential is sent
const DEST_KEYS = ['url', 'uri', 'href', 'endpoint', 'host', 'hostname', 'origin', 'webhook', 'callback', 'redirect', 'target', 'proxy', 'base_url', 'baseurl'];

function isPrivateHost(h) {
  const x = String(h).toLowerCase().replace(/^\[|\]$/g, '');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|fc|fd|fe80)/.test(x)) return true;
  const m = /^172\.(\d{1,3})\./.exec(x); // 172.16.0.0 – 172.31.255.255
  return !!(m && +m[1] >= 16 && +m[1] <= 31);
}

function allowedDestination(value, allowOrigins) {
  let u; try { u = new URL(String(value)); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  if (isPrivateHost(u.hostname)) return false;            // block SSRF to internal/link-local
  return allowOrigins.some((a) => u.origin === a || u.host === a);
}

// walk args (recursively) for destination-like keys the model might use to redirect the credential
function destinationArgs(args) {
  const hits = [];
  const walk = (o, prefix) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (DEST_KEYS.includes(k.toLowerCase())) hits.push({ key: prefix + k, value: v });
      if (v && typeof v === 'object') walk(v, prefix + k + '.');
    }
  };
  walk(args, '');
  return hits;
}

export function createBroker({
  tools = {},          // name -> { risk:'read'|'write'|'destructive', connector, mcpName?, requiredScopes? }
  connectors = {},     // connector -> { credentialHandle?, authKind? }  (allow-list of where creds may go)
  connect,             // ({ connector, auth }) => mcpClient  — pins+authenticates the sidecar at connect time
  resolveSecret = vaultMod.resolveSecret,
  approvals = approvalMod,
} = {}) {
  if (typeof connect !== 'function') throw new Error('broker requires a connect() factory');
  const toolReg = tools instanceof Map ? tools : new Map(Object.entries(tools));
  const connReg = connectors instanceof Map ? connectors : new Map(Object.entries(connectors));
  const capToken = crypto.randomBytes(24).toString('hex');
  const clients = new Map(); // connector -> mcpClient (lazy; auth bound once, at connect)

  const capOk = (t) =>
    typeof t === 'string' && t.length === capToken.length &&
    crypto.timingSafeEqual(Buffer.from(t), Buffer.from(capToken));

  function clientFor(connector) {
    if (clients.has(connector)) return clients.get(connector);
    const cfg = connReg.get(connector);
    if (!cfg) throw new Error('connector not in allow-list'); // creds can only go to a registered connector
    let auth = null;
    if (cfg.credentialHandle) {
      const secret = resolveSecret(cfg.credentialHandle); // plaintext exists ONLY here, inside the broker
      if (!secret) throw new Error('credential unavailable');
      auth = { kind: cfg.authKind || 'bearer', value: secret };
    }
    const client = connect({ connector, auth }); // transport authenticates to its pinned server with auth
    clients.set(connector, client);
    return client;
  }

  function listTools(ct) {
    if (!capOk(ct)) return { ok: false, reason: 'bad capability token' };
    const tools = [...toolReg.entries()]
      .filter(([, t]) => t.risk === READ) // the model is shown ONLY read tools
      .map(([name, t]) => ({ name, connector: t.connector, risk: t.risk }));
    return { ok: true, tools };
  }

  // the broker, not the model, owns where an auth-bearing credential is sent (Codex CRITICAL: SSRF)
  function destinationCheck(t, args) {
    const cfg = connReg.get(t.connector);
    if (!cfg || !cfg.credentialHandle) return { ok: true }; // no credential at risk → no destination gate
    for (const d of destinationArgs(args)) {
      if (!Array.isArray(t.allowDestinations)) {
        return { ok: false, reason: `destination arg '${d.key}' is broker-owned for auth-bearing tools` };
      }
      if (!allowedDestination(d.value, t.allowDestinations)) {
        return { ok: false, reason: `destination '${d.key}' is not in the tool's origin allow-list` };
      }
    }
    return { ok: true };
  }

  // BROKER-DERIVED proposal: the model supplies ONLY tool name + raw args; the broker fills in
  // connector/account/scopes from its own registry, so the model can't forge the grant (Codex HIGH).
  function proposeWrite({ name, args = {}, capToken: ct } = {}) {
    if (!capOk(ct)) return { ok: false, reason: 'bad capability token' };
    const t = toolReg.get(name);
    if (!t) return { ok: false, reason: 'unknown tool' };
    if (t.risk === READ) return { ok: false, reason: 'read tools require no approval' };
    const dc = destinationCheck(t, args);
    if (!dc.ok) return dc; // don't even propose a write to a disallowed destination
    const proposal = approvals.proposeWrite({
      connector: t.connector, account: args.account || 'default',
      action: name, args, scopes: t.requiredScopes || [],
    });
    return { ok: true, proposal }; // id + exact args for the owner; the nonce goes to the owner channel
  }

  async function callTool({ name, args = {}, capToken: ct, approvalId } = {}) {
    if (!capOk(ct)) return { ok: false, reason: 'bad capability token' };
    const t = toolReg.get(name);
    if (!t) return { ok: false, reason: 'unknown tool' };

    const dc = destinationCheck(t, args);
    if (!dc.ok) return dc;

    if (t.risk !== READ) {
      // write/destructive: must be backed by a single-use human approval matching this exact call
      if (!approvalId) return { ok: false, reason: 'write requires human approval' };
      const c = approvals.consumeApproval({
        id: approvalId, connector: t.connector, account: args.account || 'default',
        action: name, args, requiredScopes: t.requiredScopes || [],
      });
      if (!c.ok) return { ok: false, reason: `approval denied: ${c.reason}` };
    }

    let client;
    try { client = clientFor(t.connector); } catch (e) { return { ok: false, reason: e.message }; }

    let result;
    try { result = await client.callTool({ name: t.mcpName || name, args }); }
    catch { return { ok: false, reason: 'tool execution failed' }; } // generic: never echo upstream/sidecar text

    // return ONLY tool content — never auth. Flagged untrusted; the broker does NOT auto-chain it.
    return { ok: true, content: result?.content ?? result ?? null, untrusted: true };
  }

  return { capToken, listTools, proposeWrite, callTool };
}
