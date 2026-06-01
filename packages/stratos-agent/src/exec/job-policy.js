/**
 * job-policy.js — the SCOPED-RUNNER policy gate for sovereign exec (Task #16, 2nd increment).
 *
 * Closes the gaps an earlier audit flagged in execution/wasi-sandbox.js: caller-supplied mounts were
 * mapped with no `..`/over-grant validation, and the network check was a stub. This pure layer sanitizes
 * a job spec BEFORE it reaches the sandbox, deny-by-default on every axis:
 *
 *   - MOUNTS: no `..` traversal; guest path must be absolute; host path must resolve UNDER an explicit
 *     workspace root (so `/`, `/etc`, `~/.ssh`, etc. can never be granted). Preopens are empty by default.
 *   - ENV: explicit allow-list AND never secret-shaped — a key whose segments look like a credential
 *     (key/token/secret/seed/keypair/…) is refused even if someone allow-listed it (defense-in-depth
 *     against forwarding SOLANA_KEYPAIR / *_API_KEY into an untrusted guest).
 *   - NETWORK: deny-by-default; only domains the policy explicitly allows pass through.
 *
 * The sanitized output is exactly what WasiSandbox consumes (allowedPaths / allowedEnvKeys / env /
 * allowedDomains), and it is what the exec-controller receipt commits to (controller-identity.js), so a
 * receipt proves the EXACT sanitized spec that ran.
 */
import path from 'node:path';
import fs from 'node:fs';

const SECRET_WORDS = new Set(['key', 'token', 'secret', 'password', 'passwd', 'seed', 'mnemonic', 'private', 'credential', 'credentials', 'keypair', 'apikey', 'auth', 'cert']);

// a key "looks secret" if any underscore/dash-delimited segment is a credential word, or it contains
// a strong substring marker. Segment-based to avoid false positives (MONKEY_MODE is not a secret).
function looksSecret(k) {
  const segs = String(k).toLowerCase().split(/[^a-z0-9]+/);
  if (segs.some((s) => SECRET_WORDS.has(s))) return true;
  return /secret|password|passwd|mnemonic|private|keypair/i.test(k);
}

export function sanitizeJobSpec(spec = {}, policy = {}) {
  const violations = [];
  // realpath the roots ONCE (follows symlinks; e.g. /tmp → /private/tmp). A non-existent root can't
  // anchor a grant, so it is simply dropped — grants under it will then fail the under-root check.
  const workspaceRoots = [];
  for (const p of (policy.workspaceRoots || [])) {
    try { workspaceRoots.push(fs.realpathSync(path.resolve(p))); } catch { /* non-existent root → cannot anchor */ }
  }
  const allowedEnvKeys = new Set(policy.allowedEnvKeys || []);
  const allowDomains = new Set(policy.allowDomains || []);
  const maxMounts = policy.maxMounts ?? 8;

  // --- mounts → preopens (deny-by-default; no traversal; under a workspace root) ---
  const allowedPaths = {}; // guest -> host
  const mounts = Array.isArray(spec.mounts) ? spec.mounts : [];
  if (mounts.length > maxMounts) violations.push(`too many mounts (${mounts.length} > ${maxMounts})`);
  for (const m of mounts.slice(0, maxMounts)) {
    const host = String(m?.host ?? '');
    const guest = String(m?.guest ?? '');
    if (!host || !guest) { violations.push('mount requires both host and guest'); continue; }
    if (host.includes('..') || guest.includes('..')) { violations.push(`mount path traversal refused: ${host} -> ${guest}`); continue; }
    if (!path.isAbsolute(host)) { violations.push(`host mount must be an absolute path: ${host}`); continue; }
    if (!path.isAbsolute(guest)) { violations.push(`guest mount must be an absolute path: ${guest}`); continue; }
    // realpathSync FOLLOWS SYMLINKS, so a symlink inside a root pointing at /etc resolves to /etc and is
    // then rejected by the under-root check. A non-existent path is denied (you can't mount what isn't there).
    let rHost;
    try { rHost = fs.realpathSync(host); }
    catch { violations.push(`host path does not exist or is inaccessible: ${host}`); continue; }
    const underRoot = workspaceRoots.some((root) => rHost === root || rHost.startsWith(root + path.sep));
    if (!underRoot) { violations.push(`host path is outside the workspace roots: ${rHost}`); continue; }
    allowedPaths[guest] = rHost;
  }

  // --- env (explicit allow-list AND never secret-shaped) ---
  const env = {};
  const allowedEnvKeysOut = [];
  const droppedEnv = [];
  for (const [k, v] of Object.entries(spec.env || {})) {
    if (looksSecret(k)) { violations.push(`secret-shaped env key refused: ${k}`); continue; }
    if (!allowedEnvKeys.has(k)) { droppedEnv.push(k); continue; } // deny-by-default, silent drop
    env[k] = String(v); allowedEnvKeysOut.push(k);
  }

  // --- network (deny-by-default) ---
  const allowedDomains = [];
  for (const d of (Array.isArray(spec.domains) ? spec.domains : [])) {
    if (allowDomains.has(d)) allowedDomains.push(String(d));
    else violations.push(`network domain not in policy allow-list: ${d}`);
  }

  return {
    ok: violations.length === 0,
    violations,
    droppedEnv, // keys silently denied (not a violation, just not allow-listed) — surfaced for transparency
    sanitized: { allowedPaths, allowedEnvKeys: allowedEnvKeysOut, env, allowedDomains },
  };
}
