/**
 * test-upstream-breaker.mjs — EFL-014: the upstream circuit breaker must open after a
 * streak of failures, fast-fail during the cooldown, allow a single probe afterwards,
 * and fully recover on success. Hermetic: pure state machine, deterministic clock passed
 * in as `now`, no network / Ollama / live services.
 *
 * Defaults under test (env unset): THRESHOLD=5, COOLDOWN_MS=15000.
 */
import assert from 'node:assert';
import {
  upstreamUnavailable, recordSuccess, recordFailure, breakerState, breakerEnabled, _resetBreaker,
} from './src/upstream-breaker.js';

assert.equal(breakerEnabled(), true, 'breaker enabled by default (env not set to off)');
_resetBreaker();

// 1. Pristine → closed, upstream allowed.
assert.equal(breakerState(0), 'closed');
assert.equal(upstreamUnavailable(0), false, 'closed breaker never skips the upstream');

// 2. Below threshold (4 failures) → still closed.
for (let i = 0; i < 4; i++) recordFailure(0);
assert.equal(breakerState(0), 'closed', '4 < 5 failures stays closed');
assert.equal(upstreamUnavailable(0), false);

// 3. Threshold failure (5th) → OPEN; upstream skipped during cooldown.
recordFailure(0);
assert.equal(breakerState(0), 'open', '5th consecutive failure opens the breaker');
assert.equal(upstreamUnavailable(0), true, 'open breaker skips the upstream (fast-fail)');
assert.equal(upstreamUnavailable(14999), true, 'still open just before cooldown elapses');

// 4. Cooldown elapsed → half-open; exactly one probe allowed (upstream not skipped).
assert.equal(breakerState(15001), 'half-open');
assert.equal(upstreamUnavailable(15001), false, 'after cooldown a probe is allowed through');

// 5. Failed probe re-arms the cooldown from the new failure time.
recordFailure(15001);
assert.equal(upstreamUnavailable(15002), true, 'failed probe re-opens the breaker');
assert.equal(upstreamUnavailable(30000), true, 'still cooling down from the re-open');
assert.equal(upstreamUnavailable(30002), false, 'cooldown from the re-open has elapsed → probe again');

// 6. Successful probe fully closes the breaker and clears the streak.
recordSuccess();
assert.equal(breakerState(30002), 'closed', 'success closes the breaker');
assert.equal(upstreamUnavailable(30002), false);

// 7. A single success mid-streak resets the counter (failures must be CONSECUTIVE).
_resetBreaker();
for (let i = 0; i < 4; i++) recordFailure(0);
recordSuccess();                       // streak broken
for (let i = 0; i < 4; i++) recordFailure(0);
assert.equal(breakerState(0), 'closed', 'a success in the middle prevents 4+4 from tripping the breaker');

// 8. Env kill-switch path: ATMOS_UPSTREAM_BREAKER=off makes it a no-op. Verified by a
//    child process so the module reads the env at load time.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const probe = [
  "import('./src/upstream-breaker.js').then(b=>{",
  "  for(let i=0;i<10;i++) b.recordFailure(0);",
  "  if(b.upstreamUnavailable(0)!==false||b.breakerState(0)!=='closed'){console.error('breaker should be disabled');process.exit(1)}",
  "  console.log('disabled-ok');",
  "})",
].join('');
const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
  cwd: here, env: { ...process.env, ATMOS_UPSTREAM_BREAKER: 'off' }, encoding: 'utf8',
});
assert.ok(/disabled-ok/.test(out), 'ATMOS_UPSTREAM_BREAKER=off disables the breaker entirely');

console.log('  ✓ EFL-014: upstream circuit breaker — opens after threshold, fast-fails in cooldown, probes, recovers, env-disableable');
