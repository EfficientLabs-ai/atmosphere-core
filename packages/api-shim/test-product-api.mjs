/**
 * test-product-api.mjs — Foundation F1 read APIs + onboarding state. Hermetic: tmp profile, fake
 * config/receipt readers, real verifyBundle round-trip, ephemeral port. Proves each endpoint
 * composes EXISTING truth verbatim, fails honestly when an artifact is absent, and never leaks
 * key material (providers are NAMES ONLY; nodes never faked alive).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { createProductRouter } from './src/product/product-api.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'product-api-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('product-api — FE read APIs + onboarding, composed from real truth\n');

const PROFILE = tmp();
process.env.STRATOS_PROFILE_DIR = PROFILE;

// real receipt machinery for the verify + count paths
const { generateHybridKeyPair } = await import('../stratos-agent/src/security/quantum-crypto.js');
const { ReceiptLog, makeReceiptSigner, createReceipt, verifyBundle } = await import('../stratos-agent/src/ledger/capability-receipt.js');
const { originId } = await import('../stratos-agent/src/memory/skill-seal.js');

const kp = generateHybridKeyPair();
const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
fs.writeFileSync(path.join(PROFILE, 'node-keys.json'), JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }));
const NODE_DID = originId(kp.publicKey);
const logPath = path.join(PROFILE, 'live-receipts.jsonl');
const log = new ReceiptLog({ path: logPath, signer: makeReceiptSigner(kp.privateKey), nodeId: NODE_DID });
log.append(createReceipt({ actor_id: NODE_DID, action: 'inference', ref: 't1', cost_units: 1, node_id: NODE_DID }));
log.append(createReceipt({ actor_id: NODE_DID, action: 'term-session', ref: 'start:s1', cost_units: 0, node_id: NODE_DID }));

// a published runtime-score artifact
const scorePath = path.join(PROFILE, 'runtime-score.json');
fs.writeFileSync(scorePath, JSON.stringify({ format: 'efl.runtime-score.v1', generated_at: '2026-06-12T00:00:00Z', hero: { verdict: 'YELLOW' }, scores: {} }));

// a node heartbeat
fs.writeFileSync(path.join(PROFILE, 'node-heartbeat.jsonl'), JSON.stringify({ ts: new Date().toISOString(), node: 'n', uptime_s: 99, peers: 0 }) + '\n');

// fake config reader (DESIRED state; providers carry secret handles we must NEVER surface)
const fakeConfig = {
  getConfig: () => ({ agentName: 'test-node', configured: true }),
  getModelSources: () => ({ local: { enabled: true, name: 'gemma2:2b' }, providers: { anthropic: { keyHandle: 'vault:SECRET-HANDLE' }, openai: { keyHandle: 'vault:OTHER' } } }),
  getPairedOwner: () => ({ owner_did: 'did:atmos:' + 'a'.repeat(40), owner_public_key: {} }),
  getRevokedNodes: () => [],
};

const app = express();
app.use(createProductRouter({
  config: fakeConfig,
  receipts: { verifyBundle, ReceiptLog, originId },
  runtimeScorePath: scorePath,
  heartbeatPath: path.join(PROFILE, 'node-heartbeat.jsonl'),
}));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const get = (p, h) => fetch(BASE + p, { headers: h });
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

await ok('GET /v1/runtime-score: artifact verbatim + ETag; 304 on If-None-Match', async () => {
  const r = await get('/v1/runtime-score');
  assert.strictEqual(r.status, 200);
  const etag = r.headers.get('etag');
  assert.ok(etag, 'ETag present');
  const doc = await r.json();
  assert.strictEqual(doc.format, 'efl.runtime-score.v1');
  assert.strictEqual(doc.hero.verdict, 'YELLOW', 'served verbatim, not recomputed');
  const r2 = await get('/v1/runtime-score', { 'if-none-match': etag });
  assert.strictEqual(r2.status, 304, 'conditional GET → 304');
});

await ok('GET /v1/runtime-score: honest 404 when not yet published', async () => {
  const app2 = express();
  app2.use(createProductRouter({ runtimeScorePath: path.join(tmp(), 'absent.json') }));
  const s2 = app2.listen(0, '127.0.0.1');
  await new Promise((r) => s2.once('listening', r));
  const r = await fetch(`http://127.0.0.1:${s2.address().port}/v1/runtime-score`);
  s2.close();
  assert.strictEqual(r.status, 404);
});

await ok('POST /v1/receipts/verify: real bundle verifies; tampered fails closed; bad input 400', async () => {
  const bundle = log.exportBundle({ publicKeyBundle: kp.publicKey });
  const good = await (await post('/v1/receipts/verify', { bundle })).json();
  assert.strictEqual(good.ok, true, 'valid bundle verifies: ' + (good.reason || ''));
  assert.strictEqual(good.count, 2);
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.receipts[0].cost_units = 9999;
  const bad = await (await post('/v1/receipts/verify', { bundle: tampered })).json();
  assert.strictEqual(bad.ok, false, 'tampered bundle fails closed');
  assert.strictEqual((await post('/v1/receipts/verify', { nope: 1 })).status, 400);
});

await ok('GET /v1/nodes: single honest entry — real DID, heartbeat freshness, never a faked fleet', async () => {
  const r = await (await get('/v1/nodes')).json();
  assert.strictEqual(r.nodes.length, 1, 'one node, never invents a fleet');
  assert.strictEqual(r.nodes[0].node_id, NODE_DID);
  assert.strictEqual(r.nodes[0].name, 'test-node');
  assert.strictEqual(r.nodes[0].paired, true);
  assert.strictEqual(r.nodes[0].heartbeat.fresh, true, 'fresh beat detected');
  assert.match(r.measured, /not measured/, 'fleet honesty stated');
});

await ok('GET /onboard/state: checklist derived from artifacts; providers NAMES ONLY (no key handles)', async () => {
  const s = await (await get('/onboard/state')).json();
  assert.strictEqual(s.nodeDid, NODE_DID);
  assert.strictEqual(s.paired, true);
  assert.strictEqual(s.receipts.count, 2);
  assert.deepStrictEqual(s.model.providers.sort(), ['anthropic', 'openai']);
  assert.strictEqual(s.model.local, 'gemma2:2b');
  // the secret handle must NEVER appear anywhere in the response
  assert.ok(!JSON.stringify(s).includes('SECRET-HANDLE'), 'key handles never leave the node');
  assert.ok(!JSON.stringify(s).includes('vault:'), 'no vault refs leak');
  // checklist booleans
  assert.strictEqual(s.checklist.installed, true);
  assert.strictEqual(s.checklist.node_created, true);
  assert.strictEqual(s.checklist.model_connected, true);
  assert.strictEqual(s.checklist.first_receipt, true);
});

await ok('GET /onboard/state: a brand-new node reports honest falses (nothing faked)', async () => {
  const EMPTY = tmp();
  const app3 = express();
  app3.use(createProductRouter({
    config: { getConfig: () => ({ configured: false }), getModelSources: () => ({ local: { enabled: false }, providers: {} }), getPairedOwner: () => null, getRevokedNodes: () => [] },
    receipts: { verifyBundle, ReceiptLog, originId },
    heartbeatPath: path.join(EMPTY, 'none.jsonl'),
  }));
  const savedProfile = process.env.STRATOS_PROFILE_DIR;
  process.env.STRATOS_PROFILE_DIR = EMPTY; // no keys, no receipts
  const s3 = app3.listen(0, '127.0.0.1');
  await new Promise((r) => s3.once('listening', r));
  const s = await (await fetch(`http://127.0.0.1:${s3.address().port}/onboard/state`)).json();
  s3.close();
  process.env.STRATOS_PROFILE_DIR = savedProfile;
  assert.strictEqual(s.nodeDid, null);
  assert.strictEqual(s.paired, false);
  assert.strictEqual(s.receipts.count, 0);
  assert.strictEqual(s.checklist.installed, false);
  assert.strictEqual(s.checklist.first_receipt, false);
});

server.close();
delete process.env.STRATOS_PROFILE_DIR;
assert.strictEqual(pass, 6, `expected all 6 tests, got ${pass}`);
console.log(`\n✅ ${pass}/6 product-api tests passed — read APIs + onboarding, composed from real truth.`);
