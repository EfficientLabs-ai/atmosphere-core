/**
 * test-intelligence-api.mjs — Foundation F2: compute.route dry-run + continuity store/retrieve.
 * Hermetic: tmp profile, the REAL pure router engine, a real signed recorder, ephemeral port.
 * Proves /v1/route spends/executes nothing, continuity stores content but the RECEIPT carries only
 * hashes, retrieval is scoped+logged, and inputs are validated fail-closed.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { createIntelligenceRouter } from './src/product/intelligence-api.js';
import { route as engineRoute, difficulty } from '../stratos-agent/src/routing/model-router.js';
import { resolveRoute } from './src/model-manager.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'intel-api-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('intelligence-api — route dry-run + continuity (hashes-only receipts)\n');

const PROFILE = tmp();

// a real signed recorder so the continuity receipt actually lands and can be verified
const { generateHybridKeyPair } = await import('./../stratos-agent/src/security/quantum-crypto.js');
const { ReceiptLog, makeReceiptSigner } = await import('./../stratos-agent/src/ledger/capability-receipt.js');
const { originId } = await import('./../stratos-agent/src/memory/skill-seal.js');
const kp = generateHybridKeyPair();
const NODE_DID = originId(kp.publicKey);
const recPath = path.join(PROFILE, 'live-receipts.jsonl');
const recLog = new ReceiptLog({ path: recPath, signer: makeReceiptSigner(kp.privateKey), nodeId: NODE_DID });
const { createReceipt } = await import('./../stratos-agent/src/ledger/capability-receipt.js');
const recorder = ({ input_hash, output_hash, ref }) => {
  recLog.append(createReceipt({ actor_id: NODE_DID, action: 'skill-run', ref, cost_units: 0, node_id: NODE_DID, input_hash, output_hash }));
  return ref;
};

const app = express();
app.use(createIntelligenceRouter({
  profileDir: PROFILE,
  routing: { route: engineRoute, resolveRoute, difficulty },
  recordContinuity: recorder,
  env: {}, // no frontier keys configured
}));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const get = (p) => fetch(BASE + p);

await ok('POST /v1/route: privacy stays local; explicit cloud model flagged would_spend; nothing executes', async () => {
  const priv = await (await post('/v1/route', { prompt: 'summarize this', private: true })).json();
  assert.strictEqual(priv.decision.cloud, false, 'private → never cloud');
  assert.strictEqual(priv.would_spend, false);
  assert.strictEqual(priv.executed, false, 'dry-run executes nothing');
  const cloud = await (await post('/v1/route', { prompt: 'x', model: 'gpt-4o' })).json();
  assert.strictEqual(cloud.decision.cloud, true, 'explicit cloud model → cloud');
  assert.strictEqual(cloud.would_spend, true, 'would_spend flag set');
  assert.strictEqual(cloud.resolved.provider, 'openai', 'provider recognized');
  assert.strictEqual(cloud.resolved.configured, false, 'no key set → not configured (honest)');
  // with a key configured, configured flips true and the call would work
  const cfgApp = express();
  cfgApp.use(createIntelligenceRouter({ profileDir: PROFILE, routing: { route: engineRoute, resolveRoute, difficulty }, env: { OPENAI_API_KEY: 'sk-test-not-real' } }));
  const cs = cfgApp.listen(0, '127.0.0.1'); await new Promise((r) => cs.once('listening', r));
  const withKey = await (await fetch(`http://127.0.0.1:${cs.address().port}/v1/route`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', model: 'gpt-4o' }) })).json();
  cs.close();
  assert.strictEqual(withKey.resolved.configured, true, 'key configured → would work');
  assert.ok(!JSON.stringify(withKey).includes('sk-test-not-real'), 'the key VALUE never surfaces');
});

await ok('POST /v1/route: input validation (non-string / oversized prompt → 400)', async () => {
  assert.strictEqual((await post('/v1/route', { prompt: 123 })).status, 400);
  assert.strictEqual((await post('/v1/route', { prompt: 'x'.repeat(100_001) })).status, 400);
});

await ok('POST /v1/continuity: stores content, mints a skill-run receipt over HASHES ONLY', async () => {
  const secret = 'a private architecture decision the receipt must never contain';
  const r = await (await post('/v1/continuity', { scope: 'task/abc', kind: 'decision', content: secret })).json();
  assert.ok(r.id && r.content_hash && r.receipt_id);
  // the on-disk continuity entry keeps content (user's own data); the RECEIPT must not
  const bundle = recLog.exportBundle({ publicKeyBundle: kp.publicKey });
  const blob = JSON.stringify(bundle);
  assert.ok(!blob.includes(secret), 'receipt carries NO plaintext content');
  assert.ok(blob.includes(r.content_hash), 'receipt commits the content hash');
  assert.strictEqual(bundle.receipts.at(-1).action, 'skill-run', 'minted as skill-run');
  const { verifyBundle } = await import('./../stratos-agent/src/ledger/capability-receipt.js');
  assert.strictEqual(verifyBundle(bundle).ok, true, 'continuity receipt verifies on the chain');
});

await ok('POST /v1/continuity: scope + kind validation fail-closed', async () => {
  assert.strictEqual((await post('/v1/continuity', { scope: 'bad', kind: 'decision', content: 'x' })).status, 400);
  assert.strictEqual((await post('/v1/continuity', { scope: 'task/x', kind: 'invalid', content: 'x' })).status, 400);
  assert.strictEqual((await post('/v1/continuity', { scope: 'task/x', kind: 'note' })).status, 400, 'missing content');
});

await ok('GET /v1/continuity: scoped retrieval, newest-first, bounded; retrieval is logged', async () => {
  await post('/v1/continuity', { scope: 'task/q', kind: 'note', content: 'alpha findings' });
  await post('/v1/continuity', { scope: 'task/q', kind: 'note', content: 'beta findings' });
  await post('/v1/continuity', { scope: 'task/other', kind: 'note', content: 'unrelated' });
  const r = await (await get('/v1/continuity?scope=task/q')).json();
  assert.strictEqual(r.count, 2, 'only the scoped entries');
  assert.strictEqual(r.items[0].content, 'beta findings', 'newest first');
  const q = await (await get('/v1/continuity?scope=task/q&q=alpha')).json();
  assert.strictEqual(q.count, 1, 'query filter');
  // retrieval log exists and records counts, never the raw query
  const rl = path.join(PROFILE, 'continuity-retrievals.jsonl');
  assert.ok(fs.existsSync(rl), 'retrievals logged');
  const last = JSON.parse(fs.readFileSync(rl, 'utf8').trim().split('\n').at(-1));
  assert.strictEqual(typeof last.returned, 'number');
  assert.ok(!JSON.stringify(last).includes('alpha'), 'raw query text not logged (hashed)');
});

server.close();
assert.strictEqual(pass, 5, `expected all 5 tests, got ${pass}`);
console.log(`\n✅ ${pass}/5 intelligence-api tests passed — route spends nothing, continuity receipts are hashes-only.`);
