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

// the REAL synchronous continuity recorder, fed real node keys in the profile dir
const { generateHybridKeyPair } = await import('./../stratos-agent/src/security/quantum-crypto.js');
const { ReceiptLog, makeReceiptSigner, createReceipt, verifyBundle } = await import('./../stratos-agent/src/ledger/capability-receipt.js');
const { originId } = await import('./../stratos-agent/src/memory/skill-seal.js');
const { makeContinuityRecorder } = await import('./src/product/continuity-receipt.js');
const kp = generateHybridKeyPair();
const NODE_DID = originId(kp.publicKey);
const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
fs.writeFileSync(path.join(PROFILE, 'node-keys.json'), JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }));
const recPath = path.join(PROFILE, 'live-receipts.jsonl');
const recorder = makeContinuityRecorder({ ReceiptLog, makeReceiptSigner, createReceipt, originId }, { profileDir: PROFILE });

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
  // load the signed chain back from disk and confirm the returned receipt_id is the TRUE signed id
  const chain = ReceiptLog.loadChainEntries(recPath);
  const signed = chain.at(-1);
  assert.strictEqual(r.receipt_id, signed.receipt_id, 'returned id IS the signed receipt id (no false pointer)');
  const verifyLog = new ReceiptLog({}); verifyLog.chain = chain;
  const bundle = verifyLog.exportBundle({ publicKeyBundle: kp.publicKey });
  const blob = JSON.stringify(bundle);
  assert.ok(!blob.includes(secret), 'receipt carries NO plaintext content');
  assert.ok(blob.includes(r.content_hash), 'receipt commits the content hash');
  assert.strictEqual(signed.action, 'skill-run', 'minted as skill-run');
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

await ok('GET /v1/continuity: work-bounded scan flags truncation on a large log', async () => {
  const BIG = tmp();
  const bigApp = express();
  bigApp.use(createIntelligenceRouter({ profileDir: BIG, routing: { route: engineRoute, resolveRoute, difficulty } }));
  const bs = bigApp.listen(0, '127.0.0.1'); await new Promise((r) => bs.once('listening', r));
  const port = bs.address().port;
  const big = (b) => fetch(`http://127.0.0.1:${port}/v1/continuity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const line = JSON.stringify({ id: 'x', ts: new Date().toISOString(), scope: 'task/big', kind: 'note', content: 'y'.repeat(2000), refs: [], content_hash: 'h' }) + '\n';
  fs.writeFileSync(path.join(BIG, 'continuity.jsonl'), line.repeat(2200)); // ~4.5MB
  await big({ scope: 'task/big', kind: 'note', content: 'newest entry marker' });
  const r = await (await fetch(`http://127.0.0.1:${port}/v1/continuity?scope=task/big&limit=5`)).json();
  bs.close();
  assert.strictEqual(r.scanned_truncated, true, 'a >4MB log is tail-scanned (work-bounded), flagged honestly');
  assert.ok(r.items.some((e) => e.content === 'newest entry marker'), 'the newest (tail) entry is always seen');
});

server.close();
assert.strictEqual(pass, 6, `expected all 6 tests, got ${pass}`);
console.log(`\n✅ ${pass}/6 intelligence-api tests passed — route spends nothing, continuity receipts are hashes-only.`);
