/**
 * test-pairing-receipt.mjs — pairing-success receipt (ATMOS_ONBOARDING_BACKEND §1 step 3 TO-BUILD a).
 *
 * A successful `stratos pair accept` must leave an EVIDENCE ARTIFACT on the signed receipt chain
 * (action 'pairing'), not just runtime state — that artifact is what the FE checklist's step-3
 * checkmark derives from. A REFUSED accept must mint nothing. The chain stays third-party
 * verifiable (public key only). Hermetic: temp dirs, real CLI, real hybrid keys, no network.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { ReceiptLog, verifyBundle } from './src/ledger/capability-receipt.js';
import { originId } from './src/memory/skill-seal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-receipt-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('pairing receipt — accept success leaves a signed evidence artifact on the chain\n');

const devOwner = path.join(TMP, 'owner'); fs.mkdirSync(devOwner, { recursive: true });
const devNew = path.join(TMP, 'new'); fs.mkdirSync(devNew, { recursive: true });
const e = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
const newNode = generateHybridKeyPair();
const newKeys = path.join(devNew, 'node-keys.json');
fs.writeFileSync(newKeys, JSON.stringify({ publicKey: e(newNode.publicKey), privateKey: e(newNode.privateKey) }));
const receiptsFile = path.join(devNew, 'receipts.jsonl');
const NEW_DID = originId(newNode.publicKey);

const bin = path.join(HERE, 'bin', 'stratos.js');
const run = (cwd, env, args) => spawnSync(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
const newEnv = { STRATOS_NODE_KEYS: newKeys, STRATOS_RECEIPTS: receiptsFile };
const ownerEnv = { STRATOS_PROFILE_DIR: path.join(devOwner, '.stratos-profile') };

// ceremony: request → approve (node fingerprint) → owner fingerprint for the accept
const rReq = run(devNew, newEnv, ['pair', 'request']);
assert.strictEqual(rReq.status, 0, rReq.stderr);
const reqFile = path.join(TMP, 'request.json'); fs.writeFileSync(reqFile, rReq.stdout);
const nodeFp = /:\s*([0-9a-f]{4}(?:-[0-9a-f]{4}){3})/.exec(rReq.stderr)?.[1];
const rApprove = run(devOwner, ownerEnv, ['pair', 'approve', reqFile, '--fingerprint', nodeFp]);
assert.strictEqual(rApprove.status, 0, rApprove.stdout + rApprove.stderr);
const grantFile = path.join(TMP, 'grant.json'); fs.writeFileSync(grantFile, rApprove.stdout);
const rOwner = run(devOwner, ownerEnv, ['owner']);
const ownerFp = /([0-9a-f]{4}(?:-[0-9a-f]{4}){3})/.exec(rOwner.stdout)?.[1];

await ok('a REFUSED accept mints NO receipt (refusal is denial-audited, not receipted)', () => {
  const r = run(devNew, newEnv, ['pair', 'accept', grantFile]); // no owner fingerprint → refused
  assert.strictEqual(r.status, 1, 'first accept without owner fingerprint refused');
  assert.ok(!fs.existsSync(receiptsFile), 'no receipt file appears on refusal');
});

await ok('a SUCCESSFUL accept appends a signed action:pairing receipt to the chain, BOUND to the ceremony', async () => {
  const r = run(devNew, newEnv, ['pair', 'accept', grantFile, '--owner-fingerprint', ownerFp]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pairing receipt/, 'CLI reports the evidence artifact');
  const entries = ReceiptLog.loadChainEntries(receiptsFile);
  assert.strictEqual(entries.length, 1, 'exactly one receipt');
  const rec = entries[0];
  assert.strictEqual(rec.action, 'pairing');
  assert.strictEqual(rec.actor_id, NEW_DID, 'the accepting node is the actor');
  assert.strictEqual(rec.node_id, NEW_DID);
  assert.match(rec.ref, /^accept:did:atmos:/, 'ref names the event + owner did');
  assert.strictEqual(rec.cost_units, 0, 'pairing is never a cost event');
  // CEREMONY BINDING (dual-Codex): the receipt must be demandable evidence, not a self-assertion —
  // input_hash = the owner-SIGNED grant verbatim; output_hash = the accepted ceremony facts.
  const crypto = await import('node:crypto');
  const h = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
  const grant = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
  assert.strictEqual(rec.input_hash, h(JSON.stringify(grant)), 'input_hash binds the owner-signed grant — a verifier can demand the grant and check its signature');
  const ownerDid = rec.ref.replace(/^accept:/, '');
  assert.strictEqual(rec.output_hash, h(JSON.stringify({ owner_did: ownerDid, owner_fingerprint: ownerFp, node_did: NEW_DID })), 'output_hash binds owner DID + pinned fingerprint + node DID');
});

await ok('the chain containing the pairing receipt verifies third-party (public key only)', () => {
  const log = new ReceiptLog({});
  log.chain = ReceiptLog.loadChainEntries(receiptsFile);
  const bundle = log.exportBundle({ publicKeyBundle: newNode.publicKey });
  const v = verifyBundle(bundle);
  assert.strictEqual(v.ok, true, 'bundle verifies: ' + (v.reason || ''));
  assert.strictEqual(v.count, 1);
  // tamper check: flipping the ref breaks verification (fail-closed)
  const bad = JSON.parse(JSON.stringify(bundle));
  bad.receipts[0].ref = 'accept:did:atmos:' + 'f'.repeat(40);
  assert.strictEqual(verifyBundle(bad).ok, false, 'tampered pairing receipt fails closed');
});

fs.rmSync(TMP, { recursive: true, force: true });
assert.strictEqual(pass, 3, `expected all 3 tests, got ${pass}`);
console.log(`\n✅ ${pass}/3 pairing-receipt tests passed — step-3 evidence artifact on the signed chain.`);
