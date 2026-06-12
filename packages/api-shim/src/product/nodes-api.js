/**
 * nodes-api.js — POST /v1/nodes/register (ATMOS_API_SPEC §2.8).
 *
 * Registers THIS node: mints the hybrid node keypair only if one does not exist yet (an existing
 * identity is REUSED, never overwritten — registration must never rotate keys silently), writes a
 * registry entry, and emits a `node-register` receipt onto the signed chain. R2/L4: creates
 * identity + standing state, so it is never silent — every registration logs one line.
 *
 * Out: `{ node_id, public_key, receipt_id, registered }` — the PUBLIC key bundle only. The private
 * half never leaves the node (it is written 0600 and never read back into a response).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

const PASSTHROUGH = (req, res, next) => next();
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/; // human node name — bounded, no control chars

function resolveProfileDir(opts = {}) {
  return opts.profileDir || process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function createNodesRouter(opts = {}) {
  const router = express.Router();
  const auth = opts.auth || PASSTHROUGH;
  // identity deps — pure fns from the stratos-agent suite, injected like the F1/F2 routers
  const identity = opts.identity || null; // { generateHybridKeyPair, originId, normalizeWallet }
  const record = opts.record || null;     // the synchronous receipt recorder (continuity-receipt.js)
  const now = opts.now || (() => Date.now());
  const profileDir = resolveProfileDir(opts);
  const nodeKeysFile = () => process.env.STRATOS_NODE_KEYS || path.join(profileDir, 'node-keys.json');
  const registryFile = () => path.join(profileDir, 'node-registry.json');
  const deny = (res, code, message) => res.status(code).json({ error: { message, type: 'nodes_api' } });

  // ── POST /v1/nodes/register — mint-or-REUSE identity + registry entry + receipt ──
  router.post('/v1/nodes/register', auth, express.json({ limit: '64kb' }), (req, res) => {
    if (!identity?.generateHybridKeyPair || !identity?.originId) return deny(res, 503, 'identity module unavailable');
    const { name, owner_wallet = null, capabilities = [] } = req.body || {};
    if (typeof name !== 'string' || !NAME_RE.test(name)) return deny(res, 400, 'name required: 1–120 chars, letters/digits/space/._-');
    if (!Array.isArray(capabilities) || capabilities.length > 64 || capabilities.some((c) => typeof c !== 'string' || c.length > 120)) {
      return deny(res, 400, 'capabilities must be an array of ≤64 short strings');
    }
    let wallet = null;
    if (owner_wallet != null && owner_wallet !== '') {
      wallet = identity.normalizeWallet ? identity.normalizeWallet(owner_wallet) : false;
      if (wallet === false) return deny(res, 400, 'owner_wallet must be a valid Solana address (base58, 32–44 chars) or absent — never fabricated, never silently dropped');
    }

    // mint OR reuse — an existing node identity is never overwritten by a registration call.
    // RACE-SAFE (dual-Codex): the mint writes with O_EXCL ('wx') so two concurrent first-time
    // registrations cannot clobber each other — the loser reads the winner's identity and reuses it.
    const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
    const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    let publicKeyB64, minted = false;
    try {
      if (fs.existsSync(nodeKeysFile())) {
        publicKeyB64 = JSON.parse(fs.readFileSync(nodeKeysFile(), 'utf8')).publicKey;
        if (!publicKeyB64) return deny(res, 500, 'existing node-keys.json carries no public key — refusing to overwrite it');
      } else {
        const kp = identity.generateHybridKeyPair();
        const freshB64 = b64(kp.publicKey);
        fs.mkdirSync(profileDir, { recursive: true });
        try {
          fs.writeFileSync(nodeKeysFile(), JSON.stringify({ publicKey: freshB64, privateKey: b64(kp.privateKey) }), { mode: 0o600, flag: 'wx' });
          publicKeyB64 = freshB64;
          minted = true;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          // lost the race — the concurrent winner's identity is THE identity; reuse it
          publicKeyB64 = JSON.parse(fs.readFileSync(nodeKeysFile(), 'utf8')).publicKey;
          if (!publicKeyB64) return deny(res, 500, 'raced mint left no readable public key — refusing');
        }
      }
    } catch (e) { return deny(res, 500, 'node identity error: ' + e.message); }
    let node_id;
    try { node_id = identity.originId(dec(publicKeyB64)); }
    catch (e) { return deny(res, 500, 'existing key file is unusable (' + e.message + ') — refusing to touch it; restore or remove it deliberately'); }

    // registry upsert — IDEMPOTENT (dual-Codex): re-registering preserves registered_at, stamps
    // updated_at, mints NO second identity receipt, and answers 200 (201 is first-time only).
    let reg = { format: 'atmos.node-registry.v1', nodes: [] };
    try { reg = JSON.parse(fs.readFileSync(registryFile(), 'utf8')); } catch { /* first registration */ }
    if (!Array.isArray(reg.nodes)) reg.nodes = [];
    const prior = reg.nodes.find((n) => n.node_id === node_id) || null;
    const priorRaw = JSON.stringify(reg, null, 2);
    const stamp = new Date(now()).toISOString();
    // a TRUE no-op replay (identical name/wallet/capabilities) mutates NOTHING — not even
    // updated_at (dual-Codex: idempotent means the same request stops changing server state).
    const unchanged = !!prior && prior.name === name
      && (prior.owner_wallet ?? null) === wallet
      && JSON.stringify(prior.capabilities ?? []) === JSON.stringify(capabilities);
    const rollbackFreshKey = () => { if (minted) { try { fs.rmSync(nodeKeysFile(), { force: true }); } catch { /* best-effort */ } } };
    const entry = unchanged ? prior
      : prior
        ? { ...prior, name, owner_wallet: wallet, capabilities, updated_at: stamp }
        : { node_id, name, owner_wallet: wallet, capabilities, registered_at: stamp };
    if (!unchanged) {
      try {
        reg.nodes = [...reg.nodes.filter((n) => n.node_id !== node_id), entry];
        fs.mkdirSync(profileDir, { recursive: true });
        fs.writeFileSync(registryFile(), JSON.stringify(reg, null, 2));
      } catch (e) {
        rollbackFreshKey(); // a refused FIRST registration leaves nothing behind — registry-write failures included
        return deny(res, 500, 'registry write failed' + (minted ? ' — freshly-minted key rolled back' : '') + ': ' + e.message);
      }
    }

    // node-register receipt — FIRST registration only, and FAIL-CLOSED (dual-Codex): a mutation on
    // a proof-surface without its receipt is refused, and EVERYTHING this request created is
    // rolled back — the registry write AND a key minted by this very request (leaving a fresh
    // identity behind on a refusal is fail-open by another name). A reused pre-existing key is
    // never deleted. Re-registration is a registry update, not a new identity act.
    let receipt_id = null;
    if (!prior) {
      const revert = (why) => {
        try { fs.writeFileSync(registryFile(), priorRaw); } catch { /* best-effort; the 503 still refuses */ }
        rollbackFreshKey();
        return deny(res, 503, why);
      };
      if (!record) return revert('receipt recorder unavailable — registration is a proof-surface mutation and refuses without its receipt (fail-closed; nothing was kept)');
      receipt_id = record({
        action: 'node-register', ref: `node:register:${name}`, owner_wallet: wallet,
        input_hash: sha256(JSON.stringify({ name, capabilities })), output_hash: sha256(node_id),
      });
      if (!receipt_id) return revert('receipt mint failed — registration refused, registry and freshly-minted key rolled back (fail-closed; retry when the receipt rail is back)');
    }
    // R2/L4 — never silent
    try { console.log(`[nodes] register ${node_id.slice(0, 24)}… name="${name}" minted=${minted} first=${!prior} receipt=${receipt_id || '(reuse: none)'} `); } catch { /* logging is best-effort */ }
    res.status(prior ? 200 : 201).json({ node_id, public_key: publicKeyB64, receipt_id, registered: true, first_registration: !prior, key_minted: minted });
  });

  return router;
}
