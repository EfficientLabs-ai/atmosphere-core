/**
 * safe-env.js — build a MINIMAL child environment for spawned processes (the broker subprocess and every
 * MCP connector sidecar), so the agent's secrets never leak into them by inheritance (Gap 3, #35).
 *
 * The bug it fixes: both the broker child (broker-client.js) and each stdio sidecar
 * (mcp-stdio-transport.js) were spawned with `{ ...process.env, … }`, handing the FULL parent environment
 * — every API key / token the daemon decrypted into its own env at start — to those children. A sidecar
 * is an UNTRUSTED third-party MCP server; it must receive ONLY what it needs to run plus its own injected
 * credential (resolved from the vault inside the broker), never the rest of the agent's secrets.
 *
 * safeChildEnv() returns just the OS-level essentials a process needs to execute, plus an explicit
 * allow-list of NON-secret Stratos path/config vars, plus whatever the caller passes in `extra` (e.g. a
 * connector's declared env or a single scoped auth var). Deny-by-default for everything else.
 */

// OS essentials a child genuinely needs to find/run its binary. NONE of these are secrets.
const OS_ESSENTIAL = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'SHELL', 'TERM', 'SystemRoot', 'WINDIR', 'COMSPEC', 'NODE_PATH', 'NODE_OPTIONS'];

// Non-secret Stratos config the broker/vault need to locate their on-disk files (paths, not credentials).
const STRATOS_NONSECRET = ['STRATOS_VAULT_DIR', 'STRATOS_PROFILE_DIR'];

/** A minimal, secret-free base env + the caller's explicit additions. */
export function safeChildEnv(extra = {}, env = process.env) {
  const out = {};
  for (const k of OS_ESSENTIAL) if (env[k] != null) out[k] = env[k];
  for (const k of STRATOS_NONSECRET) if (env[k] != null) out[k] = env[k];
  // `extra` is the caller's explicit, scoped additions (connector-declared env, one injected auth var, the
  // broker registry path) — always applied last so an intentional value wins.
  return { ...out, ...extra };
}
