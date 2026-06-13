/**
 * entitlement-signer.js — the GRANTING side of the entitlement rail: the exact inverse of
 * entitlement.js's local verifier. Given the provisioning PRIVATE key bundle, mints a signed
 * `efl.entitlement.v1` token that a node verifies OFFLINE against the provisioning PUBLIC key.
 *
 * SCOPE LINE (deliberate, mirrors the verifier's): this module signs a token from caller-supplied
 * fields and NOTHING ELSE. It does NOT touch Stripe, move money, read webhooks, or decide WHO gets
 * WHAT tier — that provisioning service (the holder of the real signing key) stays founder-build-gated
 * per STRIPE_PROVISIONING_PLAN.md §8. This is the dev/provisioning primitive: "given a grant decision
 * + the signing key, produce the token the verifier will trust." Today it is used by tests and local
 * provisioning only.
 *
 * ENCODING — why byte arrays, not base64 (empirically established, do not change without re-probing):
 *   entitlement.js resolve() calls quantum-crypto verifyPayload(body, token.sig, pub) DIRECTLY, and
 *   the token is JSON-round-tripped from disk. verifyPayload's ed25519 half does `Buffer.from(sig.x)`
 *   with NO base64 decode (its ML-DSA half uses toU8 which DOES decode) — so a base64-STRING sig
 *   verifies FALSE on the classical half and the whole token fails to Free (a paid user looks unpaid).
 *   capability-receipt.js gets away with base64 because makeReceiptVerifier base64-decodes BEFORE
 *   calling verifyPayload; the entitlement verifier does not. The JSON-native encoding that the
 *   unmodified verifier accepts directly for BOTH halves is a plain byte array. We therefore store
 *   the signature halves as byte arrays — the exact inverse of the verifier AS SHIPPED, no edit to
 *   entitlement.js or quantum-crypto.js. The round-trip test in test-entitlement-signer.mjs is the
 *   oracle that locks this.
 */
import { signPayload } from '../../../stratos-agent/src/security/quantum-crypto.js';

/** Recursive canonical JSON — byte-for-byte identical to entitlement.js's canonical() (the repo idiom
 *  in skill-seal.js / node-authz.js / capability-receipt.js). Duplicated, NOT imported, because
 *  entitlement.js does not export it; test-entitlement-signer.mjs asserts parity against the verifier
 *  so the two can never silently drift (a drift = a signed token that fails its own verifier = a paid
 *  user looks unpaid). */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/** Core entitlement claims `extra` may NEVER override — the verifier reads these by name and their
 *  values are the grant itself. `sig` is reserved because the verifier strips the TOP-LEVEL sig to
 *  rebuild the body; an `extra.sig` would be signed-then-overwritten = a self-invalid token. */
const RESERVED_CLAIMS = new Set(['format', 'tier', 'state', 'namespaces', 'expires_at', 'sig']);

/**
 * Sign an entitlement token. Pure: builds the body, signs canonical(body) with the provisioning
 * private bundle, returns the full token (body + byte-array sig). NEVER logs the key or the bundle.
 *
 * @param {object} fields
 * @param {string} fields.tier         tier label (e.g. 'apex'). Free Forever needs NO token, so a
 *                                      signed token always names a paid/entitled tier.
 * @param {string} fields.state        entitlement state. Only 'active' | 'past_due' GRANT (verifier's
 *                                      GRANTING_STATES); anything else verifies fine but grants nothing.
 * @param {string[]} fields.namespaces granted namespace patterns (exact or 'prefix.*'). Unioned with
 *                                      the Free floor by the verifier.
 * @param {number} fields.expires_at   finite positive epoch-ms expiry. The verifier REQUIRES this
 *                                      (junk/missing/Infinity → Free); +14d grace is applied verifier-side.
 * @param {object} [fields.extra]      optional additional signed claims (e.g. account_id, node_did).
 *                                      Merged into the body; covered by the signature like every field.
 * @param {object} provPrivBundle      the provisioning PRIVATE key bundle (hybrid Ed25519 + ML-DSA-65).
 * @returns {object} the signed `efl.entitlement.v1` token, ready to JSON.stringify to disk.
 */
export function signEntitlement(fields = {}, provPrivBundle) {
  if (!provPrivBundle || typeof provPrivBundle !== 'object') {
    throw new Error('signEntitlement requires the provisioning private key bundle');
  }
  const { tier, state, namespaces, expires_at, extra } = fields;
  if (typeof tier !== 'string' || !tier) throw new Error('entitlement needs a tier');
  if (typeof state !== 'string' || !state) throw new Error('entitlement needs a state');
  if (!Array.isArray(namespaces)) throw new Error('entitlement namespaces must be an array of strings');
  // INERT SNAPSHOT WITHOUT TRUSTING THE INPUT'S METHODS (dual-Codex rounds 3+4): `namespaces` may be a
  // Proxy (Array.isArray sees through to a real target) that traps `.map`/`.every`/`.toJSON` to return
  // one value during validation and another at sign time, OR a getter on `extra` that mutates the live
  // array between validation and the body build. Defeat BOTH by reading `length` + each index exactly
  // ONCE via plain indexed access into a FRESH real array of validated primitive strings, calling NO
  // method on the input. A genuine array literal has no hijackable toJSON, and there is no longer any
  // trappable method or post-validation read for an attacker to exploit. tier/state/exp are inert
  // primitives from destructuring.
  const nsLen = namespaces.length;
  if (!Number.isInteger(nsLen) || nsLen < 0 || nsLen > 4096) throw new Error('entitlement namespaces is malformed (length)');
  const namespacesSnapshot = [];
  for (let i = 0; i < nsLen; i++) {
    const n = namespaces[i];
    if (typeof n !== 'string') throw new Error('entitlement namespaces must be an array of strings');
    namespacesSnapshot.push(n);
  }
  const exp = Number(expires_at);
  if (!Number.isFinite(exp) || exp <= 0) {
    throw new Error('entitlement expires_at must be a finite positive epoch-ms (a paid token must carry a window)');
  }
  // RESERVED-KEY GUARD (dual-Codex finding): `extra` carries ADDITIONAL signed claims only (e.g.
  // account_id, node_did for the node↔account binding) — it must NEVER override a core claim. Without
  // this, `extra:{tier:'enterprise', namespaces:['admin.*']}` would silently mint an escalated token.
  //
  // toJSON BYPASS (dual-Codex round 2): a raw key-check on `extra` is NOT enough — `extra` could be
  // `{ toJSON() { return {tier:'enterprise', namespaces:['admin.*']} } }`, whose only OWN key is the
  // innocuous `toJSON`, but which rewrites the WHOLE body when JSON.stringify later invokes it. So we
  // first MATERIALIZE `extra` into inert plain data via its own JSON round-trip (this runs any toJSON
  // ONCE, here, where we can inspect the result), THEN validate reserved-claim collisions on that
  // materialized object, THEN merge. The merged body therefore carries no callable toJSON, so the
  // body-level JSON.stringify below cannot be hijacked.
  let safeExtra = {};
  if (extra != null) {
    if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error('entitlement extra must be a plain object');
    try { safeExtra = JSON.parse(JSON.stringify(extra)); } catch { throw new Error('entitlement extra must be JSON-serializable'); }
    if (safeExtra == null || typeof safeExtra !== 'object' || Array.isArray(safeExtra)) {
      throw new Error('entitlement extra must serialize to a plain object'); // e.g. a toJSON returning a string/array
    }
    for (const k of Object.keys(safeExtra)) {
      if (RESERVED_CLAIMS.has(k)) throw new Error(`entitlement extra may not override the reserved claim "${k}"`);
    }
  }
  // The signed body = the token MINUS its sig — exactly what the verifier reconstructs via
  // canonicalBody(token). Key set + shape mirror what resolve() reads. Core fields are primitives and
  // safeExtra is inert plain data, so the body cannot carry a hijacking toJSON.
  const body = {
    format: 'efl.entitlement.v1',
    tier,
    state,
    namespaces: namespacesSnapshot, // the inert pre-materialization snapshot — never the live caller array
    expires_at: exp,
    ...safeExtra,
  };
  // ROUND-TRIP PARITY (dual-Codex finding): the verifier reads the token from disk (JSON.parse) and
  // reconstructs canonicalBody over THAT post-round-trip object. So we sign the EXACT bytes that will
  // land on disk — not the in-memory body — making "what we sign" === "what gets written" === "what
  // the verifier re-parses". (body is already inert plain data, so this is also defense-in-depth.)
  const persisted = JSON.parse(JSON.stringify(body));
  const sig = signPayload(canonical(persisted), provPrivBundle); // { ed25519Sig: Buffer, mldsaSig: Buffer }
  // Byte-array encoding (see file header): the only JSON-native form the unmodified verifier accepts
  // directly for BOTH signature halves after a disk round-trip. We return `persisted` (the signed
  // object), so the returned token is byte-identical to what was signed.
  return {
    ...persisted,
    sig: {
      ed25519Sig: Array.from(sig.ed25519Sig),
      mldsaSig: Array.from(sig.mldsaSig),
    },
  };
}
