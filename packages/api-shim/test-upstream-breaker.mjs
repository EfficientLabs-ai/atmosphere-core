/**
 * test-upstream-breaker.mjs — EFL-014: the upstream circuit breaker must open after a
 * streak of failures, fast-fail during the cooldown, admit EXACTLY ONE half-open probe,
 * ignore stale in-flight completions (generation stamping), classify upstream statuses
 * correctly, and survive bad env values. Hermetic: pure state machine, deterministic
 * clock passed in as `now`, no network / Ollama / live services.
 *
 * Covers the Codex REQUEST_CHANGES findings on PR #74:
 *   #1 (high)   concurrent half-open probes + stale completions flipping state
 *   #2 (medium) 4xx counted as availability failure
 *   #3 (medium) NaN env poisoning
 *
 * Defaults under test (env unset): THRESHOLD=5, COOLDOWN_MS=15000.
 */
import assert from 'node:assert';
import {
  beginUpstreamAttempt, recordSuccess, recordFailure, breakerState, breakerEnabled,
  breakerSnapshot, isAvailabilityFailureStatus, _resetBreaker,
} from './src/upstream-breaker.js';

assert.equal(breakerEnabled(), true, 'breaker enabled by default (env not set to off)');
_resetBreaker();

// ── 1. Serial state machine ────────────────────────────────────────────────────────
// Pristine → closed, attempts allowed.
assert.equal(breakerState(0), 'closed');
let a = beginUpstreamAttempt(0);
assert.equal(a.allowed, true, 'closed breaker admits attempts');

// 4 consecutive failures → still closed.
for (let i = 0; i < 4; i++) { const t = beginUpstreamAttempt(0); recordFailure(t.gen, 0); }
assert.equal(breakerState(0), 'closed', '4 < 5 failures stays closed');

// 5th failure → OPEN; attempts skipped during cooldown.
{ const t = beginUpstreamAttempt(0); recordFailure(t.gen, 0); }
assert.equal(breakerState(0), 'open', '5th consecutive failure opens the breaker');
assert.equal(beginUpstreamAttempt(0).allowed, false, 'open breaker fast-fails');
assert.equal(beginUpstreamAttempt(14999).allowed, false, 'still open just before cooldown elapses');

// ── 2. Half-open admits EXACTLY ONE probe (Codex #1) ──────────────────────────────
assert.equal(breakerState(15001), 'half-open');
const probe = beginUpstreamAttempt(15001);
assert.equal(probe.allowed, true, 'first attempt after cooldown is the probe');
assert.equal(probe.probe, true, 'marked as the probe');
const second = beginUpstreamAttempt(15001);
assert.equal(second.allowed, false, 'CONCURRENT second attempt during the probe is refused — no thundering herd');
const third = beginUpstreamAttempt(15002);
assert.equal(third.allowed, false, 'and the third — only one probe slot');

// Failed probe re-arms the cooldown; probe slot frees for the NEXT cooldown edge.
recordFailure(probe.gen, 15001);
assert.equal(beginUpstreamAttempt(15002).allowed, false, 'failed probe re-opens the breaker');
assert.equal(beginUpstreamAttempt(30000).allowed, false, 'still cooling down from the re-open');
const probe2 = beginUpstreamAttempt(30002);
assert.equal(probe2.allowed && probe2.probe, true, 'next cooldown edge admits exactly one new probe');

// Successful probe fully closes the breaker.
recordSuccess(probe2.gen);
assert.equal(breakerState(30002), 'closed', 'probe success closes the breaker');
assert.equal(beginUpstreamAttempt(30002).allowed, true);

// ── 3. Stale-generation completions are ignored (Codex #1) ────────────────────────
_resetBreaker();
// Outage burst: 5 in-flight attempts stamped in the same generation…
const burst = Array.from({ length: 5 }, () => beginUpstreamAttempt(0));
// …4 fail (one short of threshold), then a NEWER attempt succeeds (gen bumps):
for (let i = 0; i < 4; i++) recordFailure(burst[i].gen, 0);
const fresh = beginUpstreamAttempt(0);
recordSuccess(fresh.gen);
assert.equal(breakerState(0), 'closed', 'success resets the streak');
// The 5th STALE failure now completes — it must NOT count, let alone open the breaker:
recordFailure(burst[4].gen, 0);
assert.equal(breakerState(0), 'closed', 'stale in-flight failure after a newer success is ignored');
// And a STALE success can't close a newer open:
_resetBreaker();
const old = beginUpstreamAttempt(0);
for (let i = 0; i < 5; i++) { const t = beginUpstreamAttempt(0); recordFailure(t.gen, 0); }
assert.equal(breakerState(0), 'open');
recordSuccess(old.gen); // stale — started before the open
assert.equal(breakerState(0), 'open', 'stale success cannot close a newer open breaker');

// ── 4. Consecutive requirement (success mid-streak resets) ────────────────────────
_resetBreaker();
for (let i = 0; i < 4; i++) { const t = beginUpstreamAttempt(0); recordFailure(t.gen, 0); }
{ const t = beginUpstreamAttempt(0); recordSuccess(t.gen); }
for (let i = 0; i < 4; i++) { const t = beginUpstreamAttempt(0); recordFailure(t.gen, 0); }
assert.equal(breakerState(0), 'closed', 'a success in the middle prevents 4+4 from tripping');

// ── 5. Availability classification (Codex #2) ─────────────────────────────────────
assert.equal(isAvailabilityFailureStatus(500), true, '500 = failure');
assert.equal(isAvailabilityFailureStatus(503), true, '503 = failure');
assert.equal(isAvailabilityFailureStatus(429), true, '429 = failure (overload)');
assert.equal(isAvailabilityFailureStatus(400), false, '400 = upstream ALIVE, not an availability failure');
assert.equal(isAvailabilityFailureStatus(404), false, '404 = alive');
assert.equal(isAvailabilityFailureStatus(200), false, '200 = alive');

// ── 6. /health snapshot is minimal (no internals) ────────────────────────────────
_resetBreaker();
assert.deepEqual(Object.keys(breakerSnapshot(0)).sort(), ['enabled', 'state'], 'snapshot exposes only enabled+state');

// ── 7. Env robustness via child processes ─────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const runChild = (env, probeSrc) => execFileSync(
  process.execPath, ['--input-type=module', '-e', probeSrc],
  { cwd: here, env: { ...process.env, ...env }, encoding: 'utf8' },
);

// 7a. Kill-switch: ATMOS_UPSTREAM_BREAKER=off → never opens.
let out = runChild({ ATMOS_UPSTREAM_BREAKER: 'off' }, [
  "import('./src/upstream-breaker.js').then(b=>{",
  "  for(let i=0;i<10;i++){const t=b.beginUpstreamAttempt(0); b.recordFailure(t.gen,0);}",
  "  if(b.beginUpstreamAttempt(0).allowed!==true||b.breakerState(0)!=='closed'){console.error('should be disabled');process.exit(1)}",
  "  console.log('disabled-ok');",
  "})",
].join(''));
assert.ok(/disabled-ok/.test(out), 'ATMOS_UPSTREAM_BREAKER=off disables the breaker entirely');

// 7b. NaN env poisoning (Codex #3): garbage values fall back to sane defaults.
out = runChild({ ATMOS_UPSTREAM_BREAKER_THRESHOLD: 'banana', ATMOS_UPSTREAM_BREAKER_COOLDOWN_MS: '' }, [
  "import('./src/upstream-breaker.js').then(b=>{",
  "  if(b.breakerState(0)!=='closed'){console.error('boot state wrong');process.exit(1)}",
  "  for(let i=0;i<5;i++){const t=b.beginUpstreamAttempt(0); b.recordFailure(t.gen,0);}",
  "  if(b.breakerState(0)!=='open'){console.error('default threshold(5) not applied');process.exit(1)}",
  "  if(b.beginUpstreamAttempt(14999).allowed!==false){console.error('default cooldown not applied');process.exit(1)}",
  "  console.log('env-ok');",
  "})",
].join(''));
assert.ok(/env-ok/.test(out), 'garbage env values fall back to defaults (no NaN poisoning)');

console.log('  ✓ EFL-014: upstream circuit breaker — opens/probes/recovers; SINGLE half-open probe; stale completions ignored; 4xx≠failure; env-robust');
