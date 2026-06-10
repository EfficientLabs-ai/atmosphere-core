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
 * Concurrency-safe semantics (Codex review findings on PR #74, addressed here):
 *   - Every attempt is GENERATION-STAMPED via beginUpstreamAttempt(). A completion
 *     (success or failure) only counts if its generation is still current — so a stale
 *     in-flight failure can never re-open the breaker after a newer success, and a
 *     stale success can never close it after a newer open.
 *   - Half-open admits EXACTLY ONE probe: while that probe is in flight, all other
 *     requests keep fast-failing to fallback. No thundering herd at the cooldown edge.
 *   - Only transport errors/timeouts and upstream-side statuses (5xx, 429) count as
 *     availability failures — a 4xx means the upstream is alive (callers still get the
 *     existing fallback behaviour for non-OK; that is response handling, not health).
 *   - Env knobs are validated finite (a bad value falls back to the default instead of
 *     NaN-poisoning the state machine).
 *
 * States (pure functions of failure count + clock + probe flag, no timers held):
 *   closed     failures < THRESHOLD                       → call upstream normally
 *   open       failures >= THRESHOLD, within COOLDOWN_MS   → skip upstream, fail fast
 *   half-open  cooldown elapsed                            → ONE probe allowed; others skip
 *
 * Tunable via env (defaults conservative so a single failing request never trips it):
 *   ATMOS_UPSTREAM_BREAKER=off            disable entirely (always "closed")
 *   ATMOS_UPSTREAM_BREAKER_THRESHOLD=5    consecutive failures before opening
 *   ATMOS_UPSTREAM_BREAKER_COOLDOWN_MS=15000
 */

function envInt(name, def, min) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? Math.max(min, v) : def;
}

const THRESHOLD = envInt('ATMOS_UPSTREAM_BREAKER_THRESHOLD', 5, 1);
const COOLDOWN_MS = envInt('ATMOS_UPSTREAM_BREAKER_COOLDOWN_MS', 15000, 0);
const ENABLED = process.env.ATMOS_UPSTREAM_BREAKER !== 'off';

let failures = 0;
let openedAt = 0;
let generation = 0;   // bumped on every success and every open — stale completions are ignored
let probing = false;  // a half-open probe is currently in flight

/** Whether the breaker is currently active (false when disabled via env). */
export function breakerEnabled() {
  return ENABLED;
}

/**
 * Gate + stamp for ONE upstream attempt. Call before the proxy fetch.
 * Returns { allowed, gen, probe }:
 *   allowed=false → skip the upstream and fail fast to fallback (breaker open, or a
 *                   half-open probe is already in flight).
 *   allowed=true  → proceed; report the outcome with recordSuccess(gen)/recordFailure(gen).
 *                   probe=true marks the single half-open probe.
 */
export function beginUpstreamAttempt(now = Date.now()) {
  if (!ENABLED || failures < THRESHOLD) return { allowed: true, gen: generation, probe: false };
  if (now - openedAt < COOLDOWN_MS) return { allowed: false, gen: generation, probe: false }; // open
  // half-open: admit exactly one probe; everyone else keeps fast-failing
  if (probing) return { allowed: false, gen: generation, probe: false };
  probing = true;
  return { allowed: true, gen: generation, probe: true };
}

/**
 * A genuine upstream availability success (2xx/3xx — or any response proving the
 * upstream is alive, see classifyUpstreamStatus). Stale generations are ignored.
 */
export function recordSuccess(gen = generation) {
  if (!ENABLED || gen !== generation) return;
  generation += 1; // invalidate older in-flight completions
  failures = 0;
  openedAt = 0;
  probing = false;
}

/**
 * A transport error, timeout, or upstream-side failure status. Stale generations are
 * ignored, so an old failure completing after a newer success cannot re-open the breaker.
 */
export function recordFailure(gen = generation, now = Date.now()) {
  if (!ENABLED || gen !== generation) return;
  failures += 1;
  probing = false; // a failed probe ends the probe slot (and re-arms below)
  if (failures >= THRESHOLD) {
    generation += 1; // (re)open — invalidate older in-flight completions
    openedAt = now;
  }
}

/**
 * Availability classification for an upstream HTTP status: 5xx and 429 indicate the
 * upstream is unhealthy/overloaded; any other response (incl. 4xx) proves it is ALIVE —
 * callers still apply their own non-OK fallback handling, but the breaker counts it
 * as availability success.
 */
export function isAvailabilityFailureStatus(status) {
  return status >= 500 || status === 429;
}

/** Human-readable state for logging/health, without mutating anything. */
export function breakerState(now = Date.now()) {
  if (!ENABLED || failures < THRESHOLD) return 'closed';
  return now - openedAt < COOLDOWN_MS ? 'open' : 'half-open';
}

/** Minimal snapshot for /health diagnostics (no internals beyond state). */
export function breakerSnapshot(now = Date.now()) {
  return { enabled: ENABLED, state: breakerState(now) };
}

/** Test-only: reset to the pristine closed state. */
export function _resetBreaker() {
  failures = 0;
  openedAt = 0;
  generation = 0;
  probing = false;
}
