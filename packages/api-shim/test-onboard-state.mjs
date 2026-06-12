/**
 * test-onboard-state.mjs — the ATMOS_ONBOARDING_BACKEND §2 onboarding state machine.
 *
 * States advance ONLY on disk-verifiable evidence; export/activation/score states are honestly
 * unobservable (no local artifact) and must never be claimed. Hermetic: tmp dirs, pure functions,
 * one HTTP round-trip through the real /onboard/state route.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { computeOnboardingState, hasTraceEvidence, ONBOARD_STATES } from './src/product/onboard-state.js';
import { createProductRouter } from './src/product/product-api.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-state-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('onboard-state — §2 state machine, disk evidence only\n');

await ok('state ladder: each state needs its exact evidence; furthest evidenced state wins', () => {
  assert.strictEqual(computeOnboardingState({}).state, 'INSTALLED', 'API answering = installed');
  assert.strictEqual(computeOnboardingState({ nodeDid: 'did:atmos:x', configured: true }).state, 'NODE_CREATED');
  assert.strictEqual(computeOnboardingState({ nodeDid: 'did:atmos:x', configured: true, paired: true }).state, 'PAIRED');
  assert.strictEqual(
    computeOnboardingState({ nodeDid: 'did:atmos:x', configured: true, paired: true, modelConnected: true }).state,
    'MODEL_CONNECTED');
  assert.strictEqual(
    computeOnboardingState({ nodeDid: 'did:atmos:x', configured: true, modelConnected: true, traceExists: true, receiptCount: 2 }).state,
    'FIRST_TASK_RUN');
});

await ok('sovereign path: PAIRED is optional — a trace + receipt advances past an unpaired node (V2 rule)', () => {
  const s = computeOnboardingState({ nodeDid: 'did:atmos:x', configured: true, paired: false, modelConnected: false, traceExists: true, receiptCount: 1 });
  assert.strictEqual(s.state, 'FIRST_TASK_RUN', 'pairing never gates steps 4–5');
  assert.strictEqual(s.evidence.PAIRED, false, 'and the evidence map stays honest about it');
});

await ok('FIRST_TASK_RUN needs BOTH artifacts: a trace AND ≥1 receipt (§2 evidence column)', () => {
  assert.notStrictEqual(computeOnboardingState({ traceExists: true, receiptCount: 0 }).state, 'FIRST_TASK_RUN');
  assert.notStrictEqual(computeOnboardingState({ traceExists: false, receiptCount: 3 }).state, 'FIRST_TASK_RUN');
});

await ok('RECEIPT_EXPORTED / ACTIVATED / SCORED are NEVER claimed — unobservable, with reasons', () => {
  const s = computeOnboardingState({ nodeDid: 'd', configured: true, paired: true, modelConnected: true, traceExists: true, receiptCount: 99 });
  assert.strictEqual(s.state, 'FIRST_TASK_RUN', 'the ladder stops at the last disk-evidenced state');
  for (const u of ['RECEIPT_EXPORTED', 'ACTIVATED', 'SCORED']) {
    assert.ok(ONBOARD_STATES.includes(u), `${u} is a real §2 state`);
    assert.ok(typeof s.unobservable[u] === 'string' && s.unobservable[u].length > 0, `${u} carries its honest reason`);
    assert.ok(!(u in s.evidence), `${u} has no evidence claim`);
  }
});

await ok('hasTraceEvidence: finds traces/*.json in the workspace-tree layout; empty/missing → false', () => {
  const root = tmp();
  assert.strictEqual(hasTraceEvidence(path.join(root, 'absent')), false, 'missing root → false');
  const taskDir = path.join(root, 'ws1', 'proj', 'flow', 'task1', 'traces');
  fs.mkdirSync(taskDir, { recursive: true });
  assert.strictEqual(hasTraceEvidence(root), false, 'empty traces dir → false');
  fs.writeFileSync(path.join(taskDir, 'run1.json'), '{}');
  assert.strictEqual(hasTraceEvidence(root), true, 'a trace file is the evidence');
});

await ok('GET /onboard/state surfaces the machine (additive fields) and still writes NOTHING', async () => {
  const PROFILE = tmp();
  const ws = path.join(PROFILE, 'workspaces', 'w', 'p', 'f', 't', 'traces');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'x.json'), '{}');
  fs.writeFileSync(path.join(PROFILE, 'agent-config.json'), JSON.stringify({ configured: true, modelSources: { local: { enabled: true, name: 'gemma2:2b' } } }));
  const before = fs.readdirSync(PROFILE).sort();
  const app = express();
  app.use(createProductRouter({ profileDir: PROFILE }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const s = await (await fetch(`http://127.0.0.1:${srv.address().port}/onboard/state`)).json();
  srv.close();
  assert.strictEqual(s.state, 'MODEL_CONNECTED', 'no node keys + no receipts → model is the furthest evidence');
  assert.strictEqual(s.state_evidence.FIRST_TASK_RUN, false, 'trace alone is not enough without a receipt');
  assert.ok(s.state_unobservable.ACTIVATED, 'unobservable states surfaced with reasons');
  assert.ok(s.checklist, 'F1 checklist fields remain (additive change only)');
  assert.deepStrictEqual(fs.readdirSync(PROFILE).sort(), before, 'GET wrote nothing (no write-on-read)');
});

assert.strictEqual(pass, 6, `expected all 6 tests, got ${pass}`);
console.log(`\n✅ ${pass}/6 onboard-state tests passed — states advance only on disk evidence.`);
