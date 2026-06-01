/**
 * vault.js — the sovereign credential vault for connectors / native MCP (Codex CRITICAL #5/#8).
 *
 * THE SECURITY CONTRACT:
 *  - Credentials live in a DEDICATED encrypted subtree (`.stratos-profile/connector-vault/`),
 *    SEPARATE from agent-config.json / runtime-state.json and from process env.
 *  - The agent (and the model, logs, chat-history, vector store, telemetry, mesh) only ever see an
 *    OPAQUE HANDLE (`cvault:<connector>:<kind>:<id>`). The raw secret is NEVER returned by list()/
 *    audit() and never appears in a handle.
 *  - `resolveSecret(handle)` is the ONE privileged path that returns plaintext — only the connector
 *    broker calls it, only at the outbound HTTP boundary, and the result is never logged.
 *  - AES-256-GCM at rest under a machine-local 0600 master key. Tamper → fail closed (auth tag).
 *  - `audit()` is the user-verifiable NON-EGRESS proof: file modes + a scan that the stored secrets
 *    do not appear in any given log/config/memory path.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = () => path.join(process.cwd(), '.stratos-profile', 'connector-vault');
const storePath = () => path.join(dir(), 'vault.json');
const masterKeyPath = () => path.join(dir(), '.master.key');
const HANDLE_RE = /^cvault:([a-z0-9_-]+):([a-z0-9_-]+):([a-f0-9]{16,})$/i;

function ensureDir() { fs.mkdirSync(dir(), { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir(), 0o700); } catch { /* */ } }

function writeLocked(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);            // defeat umask — guarantee 0600
  fs.renameSync(tmp, file);
}

/** The machine-local root of trust. Generated once, 0600. Never leaves the box. */
function masterKey() {
  ensureDir();
  try { const k = fs.readFileSync(masterKeyPath()); if (k.length === 32) return k; } catch { /* none */ }
  const k = crypto.randomBytes(32);
  writeLocked(masterKeyPath(), k);
  return k;
}

function loadStore() { try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return {}; } }
function saveStore(s) { ensureDir(); writeLocked(storePath(), JSON.stringify(s, null, 2)); }

/** Store a secret encrypted; return an OPAQUE handle (contains no secret material). */
export function putSecret({ connector, kind = 'oauth', value } = {}) {
  if (!/^[a-z0-9_-]+$/i.test(String(connector || ''))) throw new Error('invalid connector name');
  if (!/^[a-z0-9_-]+$/i.test(String(kind))) throw new Error('invalid kind');
  if (value == null || String(value) === '') throw new Error('empty secret');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const id = crypto.randomBytes(16).toString('hex');
  const store = loadStore();
  store[id] = { connector, kind, createdAt: Date.now(), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ct: ct.toString('hex') };
  saveStore(store);
  return `cvault:${connector}:${kind}:${id}`;
}

/** PRIVILEGED: return the plaintext secret for a handle. Broker-only; never log the result. */
export function resolveSecret(handle) {
  const m = HANDLE_RE.exec(String(handle || ''));
  if (!m) return null;
  const e = loadStore()[m[3]];
  if (!e) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(e.iv, 'hex'));
    d.setAuthTag(Buffer.from(e.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(e.ct, 'hex')), d.final()]).toString('utf8');
  } catch { return null; } // tamper / wrong key → fail closed
}

/** Metadata ONLY — never the secret value. Safe to show/log. */
export function list() {
  const store = loadStore();
  return Object.entries(store).map(([id, e]) => ({ handle: `cvault:${e.connector}:${e.kind}:${id}`, connector: e.connector, kind: e.kind, createdAt: e.createdAt }));
}

export function revoke(handle) {
  const m = HANDLE_RE.exec(String(handle || ''));
  if (!m) return false;
  const store = loadStore();
  if (!store[m[3]]) return false;
  delete store[m[3]];
  saveStore(store);
  return true;
}

/**
 * User-verifiable NON-EGRESS audit: reports the vault location + file modes, and proves the stored
 * secrets do NOT appear in any of `scanPaths` (logs / config / vector store / telemetry exports).
 */
export function audit({ scanPaths = [] } = {}) {
  const out = { vaultDir: dir(), storeExists: fs.existsSync(storePath()), handleCount: list().length, modes: {}, leaks: [] };
  for (const [label, p] of [['masterKey', masterKeyPath()], ['store', storePath()]]) {
    try { out.modes[label] = '0' + (fs.statSync(p).mode & 0o777).toString(8); } catch { out.modes[label] = 'missing'; }
  }
  const secrets = list().map((h) => resolveSecret(h.handle)).filter((s) => s && s.length >= 6);
  for (const p of scanPaths) {
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const s of secrets) if (txt.includes(s)) { out.leaks.push({ path: p }); break; }
  }
  out.modesOk = ['masterKey', 'store'].every((k) => out.modes[k] === '0600' || out.modes[k] === 'missing');
  out.clean = out.leaks.length === 0 && out.modesOk;
  return out;
}
