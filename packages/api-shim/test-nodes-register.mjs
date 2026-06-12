/**
 * test-nodes-register.mjs — POST /v1/nodes/register (ATMOS_API_SPEC §2.8).
 *
 * Proves: mint-on-first-register (0600, private key never in the response), REUSE on re-register
 * (an existing identity is never rotated), registry upsert, a signed node-register receipt that
 * verifies third-party, and invalid owner_wallet rejected (never fabricated, never dropped).
 * Hermetic: tmp profile, real keys + recorder, ephemeral port.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { createNodesRouter } from './src/product/nodes-api.js';
import { makeContinuityRecorder } from './src/product/continuity-receipt.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nodes-register-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('nodes-api — register: mint-or-reuse identity, registry entry, signed receipt\n');

const { generateHybridKeyPair } = await import('../stratos-agent/src/security/quantum-crypto.js');
const { ReceiptLog, makeReceiptSigner, createReceipt, normalizeWallet, verifyBundle } = await import('../stratos-agent/src/ledger/capability-receipt.js');
const { originId } = await import('../stratos-agent/src/memory/skill-seal.js');

const PROFILE = tmp();
const recorder = makeContinuityRecorder({ ReceiptLog, makeReceiptSigner, createReceipt, originId }, { profileDir: PROFILE });
const app = express();
app.use(createNodesRouter({
  profileDir: PROFILE,
  identity: { generateHybridKeyPair, originId, normalizeWallet },
  record: recorder,
}));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const post = (body) => fetch(BASE + '/v1/nodes/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// spin an isolated router with an arbitrary recorder (null = none wired) for fail-closed cases
const postTo = async (profileDir, body, record) => {
  const a = express();
  a.use(createNodesRouter({ profileDir, identity: { generateHybridKeyPair, originId, normalizeWallet }, record }));
  const srv = a.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/v1/nodes/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  srv.close();
  return r;
};

let firstNodeId = null;

await ok('first register MINTS the identity (0600), returns PUBLIC key only + a real receipt', async () => {
  const r = await post({ name: 'desk-node', capabilities: ['terminal'] });
  assert.strictEqual(r.status, 201);
  const out = await r.json();
  assert.ok(out.node_id.startsWith('did:atmos:'));
  assert.strictEqual(out.key_minted, true);
  assert.ok(out.public_key?.ed25519Der, 'public bundle returned');
  assert.ok(!JSON.stringify(out).includes('privateKey'), 'private key NEVER in the response');
  const keyFile = path.join(PROFILE, 'node-keys.json');
  assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600, 'key file is 0600');
  assert.ok(out.receipt_id, 'signed receipt minted');
  firstNodeId = out.node_id;
  const reg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'node-registry.json'), 'utf8'));
  assert.strictEqual(reg.format, 'atmos.node-registry.v1');
  assert.strictEqual(reg.nodes.length, 1);
  assert.strictEqual(reg.nodes[0].name, 'desk-node');
});

await ok('re-register is IDEMPOTENT (dual-Codex): 200 not 201, identity + registered_at preserved, NO second receipt', async () => {
  const keysBefore = fs.readFileSync(path.join(PROFILE, 'node-keys.json'), 'utf8');
  const regBefore = JSON.parse(fs.readFileSync(path.join(PROFILE, 'node-registry.json'), 'utf8'));
  const r = await post({ name: 'desk-node-renamed' });
  assert.strictEqual(r.status, 200, 're-registration answers 200, not 201');
  const out = await r.json();
  assert.strictEqual(out.node_id, firstNodeId, 'same did — identity reused');
  assert.strictEqual(out.key_minted, false);
  assert.strictEqual(out.first_registration, false);
  assert.strictEqual(out.receipt_id, null, 're-register mints NO second identity receipt');
  assert.strictEqual(fs.readFileSync(path.join(PROFILE, 'node-keys.json'), 'utf8'), keysBefore, 'key file byte-identical');
  const reg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'node-registry.json'), 'utf8'));
  assert.strictEqual(reg.nodes.length, 1, 'upsert, not duplicate');
  assert.strictEqual(reg.nodes[0].name, 'desk-node-renamed');
  assert.strictEqual(reg.nodes[0].registered_at, regBefore.nodes[0].registered_at, 'registered_at preserved — first registration is a fact, not a counter');
  assert.ok(reg.nodes[0].updated_at, 'updates stamp updated_at instead');
});

await ok('the node-register receipts verify third-party on the chain (public key only)', async () => {
  const keys = JSON.parse(fs.readFileSync(path.join(PROFILE, 'node-keys.json'), 'utf8'));
  const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  const log = new ReceiptLog({});
  log.chain = ReceiptLog.loadChainEntries(path.join(PROFILE, 'live-receipts.jsonl'));
  assert.strictEqual(log.chain.length, 1, 'ONE identity receipt total — the first registration only (idempotency, dual-Codex)');
  assert.ok(log.chain.every((r) => r.action === 'node-register'));
  const v = verifyBundle(log.exportBundle({ publicKeyBundle: dec(keys.publicKey) }));
  assert.strictEqual(v.ok, true, 'bundle verifies: ' + (v.reason || ''));
});

await ok('invalid input rejected: bad name 400; bad owner_wallet 400 (never fabricated/dropped)', async () => {
  assert.strictEqual((await post({ name: '' })).status, 400);
  assert.strictEqual((await post({ name: '../escape' })).status, 400);
  const r = await post({ name: 'ok-node', owner_wallet: 'not-a-solana-address!' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error.message, /owner_wallet/, 'refusal names the field');
  assert.strictEqual((await post({ name: 'ok-node', capabilities: 'nope' })).status, 400);
});

await ok('a valid owner_wallet lands in BOTH the registry entry and the signed receipt (FIRST registration — fresh profile)', async () => {
  const WALLET = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2'; // valid base58, 44 chars
  const PROFILE3 = fs.mkdtempSync(path.join(os.tmpdir(), 'nodes-wallet-'));
  const rec3 = makeContinuityRecorder({ ReceiptLog, makeReceiptSigner, createReceipt, originId }, { profileDir: PROFILE3 });
  const out = await (await postTo(PROFILE3, { name: 'attributed-node', owner_wallet: WALLET }, rec3)).json();
  assert.ok(out.receipt_id, 'first registration mints the identity receipt');
  const reg = JSON.parse(fs.readFileSync(path.join(PROFILE3, 'node-registry.json'), 'utf8'));
  assert.strictEqual(reg.nodes.find((n) => n.name === 'attributed-node').owner_wallet, WALLET);
  const chain = ReceiptLog.loadChainEntries(path.join(PROFILE3, 'live-receipts.jsonl'));
  assert.strictEqual(chain[chain.length - 1].owner_wallet, WALLET, 'attribution signed into the receipt');
});

server.close();
await ok('FAIL-CLOSED (dual-Codex): first registration without a working receipt rail is REFUSED and the registry reverts', async () => {
  const PROFILE2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nodes-fc-'));
  const r = await postTo(PROFILE2, { name: 'orphan-node' }, null); // record: null — no recorder wired
  assert.strictEqual(r.status, 503, 'proof-surface mutation refused without its receipt');
  assert.ok(!fs.existsSync(path.join(PROFILE2, 'node-registry.json')) || JSON.parse(fs.readFileSync(path.join(PROFILE2, 'node-registry.json'), 'utf8')).nodes.length === 0, 'registry holds NO entry after the refusal');
  const r2 = await postTo(PROFILE2, { name: 'orphan-node' }, () => null); // recorder wired but mint FAILS
  assert.strictEqual(r2.status, 503, 'failed mint also refuses');
});

assert.strictEqual(pass, 6, `expected all 5 tests, got ${pass}`);
console.log(`\n✅ ${pass}/6 nodes-register tests passed — identity minted-or-reused, receipted, attributed.`);
