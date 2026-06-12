/**
 * test-skills-publish.mjs — POST /v1/skills/publish (ATMOS_API_SPEC §2.11).
 *
 * Proves the three refusal walls and the happy path: target:"public" ALWAYS 403 (founder-only,
 * before the gate is even consulted); no lifecycle gate wired ⇒ 503 fail-closed; a refusing gate
 * ⇒ 403 with its reason. A gated local publish seals with the REAL hybrid suite (seal verifies
 * against the node's pinned public key, tamper fails) and mints a skill-run receipt.
 * Hermetic: tmp profile, real keys/seal/recorder, ephemeral port.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { createSkillsRouter } from './src/product/skills-api.js';
import { makeContinuityRecorder } from './src/product/continuity-receipt.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skills-publish-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('skills-api — publish: protected wall, lifecycle gate fail-closed, real seal + receipt\n');

const { generateHybridKeyPair } = await import('../stratos-agent/src/security/quantum-crypto.js');
const { ReceiptLog, makeReceiptSigner, createReceipt } = await import('../stratos-agent/src/ledger/capability-receipt.js');
const { originId, sealSkillBlock, verifySkillBlock } = await import('../stratos-agent/src/memory/skill-seal.js');

async function freshServer({ lifecycleGate } = {}) {
  const PROFILE = tmp();
  fs.mkdirSync(path.join(PROFILE, 'skills'), { recursive: true });
  const kp = generateHybridKeyPair();
  const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  fs.writeFileSync(path.join(PROFILE, 'node-keys.json'), JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }));
  fs.writeFileSync(path.join(PROFILE, 'skills', 'summarize-v1.json'),
    JSON.stringify({ skillId: 'summarize-v1', wasmHash: 'a'.repeat(64), metadata: { evals: '6/6' } }));
  const record = makeContinuityRecorder({ ReceiptLog, makeReceiptSigner, createReceipt, originId }, { profileDir: PROFILE });
  const app = express();
  app.use(createSkillsRouter({ profileDir: PROFILE, seal: { sealSkillBlock }, lifecycleGate, record }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { PROFILE, kp, srv, base: `http://127.0.0.1:${srv.address().port}` };
}
const post = (base, body) => fetch(base + '/v1/skills/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

await ok('target "public" is ALWAYS 403 — even with an approving gate (founder-only, checked first)', async () => {
  const { base, srv, PROFILE } = await freshServer({ lifecycleGate: () => ({ ok: true }) });
  const r = await post(base, { skill_id: 'summarize-v1', target: 'public' });
  srv.close();
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error.message, /founder-only/, 'refusal names the authority rule');
  assert.ok(!fs.existsSync(path.join(PROFILE, 'published-skills.jsonl')), 'nothing was published');
});

await ok('no lifecycle gate wired ⇒ 503 fail-closed (un-validated promotions never pass by omission)', async () => {
  const { base, srv } = await freshServer({});
  const r = await post(base, { skill_id: 'summarize-v1', target: 'local' });
  srv.close();
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error.message, /fail-closed/);
});

await ok('a refusing gate ⇒ 403 carrying ITS reason; a throwing gate ⇒ 503 (refusing, not crashing)', async () => {
  const { base, srv } = await freshServer({ lifecycleGate: () => ({ ok: false, reason: 'no eval evidence on record' }) });
  const r = await post(base, { skill_id: 'summarize-v1', target: 'workspace' });
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error.message, /no eval evidence/);
  srv.close();
  const t = await freshServer({ lifecycleGate: () => { throw new Error('gate offline'); } });
  const r2 = await post(t.base, { skill_id: 'summarize-v1', target: 'local' });
  t.srv.close();
  assert.strictEqual(r2.status, 503);
});

await ok('gated local publish: REAL seal (verifies, tamper fails), publish entry, skill-run receipt', async () => {
  const gateCalls = [];
  const { PROFILE, kp, base, srv } = await freshServer({ lifecycleGate: (x) => { gateCalls.push(x.skill_id); return { ok: true }; } });
  const r = await post(base, { skill_id: 'summarize-v1', target: 'local' });
  srv.close();
  assert.strictEqual(r.status, 201);
  const out = await r.json();
  assert.deepStrictEqual(gateCalls, ['summarize-v1'], 'the gate WAS consulted');
  assert.strictEqual(out.published, true);
  // the seal is real: verifies against the node's public bundle; tampering the hash breaks it
  const v = verifySkillBlock(out.seal, kp.publicKey);
  assert.strictEqual(v.ok, true, 'seal verifies: ' + (v.reason || ''));
  const tampered = { ...out.seal, wasmHash: 'b'.repeat(64) };
  assert.strictEqual(verifySkillBlock(tampered, kp.publicKey).ok, false, 'tampered seal fails closed');
  // publish entry + receipt
  const entry = JSON.parse(fs.readFileSync(path.join(PROFILE, 'published-skills.jsonl'), 'utf8').trim());
  assert.strictEqual(entry.skill_id, 'summarize-v1');
  assert.strictEqual(entry.target, 'local');
  assert.ok(out.receipt_id, 'receipt minted');
  const chain = ReceiptLog.loadChainEntries(path.join(PROFILE, 'live-receipts.jsonl'));
  assert.strictEqual(chain[0].ref, 'skill:publish:summarize-v1');
  assert.strictEqual(chain[0].action, 'skill-run');
});

await ok('unknown skill 404; bad inputs 400 — publish never invents an artifact', async () => {
  const { base, srv } = await freshServer({ lifecycleGate: () => ({ ok: true }) });
  assert.strictEqual((await post(base, { skill_id: 'ghost', target: 'local' })).status, 404);
  assert.strictEqual((await post(base, { skill_id: '../../etc', target: 'local' })).status, 400);
  assert.strictEqual((await post(base, { skill_id: 'summarize-v1', target: 'npm' })).status, 400);
  srv.close();
});

assert.strictEqual(pass, 5, `expected all 5 tests, got ${pass}`);
console.log(`\n✅ ${pass}/5 skills-publish tests passed — protected wall + gate fail-closed + real seal.`);
