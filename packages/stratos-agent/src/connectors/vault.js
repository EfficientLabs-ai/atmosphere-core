/**
 * vault.js — the sovereign credential STORAGE PRIMITIVE for connectors / native MCP.
 * (Task #11; Codex CRITICAL #5/#8, hardened by the Codex impl review.)
 *
 * SCOPE / HONEST BOUNDARY:
 *  - This is the encrypted-at-rest STORAGE layer. Full in-process isolation — so the model/agent can
 *    never call resolveSecret() in-memory — requires a SEPARATE BROKER PROCESS (Task #12). Until that
 *    lands, `resolveSecret` is the privileged primitive the broker will own; do NOT import it from the
 *    model/agent path. OS-keychain backing is a further hardening on top of this.
 *
 * WHAT THIS LAYER GUARANTEES:
 *  - Credentials live OUTSIDE the model's working dir (STRATOS_VAULT_DIR or ~/.local/share/stratos),
 *    SEPARATE from agent-config / env. Callers only ever see an OPAQUE HANDLE.
 *  - AES-256-GCM at rest under a machine-local 0600 master key, with connector/kind/id bound as AAD
 *    (forging metadata breaks authentication). Tamper → fail closed.
 *  - Fail-hard, not fail-silent: a missing key over a non-empty store, or a corrupt store, surfaces a
 *    fault — it never looks like an empty/clean vault.
 *  - audit() proves vault HYGIENE (encrypted-at-rest, 0600, key-consistent) WITHOUT decrypting — it
 *    never materializes plaintext in this process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = () => process.env.STRATOS_VAULT_DIR || path.join(os.homedir(), '.local', 'share', 'stratos', 'connector-vault');
const storePath = () => path.join(dir(), 'vault.json');
const masterKeyPath = () => path.join(dir(), 'master.key');
const lockPath = () => path.join(dir(), '.lock');
const HANDLE_RE = /^cvault:([a-z0-9_-]+):([a-z0-9_-]+):([a-f0-9]{32})$/i;

function ensureDir() { fs.mkdirSync(dir(), { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir(), 0o700); } catch { /* */ } }
function writeLocked(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Cross-process mutual exclusion so concurrent put/revoke can't lose writes or resurrect secrets. */
function withLock(fn) {
  ensureDir();
  let fd;
  try { fd = fs.openSync(lockPath(), 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') { try { if (Date.now() - fs.statSync(lockPath()).mtimeMs > 5000) { fs.unlinkSync(lockPath()); fd = fs.openSync(lockPath(), 'wx'); } } catch { /* */ } }
    if (fd === undefined) throw new Error('vault is locked by another writer; retry');
  }
  try { return fn(); } finally { try { fs.closeSync(fd); } catch { /* */ } try { fs.unlinkSync(lockPath()); } catch { /* */ } }
}

/** ENOENT → empty (fine). Anything else → THROW (corruption must never look like an empty vault). */
function loadStore() {
  try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`vault store unreadable/corrupt: ${e.message}`); }
}
function storeNonEmpty() { try { return Object.keys(loadStore()).length > 0; } catch { return true; } }

/** Machine-local root of trust. Created ONLY on first init; refuses to regenerate over existing data. */
function masterKey() {
  ensureDir();
  try { const k = fs.readFileSync(masterKeyPath()); if (k.length === 32) return k; throw new Error('master key wrong length'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`vault master key fault: ${e.message}`);
  }
  if (storeNonEmpty()) throw new Error('master key missing but store is non-empty — refusing to regenerate (possible tampering)');
  const k = crypto.randomBytes(32);
  writeLocked(masterKeyPath(), k);
  return k;
}

const aad = (connector, kind, id) => Buffer.from(`cvault:${connector}:${kind}:${id}`, 'utf8');

/** Store a secret encrypted; return an OPAQUE handle (no secret material in it). */
export function putSecret({ connector, kind = 'oauth', value } = {}) {
  if (!/^[a-z0-9_-]+$/i.test(String(connector || ''))) throw new Error('invalid connector name');
  if (!/^[a-z0-9_-]+$/i.test(String(kind))) throw new Error('invalid kind');
  if (value == null || String(value) === '') throw new Error('empty secret');
  return withLock(() => {
    const key = masterKey();
    const id = crypto.randomBytes(16).toString('hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(connector, kind, id)); // authenticate the metadata: forging it breaks GCM
    const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const store = loadStore();
    store[id] = { connector, kind, createdAt: Date.now(), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ct: ct.toString('hex') };
    writeLocked(storePath(), JSON.stringify(store, null, 2));
    return `cvault:${connector}:${kind}:${id}`;
  });
}

/** PRIVILEGED (broker-only — see header): return plaintext for a handle. Never log the result. */
export function resolveSecret(handle) {
  const m = HANDLE_RE.exec(String(handle || ''));
  if (!m) return null;
  const [, connector, kind, id] = m;
  let e; try { e = loadStore()[id]; } catch { return null; }
  if (!e || e.connector !== connector || e.kind !== kind) return null; // handle/metadata mismatch
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(e.iv, 'hex'));
    d.setAAD(aad(connector, kind, id));
    d.setAuthTag(Buffer.from(e.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(e.ct, 'hex')), d.final()]).toString('utf8');
  } catch { return null; } // tamper / forged metadata / wrong key → fail closed
}

/** Metadata ONLY — never the secret value. */
export function list() {
  return Object.entries(loadStore()).map(([id, e]) => ({ handle: `cvault:${e.connector}:${e.kind}:${id}`, connector: e.connector, kind: e.kind, createdAt: e.createdAt }));
}

export function revoke(handle) {
  const m = HANDLE_RE.exec(String(handle || ''));
  if (!m) return false;
  return withLock(() => { const store = loadStore(); if (!store[m[3]]) return false; delete store[m[3]]; writeLocked(storePath(), JSON.stringify(store, null, 2)); return true; });
}

/** Vault-HYGIENE proof — never decrypts, never materializes plaintext in this process. */
export function audit() {
  const out = { vaultDir: dir(), modes: {}, fault: null };
  for (const [label, p] of [['masterKey', masterKeyPath()], ['store', storePath()]]) {
    try { out.modes[label] = '0' + (fs.statSync(p).mode & 0o777).toString(8); } catch (e) { out.modes[label] = e.code === 'ENOENT' ? 'missing' : 'error'; }
  }
  let entries = {};
  try { entries = loadStore(); } catch (e) { out.fault = e.message; }
  out.handleCount = Object.keys(entries).length;
  out.encryptedAtRest = Object.values(entries).every((e) => e && e.iv && e.tag && e.ct && !('value' in e) && !('plaintext' in e));
  out.modesOk = ['masterKey', 'store'].every((k) => out.modes[k] === '0600' || out.modes[k] === 'missing');
  out.keyConsistent = !(out.modes.masterKey === 'missing' && out.handleCount > 0); // missing key over data = tamper/loss
  out.healthy = !out.fault && out.modesOk && out.encryptedAtRest && out.keyConsistent;
  return out;
}
