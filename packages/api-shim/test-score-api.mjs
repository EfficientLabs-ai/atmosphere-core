/**
 * test-score-api.mjs — GET /score, the per-user-node Runtime Score (onboarding step 8).
 *
 * The contract under test is the FE's: efficientlabs-web lib/runtime-score.ts
 * isValidRuntimeScore() — ported below as the ORACLE so this suite fails the
 * moment the emitted shape and the FE validator drift (dual-Codex finding:
 * the previous suite locked in a shape the validator rejected). Plus the
 * RUNTIME_SCORE_SPEC §0 hard rule: MEASURED from a real local source or label
 * null with a reason — never synthetic. Hermetic: tmp profile, injected clock.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { createScoreRouter } from './src/product/score-api.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'score-api-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('score-api — per-user runtime score, FE-contract-valid in every state\n');

const { generateHybridKeyPair } = await import('../stratos-agent/src/security/quantum-crypto.js');
const { ReceiptLog, makeReceiptSigner, makeReceiptVerifier, createReceipt } = await import('../stratos-agent/src/ledger/capability-receipt.js');
const { originId } = await import('../stratos-agent/src/memory/skill-seal.js');
const RECEIPT_DEPS = { ReceiptLog, makeReceiptVerifier, originId };

// ── THE ORACLE: a faithful port of the FE validator (lib/runtime-score.ts).
//    If the FE contract changes, change BOTH — that is the point of this test.
const VERDICTS = new Set(['GREEN', 'YELLOW', 'RED']);
const SCORE_KEYS = ['runtime', 'continuity', 'session', 'cost', 'ownership', 'agent_readiness'];
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const optStr = (v) => v === undefined || v === null || isStr(v);
const INPUTS_VALID = {
  runtime: (i) => !!i.heartbeat && isNum(i.heartbeat.fail) && isNum(i.heartbeat.warn) && isNum(i.heartbeat.ok),
  continuity: (i) => isNum(i.signed_receipts) && typeof i.chain_intact === 'boolean',
  session: (i) => isNum(i.context_per_request) && isStr(i.level),
  cost: (i) => isNum(i.rung1_pct) && isNum(i.flagship_on_deterministic),
  ownership: (i) => typeof i.chain_intact === 'boolean',
  agent_readiness: (i) => isNum(i.components_production) && isNum(i.components_total),
};
function feValidatorAccepts(r) {
  if (!r || r.format !== 'efl.runtime-score.v1' || !isStr(r.generated_at)) return false;
  if (!r.hero || !isNum(r.hero.measured) || !isNum(r.hero.total) || !isStr(r.hero.method)) return false;
  if (r.hero.verdict !== null && !VERDICTS.has(r.hero.verdict)) return false;
  if (!r.scores) return false;
  for (const k of SCORE_KEYS) {
    const s = r.scores[k];
    if (!s) return false;
    if (s.label !== 'MEASURED' && s.label !== null) return false;
    if (!optStr(s.updated_at) || !optStr(s.method) || !optStr(s.verify) || !optStr(s.footnote) || !optStr(s.reason)) return false;
    if (s.label === 'MEASURED') {
      if (!VERDICTS.has(s.verdict)) return false;
      if (!s.inputs || !INPUTS_VALID[k](s.inputs)) return false;
    }
  }
  if (!Array.isArray(r.not_measured_registry)) return false;
  for (const e of r.not_measured_registry) if (!e || !isStr(e.what) || !isStr(e.reason)) return false;
  return true;
}

const serve = async (opts) => {
  const app = express();
  app.use(createScoreRouter(opts));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/score`);
  srv.close();
  return r;
};
const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));

await ok('brand-new node: FE-valid grey payload — every label null WITH reason, hero verdict NULL, nothing written', async () => {
  const PROFILE = tmp();
  const doc = await (await serve({ profileDir: PROFILE, receipts: RECEIPT_DEPS })).json();
  assert.ok(feValidatorAccepts(doc), 'fresh-node payload must pass the FE validator');
  assert.strictEqual(doc.hero.verdict, null, 'nothing measured → null, never an invented word');
  assert.strictEqual(doc.hero.measured, 0);
  assert.strictEqual(doc.hero.total, 6);
  for (const k of SCORE_KEYS) {
    assert.strictEqual(doc.scores[k].label, null, `${k} null on a bare node`);
    assert.ok(doc.scores[k].reason?.length > 0, `${k} carries its reason`);
    assert.ok(doc.scores[k].verdict === undefined, `${k} carries NO synthetic verdict`);
  }
  assert.ok(doc.not_measured_registry.length >= 6, 'registry names every unmeasured sub-score');
  assert.deepStrictEqual(fs.readdirSync(PROFILE), [], 'GET /score wrote nothing (no write-on-read)');
});

await ok('fresh heartbeat + verified chain → FE-valid: runtime/continuity/ownership MEASURED GREEN, gaps null, hero worst-of-measured', async () => {
  const PROFILE = tmp();
  const NOW = Date.parse('2026-06-13T12:00:00Z');
  fs.writeFileSync(path.join(PROFILE, 'node-heartbeat.jsonl'),
    JSON.stringify({ ts: '2026-06-13T11:58:00Z', uptime_s: 120, peers: 0 }) + '\n');
  const kp = generateHybridKeyPair();
  const did = originId(kp.publicKey);
  fs.writeFileSync(path.join(PROFILE, 'node-keys.json'), JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }));
  const log = new ReceiptLog({ path: path.join(PROFILE, 'live-receipts.jsonl'), signer: makeReceiptSigner(kp.privateKey), nodeId: did });
  log.append(createReceipt({ actor_id: did, action: 'inference', ref: 'm', cost_units: 1, node_id: did }));
  const doc = await (await serve({ profileDir: PROFILE, receipts: RECEIPT_DEPS, now: () => NOW })).json();
  assert.ok(feValidatorAccepts(doc), 'measured payload must pass the FE validator');
  assert.strictEqual(doc.scores.runtime.label, 'MEASURED');
  assert.strictEqual(doc.scores.runtime.verdict, 'GREEN', 'a 2-min-old beat is fresh');
  assert.deepStrictEqual(doc.scores.runtime.inputs.heartbeat, { fail: 0, warn: 0, ok: 1 }, 'the ONE real check, honestly counted');
  assert.strictEqual(doc.scores.continuity.verdict, 'GREEN', 'full chain verify passed');
  assert.strictEqual(doc.scores.continuity.inputs.signed_receipts, 1);
  assert.strictEqual(doc.scores.continuity.inputs.chain_intact, true);
  assert.strictEqual(doc.scores.ownership.verdict, 'GREEN', 'portable evidence = same intact chain');
  assert.strictEqual(doc.scores.session.label, null, 'no telemetry source → stays honest');
  assert.strictEqual(doc.hero.measured, 3);
  assert.strictEqual(doc.hero.verdict, 'GREEN', 'worst-of-MEASURED only; gaps show via the 3-of-6 denominator, not a degraded verdict');
});

await ok('a stale heartbeat or a TAMPERED chain → measured RED sub-scores, hero RED — and STILL FE-valid', async () => {
  const PROFILE = tmp();
  const NOW = Date.parse('2026-06-13T12:00:00Z');
  fs.writeFileSync(path.join(PROFILE, 'node-heartbeat.jsonl'),
    JSON.stringify({ ts: '2026-06-13T09:00:00Z', uptime_s: 1, peers: 0 }) + '\n'); // 3h old → stale
  const kp = generateHybridKeyPair();
  const did = originId(kp.publicKey);
  fs.writeFileSync(path.join(PROFILE, 'node-keys.json'), JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }));
  const chainFile = path.join(PROFILE, 'live-receipts.jsonl');
  const log = new ReceiptLog({ path: chainFile, signer: makeReceiptSigner(kp.privateKey), nodeId: did });
  log.append(createReceipt({ actor_id: did, action: 'inference', ref: 'm', cost_units: 1, node_id: did }));
  // tamper the persisted receipt (cost flip) — the verify MUST fail closed
  const tampered = JSON.parse(fs.readFileSync(chainFile, 'utf8').trim());
  tampered.cost_units = 9999;
  fs.writeFileSync(chainFile, JSON.stringify(tampered) + '\n');
  const doc = await (await serve({ profileDir: PROFILE, receipts: RECEIPT_DEPS, now: () => NOW })).json();
  assert.ok(feValidatorAccepts(doc), 'failure payload must ALSO pass the FE validator');
  assert.strictEqual(doc.scores.runtime.verdict, 'RED', 'stale beat is a measured FAILURE, not a gap');
  assert.deepStrictEqual(doc.scores.runtime.inputs.heartbeat, { fail: 1, warn: 0, ok: 0 });
  assert.strictEqual(doc.scores.continuity.verdict, 'RED', 'tampered chain fails closed');
  assert.ok(/broken/.test(doc.scores.continuity.method), 'break reason surfaced in method');
  assert.strictEqual(doc.hero.verdict, 'RED', 'any measured failure → RED');
});

assert.strictEqual(pass, 3, `expected all 3 tests, got ${pass}`);
console.log(`\n✅ ${pass}/3 score-api tests passed — FE-contract-valid in every state, never synthetic.`);
