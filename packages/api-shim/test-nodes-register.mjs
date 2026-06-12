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

await ok('re-register REUSES the identity (never rotates keys) and upserts the registry entry', async () => {
  const keysBefore = fs.readFileSync(path.join(PROFILE, 'node-keys.json'), 'utf8');
  const out = await (await post({ name: 'desk-node-renamed' })).json();
  assert.strictEqual(out.node_id, firstNodeId, 'same did — identity reused');
  assert.strictEqual(out.key_minted, false);
  assert.strictEqual(fs.readFileSync(path.join(PROFILE, 'node-keys.json'), 'utf8'), keysBefore, 'key file byte-identical');
  const reg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'node-registry.json'), 'utf8'));
  assert.strictEqual(reg.nodes.length, 1, 'upsert, not duplicate');
  assert.strictEqual(reg.nodes[0].name, 'desk-node-renamed');
});

await ok('the node-register receipts verify third-party on the chain (public key only)', async () => {
  const keys = JSON.parse(fs.readFileSync(path.join(PROFILE, 'node-keys.json'), 'utf8'));
  const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  const log = new ReceiptLog({});
  log.chain = ReceiptLog.loadChainEntries(path.join(PROFILE, 'live-receipts.jsonl'));
  assert.strictEqual(log.chain.length, 2, 'one receipt per registration call');
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

await ok('a valid owner_wallet lands in BOTH the registry entry and the signed receipt', async () => {
  const WALLET = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2'; // valid base58, 44 chars
  const out = await (await post({ name: 'attributed-node', owner_wallet: WALLET })).json();
  assert.ok(out.receipt_id);
  const reg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'node-registry.json'), 'utf8'));
  assert.strictEqual(reg.nodes.find((n) => n.name === 'attributed-node').owner_wallet, WALLET);
  const chain = ReceiptLog.loadChainEntries(path.join(PROFILE, 'live-receipts.jsonl'));
  assert.strictEqual(chain[chain.length - 1].owner_wallet, WALLET, 'attribution signed into the receipt');
});

server.close();
assert.strictEqual(pass, 5, `expected all 5 tests, got ${pass}`);
console.log(`\n✅ ${pass}/5 nodes-register tests passed — identity minted-or-reused, receipted, attributed.`);
