/**
 * node-heartbeat.mjs — periodic liveness telemetry for a mesh node (B5: node health WIRED→MEASURED).
 *
 * The mesh node deliberately exposes NO inbound surface (DHT hole-punch only), so its heartbeat is
 * a LOCAL append-only jsonl the operator/heartbeat-monitor reads — never an endpoint. Before this,
 * liveness was only observable on-demand (proof-of-capacity on request): a crashed or wedged node
 * left no trace. Now a missing/stale beat IS the signal.
 *
 * One line per beat: { ts, node, topic, version, uptime_s, loadavg1, mem_free, mem_total,
 * skills_run, peers } — MEASURED os/process facts only. Disk-bounded by single-file rotation
 * (the denial-audit/receipt-log precedent). Fully injectable for hermetic tests.
 */
import fs from 'node:fs';
import os from 'node:os';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export function makeNodeHeartbeat({
  file,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  now = Date.now,
  meta = {},            // static fields: node label, topic, version
  counters = {},        // live getters: { skillsRun: () => n, peers: () => n }
} = {}) {
  if (!file) throw new Error('makeNodeHeartbeat requires a file path');
  let timer = null;
  let warned = false;

  function beat() {
    try {
      const line = {
        ts: new Date(now()).toISOString(),
        ...meta,
        uptime_s: Math.round(process.uptime()),
        loadavg1: os.loadavg()[0],
        mem_free: os.freemem(),
        mem_total: os.totalmem(),
        skills_run: counters.skillsRun ? counters.skillsRun() : 0,
        peers: counters.peers ? counters.peers() : 0,
      };
      try {
        const st = fs.statSync(file);
        if (st.size > maxBytes) fs.renameSync(file, file + '.1');
      } catch { /* first beat */ }
      fs.appendFileSync(file, JSON.stringify(line) + '\n');
      return true;
    } catch (e) {
      // fail-open, fail-visible: a broken beat never affects the node, but never dies silently
      if (!warned) { try { console.warn('⚠️  [node-heartbeat] write failed (node unaffected):', e.message); } catch { /* never throw */ } warned = true; }
      return false;
    }
  }

  function start() {
    // setInterval clamps invalid delays to 1ms (Codex finding): a malformed interval must mean
    // DISABLED, never a hot append loop. Finite and positive, or no timer at all.
    if (timer || !Number.isFinite(intervalMs) || intervalMs <= 0) return;
    beat(); // first beat immediately — "started" is itself a liveness fact
    timer = setInterval(beat, intervalMs);
    timer.unref?.(); // a heartbeat must never keep a stopping node alive
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, beat };
}

/**
 * Parse a --heartbeat seconds value from CLI/config. Accepts a finite number ≥ 0 (0 = disabled).
 * Everything else — bare flag (true), '', strings, NaN, Infinity, negatives — falls back LOUDLY.
 * (Codex round-2: Number(true) === 1, so a bare --heartbeat silently meant a 1s beat.)
 */
export function parseHeartbeatSeconds(raw, fallback = 300, warn = (m) => console.warn(m)) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  try { warn(`⚠️  invalid --heartbeat value (${String(raw)}) — using default ${fallback}s`); } catch { /* warner never throws */ }
  return fallback;
}

/** Freshness check for monitors: true when the last beat is younger than staleMs. */
export function lastBeat(file, { staleMs = 2 * DEFAULT_INTERVAL_MS, now = Date.now } = {}) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    const age = now() - Date.parse(last.ts);
    return { ok: age >= 0 && age < staleMs, age_ms: age, last };
  } catch {
    return { ok: false, age_ms: null, last: null };
  }
}
