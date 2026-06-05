// test-operating-tap.mjs — INCREMENT 5 (final): the FLAG-GATED, DEFAULT-OFF, FAIL-OPEN observational
// tap that wires the operating core into the live request path.
//
// Hermetic: pure fs + crypto in an isolated tmp dir — NO network, NO Ollama, NO daemon, NO on-disk keys
// (the node keypair is generated in-process and injected). Proves the SAFETY contract that lets this
// touch the production daemon:
//   1. FLAG OFF (default): observe({exec}) returns exec()'s EXACT result and writes ZERO workspace
//      artifacts; a thrown exec error propagates UNCHANGED. Asserted by snapshotting the fs: no writes.
//   2. FLAG ON: observe writes a capture + a receipt-chained trace for a successful run AND returns the
//      unchanged result; for a thrown exec the error STILL propagates unchanged AND a trace marked
//      result:"error" is written.
//   3. FAIL-OPEN: a tap-internal failure (an injected capture that throws) with the flag ON still
//      returns exec()'s result unchanged (the tap error is swallowed, never propagated).
//   4. Determinism + input validation.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observe, isEnabled } from './src/operating/operating-tap.js';
import { createTask, resolveTask } from './src/workspace/workspace-tree.js';
import { capture } from './src/context/context-capture.js';
import { startTrace, recordStep, endTrace, readTrace } from './src/trace/trace-engine.js';
import { ReceiptLog, makeReceiptSigner, makeReceiptVerifier } from './src/ledger/capability-receipt.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { originId } from './src/memory/skill-seal.js';

let pass = 0;
const _cases = [];
const ok = (name, fn) => { _cases.push([name, fn]); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'optap-'));
const FLAG = 'STRATOS_OPERATING_CORE';

// Recursively count every file under a dir (to prove the disabled path writes NOTHING).
function fileCount(dir) {
  let n = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += fileCount(p);
    else n += 1;
  }
  return n;
}

// Build an injected, in-process operating-core set so the tap never touches on-disk keys / real root.
function injectedTap({ now, captureOverride } = {}) {
  const kp = generateHybridKeyPair();
  const nodeId = originId(kp.publicKey);
  const verifier = makeReceiptVerifier(kp.publicKey);
  const log = new ReceiptLog({ signer: makeReceiptSigner(kp.privateKey), verifier, nodeId, now });
  return {
    root: ROOT,
    now,
    createTask,
    capture: captureOverride || capture,
    startTrace,
    recordStep,
    endTrace,
    receiptLog: log,
    actor_id: 'did:atmos:test-actor',
    _kp: kp, _verifier: verifier, _log: log, _nodeId: nodeId,
  };
}

console.log('operating tap — flag-gated, default-off, fail-open observational wrap\n');

// ── 1. FLAG OFF (default): no-op, byte-identical to calling exec() directly ───────────────────────

ok('isEnabled() is OFF by default (flag unset)', () => {
  delete process.env[FLAG];
  assert.strictEqual(isEnabled(), false);
});

ok('FLAG OFF: observe returns exec()\'s EXACT result and writes ZERO artifacts', async () => {
  delete process.env[FLAG];
  const before = fileCount(ROOT);
  const sentinel = { value: 42, nested: { ok: true } };
  // Pass an injected tap too — to prove it is NEVER consulted when the flag is off.
  let injConsulted = false;
  const tap = { root: ROOT, capture: () => { injConsulted = true; }, startTrace: () => { injConsulted = true; } };
  const r = await observe({ meta: { route: 'classify', raw: 'hello' }, exec: async () => sentinel, tap });
  assert.strictEqual(r, sentinel, 'returns the EXACT same reference exec resolved');
  assert.strictEqual(injConsulted, false, 'the operating core is NEVER touched on the disabled path');
  assert.strictEqual(fileCount(ROOT), before, 'NO fs writes happened on the disabled path');
});

ok('FLAG OFF: a thrown exec error propagates UNCHANGED (same error object)', async () => {
  delete process.env[FLAG];
  const before = fileCount(ROOT);
  const boom = new Error('exec exploded');
  boom.code = 'E_BOOM';
  let caught = null;
  try { await observe({ meta: {}, exec: async () => { throw boom; } }); }
  catch (e) { caught = e; }
  assert.strictEqual(caught, boom, 'the exact same error object is rethrown unchanged');
  assert.strictEqual(caught.code, 'E_BOOM');
  assert.strictEqual(fileCount(ROOT), before, 'no fs writes even on the error path when disabled');
});

// ── 2. FLAG ON: observe writes capture + receipt-chained trace; result unchanged ─────────────────

ok('FLAG ON: success — capture + trace (verifying receipt) written AND result returned unchanged', async () => {
  process.env[FLAG] = '1';
  try {
    let nowMs = 1_700_000_000_000;
    const now = () => nowMs++;
    const tap = injectedTap({ now });
    const sentinel = { answer: 'local', tier: 'local-fast' };
    const meta = { workspace: 'live', project: 'requests', workflow: 'classify', day: 'unitday1', source: 'api', raw: 'route this', model: 'gemma2:2b' };

    const r = await observe({ meta, exec: async () => sentinel, tap });
    assert.strictEqual(r, sentinel, 'result returned unchanged (exact reference)');

    // The per-day task exists and is fully scaffolded.
    const tpath = 'live/requests/classify/unitday1';
    const t = resolveTask(tpath, { root: ROOT });
    assert.strictEqual(t.scaffold.ok, true);

    // A capture record landed in memory/ and a raw input in data/.
    assert.ok(fs.readdirSync(t.dirs.memory).some((f) => f.endsWith('.json')), 'a capture record was written to memory/');
    assert.ok(fs.readdirSync(t.dirs.data).length > 0, 'the raw input was written to data/');

    // A trace was written and its receipt VERIFIES with the public key only.
    const traceFile = path.join(t.dirs.traces, 'unitday1.json');
    assert.ok(fs.existsSync(traceFile), 'a trace was written to traces/');
    const trace = readTrace(traceFile);
    assert.strictEqual(trace.result, 'ok', 'trace marked ok for a successful exec');
    assert.ok(trace.steps.length >= 1, 'the model step was recorded');
    assert.ok(tap._log.length >= 1, 'a capability-receipt was minted');
    assert.strictEqual(tap._log.verify().ok, true, 'the receipt chain verifies with the public key only');
  } finally { delete process.env[FLAG]; }
});

ok('FLAG ON: thrown exec — error propagates UNCHANGED and a trace marked "error" is written', async () => {
  process.env[FLAG] = '1';
  try {
    let nowMs = 1_700_000_100_000;
    const now = () => nowMs++;
    const tap = injectedTap({ now });
    const boom = new Error('downstream failed');
    boom.code = 'E_DOWN';
    const meta = { workspace: 'live', project: 'requests', workflow: 'classify', day: 'unitday2', raw: 'x' };

    let caught = null;
    try { await observe({ meta, exec: async () => { throw boom; }, tap }); }
    catch (e) { caught = e; }
    assert.strictEqual(caught, boom, 'the exact exec error is rethrown unchanged');
    assert.strictEqual(caught.code, 'E_DOWN');

    const traceFile = path.join(ROOT, 'live', 'requests', 'classify', 'unitday2', 'traces', 'unitday2.json');
    assert.ok(fs.existsSync(traceFile), 'a trace was still written for the failed run');
    const trace = readTrace(traceFile);
    assert.strictEqual(trace.result, 'error', 'the trace is marked error');
  } finally { delete process.env[FLAG]; }
});

// ── 3. FAIL-OPEN: a tap-internal failure never affects exec()'s result ────────────────────────────

ok('FAIL-OPEN: an injected capture that THROWS (flag on) still returns exec()\'s result unchanged', async () => {
  process.env[FLAG] = '1';
  try {
    let nowMs = 1_700_000_200_000;
    const now = () => nowMs++;
    const throwingCapture = () => { throw new Error('capture blew up'); };
    const tap = injectedTap({ now, captureOverride: throwingCapture });
    const sentinel = { still: 'returned' };
    const meta = { workspace: 'live', project: 'requests', workflow: 'classify', day: 'unitday3', raw: 'y' };

    const r = await observe({ meta, exec: async () => sentinel, tap });
    assert.strictEqual(r, sentinel, 'exec result returned unchanged despite the tap-internal failure');
  } finally { delete process.env[FLAG]; }
});

ok('FAIL-OPEN: a tap-internal failure with a THROWING exec still rethrows exec()\'s error', async () => {
  process.env[FLAG] = '1';
  try {
    let nowMs = 1_700_000_300_000;
    const now = () => nowMs++;
    const throwingCapture = () => { throw new Error('capture blew up'); };
    const tap = injectedTap({ now, captureOverride: throwingCapture });
    const boom = new Error('exec error wins');
    let caught = null;
    try { await observe({ meta: { day: 'unitday4', workflow: 'classify' }, exec: async () => { throw boom; }, tap }); }
    catch (e) { caught = e; }
    assert.strictEqual(caught, boom, 'exec()\'s error is what propagates, not the tap\'s');
  } finally { delete process.env[FLAG]; }
});

// ── 4. Determinism + input validation ─────────────────────────────────────────────────────────────

ok('exec() is called EXACTLY once (both disabled and enabled paths)', async () => {
  // disabled
  delete process.env[FLAG];
  let n = 0;
  await observe({ meta: {}, exec: async () => { n++; return 1; } });
  assert.strictEqual(n, 1, 'exactly once on the disabled path');
  // enabled
  process.env[FLAG] = '1';
  try {
    let m = 0;
    const tap = injectedTap({ now: () => 1_700_000_400_000 });
    await observe({ meta: { day: 'unitday5', workflow: 'classify' }, exec: async () => { m++; return 1; }, tap });
    assert.strictEqual(m, 1, 'exactly once on the enabled path');
  } finally { delete process.env[FLAG]; }
});

ok('input validation: observe with a non-function exec throws (both flag states)', async () => {
  delete process.env[FLAG];
  await assert.rejects(() => observe({ meta: {} }), /exec must be a function/);
  await assert.rejects(() => observe({ meta: {}, exec: 'nope' }), /exec must be a function/);
  process.env[FLAG] = '1';
  try {
    await assert.rejects(() => observe({ meta: {} }), /exec must be a function/);
  } finally { delete process.env[FLAG]; }
});

ok('determinism: same inputs (injected clock) → same trace task path + verifying receipt', async () => {
  process.env[FLAG] = '1';
  try {
    const run = async (day) => {
      const tap = injectedTap({ now: () => 1_700_000_500_000 });
      await observe({ meta: { workspace: 'live', project: 'requests', workflow: 'classify', day, raw: 'same' }, exec: async () => ({ d: day }), tap });
      const f = path.join(ROOT, 'live', 'requests', 'classify', day, 'traces', `${day}.json`);
      return { trace: readTrace(f), verifies: tap._log.verify().ok };
    };
    const a = await run('detA');
    const b = await run('detB');
    assert.strictEqual(a.verifies, true);
    assert.strictEqual(b.verifies, true);
    // Same shape, same step count — deterministic structure (ids/paths differ only by the day segment).
    assert.strictEqual(a.trace.steps.length, b.trace.steps.length);
    assert.strictEqual(a.trace.result, b.trace.result);
  } finally { delete process.env[FLAG]; }
});

// ── runner ────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  for (const [name, fn] of _cases) {
    try { await fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`); process.exitCode = 1; }
  }
  // Cleanup the isolated tmp root.
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass}/${_cases.length} operating-tap cases passed.`);
  if (pass !== _cases.length) process.exitCode = 1;
})();
