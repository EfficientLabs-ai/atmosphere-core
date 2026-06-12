/**
 * terminal-sessions.js — REST + WebSocket transport over the session manager (slice 2 wiring).
 *
 *   POST   /term/sessions                       create → { sessionId, attachToken, wsPath }
 *   GET    /term/sessions                       list own sessions
 *   POST   /term/sessions/:id/attach-token      new single-use token (re-attach)
 *   POST   /term/sessions/:id/resize            { cols, rows }   (transportless resize)
 *   DELETE /term/sessions/:id                   kill (SIGHUP → end receipt)
 *   WS     /term/attach?session=ID&token=T      byte stream + JSON control frames
 *
 * Frames (ALL JSON — one socket multiplexes data + control, per the research doc):
 *   server → client   {t:'data', data}            PTY output (utf8)
 *                     {t:'exit', code}            session ended
 *   client → server   {t:'input', data}           keystrokes
 *                     {t:'resize', cols, rows}
 *                     {t:'ack', bytes}            flow-control credit (every ~256KB)
 *                     {t:'ping'} → {t:'pong'}
 *
 * AUTH: REST rides requireGatewaySecretStrict (mounted in server.js). The WS upgrade carries the
 * SINGLE-USE attach token in the query (never the long-lived secret — URLs land in logs) and
 * re-validates Origin against ATMOS_GATEWAY_ORIGINS (CSWSH defense, same policy as strict REST).
 * RECEIPTS: start/attach/detach/end sign onto the daemon receipt chain as action 'term-session'
 * via the same lazy keys+log pattern the operating tap uses; receipt failure is fail-visible,
 * never lifecycle-blocking.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createSessionManager, loadNodePty } from './session-manager.js';
import { recordDenial } from '../../../stratos-agent/src/security/denial-audit.js';

/** Lazy, fail-visible signed receipt recorder (the operating-tap defaultReceiptLog pattern). */
export function makeSessionReceiptRecorder({ profileDir } = {}) {
  let state = null; // { log, actor_id } | 'failed'
  let initPromise = null; // single-flight init (Codex finding: concurrent first events raced
  // two initializers → competing keypairs/ReceiptLog instances → broken prev_hash chain)
  let queue = Promise.resolve(); // appends are SERIALIZED so prev_hash ordering is deterministic
  async function init() {
        const [led, qc, seal] = await Promise.all([
          import('../../../stratos-agent/src/ledger/capability-receipt.js'),
          import('../../../stratos-agent/src/security/quantum-crypto.js'),
          import('../../../stratos-agent/src/memory/skill-seal.js'),
        ]);
        const profile = profileDir || process.env.STRATOS_PROFILE_DIR || '.stratos-profile';
        const keyFile = process.env.STRATOS_NODE_KEYS || path.join(profile, 'node-keys.json');
        const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
        const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
        let keys;
        try {
          const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
          keys = { publicKey: dec(raw.publicKey), privateKey: dec(raw.privateKey) };
        } catch {
          keys = qc.generateHybridKeyPair();
          fs.mkdirSync(path.dirname(keyFile), { recursive: true });
          fs.writeFileSync(keyFile, JSON.stringify({ publicKey: enc(keys.publicKey), privateKey: enc(keys.privateKey) }), { mode: 0o600 });
        }
        const actor_id = seal.originId(keys.publicKey);
        const logPath = process.env.STRATOS_RECEIPTS || path.join(profile, 'live-receipts.jsonl');
        const log = new led.ReceiptLog({ path: logPath, signer: led.makeReceiptSigner(keys.privateKey), nodeId: actor_id, rotateMaxBytes: 5 * 1024 * 1024 });
        state = { log, actor_id, createReceipt: led.createReceipt };
  }
  async function append(event) {
      if (state === 'failed') return;
      if (!state) { await (initPromise ||= init()); }
      const { event: ev, session_id, owner, profile: prof, ...meta } = event;
      state.log.append(state.createReceipt({
        actor_id: state.actor_id,
        action: 'term-session',
        ref: `${ev}:${session_id}`,
        cost_units: 0,
        node_id: state.actor_id,
        caller_id: owner,
        input_hash: null,
        output_hash: null,
        meta: { profile: prof, ...meta },
      }));
  }
  return function record(event) {
    queue = queue.then(() => append(event)).catch((e) => {
      try {
        if (state !== 'failed') console.warn('⚠️  [terminal] session receipt failed (fail-visible; lifecycle unaffected):', e.message);
      } catch { /* never block lifecycle */ }
      state = 'failed';
    });
    return queue;
  };
}

/** The single identity the strict gateway secret represents today; DIDs slot in with pairing. */
const OWNER = 'gateway';

export function createSessionRouter(manager, { ptyAvailable } = {}) {
  const router = express.Router();
  const err = (res, e) => res.status(e.code || 500).json({ error: { message: e.message, type: 'terminal_session' } });

  router.post('/sessions', express.json(), (req, res) => {
    if (!ptyAvailable()) return res.status(503).json({ error: { message: 'PTY backend not installed (node-pty is an optionalDependency — `npm i node-pty` on the daemon host)', type: 'terminal_session' } });
    try {
      const { profile, cwd, cols, rows, tmuxSession } = req.body || {};
      const { id, attachToken } = manager.create({ owner: OWNER, profile, cwd, cols, rows, tmuxSession });
      res.status(201).json({ sessionId: id, attachToken, wsPath: `/term/attach?session=${id}` });
    } catch (e) { err(res, e); }
  });

  router.get('/sessions', (req, res) => res.json({ sessions: manager.list(OWNER) }));

  router.post('/sessions/:id/attach-token', (req, res) => {
    try { res.json({ attachToken: manager.reissueToken(req.params.id, OWNER) }); } catch (e) { err(res, e); }
  });

  router.post('/sessions/:id/resize', express.json(), (req, res) => {
    try {
      const s = manager._sessions.get(req.params.id);
      if (!s || s.owner !== OWNER) return res.status(404).json({ error: { message: 'no such session', type: 'terminal_session' } });
      try { s.pty.resize(Math.max(2, req.body?.cols | 0), Math.max(2, req.body?.rows | 0)); } catch { /* backend without resize */ }
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  router.delete('/sessions/:id', (req, res) => {
    try { res.json(manager.kill(req.params.id, OWNER)); } catch (e) { err(res, e); }
  });

  return router;
}

/**
 * Wire the WS endpoint onto an http.Server. Token-authenticated (single-use, short-expiry),
 * origin-checked. Returns the WebSocketServer for tests/shutdown.
 */
export async function attachTerminalWs(httpServer, manager, { path: wsPath = '/term/attach' } = {}) {
  // version-agnostic: ws@8 exports WebSocketServer; ws@7 (hoisted today via chat connectors)
  // exposes it as default.Server. Either works — the noServer upgrade API is identical.
  const wsMod = await import('ws');
  const WSServer = wsMod.WebSocketServer || wsMod.default?.Server || wsMod.Server;
  const wss = new WSServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== wsPath) {
      // The bridge has NO other WS endpoints: an unmatched upgrade left dangling would let a
      // local process hold unauthenticated FDs open (Codex finding) — refuse and destroy.
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      const allowed = (process.env.ATMOS_GATEWAY_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!allowed.includes(origin)) {
        recordDenial({ gate: 'terminal-ws', reason: 'un-allowlisted browser origin on WS upgrade', route: wsPath, actor: origin });
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = url.searchParams.get('session') || '';
      const token = url.searchParams.get('token') || '';
      let conn;
      try {
        conn = manager.attach(sessionId, token, {
          send: (data) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'data', data })); },
          close: () => { try { ws.close(1000, 'session ended'); } catch { /* gone */ } },
        }, OWNER);
      } catch (e) {
        // sessionId here is the RAW query param — a swapped URL (session=<attachToken>) would log
        // the token verbatim (Codex finding). Only the minted 16-hex id shape is ever persisted.
        const safeTarget = /^[0-9a-f]{16}$/.test(sessionId) ? sessionId : undefined;
        recordDenial({ gate: 'terminal-ws', reason: e.message, route: wsPath, action: 'attach', target: safeTarget });
        ws.close(4000 + Math.min(999, e.code || 500), e.message.slice(0, 120));
        return;
      }
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString('utf8')); } catch { return; } // non-JSON frames are dropped
        if (m.t === 'input' && typeof m.data === 'string') conn.input(m.data);
        else if (m.t === 'resize') conn.resize(m.cols, m.rows);
        else if (m.t === 'ack') conn.ack(m.bytes);
        else if (m.t === 'ping') { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'pong' })); }
      });
      ws.on('close', () => conn.detach());
      ws.on('error', () => conn.detach());
    });
  });
  return wss;
}

/** Production assembly: real node-pty (optional), signed receipts, idle reaper. */
export async function buildTerminalSessions({ workspaceRoot } = {}) {
  const ptyMod = await loadNodePty();
  const record = makeSessionReceiptRecorder({});
  const manager = createSessionManager({
    spawnPty: ({ file, args, cwd, env, cols, rows }) => {
      if (!ptyMod) throw Object.assign(new Error('PTY backend not installed'), { code: 503 });
      return ptyMod.spawn(file, args, { name: 'xterm-256color', cwd, env, cols, rows });
    },
    recordEvent: (ev) => { record(ev); }, // async, fail-visible, non-blocking
    workspaceRoot: workspaceRoot || process.cwd(),
  });
  manager.startReaper();
  return { manager, router: createSessionRouter(manager, { ptyAvailable: () => !!ptyMod }), attachWs: (srv) => attachTerminalWs(srv, manager) };
}
