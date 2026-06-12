/**
 * test-score-api.mjs — GET /score, the per-user-node Runtime Score (onboarding step 8).
 *
 * Hard rule under test (RUNTIME_SCORE_SPEC §0 via ATMOS_ONBOARDING_BACKEND): every sub-score is
 * either MEASURED from a real local source or `not_measured` with a reason — NEVER a synthetic
 * number. Hermetic: tmp profile, real receipt chain, injected clock.
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

console.log('score-api — per-user runtime score, MEASURED or not_measured with a reason\n');

const { generateHybridKeyPair } = await import('../stratos-agent/src/security/quantum-crypto.js');
const { ReceiptLog, makeReceiptSigner, makeReceiptVerifier, createReceipt } = await import('../stratos-agent/src/ledger/capability-receipt.js');
const { originId } = await import('../stratos-agent/src/memory/skill-seal.js');
const RECEIPT_DEPS = { ReceiptLog, makeReceiptVerifier, originId };

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

await ok('brand-new node: every sub-score not_measured WITH a reason; hero NOT_MEASURED; nothing written', async () => {
  const PROFILE = tmp();
  const doc = await (await serve({ profileDir: PROFILE, receipts: RECEIPT_DEPS })).json();
  assert.strictEqual(doc.format, 'efl.runtime-score.v1');
  assert.strictEqual(doc.variant, 'per-user-node');
  assert.ok(doc.generated_at, 'carries generated_at for the FE stale rule');
  assert.strictEqual(doc.hero.verdict, 'NOT_MEASURED', 'no source → no verdict, never synthesized');
  for (const [k, s] of Object.entries(doc.scores)) {
    assert.strictEqual(s.status, 'not_measured', `${k} not measured on a bare node`);
    assert.ok(s.reason?.length > 0, `${k} carries its reason`);
    assert.ok(!('verdict' in s), `${k} carries NO synthetic verdict`);
  }
  assert.deepStrictEqual(fs.readdirSync(PROFILE), [], 'GET /score wrote nothing (no write-on-read)');
});

await ok('fresh heartbeat + verified chain → MEASURED ok sub-scores; hero YELLOW (telemetry gaps stay honest)', async () => {
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
  assert.strictEqual(doc.scores.heartbeat.status, 'MEASURED');
  assert.strictEqual(doc.scores.heartbeat.verdict, 'ok', 'a 2-min-old beat is fresh');
  assert.strictEqual(doc.scores.receipts.status, 'MEASURED');
  assert.strictEqual(doc.scores.receipts.verdict, 'ok', 'full chain verify passed');
  assert.strictEqual(doc.scores.receipts.inputs.receipt_count, 1);
  assert.strictEqual(doc.scores.sessions.status, 'not_measured', 'no telemetry source → stays honest');
  assert.strictEqual(doc.hero.verdict, 'YELLOW', 'measured-ok with gaps is YELLOW, never inflated to GREEN');
  assert.deepStrictEqual(doc.hero, { verdict: 'YELLOW', measured: 2, not_measured: 2 });
});

await ok('a stale heartbeat or a TAMPERED chain turns its sub-score fail → hero RED (fail-visible)', async () => {
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
  assert.strictEqual(doc.scores.heartbeat.verdict, 'fail', 'stale beat is a measured FAILURE, not a gap');
  assert.strictEqual(doc.scores.receipts.verdict, 'fail', 'tampered chain fails closed');
  assert.strictEqual(typeof doc.scores.receipts.inputs.broken_at, 'number', 'break index surfaced');
  assert.strictEqual(doc.hero.verdict, 'RED', 'any measured failure → RED');
});

assert.strictEqual(pass, 3, `expected all 3 tests, got ${pass}`);
console.log(`\n✅ ${pass}/3 score-api tests passed — measured or honestly absent, never synthetic.`);
