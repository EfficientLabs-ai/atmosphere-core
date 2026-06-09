/**
 * upstream-breaker.js — EFL-014: a consecutive-failure circuit breaker for the
 * upstream StratosAgent proxy used by server.js (`/v1/chat/completions` and
 * `/v1/messages`).
 *
 * Why: an 8s per-request timeout (STRATOS_TIMEOUT) already guards each proxy call,
 * but when the upstream (default 127.0.0.1:5001) is *persistently* unreachable EVERY
 * request still burns the full timeout before falling back. Under sustained channel
 * traffic those slow requests stack up — which is what pushed the bridge heap toward
 * its ~80 MiB ceiling and the HTTP p95 to ~71s in the audit. This breaker short-circuits
 * to the SAME local-fallback path once the upstream has failed THRESHOLD times in a row,
 * then probes again after a cooldown.
 *
 * Crucially, the open-state behaviour is identical to a timeout — the caller routes to
 * local fallback (or returns 502 when fallback is disabled), just without the wait — so
 * the breaker is transparent to callers and to the existing gateway route tests.
 *
 * States (pure functions of failure count + clock, no timers held):
 *   closed     failures < THRESHOLD                      → call upstream normally
 *   open       failures >= THRESHOLD, within COOLDOWN_MS  → skip upstream, fail fast
 *   half-open  failures >= THRESHOLD, cooldown elapsed     → allow one probe
 *
 * Tunable via env (defaults are conservative so a single failing request never trips it):
 *   ATMOS_UPSTREAM_BREAKER=off            disable entirely (always "closed")
 *   ATMOS_UPSTREAM_BREAKER_THRESHOLD=5    consecutive failures before opening
 *   ATMOS_UPSTREAM_BREAKER_COOLDOWN_MS=15000
 */

const THRESHOLD = Math.max(1, parseInt(process.env.ATMOS_UPSTREAM_BREAKER_THRESHOLD || '5', 10));
const COOLDOWN_MS = Math.max(0, parseInt(process.env.ATMOS_UPSTREAM_BREAKER_COOLDOWN_MS || '15000', 10));
const ENABLED = process.env.ATMOS_UPSTREAM_BREAKER !== 'off';

let failures = 0;
let openedAt = 0;

/** Whether the breaker is currently active (false when disabled via env). */
export function breakerEnabled() {
  return ENABLED;
}

/**
 * True when the upstream call should be SKIPPED right now (breaker open, still cooling
 * down). Pure read — does not mutate state. Once the cooldown elapses this returns false
 * again to allow a single probe; if that probe fails, recordFailure() re-arms the cooldown.
 */
export function upstreamUnavailable(now = Date.now()) {
  if (!ENABLED || failures < THRESHOLD) return false;
  return now - openedAt < COOLDOWN_MS;
}

/** A successful upstream response closes the breaker and clears the failure streak. */
export function recordSuccess() {
  failures = 0;
  openedAt = 0;
}

/**
 * A failed/timed-out/non-OK upstream response. At or past the threshold each failure
 * (re)stamps the cooldown window, so a failed half-open probe re-opens the breaker.
 */
export function recordFailure(now = Date.now()) {
  failures += 1;
  if (failures >= THRESHOLD) openedAt = now;
}

/** Human-readable state for logging/health, without mutating anything. */
export function breakerState(now = Date.now()) {
  if (!ENABLED || failures < THRESHOLD) return 'closed';
  return now - openedAt < COOLDOWN_MS ? 'open' : 'half-open';
}

/** Snapshot for /health diagnostics. */
export function breakerSnapshot(now = Date.now()) {
  return { enabled: ENABLED, state: breakerState(now), failures, threshold: THRESHOLD, cooldownMs: COOLDOWN_MS };
}

/** Test-only: reset to the pristine closed state. */
export function _resetBreaker() {
  failures = 0;
  openedAt = 0;
}
