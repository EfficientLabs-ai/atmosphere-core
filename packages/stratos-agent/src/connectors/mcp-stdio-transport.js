/**
 * mcp-stdio-transport.js — production transport for mcp-client.js: newline-delimited JSON-RPC over a
 * PINNED stdio MCP sidecar (the MCP stdio convention) (Task #12).
 *
 * Security posture:
 *  - The server binary + args are PINNED by the caller (the broker), launched least-privilege.
 *  - Auth is injected as ENVIRONMENT at spawn (connection-level) — never as a JSON-RPC parameter — so a
 *    malicious tool result cannot echo a credential back through the wire protocol.
 *  - Requests are correlated by JSON-RPC id; a response with no matching pending id is dropped.
 *  - stderr is captured but NEVER forwarded into tool content (keeps server diagnostics out of the model).
 */
import { spawn } from 'node:child_process';
import { safeChildEnv } from './safe-env.js';

export function createStdioTransport({ command, args = [], env = {}, auth = null, cwd } = {}) {
  if (!command) throw new Error('stdio transport requires a pinned command');
  // SECRET ISOLATION (Gap 3, #35): an MCP sidecar is an UNTRUSTED third-party process — it must NOT inherit
  // the agent's secrets. Build a minimal, secret-free env (OS essentials + non-secret Stratos paths) plus
  // ONLY the connector's declared env, then inject the single scoped auth var. (Was `{...process.env,...}`.)
  const childEnv = safeChildEnv(env);
  if (auth && auth.value) childEnv[auth.envVar || 'MCP_AUTH_TOKEN'] = auth.value;

  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, cwd });
  const pending = new Map(); // id -> {resolve, reject}
  let buf = '';
  let dead = null;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; } // ignore non-JSON noise
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); } // unmatched ids are dropped
    }
  });
  child.on('error', (e) => { dead = e; for (const p of pending.values()) p.reject(e); pending.clear(); });
  child.on('exit', (code) => { dead = dead || new Error(`mcp sidecar exited (${code})`); for (const p of pending.values()) p.reject(dead); pending.clear(); });

  return {
    send(req) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        pending.set(req.id, { resolve, reject });
        child.stdin.write(JSON.stringify(req) + '\n', (err) => { if (err) { pending.delete(req.id); reject(err); } });
      });
    },
    close() { try { child.kill(); } catch { /* */ } },
  };
}
