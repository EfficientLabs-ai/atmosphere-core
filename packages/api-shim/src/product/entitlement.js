/**
 * entitlement.js — Foundation F3 (SAFE slice): the LOCAL, OFFLINE entitlement verifier.
 * (STRIPE_PROVISIONING_PLAN.md §4 — the consumer side; ATMOS_API_SPEC TO-BUILD #10.)
 *
 * SCOPE LINE (deliberate): this module is PURE local verification — it touches NO Stripe, moves NO
 * money, signs NOTHING, and grants NOTHING. The GRANTING side (Stripe webhooks, the provisioning
 * service that holds the signing key, credit grants) remains founder-build-gated per the plan's §8
 * build order. This is only the local gate every tiered feature will eventually consult.
 *
 * Local-first posture (plan §4):
 *  - The node holds a signed `efl.entitlement.v1` token on disk and verifies it OFFLINE against a
 *    configured provisioning PUBLIC key (the same Ed25519+ML-DSA-65 hybrid suite used everywhere).
 *  - FAIL-TO-FREE, never fail-closed: no token, an expired token (past grace), a bad signature, or
 *    a missing provisioning key all resolve to the **Free Forever** floor — a paid feature simply
 *    isn't unlocked; nothing errors, nothing is deleted. Free Forever needs NO token at all.
 *  - INERT until wired: nothing in the gateway calls isEntitled() yet (the spec's "nothing checks
 *    tiers today"). Enforcement wiring is a separate, deliberate step — this primitive just exists,
 *    tested, ready.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The Free Forever floor — namespaces every node has with zero contact with Efficient Labs. */
export const FREE_FOREVER_NAMESPACES = Object.freeze([
  'workspace.read', 'receipts.*', 'files.read', 'runtime-score.verdict', 'terminal.read',
  'continuity.store', 'continuity.retrieve', 'node.status', 'health',
]);

const GRACE_MS = 14 * 24 * 60 * 60_000; // PROPOSED 14-day grace past expiry (plan §4)

/** Recursive canonical JSON (the repo idiom — skill-seal.js/node-authz.js). A flat-key replacer
 *  would collapse nested objects to {}, letting a nested authz field be tampered post-signature
 *  (Codex finding). This canonicalizes at EVERY depth; the provisioning signer MUST use the same. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
/** The signed body = the token minus its signature. */
function canonicalBody(token) { const { sig, ...body } = token; return canonical(body); }

/** Entitlement states that actually GRANT paid namespaces (plan §3). Anything else → Free floor. */
const GRANTING_STATES = new Set(['active', 'past_due']); // past_due = grace; features stay on

/** True if `ns` is covered by a grant list entry (exact, or a `prefix.*` wildcard). */
export function namespaceCovered(ns, granted) {
  if (typeof ns !== 'string' || !/^[a-z0-9]+(\.[a-z0-9]+)*$/i.test(ns)) return false; // valid dotted id only
  for (const g of granted) {
    if (g === ns) return true;
    if (g.endsWith('.*')) {
      const base = g.slice(0, -2);                 // 'terminal.*' → 'terminal'
      if (ns === base) return true;                 // the base itself
      if (ns.startsWith(base + '.') && ns.length > base.length + 1) return true; // base.<something>
    }
  }
  return false;
}

/**
 * Build an entitlement checker. Pure + injectable.
 * @param {object} deps   { verifyPayload }  — the hybrid verifier (quantum-crypto)
 * @param {object} [opts] { profileDir?, tokenPath?, provisioningPublicKey?, now? }
 *   provisioningPublicKey: the base64 hybrid PUBLIC bundle the node ships with (or ATMOS_PROV_PUBKEY).
 */
export function createEntitlement(deps = {}, opts = {}) {
  const { verifyPayload } = deps;
  const now = opts.now || Date.now;
  const tokenPath = () => opts.tokenPath
    || process.env.STRATOS_ENTITLEMENT
    || path.join(opts.profileDir || process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile'), 'entitlement.json');

  // The provisioning public key is stored/shipped as a base64 hybrid bundle (JSON); verifyPayload
  // needs raw Buffers — decode here. Returns a Buffer bundle, or null if absent/garbage.
  function provPubKey() {
    let bundle = opts.provisioningPublicKey;
    if (!bundle) {
      const env = process.env.ATMOS_PROV_PUBKEY;
      if (!env) return null;
      try { bundle = JSON.parse(env); } catch { return null; }
    }
    try { return Object.fromEntries(Object.entries(bundle).map(([k, v]) => [k, typeof v === 'string' ? Buffer.from(v, 'base64') : v])); }
    catch { return null; }
  }

  /**
   * Resolve the node's current entitlement. NEVER throws. Returns:
   *   { tier, namespaces[], state, source: 'token'|'free', reason? }
   * `source:'free'` means we fell back to the Free Forever floor (and why).
   */
  function resolve() {
    const free = (reason) => ({ tier: 'free_forever', namespaces: [...FREE_FOREVER_NAMESPACES], state: 'active', source: 'free', reason });
    let raw;
    try { raw = fs.readFileSync(tokenPath(), 'utf8'); } catch { return free('no entitlement token — Free Forever floor (no contact required)'); }
    let token;
    try { token = JSON.parse(raw); } catch { return free('entitlement token unreadable — fail to Free Forever'); }
    if (token?.format !== 'efl.entitlement.v1' || !token.sig) return free('entitlement token malformed — fail to Free Forever');
    const pub = provPubKey();
    if (!pub || !verifyPayload) return free('no provisioning public key configured — cannot trust a paid token, fail to Free Forever');
    let ok = false;
    try { ok = verifyPayload(canonicalBody(token), token.sig, pub); } catch { ok = false; }
    if (!ok) return free('entitlement signature invalid — fail to Free Forever (a forged token grants nothing)');
    // STATE (Codex finding): a signed-but-revoked/canceled/suspended token must NOT grant. Only
    // active/past_due(grace) states unlock paid namespaces; anything else falls to Free.
    const state = String(token.state || '');
    if (!GRANTING_STATES.has(state)) return free(`entitlement state "${state || 'unset'}" is not granting — fail to Free Forever`);
    // EXPIRY (Codex finding): a paid token MUST carry a finite positive expires_at. Junk/missing/
    // Infinity is not a perpetual grant — it's an untrustworthy token → Free.
    const exp = Number(token.expires_at);
    if (!Number.isFinite(exp) || exp <= 0) return free('entitlement has no valid expiry — fail to Free Forever (a paid token must carry a window)');
    if (now() > exp + GRACE_MS) return free('entitlement expired past grace — fail to Free Forever (never an error wall)');
    // valid, signed, granting state, within the window: union paid namespaces with the Free floor
    const ns = Array.isArray(token.namespaces) ? token.namespaces : [];
    return { tier: token.tier || 'unknown', namespaces: [...new Set([...FREE_FOREVER_NAMESPACES, ...ns])], state, source: 'token' };
  }

  /** isEntitled(namespace) → boolean. Free Forever namespaces are ALWAYS true. */
  function isEntitled(ns) {
    return namespaceCovered(ns, resolve().namespaces);
  }

  return { resolve, isEntitled };
}
