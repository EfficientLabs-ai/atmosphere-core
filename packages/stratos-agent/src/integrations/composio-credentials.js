/**
 * composio-credentials.js — PER-ENTITY sovereign credential storage for Composio toolkits.
 *
 * Thin layer over connectors/vault.js (the AES-256-GCM encrypted-at-rest store with opaque handles).
 * The vault resolves by OPAQUE HANDLE; the executor wants to resolve by (entity, toolkit, kind). This
 * module keeps a small, non-secret INDEX (entity/toolkit/kind → handle) so the broker-side executor
 * can find the right handle, while the SECRET VALUE only ever lives encrypted in the vault.
 *
 * Per-entity isolation: the vault `connector` is `composio_<entity>_<toolkit>`, so one entity's
 * credential is namespaced away from another's — addEntityCredential for entity A can never surface
 * for entity B.
 *
 * The index file holds NO secret material (handles + metadata only) and sits in .stratos-profile/.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as vaultMod from '../connectors/vault.js';
import { vaultConnectorFor } from './composio-exec.js';

const dir = () => process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
const idxPath = () => path.join(dir(), 'composio-credentials.json');

function loadIdx() {
  try { return JSON.parse(fs.readFileSync(idxPath(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`composio credential index unreadable: ${e.message}`); }
}
function saveIdx(idx) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${idxPath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, idxPath());
}
const idxKey = (connector, kind) => `${connector}:${kind}`;

/**
 * addEntityCredential — operator/onboarding path: store an entity's credential for a toolkit.
 * @param {string} entity   per-user/entity id
 * @param {string} toolkit  toolkit slug (github/gmail/slack…)
 * @param {string} value    the secret (PAT, OAuth access token, …) — goes ENCRYPTED into the vault only
 * @param {string} [kind]   'token' (PAT/bearer) or 'oauth' (OAuth access token)
 * @returns {{handle:string, connector:string}}  the OPAQUE handle (no secret material)
 */
export function addEntityCredential(entity, toolkit, value, kind = 'token', vault = vaultMod) {
  if (!entity || !toolkit) throw new Error('addEntityCredential needs entity + toolkit');
  if (value == null || String(value) === '') throw new Error('addEntityCredential: empty secret');
  const connector = vaultConnectorFor(entity, toolkit);
  const handle = vault.putSecret({ connector, kind, value: String(value) }); // secret → vault ONLY
  const idx = loadIdx();
  idx[idxKey(connector, kind)] = { handle, entity, toolkit, kind, createdAt: Date.now() };
  saveIdx(idx);
  return { handle, connector };
}

/**
 * resolveEntityCredential — broker-side privileged resolve by (connector, kind) → plaintext|null.
 * This is the resolver shape composio-exec.runToolAction expects in deps.resolveSecret. NEVER log it.
 */
export function resolveEntityCredential(connector, kind, vault = vaultMod) {
  const entry = loadIdx()[idxKey(connector, kind)];
  if (!entry) return null;
  return vault.resolveSecret(entry.handle);
}

/** Metadata-only listing for an entity (or all) — never the secret. */
export function listEntityCredentials(entity = null) {
  return Object.values(loadIdx())
    .filter((e) => !entity || e.entity === entity)
    .map((e) => ({ entity: e.entity, toolkit: e.toolkit, kind: e.kind, handle: e.handle, createdAt: e.createdAt }));
}

export function removeEntityCredential(entity, toolkit, kind = 'token', vault = vaultMod) {
  const connector = vaultConnectorFor(entity, toolkit);
  const idx = loadIdx();
  const k = idxKey(connector, kind);
  const entry = idx[k];
  if (!entry) return false;
  try { vault.revoke(entry.handle); } catch { /* best-effort */ }
  delete idx[k];
  saveIdx(idx);
  return true;
}

/** The resolver bound to a vault instance — convenient for prod wiring. */
export function makeResolver(vault = vaultMod) {
  return (connector, kind) => resolveEntityCredential(connector, kind, vault);
}
