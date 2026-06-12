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
const { ReceiptLog, makeReceiptSigner, createReceipt, verifyBundle, makeReceiptVerifier } = await import('../stratos-agent/src/ledger/capability-receipt.js');
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

// real on-disk state files (the API reads these directly, read-only). The provider map carries a
// secret HANDLE that must never surface.
fs.writeFileSync(path.join(PROFILE, 'agent-config.json'), JSON.stringify({
  agentName: 'test-node', configured: true,
  modelSources: { local: { enabled: true, name: 'gemma2:2b' }, providers: { anthropic: { keyHandle: 'vault:SECRET-HANDLE' }, openai: { keyHandle: 'vault:OTHER' } } },
}));
fs.writeFileSync(path.join(PROFILE, 'runtime-state.json'), JSON.stringify({
  pairedOwner: { owner_did: 'did:atmos:' + 'a'.repeat(40), owner_public_key: {} }, revokedNodes: [],
}));

const app = express();
app.use(createProductRouter({
  profileDir: PROFILE,
  receipts: { verifyBundle, ReceiptLog, originId, makeReceiptVerifier }, // PRODUCTION dep shape — keep in sync with server.js
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

await ok('GET /onboard/state: a brand-new node reports honest falses (nothing faked, no write-on-read)', async () => {
  const EMPTY = tmp(); // empty profile dir — zero state files
  const app3 = express();
  app3.use(createProductRouter({ profileDir: EMPTY, receipts: { verifyBundle, ReceiptLog, originId, makeReceiptVerifier }, heartbeatPath: path.join(EMPTY, 'none.jsonl') }));
  const s3 = app3.listen(0, '127.0.0.1');
  await new Promise((r) => s3.once('listening', r));
  const s = await (await fetch(`http://127.0.0.1:${s3.address().port}/onboard/state`)).json();
  s3.close();
  // CRITICAL (Codex finding): a GET must NOT create state — the dir stays empty after the read
  assert.deepStrictEqual(fs.readdirSync(EMPTY), [], 'GET /onboard/state wrote NOTHING to disk');
  assert.strictEqual(s.nodeDid, null);
  assert.strictEqual(s.paired, false);
  assert.strictEqual(s.receipts.count, 0);
  assert.strictEqual(s.checklist.installed, true, 'this API answering IS the install evidence — checklist matches the state machine (dual-Codex round 3)');
  assert.strictEqual(s.state, 'INSTALLED');
  assert.strictEqual(s.checklist.first_receipt, false);
});

await ok('real server mount: product routes are strict (503 no-secret) but /health stays OPEN', async () => {
  const cwd0 = process.cwd();
  const FRESH = tmp();
  process.chdir(FRESH); // no .stratos-profile here, no secret → strict surface must refuse
  const savedSecret = process.env.ATMOS_GATEWAY_SECRET;
  delete process.env.ATMOS_GATEWAY_SECRET;
  process.env.LOCAL_FALLBACK_ENABLED = 'false';
  let appMod;
  try {
    appMod = (await import('./server.js')).app;
    const srv = appMod.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const health = await fetch(`${base}/health`);
    assert.strictEqual(health.status, 200, '/health must NOT be gated by the product strict auth');
    assert.strictEqual((await fetch(`${base}/v1/nodes`)).status, 503, '/v1/nodes is strict fail-closed');
    assert.strictEqual((await fetch(`${base}/onboard/state`)).status, 503, '/onboard/state is strict fail-closed');
    // Lane B surfaces (2026-06-13): same strict wall, no secret → the surface refuses to exist
    assert.strictEqual((await fetch(`${base}/score`)).status, 503, '/score is strict fail-closed');
    assert.strictEqual((await fetch(`${base}/v1/nodes/register`, { method: 'POST' })).status, 503, 'node register is strict fail-closed');
    assert.strictEqual((await fetch(`${base}/v1/workflows/x/execute`, { method: 'POST' })).status, 503, 'workflow execute is strict fail-closed');
    assert.strictEqual((await fetch(`${base}/v1/skills/publish`, { method: 'POST' })).status, 503, 'skill publish is strict fail-closed');
    srv.close();
  } finally {
    process.chdir(cwd0);
    if (savedSecret === undefined) delete process.env.ATMOS_GATEWAY_SECRET; else process.env.ATMOS_GATEWAY_SECRET = savedSecret;
  }
});

server.close();
delete process.env.STRATOS_PROFILE_DIR;
await ok('PAIRED lights ONLY from a VERIFIED pairing receipt on this node\'s chain (dual-Codex round 3 — production dep shape)', async () => {
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-verify-'));
  const kp = generateHybridKeyPair();
  const b64o = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  fs.writeFileSync(path.join(PROFILE, 'node-keys.json'), JSON.stringify({ publicKey: b64o(kp.publicKey), privateKey: b64o(kp.privateKey) }));
  fs.writeFileSync(path.join(PROFILE, 'agent-config.json'), JSON.stringify({ configured: true }));
  const did = originId(kp.publicKey);
  const chainPath = path.join(PROFILE, 'live-receipts.jsonl');
  const log = new ReceiptLog({ path: chainPath, signer: makeReceiptSigner(kp.privateKey), nodeId: did });
  log.append(createReceipt({ actor_id: did, action: 'pairing', ref: 'accept:did:atmos:owner', cost_units: 0, node_id: did }));
  const mk = async () => {
    const a = express();
    a.use(createProductRouter({ profileDir: PROFILE, receipts: { verifyBundle, ReceiptLog, originId, makeReceiptVerifier } }));
    const srv = a.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const out = await (await fetch(`http://127.0.0.1:${srv.address().port}/onboard/state`)).json();
    srv.close();
    return out;
  };
  const s1 = await mk();
  assert.strictEqual(s1.state_evidence.PAIRED, true, 'a signed pairing receipt on the verified chain lights PAIRED');
  assert.strictEqual(s1.state, 'PAIRED');
  // tamper the chain → the SAME artifact stops counting (fail-closed)
  const lines = fs.readFileSync(chainPath, 'utf8').trim().split('\n');
  const t = JSON.parse(lines[0]); t.ref = 'accept:did:atmos:EVIL';
  fs.writeFileSync(chainPath, JSON.stringify(t) + '\n');
  const s2 = await mk();
  assert.strictEqual(s2.state_evidence.PAIRED, false, 'a tampered pairing line is just text');
});

assert.strictEqual(pass, 8, `expected all 8 tests, got ${pass}`);
console.log(`\n✅ ${pass}/8 product-api tests passed — read APIs + onboarding, composed from real truth.`);
