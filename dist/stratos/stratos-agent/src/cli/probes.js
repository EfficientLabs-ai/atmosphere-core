/**
 * probes.js — read-only environment probes for `stratos doctor` / `stratos status`.
 *
 * Codex guardrail: these NEVER mutate and NEVER phone home — they only inspect the LOCAL machine
 * (Node version, a localhost port, a localhost Ollama). All are injectable so the CLI can be unit
 * tested without a real network or daemon.
 */
import net from 'node:net';

export const MIN_NODE_MAJOR = 18;

export function nodeVersion() {
  const raw = process.versions.node;
  const major = parseInt(raw.split('.')[0], 10);
  return { raw, major, ok: major >= MIN_NODE_MAJOR };
}

/** Is something listening on a localhost TCP port? (daemon up/down — read-only.) */
export function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (listening) => { if (!done) { done = true; try { sock.destroy(); } catch { /* */ } resolve(listening); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));   // ECONNREFUSED → nothing listening
    sock.connect(port, host);
  });
}

/** Is a local Ollama reachable, and which models are installed? (read-only GET.) */
export async function probeOllama(host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', timeoutMs = 1500) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${host}/api/tags`, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return { reachable: false, models: [] };
    const j = await r.json();
    const models = Array.isArray(j.models) ? j.models.map((m) => m.name).filter(Boolean) : [];
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

/** Default real-probe bundle; the CLI accepts an override for tests. */
export const realProbes = { nodeVersion, probePort, probeOllama };
