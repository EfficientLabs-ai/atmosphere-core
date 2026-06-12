/**
 * session-manager.js — Atmos Terminal slice 2: PTY session lifecycle, decoupled from transport.
 * (03_reviews/ATMOS_TERMINAL_BACKEND.md §3 — the one genuinely new component.)
 *
 * One session API; every surface (web/xterm.js, CLI, future TUI) is a client. The manager owns:
 *   - CREATE: spawn a PTY from a sanitized spec — profiles `default` (login shell, cwd jailed
 *     under the workspace root) and `agent` (tmux attach to an EXISTING session; tmux gives
 *     detach-survival/multi-viewer/scrollback for free — we never build a multiplexer).
 *   - OWNERSHIP: sessions bind to the creating identity; attach/input/kill are owner-only.
 *     (Today the bridge has one secret-bearing identity; the owner field is structural so
 *     owner-identity DIDs slot in when pairing lands — stated honestly, not claimed done.)
 *   - ATTACH/DETACH decoupled from PTY lifetime: a bounded ring buffer replays recent output
 *     on (re)attach; a dropped transport never kills the session.
 *   - SINGLE-USE ATTACH TOKENS: short-expiry, bound to one session — the long-lived gateway
 *     secret never appears in a ws:// URL (it would land in logs).
 *   - FLOW CONTROL: WebSocket gives JS no backpressure signal (xterm.js guidance), so output
 *     is metered — unacked bytes past the high-water mark PAUSE the PTY until the client acks.
 *   - IDLE REAPING + caps: no attached client AND no output for idleMs → SIGHUP + receipt;
 *     per-owner concurrent-session cap.
 *   - RECEIPTS: start/attach/detach/end emit through an injected recorder (production wiring
 *     signs them onto the daemon's receipt chain as action 'term-session').
 *
 * SECURITY: the PTY env is ALLOWLIST-BUILT (PATH/HOME/TERM/LANG/USER/SHELL/COLORTERM only) —
 * the bridge's own env carries ATMOS_GATEWAY_SECRET and must NEVER be inherited by a shell.
 * node-pty runs at process privilege (its own warning): the bridge user stays unprivileged and
 * the `default` profile offers no sudo path. Everything is dependency-injected (spawnPty, now,
 * tokens) so the lifecycle is hermetically testable without the native addon.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ENV_ALLOWLIST = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'COLORTERM'];
const TOKEN_TTL_MS = 60_000;
const RING_BYTES = 64 * 1024;
const HIGH_WATER = 256 * 1024;        // unacked bytes before the PTY is paused
const IDLE_MS = 15 * 60_000;
const MAX_PER_OWNER = 4;
const TMUX_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Build the sanitized child env — allowlist, never inherit (the bridge env holds the secret). */
export function sanitizedEnv(source = process.env) {
  const env = {};
  for (const k of ENV_ALLOWLIST) if (source[k] != null) env[k] = source[k];
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}

/** Default PTY backend: lazy node-pty (optionalDependency). Absent → null, caller 503s. */
export async function loadNodePty() {
  try { return (await import('node-pty')); } catch { return null; }
}

export function createSessionManager(opts = {}) {
  const spawnPty = opts.spawnPty;                       // ({file,args,cwd,env,cols,rows}) => pty
  if (typeof spawnPty !== 'function') throw new Error('createSessionManager requires spawnPty');
  const now = opts.now || Date.now;
  const recordEvent = opts.recordEvent || (() => {});    // ({event, session_id, owner, profile, meta}) — best-effort
  const workspaceRoot = opts.workspaceRoot || process.cwd();
  const idleMs = opts.idleMs ?? IDLE_MS;
  const maxPerOwner = opts.maxPerOwner ?? MAX_PER_OWNER;
  const ringBytes = opts.ringBytes ?? RING_BYTES;
  const highWater = opts.highWater ?? HIGH_WATER;
  const tokenTtlMs = opts.tokenTtlMs ?? TOKEN_TTL_MS;
  const envSource = opts.envSource || process.env;

  const sessions = new Map(); // id → session
  const tokens = new Map();   // token → { sessionId, expires, used }

  const emit = (event, s, meta = {}) => {
    try { recordEvent({ event, session_id: s.id, owner: s.owner, profile: s.profile, ...meta }); }
    catch { /* receipts are best-effort; lifecycle never blocks on them */ }
  };

  function jailCwd(cwd) {
    const base = fs.realpathSync(workspaceRoot);
    const target = cwd ? path.resolve(base, cwd) : base;
    let real;
    try { real = fs.realpathSync(target); } catch { return null; }
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    return real;
  }

  function mintToken(sessionId) {
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, { sessionId, expires: now() + tokenTtlMs, used: false });
    return token;
  }

  /** Redeem a single-use attach token. Expired/used/foreign tokens fail closed. */
  function redeemToken(token, sessionId) {
    const t = tokens.get(token);
    if (!t || t.used || t.sessionId !== sessionId || now() > t.expires) return false;
    t.used = true;
    tokens.delete(token);
    return true;
  }

  function create({ owner, profile = 'default', cwd = null, cols = 80, rows = 24, tmuxSession = null } = {}) {
    if (!owner || typeof owner !== 'string') throw Object.assign(new Error('owner identity required'), { code: 400 });
    const mine = [...sessions.values()].filter((s) => s.owner === owner && !s.exited);
    if (mine.length >= maxPerOwner) throw Object.assign(new Error(`session cap reached (${maxPerOwner} per identity)`), { code: 429 });

    let spec;
    if (profile === 'default') {
      const dir = jailCwd(cwd);
      if (!dir) throw Object.assign(new Error('cwd outside the workspace root (jailed)'), { code: 403 });
      const shell = sanitizedEnv(envSource).SHELL || '/bin/bash';
      spec = { file: shell, args: ['-l'], cwd: dir };
    } else if (profile === 'agent') {
      // tmux attach to an EXISTING agent session — a distinct, higher-authority capability
      // (the agent's full ambient authority). Callers gate it; the manager validates the name.
      if (!tmuxSession || !TMUX_NAME.test(tmuxSession)) throw Object.assign(new Error('agent profile requires a valid tmuxSession name'), { code: 400 });
      spec = { file: 'tmux', args: ['attach-session', '-t', tmuxSession], cwd: fs.realpathSync(workspaceRoot) };
    } else {
      throw Object.assign(new Error(`unknown profile "${profile}" (default|agent)`), { code: 400 });
    }

    const env = sanitizedEnv(envSource); // NEVER the bridge env — it carries the gateway secret
    const pty = spawnPty({ ...spec, env, cols, rows });
    const id = crypto.randomBytes(8).toString('hex');
    const s = {
      id, owner, profile, cwd: spec.cwd, tmuxSession, createdAt: now(),
      pty, exited: false, exitCode: null,
      ring: [], ringSize: 0,
      clients: new Map(), // connId → { send, unacked, paused }
      lastActivity: now(),
      bytesOut: 0,
    };
    sessions.set(id, s);

    pty.onData((data) => {
      s.lastActivity = now();
      s.bytesOut += Buffer.byteLength(data);
      s.ring.push(data);
      s.ringSize += Buffer.byteLength(data);
      while (s.ringSize > ringBytes && s.ring.length > 1) s.ringSize -= Buffer.byteLength(s.ring.shift());
      for (const c of s.clients.values()) {
        c.unacked += Buffer.byteLength(data);
        try { c.send(data); } catch { /* transport died; detach() will clean up */ }
      }
      // flow control: any client too far behind pauses the PTY (xterm.js flow-control guidance)
      if (!s.paused && [...s.clients.values()].some((c) => c.unacked > highWater)) {
        s.paused = true;
        try { s.pty.pause?.(); } catch { /* backend without pause: metering degrades, never breaks */ }
      }
    });
    pty.onExit(({ exitCode } = {}) => {
      s.exited = true;
      s.exitCode = exitCode ?? null;
      emit('term.session.end', s, { exit_code: s.exitCode, bytes_out: s.bytesOut, duration_ms: now() - s.createdAt });
      for (const c of s.clients.values()) { try { c.close(); } catch { /* already gone */ } }
      s.clients.clear();
    });

    emit('term.session.start', s, { cwd: spec.cwd, cols, rows, tmux: tmuxSession || undefined });
    return { id, attachToken: mintToken(id) };
  }

  function mustOwn(sessionId, owner) {
    const s = sessions.get(sessionId);
    if (!s) throw Object.assign(new Error('no such session'), { code: 404 });
    if (s.owner !== owner) throw Object.assign(new Error('not your session (owner-only)'), { code: 403 });
    return s;
  }

  /** Attach a transport. sink = { send(string), close() }. Returns { connId, detach, ack, input, resize }. */
  function attach(sessionId, token, sink, owner) {
    const s = mustOwn(sessionId, owner);
    if (s.exited) throw Object.assign(new Error('session already ended'), { code: 410 });
    if (!redeemToken(token, sessionId)) throw Object.assign(new Error('invalid, used, or expired attach token'), { code: 401 });
    const connId = crypto.randomBytes(6).toString('hex');
    s.clients.set(connId, { send: sink.send, close: sink.close, unacked: 0 });
    s.lastActivity = now();
    if (s.ring.length) { try { sink.send(s.ring.join('')); } catch { /* dead on arrival */ } }
    emit('term.session.attach', s, { conn_id: connId });
    return {
      connId,
      input: (data) => { s.lastActivity = now(); try { s.pty.write(data); } catch { /* exited */ } },
      resize: (cols, rows) => { try { s.pty.resize(Math.max(2, cols | 0), Math.max(2, rows | 0)); } catch { /* backend without resize */ } },
      ack: (bytes) => {
        const c = s.clients.get(connId);
        if (!c) return;
        c.unacked = Math.max(0, c.unacked - (Number(bytes) || 0));
        if (s.paused && ![...s.clients.values()].some((x) => x.unacked > highWater)) {
          s.paused = false;
          try { s.pty.resume?.(); } catch { /* see pause */ }
        }
      },
      detach: () => {
        s.clients.delete(connId);
        emit('term.session.detach', s, { conn_id: connId });
        // a detached laggard must not keep the PTY paused forever
        if (s.paused && ![...s.clients.values()].some((x) => x.unacked > highWater)) {
          s.paused = false;
          try { s.pty.resume?.(); } catch { /* see pause */ }
        }
      },
    };
  }

  function kill(sessionId, owner) {
    const s = mustOwn(sessionId, owner);
    try { s.pty.kill('SIGHUP'); } catch { /* already gone */ }
    return { id: s.id };
  }

  function list(owner) {
    return [...sessions.values()].filter((s) => s.owner === owner).map((s) => ({
      id: s.id, profile: s.profile, cwd: s.cwd, tmuxSession: s.tmuxSession || null,
      createdAt: s.createdAt, exited: s.exited, exitCode: s.exitCode,
      attachedClients: s.clients.size, bytesOut: s.bytesOut,
    }));
  }

  /** New single-use token for re-attach (owner-only, live sessions only). */
  function reissueToken(sessionId, owner) {
    const s = mustOwn(sessionId, owner);
    if (s.exited) throw Object.assign(new Error('session already ended'), { code: 410 });
    return mintToken(sessionId);
  }

  /** Reap idle sessions (no clients + no output for idleMs). Returns reaped ids. */
  function reapIdle() {
    const reaped = [];
    for (const s of sessions.values()) {
      if (!s.exited && s.clients.size === 0 && now() - s.lastActivity > idleMs) {
        try { s.pty.kill('SIGHUP'); } catch { /* already gone */ }
        reaped.push(s.id);
      }
    }
    // token GC rides the reaper
    for (const [t, v] of tokens) if (v.used || now() > v.expires) tokens.delete(t);
    return reaped;
  }

  function startReaper(intervalMs = 60_000) {
    const timer = setInterval(reapIdle, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { create, attach, kill, list, reissueToken, reapIdle, startReaper, _sessions: sessions };
}
