/**
 * stage-runners.js — injected executors for pipeline stages. The engine never imports these
 * directly in tests (it injects deterministic fakes); these are the production defaults.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fetch from 'node-fetch';

/** Default model runner — calls the local OpenAI-compatible endpoint (identity + Tier-0 window apply). */
export function defaultModelRunner({ endpoint = `http://127.0.0.1:${process.env.PORT || 4099}/v1/chat/completions`, fallbackModel = 'qwen2.5:7b' } = {}) {
  // Only attach the gateway secret when the destination is the LOCAL shim — never leak it to a
  // remote endpoint a caller may point this runner at (Codex review of F2).
  let _loopback = false;
  try { const _h = new URL(endpoint).hostname.replace(/^\[|\]$/g, ''); _loopback = _h === '127.0.0.1' || _h === 'localhost' || _h === '::1'; } catch { /* malformed endpoint → no secret */ }
  const _auth = (_loopback && process.env.ATMOS_GATEWAY_SECRET) ? { 'x-atmos-gateway': process.env.ATMOS_GATEWAY_SECRET } : {};
  return async ({ system, user, model }) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._auth },
      body: JSON.stringify({
        model: model && model !== 'default' ? model : fallbackModel,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`model endpoint returned ${res.status}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content ?? '';
  };
}

/**
 * Default script runner — TRUSTED FIRST-PARTY ONLY (v1). This is NOT a sandbox: it runs a local
 * script with a hard timeout, input via STDIN (never argv), and a minimal env (no inherited
 * secrets). WASI sandboxing of untrusted scripts is future work.
 */
export function defaultScriptRunner() {
  return ({ scriptPath, stdin, cwd, timeoutMs = 30000 }) => new Promise((resolve, reject) => {
    const cmd = path.extname(scriptPath) === '.sh' ? 'bash' : 'node';
    const child = spawn(cmd, [scriptPath], {
      cwd,
      timeout: timeoutMs,
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', NODE_OPTIONS: '' }, // no secrets
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) return reject(new Error(`script killed (${signal}) — timeout ${timeoutMs}ms?`));
      if (code !== 0) return reject(new Error(`script exited ${code}: ${err.slice(0, 200)}`));
      resolve(out);
    });
    child.stdin.write(stdin || '');
    child.stdin.end();
  });
}
