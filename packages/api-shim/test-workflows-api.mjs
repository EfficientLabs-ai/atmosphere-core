/**
 * test-workflows-api.mjs — workflow.execute (ATMOS_API_SPEC §2.10, fail-closed slice).
 *
 * Proves: no classifier ⇒ NOTHING executes (fail-closed); L5/L4 steps always refused; L≤3 steps
 * run only through a wired executor and mint one skill-run receipt each (ref=workflow:<id>#<step>);
 * a step failure stops the run fail-visible; run records persist + serve back; dry_run executes
 * nothing. Hermetic: tmp profile, real recorder + chain verify, ephemeral port.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { createWorkflowsRouter } from './src/product/workflows-api.js';
import { makeContinuityRecorder } from './src/product/continuity-receipt.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-api-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('workflows-api — declared steps, classified levels, fail-closed execution, per-step receipts\n');

const { generateHybridKeyPair } = await import('../stratos-agent/src/security/quantum-crypto.js');
const { ReceiptLog, makeReceiptSigner, createReceipt, verifyBundle } = await import('../stratos-agent/src/ledger/capability-receipt.js');
const { originId } = await import('../stratos-agent/src/memory/skill-seal.js');

// the test classifier mirrors the canonical contract: protected verbs → L5, deploy-ish → L4,
// reversible local work → L3 (the REAL one is injected by the daemon; the route only consumes it).
const classifyByVerb = (step) => {
  if (/\b(publish|deploy to production|delete|secret)\b/i.test(step.action)) return { level: 5 };
  if (/\bapply\b/i.test(step.action)) return { level: 4 };
  return { level: 3 };
};

function freshServer({ classify, executors, withRecorder = true } = {}) {
  const PROFILE = tmp();
  fs.mkdirSync(path.join(PROFILE, 'workflows'), { recursive: true });
  // a node identity so the recorder can sign
  const kp = generateHybridKeyPair();
  const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  fs.writeFileSync(path.join(PROFILE, 'node-keys.json'), JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }));
  const record = withRecorder ? makeContinuityRecorder({ ReceiptLog, makeReceiptSigner, createReceipt, originId }, { profileDir: PROFILE }) : null;
  const app = express();
  app.use(createWorkflowsRouter({ profileDir: PROFILE, classify, executors, record }));
  const srv = app.listen(0, '127.0.0.1');
  return new Promise((r) => srv.once('listening', () => r({
    PROFILE, kp, srv,
    base: `http://127.0.0.1:${srv.address().port}`,
  })));
}
const writeWf = (PROFILE, id, steps) => fs.writeFileSync(path.join(PROFILE, 'workflows', id + '.json'), JSON.stringify({ id, steps }));
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

await ok('FAIL-CLOSED: with no classifier wired, nothing executes (and dry_run says so honestly)', async () => {
  const notes = [];
  const { PROFILE, base, srv } = await freshServer({ executors: { note: (s) => notes.push(s.id) } });
  writeWf(PROFILE, 'wf1', [{ id: 's1', action: 'append a local note', uses: 'note' }]);
  const run = await (await post(base, '/v1/workflows/wf1/execute')).json();
  srv.close();
  assert.strictEqual(run.status, 'refused', 'no classifier → the whole run refuses');
  assert.strictEqual(run.steps[0].decision, 'refused');
  assert.match(run.steps[0].reason, /classifier unavailable/, 'reason names the gap');
  assert.strictEqual(notes.length, 0, 'the executor was NEVER called');
});

await ok('L5 protected + L4 policy steps refuse; L3 steps execute with ONE receipt each (ref=workflow:<id>#<step>)', async () => {
  const { PROFILE, kp, base, srv } = await freshServer({
    classify: classifyByVerb,
    executors: { note: (step, ctx) => ({ noted: step.with?.text, run: ctx.run_id }) },
  });
  writeWf(PROFILE, 'mixed', [
    { id: 'safe1', action: 'write a reversible local note', uses: 'note', with: { text: 'a' } },
    { id: 'prot', action: 'publish the skill to npm', uses: 'note' },
    { id: 'pol', action: 'apply the staged config', uses: 'note' },
    { id: 'safe2', action: 'write another local note', uses: 'note', with: { text: 'b' } },
  ]);
  const r = await post(base, '/v1/workflows/mixed/execute');
  assert.strictEqual(r.status, 201);
  const run = await r.json();
  srv.close();
  assert.strictEqual(run.status, 'partial', 'some executed, some refused — named honestly');
  const byId = Object.fromEntries(run.steps.map((s) => [s.id, s]));
  assert.strictEqual(byId.safe1.decision, 'executed');
  assert.strictEqual(byId.safe2.decision, 'executed');
  assert.strictEqual(byId.prot.decision, 'refused');
  assert.match(byId.prot.reason, /L5|founder-only/, 'protected refusal named');
  assert.strictEqual(byId.pol.decision, 'refused');
  assert.match(byId.pol.reason, /L4|policy/, 'policy refusal named');
  // exactly the two executed steps minted receipts, with the spec ref format, chain verifies
  assert.strictEqual(run.receipts.length, 2);
  const chain = ReceiptLog.loadChainEntries(path.join(PROFILE, 'live-receipts.jsonl'));
  assert.deepStrictEqual(chain.map((c) => c.ref).sort(), ['workflow:mixed#safe1', 'workflow:mixed#safe2']);
  assert.ok(chain.every((c) => c.action === 'skill-run'));
  const log = new ReceiptLog({}); log.chain = chain;
  assert.strictEqual(verifyBundle(log.exportBundle({ publicKeyBundle: kp.publicKey })).ok, true, 'receipts verify third-party');
});

await ok('a failing step stops the run (fail-visible): later steps SKIPPED, no receipt for the failure', async () => {
  const { PROFILE, base, srv } = await freshServer({
    classify: classifyByVerb,
    executors: { note: () => 'ok', boom: () => { throw new Error('executor exploded'); } },
  });
  writeWf(PROFILE, 'fragile', [
    { id: 'a', action: 'note one', uses: 'note' },
    { id: 'b', action: 'blow up', uses: 'boom' },
    { id: 'c', action: 'note two', uses: 'note' },
  ]);
  const run = await (await post(base, '/v1/workflows/fragile/execute')).json();
  srv.close();
  assert.strictEqual(run.status, 'failed');
  assert.deepStrictEqual(run.steps.map((s) => s.decision), ['executed', 'failed', 'skipped']);
  assert.match(run.steps[1].reason, /exploded/, 'the failure reason is surfaced verbatim');
  assert.strictEqual(run.receipts.length, 1, 'only the step that ran minted a receipt');
});

await ok('dry_run classifies every step and executes NOTHING; run record persists and serves back', async () => {
  const calls = [];
  const { PROFILE, base, srv } = await freshServer({ classify: classifyByVerb, executors: { note: () => calls.push(1) } });
  writeWf(PROFILE, 'plan', [
    { id: 'x', action: 'local note', uses: 'note' },
    { id: 'y', action: 'publish everything', uses: 'note' },
  ]);
  const run = await (await post(base, '/v1/workflows/plan/execute', { dry_run: true })).json();
  assert.strictEqual(run.status, 'dry_run');
  assert.deepStrictEqual(run.steps.map((s) => s.decision), ['would_execute', 'would_refuse']);
  assert.strictEqual(calls.length, 0, 'dry_run ran nothing');
  assert.strictEqual(run.receipts.length, 0, 'no work → no receipt (§2.7 rule)');
  const got = await (await fetch(`${base}/v1/workflows/plan/runs/${run.run_id}`)).json();
  assert.strictEqual(got.run_id, run.run_id, 'run record served back verbatim');
  // scoped + traversal-safe lookups
  assert.strictEqual((await fetch(`${base}/v1/workflows/OTHER/runs/${run.run_id}`)).status, 404, 'run ids are scoped to their workflow');
  assert.strictEqual((await fetch(`${base}/v1/workflows/plan/runs/..%2F..%2Fetc`)).status, 404, 'traversal-shaped run ids 404');
  srv.close();
});

await ok('unknown workflow 404; malformed definition 400 (dup step ids / missing action)', async () => {
  const { PROFILE, base, srv } = await freshServer({ classify: classifyByVerb });
  assert.strictEqual((await post(base, '/v1/workflows/ghost/execute')).status, 404);
  writeWf(PROFILE, 'dup', [{ id: 's', action: 'a' }, { id: 's', action: 'b' }]);
  assert.strictEqual((await post(base, '/v1/workflows/dup/execute')).status, 400);
  writeWf(PROFILE, 'noaction', [{ id: 's' }]);
  assert.strictEqual((await post(base, '/v1/workflows/noaction/execute')).status, 400);
  srv.close();
});

assert.strictEqual(pass, 5, `expected all 5 tests, got ${pass}`);
console.log(`\n✅ ${pass}/5 workflows-api tests passed — classified, fail-closed, receipted per step.`);
