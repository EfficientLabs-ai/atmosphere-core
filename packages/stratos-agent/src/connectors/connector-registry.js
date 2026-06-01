/**
 * connector-registry.js — manages the on-disk connector registry the broker consumes (.stratos-profile/
 * connectors.json), plus the vault binding. Onboarding a connector stores its credential in the VAULT
 * (encrypted, opaque handle) and records ONLY the handle + the pinned sidecar command in the registry —
 * the secret value is NEVER written to the registry or any config.
 *
 * The file shape matches what broker-process.js (Task #12) reads: { tools, connectors:{ name:{ credentialHandle,
 * command, args, authEnvVar } } }. Tool risk-tagging stays broker-owned and is configured separately.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as vaultMod from './vault.js';

const dir = () => process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
const regPath = () => path.join(dir(), 'connectors.json');
const NAME_RE = /^[a-z0-9_-]+$/i;

function load() {
  try { const r = JSON.parse(fs.readFileSync(regPath(), 'utf8')); return { tools: r.tools || {}, connectors: r.connectors || {} }; }
  catch (e) { if (e.code === 'ENOENT') return { tools: {}, connectors: {} }; throw new Error(`connector registry unreadable/corrupt: ${e.message}`); }
}
function save(reg) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${regPath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, regPath());
}

/** Onboard a connector: secret → vault (encrypted); registry gets the opaque handle + pinned sidecar. */
export function addConnector({ name, kind = 'oauth', secret, command, args = [], authEnvVar = 'MCP_AUTH_TOKEN' } = {}, vault = vaultMod) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('invalid connector name (letters/digits/_/- only)');
  if (!command || typeof command !== 'string') throw new Error('connector needs a pinned sidecar command');
  const reg = load();
  let credentialHandle = null;
  if (secret != null && String(secret) !== '') {
    credentialHandle = vault.putSecret({ connector: name, kind, value: String(secret) }); // secret → vault ONLY
  }
  reg.connectors[name] = { credentialHandle, command, args: Array.isArray(args) ? args : [], authEnvVar };
  save(reg);
  return { name, credentialHandle, command, hasCredential: !!credentialHandle };
}

/** Metadata only — never the secret. */
export function listConnectors() {
  return Object.entries(load().connectors).map(([name, c]) => ({ name, hasCredential: !!c.credentialHandle, command: c.command }));
}

export function removeConnector(name, vault = vaultMod) {
  const reg = load();
  const c = reg.connectors[name];
  if (!c) return false;
  if (c.credentialHandle) { try { vault.revoke(c.credentialHandle); } catch { /* best-effort revoke */ } }
  delete reg.connectors[name];
  save(reg);
  return true;
}

export function registryPath() { return regPath(); }
