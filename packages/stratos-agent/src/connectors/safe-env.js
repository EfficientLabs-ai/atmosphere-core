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

// OS essentials a child genuinely needs to find/run its binary + resolve $HOME on every platform. NONE
// of these are secrets. Windows home is USERPROFILE / HOMEDRIVE+HOMEPATH (os.homedir() reads them), so
// the broker's default vault path keeps working there when STRATOS_VAULT_DIR is unset.
const OS_ESSENTIAL = ['PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP',
  'TMP', 'SHELL', 'TERM', 'SystemRoot', 'WINDIR', 'COMSPEC', 'NODE_PATH', 'NODE_OPTIONS',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'];

// Standard NON-secret networking/TLS config a networked sidecar needs (proxies + CA bundles). These are
// configuration, not credentials — omitting them silently breaks sidecars behind a proxy or custom CA.
const NET_TLS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE'];

// Non-secret Stratos config the broker/vault need to locate their on-disk files (paths, not credentials).
const STRATOS_NONSECRET = ['STRATOS_VAULT_DIR', 'STRATOS_PROFILE_DIR'];

/** A minimal, secret-free base env + the caller's explicit additions. */
export function safeChildEnv(extra = {}, env = process.env) {
  const out = {};
  for (const k of OS_ESSENTIAL) if (env[k] != null) out[k] = env[k];
  for (const k of NET_TLS) if (env[k] != null) out[k] = env[k];
  for (const k of STRATOS_NONSECRET) if (env[k] != null) out[k] = env[k];
  // `extra` is the caller's explicit, scoped additions (connector-declared env, one injected auth var, the
  // broker registry path) — always applied last so an intentional value wins.
  return { ...out, ...extra };
}
