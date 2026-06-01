/**
 * broker-client.js — the PARENT side of the out-of-process broker (Task #12). The agent/model uses this;
 * it spawns broker-process.js as a child and speaks newline-delimited JSON over the child's stdio (a
 * private inherited pipe — no named socket). The capability token is held HERE and injected into every
 * request, so the model-facing API never even surfaces it.
 *
 * Lifecycle = the child: if the broker child dies, in-flight calls reject and the token is gone. The
 * agent process never holds the vault key or plaintext — only handles in, results out.
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import url from 'node:url';
import path from 'node:path';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

export function startBroker({ registryPath, nodeBin = process.execPath, idleMs = 0 } = {}) {
  const child = spawn(nodeBin, [path.join(HERE, 'broker-process.js')], {
    stdio: ['pipe', 'pipe', 'inherit'], // stderr inherited for diagnostics; never parsed into results
    env: { ...process.env, STRATOS_BROKER_REGISTRY: registryPath || '' },
  });

  let capToken = null;
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  let resolveReady, rejectReady;
  const readyP = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.ready) { capToken = msg.capToken; resolveReady(); return; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p.resolve(msg.result); }
  });
  const fail = (err) => { closed = true; capToken = null; for (const p of pending.values()) p.reject(err); pending.clear(); rejectReady(err); };
  child.on('exit', () => fail(new Error('broker process exited')));
  child.on('error', (e) => fail(e));

  let idleTimer = null;
  const touch = () => { if (!idleMs) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => close(), idleMs); };

  function rpc(verb, payload) {
    if (closed) return Promise.reject(new Error('broker is closed'));
    touch();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, verb, payload: { ...payload, capToken } }) + '\n', (err) => {
        if (err) { pending.delete(id); reject(err); }
      });
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    try { child.stdin.end(); } catch { /* */ }
    try { child.kill(); } catch { /* */ }
  }

  return {
    ready: () => readyP,
    listTools: () => rpc('listTools', {}),
    proposeWrite: (p) => rpc('proposeWrite', p),
    callTool: (p) => rpc('callTool', p),
    close,
  };
}
