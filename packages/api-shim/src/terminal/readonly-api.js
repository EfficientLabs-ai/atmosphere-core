/**
 * readonly-api.js — Atmos Terminal MVP slice 1: READ-ONLY file/log/metrics/receipt APIs.
 * (03_reviews/ATMOS_TERMINAL_BACKEND.md §6 item 5 — ships before any PTY; unblocks the
 * dashboard's Terminal/File Viewer surface.)
 *
 * Mounted under /term behind requireGatewaySecret. Five endpoints, all read-only:
 *   GET /term/fs/roots                          named root allowlist (ids only)
 *   GET /term/fs/tree?root=&path=               one directory level (name/type/size/mtime)
 *   GET /term/fs/read?root=&path=&maxBytes=     bounded text read, redactSecrets()-filtered
 *   GET /term/logs/stream?app=&kind=            SSE tail of a PM2 log (redacted chunks)
 *   GET /term/metrics/stream?intervalMs=        SSE of MEASURED host/process facts
 *   GET /term/receipts/export?since=            signed receipt bundle (public key only)
 *
 * Security posture (deny-by-default, the exec/job-policy idioms):
 *   - FS access is jailed to a NAMED ROOT ALLOWLIST; every resolved path must realpath back
 *     under its root (symlink escape = deny, not follow).
 *   - A DENY pattern refuses secret-bearing names ANYWHERE in the path (.env*, vault, secrets,
 *     *-keys.json, *.pem/*.key, .git, .npmrc) — listing and reading both.
 *   - File content and log chunks pass through redactSecrets() before leaving the process.
 *     (Redact persistence/egress, never an owner's live PTY — but this slice HAS no PTY.)
 *   - SSE is bounded: per-route client cap + bounded tail windows, so the streaming surface
 *     cannot balloon the daemon's 256MB heap.
 *   - Metrics are MEASURED facts only (os.*, process.*). maximus-telemetry's captureMetrics()
 *     was deliberately NOT reused: it emits an EMULATED "(Virtual)" GPU block with random
 *     utilization — streaming that as telemetry would violate the truth gate.
 *   - /receipts/export embeds ONLY the public key half; absent node keys → 404 (an export
 *     endpoint must never mint identity).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { redactSecrets } from '../secret-guard.js';

const MODULE_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..', '..');

/** Secret-bearing names refused ANYWHERE in a relative path — list and read alike. */
export const DENY_SEGMENT = /(^|\/)(\.env[^/]*|[^/]*vault[^/]*|secrets?|\.secrets[^/]*|[^/]*-keys\.json|owner-keys\.json|[^/]+\.(pem|key)|id_rsa[^/]*|\.npmrc|\.git|node_modules|\.stratos-profile|chat-memory|composio-credentials\.json|connectors\.json|runtime-state\.json)(\/|$)/i;

const MAX_READ_DEFAULT = 256 * 1024;       // per-read soft cap
const MAX_READ_HARD = 1024 * 1024;         // absolute ceiling
const TAIL_WINDOW = 16 * 1024;             // initial SSE log tail
const MIN_INTERVAL_MS = 1000;              // metrics sampling floor
const SSE_HEARTBEAT_MS = 15_000;

/** Parse ATMOS_FS_ROOTS ("name:/abs/path,name2:/abs/path2") into extra named roots. */
function envRoots(spec) {
  const out = {};
  for (const pair of String(spec || '').split(',')) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    const p = pair.slice(i + 1).trim();
    if (/^[a-z0-9_-]{1,32}$/i.test(name) && path.isAbsolute(p)) out[name] = p;
  }
  return out;
}

/**
 * Resolve root+relative into an absolute path PROVEN to live under the root, or null.
 * realpath on the nearest existing ancestor defeats symlink escapes; '..' never survives.
 */
function jail(roots, rootId, rel) {
  const base = roots[rootId];
  if (!base) return null;
  const cleaned = path.normalize(String(rel || '.')).replace(/^([/\\])+/, '');
  if (cleaned.split(path.sep).includes('..')) return null;
  if (DENY_SEGMENT.test(cleaned.split(path.sep).join('/'))) return null;
  const abs = path.resolve(base, cleaned);
  // an in-root symlink ALIAS to a denied name (safe.txt -> .env) must not bypass the deny list:
  // refuse symlink leaves outright, and re-apply the deny pattern to the RESOLVED path below.
  try { if (fs.lstatSync(abs).isSymbolicLink()) return null; } catch { return null; }
  let real;
  try { real = fs.realpathSync(abs); } catch { return null; } // must exist (read-only API)
  let realBase;
  try { realBase = fs.realpathSync(base); } catch { return null; }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) return null; // symlink escape
  const resolvedRel = path.relative(realBase, real).split(path.sep).join('/');
  if (resolvedRel && DENY_SEGMENT.test(resolvedRel)) return null; // intermediate symlink → denied target
  return real;
}

/** Open an SSE response (and a heartbeat so proxies don't reap idle streams). */
function sseOpen(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': stream open\n\n');
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, SSE_HEARTBEAT_MS);
  return () => clearInterval(hb);
}
const sseSend = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * Build the read-only terminal router. Everything injectable for hermetic tests.
 * @param {object} [opts] { roots?, pm2LogsDir?, profileDir?, maxSseClients?, now? }
 */
export function createReadonlyRouter(opts = {}) {
  const roots = opts.roots || { repo: REPO_ROOT, 'pm2-logs': path.join(os.homedir(), '.pm2', 'logs'), ...envRoots(process.env.ATMOS_FS_ROOTS) };
  const pm2LogsDir = opts.pm2LogsDir || path.join(os.homedir(), '.pm2', 'logs');
  const profileDir = opts.profileDir || process.env.STRATOS_PROFILE_DIR || '.stratos-profile';
  const maxSseClients = opts.maxSseClients ?? 8;
  let sseClients = 0;
  const router = express.Router();

  const sseGuard = (res) => {
    if (sseClients >= maxSseClients) { res.status(429).json({ error: { message: `SSE client cap (${maxSseClients}) reached`, type: 'terminal_readonly' } }); return false; }
    return true;
  };
  const deny = (res, code, message) => res.status(code).json({ error: { message, type: 'terminal_readonly' } });

  router.get('/fs/roots', (req, res) => {
    res.json({ roots: Object.keys(roots).filter((id) => { try { return fs.statSync(roots[id]).isDirectory(); } catch { return false; } }) });
  });

  router.get('/fs/tree', (req, res) => {
    const real = jail(roots, String(req.query.root || ''), String(req.query.path || '.'));
    if (!real) return deny(res, 403, 'path denied: unknown root, traversal, secret-bearing name, or symlink escape (deny-by-default)');
    let st;
    try { st = fs.statSync(real); } catch { return deny(res, 404, 'not found'); }
    if (!st.isDirectory()) return deny(res, 400, 'not a directory — use /fs/read for files');
    const entries = [];
    for (const name of fs.readdirSync(real).sort()) {
      const relChild = path.relative(roots[String(req.query.root)], path.join(real, name)).split(path.sep).join('/');
      if (DENY_SEGMENT.test(relChild)) continue; // denied names are invisible, not greyed out
      try {
        const s = fs.lstatSync(path.join(real, name)); // lstat: symlinks are OMITTED, never followed
        if (s.isSymbolicLink()) continue;
        entries.push({ name, type: s.isDirectory() ? 'dir' : 'file', size: s.isDirectory() ? null : s.size, mtime: s.mtimeMs });
      } catch { /* raced away or unreadable — omit */ }
    }
    res.json({ root: req.query.root, path: String(req.query.path || '.'), entries });
  });

  router.get('/fs/read', (req, res) => {
    const real = jail(roots, String(req.query.root || ''), String(req.query.path || ''));
    if (!real) return deny(res, 403, 'path denied: unknown root, traversal, secret-bearing name, or symlink escape (deny-by-default)');
    let st;
    try { st = fs.statSync(real); } catch { return deny(res, 404, 'not found'); }
    if (!st.isFile()) return deny(res, 400, 'not a regular file');
    const cap = Math.min(Math.max(1, Number(req.query.maxBytes) || MAX_READ_DEFAULT), MAX_READ_HARD);
    const fd = fs.openSync(real, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.min(st.size, cap));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally { fs.closeSync(fd); }
    if (buf.includes(0)) return deny(res, 415, 'binary file — this endpoint serves text only');
    res.json({ path: String(req.query.path), size: st.size, truncated: st.size > cap, content: redactSecrets(buf.toString('utf8')) });
  });

  router.get('/logs/stream', (req, res) => {
    const app = String(req.query.app || '');
    const kind = String(req.query.kind || 'out');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(app)) return deny(res, 400, 'invalid app name');
    if (!['out', 'error'].includes(kind)) return deny(res, 400, 'kind must be out|error');
    const file = path.join(pm2LogsDir, `${app}-${kind}.log`);
    if (!fs.existsSync(file)) return deny(res, 404, `no such log: ${app}-${kind}.log`);
    if (!sseGuard(res)) return;
    sseClients++;
    const stopHb = sseOpen(res);
    let pos;
    try {
      const size = fs.statSync(file).size;
      pos = Math.max(0, size - TAIL_WINDOW);
      if (size > pos) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - pos);
        try { fs.readSync(fd, buf, 0, buf.length, pos); } finally { fs.closeSync(fd); }
        sseSend(res, 'log', { chunk: redactSecrets(buf.toString('utf8')), tail: true });
        pos = size;
      }
    } catch { pos = 0; }
    const poll = setInterval(() => {
      try {
        const size = fs.statSync(file).size;
        if (size < pos) pos = 0; // size-shrink-aware only (copytruncate-style); a rename rotation needs a reconnect
        if (size > pos) {
          const fd = fs.openSync(file, 'r');
          const buf = Buffer.alloc(Math.min(size - pos, TAIL_WINDOW));
          try { fs.readSync(fd, buf, 0, buf.length, pos); } finally { fs.closeSync(fd); }
          pos += buf.length;
          sseSend(res, 'log', { chunk: redactSecrets(buf.toString('utf8')) });
        }
      } catch { /* transient stat/read failure — next tick retries; stream stays up */ }
    }, opts.pollMs ?? 500);
    req.on('close', () => { clearInterval(poll); stopHb(); sseClients--; });
  });

  router.get('/metrics/stream', (req, res) => {
    if (!sseGuard(res)) return;
    sseClients++;
    const stopHb = sseOpen(res);
    const interval = Math.max(MIN_INTERVAL_MS, Number(req.query.intervalMs) || 3000);
    const sample = () => {
      const mem = process.memoryUsage();
      return {
        ts: Date.now(),
        host: { loadavg: os.loadavg(), cpus: os.cpus().length, mem_total: os.totalmem(), mem_free: os.freemem(), uptime_s: os.uptime() },
        process: { pid: process.pid, rss: mem.rss, heap_used: mem.heapUsed, uptime_s: process.uptime() },
        // MEASURED facts only — no emulated/virtual hardware blocks (truth gate).
      };
    };
    sseSend(res, 'metrics', sample());
    const timer = setInterval(() => { try { sseSend(res, 'metrics', sample()); } catch { /* closed */ } }, interval);
    req.on('close', () => { clearInterval(timer); stopHb(); sseClients--; });
  });

  router.get('/receipts/export', async (req, res) => {
    try {
      const keyFile = process.env.STRATOS_NODE_KEYS || path.join(profileDir, 'node-keys.json');
      if (!fs.existsSync(keyFile)) return deny(res, 404, 'no node identity on this device — an export endpoint never mints keys');
      const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      // decode the persisted base64 bundle to Buffers — exportBundle re-encodes; passing the
      // strings through would double-encode and break third-party verifyBundle(). PUBLIC half only.
      const publicKeyBundle = Object.fromEntries(Object.entries(raw.publicKey).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
      const logPath = process.env.STRATOS_RECEIPTS || path.join(profileDir, 'live-receipts.jsonl');
      if (!fs.existsSync(logPath)) return deny(res, 404, 'no receipt log on this device yet');
      const { ReceiptLog } = await import('../../../stratos-agent/src/ledger/capability-receipt.js');
      // segment-aware (Codex finding): the live log rotates at 5MB; loading only the active file
      // would silently drop archived history and skew `since`. Same path the CLI export uses.
      const log = new ReceiptLog({});
      log.chain = ReceiptLog.loadChainEntries(logPath);
      const since = req.query.since ? String(req.query.since) : null;
      res.json(log.exportBundle({ since, publicKeyBundle }));
    } catch (e) {
      deny(res, 500, 'export failed: ' + e.message);
    }
  });

  return router;
}
