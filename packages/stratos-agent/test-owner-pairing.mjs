// test-owner-pairing.mjs — GATE 2: cryptographic owner identity + the node-pairing ceremony.
//
// Hermetic: pure crypto + fs in isolated tmp dirs — no network, no daemon. Proves:
//   1. owner keypair: created 0600, idempotent reload, stable did:atmos.
//   2. pairing request: self-certifying + signed; tamper/did-mismatch fail closed.
//   3. approve: REFUSES without a fingerprint, REFUSES a wrong fingerprint (the comparison IS the
//      ceremony — no blind TOFU), signs a grant on the correct one.
//   4. grant verification: ok-path; field tamper fails; a FOREIGN owner key fails; a pinned owner
//      mismatch fails even for an internally-valid grant; pinned match passes.
//   5. runtime storage (agent-config): owner identity + paired nodes round-trip; re-pair replaces.
//   6. END-TO-END through the real CLI: device B requests → owner approves (fingerprint) →
//      device B accepts + pins. Two separate profile dirs = two devices.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { originId } from './src/memory/skill-seal.js';
import {
  loadOrCreateOwnerKeys, fingerprint, createPairingRequest, verifyPairingRequest,
  approvePairing, verifyPairingGrant,
} from './src/identity/owner-identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); pass++; };

console.log('owner identity + pairing ceremony — Gate 2, fail-closed, no blind TOFU\n');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-'));
let t = 5000; const now = () => (t += 1);

await ok('owner keypair: created 0600, idempotent reload, stable did', () => {
  const dir = path.join(TMP, 'owner-a');
  const a1 = loadOrCreateOwnerKeys({ profileDir: dir });
  const mode = fs.statSync(a1.path).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'owner key file is 0600');
  const a2 = loadOrCreateOwnerKeys({ profileDir: dir });
  assert.strictEqual(a1.ownerDid, a2.ownerDid, 'reload returns the same identity');
  assert.match(a1.ownerDid, /^did:atmos:[0-9a-f]{40}$/);
  assert.match(fingerprint(a1.publicKey), /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/, 'human fingerprint shape');
});

const owner = loadOrCreateOwnerKeys({ profileDir: path.join(TMP, 'owner-a') });
const nodeB = generateHybridKeyPair(); // the NEW device's node identity

await ok('pairing request: signed + self-certifying; tamper and did-mismatch fail closed', () => {
  const req = createPairingRequest({ nodeKeys: nodeB, now });
  const v = verifyPairingRequest(req);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.nodeDid, originId(nodeB.publicKey));
  assert.strictEqual(v.nodeFingerprint, fingerprint(nodeB.publicKey));
  // tamper a field → signature breaks
  const t1 = JSON.parse(JSON.stringify(req)); t1.requested_at += 1;
  assert.strictEqual(verifyPairingRequest(t1).ok, false);
  // swap the embedded key → did no longer matches
  const t2 = JSON.parse(JSON.stringify(req));
  t2.node_public_key = JSON.parse(JSON.stringify(createPairingRequest({ nodeKeys: generateHybridKeyPair(), now }).node_public_key));
  assert.strictEqual(verifyPairingRequest(t2).ok, false);
});

await ok('approve: refuses without/with-wrong fingerprint; correct fingerprint → signed grant', () => {
  const req = createPairingRequest({ nodeKeys: nodeB, now });
  assert.throws(() => approvePairing({ ownerKeys: owner, request: req }), /without a fingerprint/);
  assert.throws(() => approvePairing({ ownerKeys: owner, request: req, expectedFingerprint: 'dead-beef-dead-beef' }), /fingerprint mismatch/);
  const grant = approvePairing({ ownerKeys: owner, request: req, expectedFingerprint: fingerprint(nodeB.publicKey), now });
  assert.strictEqual(grant.kind, 'pairing-grant');
  assert.strictEqual(grant.owner_did, owner.ownerDid);
  assert.strictEqual(grant.node_did, originId(nodeB.publicKey));
  // fingerprint comparison is format-tolerant (case/dashes)
  const fpLoose = fingerprint(nodeB.publicKey).toUpperCase().replace(/-/g, ' ');
  assert.ok(approvePairing({ ownerKeys: owner, request: req, expectedFingerprint: fpLoose, now }));
});

await ok('grant verification: ok · tamper fails · foreign owner fails · pin enforced', () => {
  const req = createPairingRequest({ nodeKeys: nodeB, now });
  const grant = approvePairing({ ownerKeys: owner, request: req, expectedFingerprint: fingerprint(nodeB.publicKey), now });
  assert.strictEqual(verifyPairingGrant(grant).ok, true);
  // tamper any signed field
  const g1 = JSON.parse(JSON.stringify(grant)); g1.granted_at += 1;
  assert.strictEqual(verifyPairingGrant(g1).ok, false);
  // a FOREIGN owner forges a grant claiming the real owner's did → did/key mismatch
  const mallory = generateHybridKeyPair();
  const forged = approvePairing({ ownerKeys: { ...mallory, ownerDid: originId(mallory.publicKey) }, request: req, expectedFingerprint: fingerprint(nodeB.publicKey), now });
  forged.owner_did = owner.ownerDid; // claim to be the real owner
  assert.strictEqual(verifyPairingGrant(forged).ok, false, 'did does not match embedded key');
  // pin: a grant from a DIFFERENT (internally valid) owner is refused when the pin is set
  const forged2 = approvePairing({ ownerKeys: { ...mallory, ownerDid: originId(mallory.publicKey) }, request: req, expectedFingerprint: fingerprint(nodeB.publicKey), now });
  assert.strictEqual(verifyPairingGrant(forged2).ok, true, 'internally valid on its own');
  const pinned = Object.fromEntries(Object.entries(owner.publicKey).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  assert.strictEqual(verifyPairingGrant(forged2, { pinnedOwnerPublicKey: pinned }).ok, false, 'pin rejects a foreign owner');
  assert.strictEqual(verifyPairingGrant(grant, { pinnedOwnerPublicKey: pinned }).ok, true, 'pin accepts the real owner');
});

await ok('runtime storage: owner identity + paired nodes round-trip; re-pair replaces', async () => {
  const devA = path.join(TMP, 'dev-a'); fs.mkdirSync(devA, { recursive: true });
  const prev = process.cwd();
  process.chdir(devA); // agent-config resolves .stratos-profile off cwd (lazy, so chdir works)
  try {
    const mod = await import(path.join(HERE, 'src/core/agent-config.js'));
    mod._reset?.();
    mod.setOwnerIdentity(owner.ownerDid, { x: 'pub' });
    assert.strictEqual(mod.getOwnerIdentity().owner_did, owner.ownerDid);
    mod.addPairedNode({ node_did: 'did:atmos:b1', node_public_key: { x: 'k1' } });
    mod.addPairedNode({ node_did: 'did:atmos:b2', node_public_key: { x: 'k2' } });
    mod.addPairedNode({ node_did: 'did:atmos:b1', node_public_key: { x: 'k1-rotated' } }); // re-pair replaces
    const nodes = mod.getPairedNodes();
    assert.strictEqual(nodes.length, 2);
    assert.strictEqual(nodes.find((n) => n.node_did === 'did:atmos:b1').node_public_key.x, 'k1-rotated');
  } finally { process.chdir(prev); }
});

await ok('END-TO-END via the real CLI: request → approve(fingerprint) → accept + pin (two devices)', () => {
  const devOwner = path.join(TMP, 'cli-owner'); fs.mkdirSync(devOwner, { recursive: true });
  const devNew = path.join(TMP, 'cli-new'); fs.mkdirSync(devNew, { recursive: true });
  // The NEW device has a node identity on disk (same bundle shape the daemon writes).
  const e = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  const newNode = generateHybridKeyPair();
  const newKeys = path.join(devNew, 'node-keys.json');
  fs.writeFileSync(newKeys, JSON.stringify({ publicKey: e(newNode.publicKey), privateKey: e(newNode.privateKey) }));
  const bin = path.join(HERE, 'bin', 'stratos.js');
  const run = (cwd, env, args) => spawnSync(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });

  // device B: emit the request (stdout = JSON; fingerprint goes to stderr for the human)
  const rReq = run(devNew, { STRATOS_NODE_KEYS: newKeys }, ['pair', 'request']);
  assert.strictEqual(rReq.status, 0, rReq.stderr);
  const reqFile = path.join(TMP, 'request.json');
  fs.writeFileSync(reqFile, rReq.stdout);
  const humanFp = /:\s*([0-9a-f]{4}(?:-[0-9a-f]{4}){3})/.exec(rReq.stderr)?.[1];
  assert.ok(humanFp, 'fingerprint printed for the human');

  // owner device: approving WITHOUT the fingerprint refuses
  const ownerEnv = { STRATOS_PROFILE_DIR: path.join(devOwner, '.stratos-profile') };
  const rNoFp = run(devOwner, ownerEnv, ['pair', 'approve', reqFile]);
  assert.strictEqual(rNoFp.status, 1, 'no fingerprint → refused');
  // with the WRONG fingerprint refuses
  const rBadFp = run(devOwner, ownerEnv, ['pair', 'approve', reqFile, '--fingerprint', '0000-0000-0000-0000']);
  assert.strictEqual(rBadFp.status, 1, 'wrong fingerprint → refused');
  // with the fingerprint the human read → grant
  const rOk = run(devOwner, ownerEnv, ['pair', 'approve', reqFile, '--fingerprint', humanFp]);
  assert.strictEqual(rOk.status, 0, rOk.stdout + rOk.stderr);
  const grantFile = path.join(TMP, 'grant.json');
  fs.writeFileSync(grantFile, rOk.stdout);

  // owner device recorded the pairing
  const rList = run(devOwner, ownerEnv, ['pair', 'list']);
  assert.match(rList.stdout, /did:atmos/, 'paired node listed');

  // device B: accept verifies + pins the owner
  const rAcc = run(devNew, { STRATOS_NODE_KEYS: newKeys }, ['pair', 'accept', grantFile]);
  assert.strictEqual(rAcc.status, 0, rAcc.stdout + rAcc.stderr);
  assert.match(rAcc.stdout, /paired to owner/, 'accept confirms');
  const runtime = JSON.parse(fs.readFileSync(path.join(devNew, '.stratos-profile', 'runtime-state.json'), 'utf8'));
  assert.ok(runtime.ownerIdentity?.owner_did?.startsWith('did:atmos:'), 'owner PINNED on the new device');

  // a tampered grant is refused on accept
  const bad = JSON.parse(fs.readFileSync(grantFile, 'utf8')); bad.granted_at += 1;
  const badFile = path.join(TMP, 'grant-bad.json'); fs.writeFileSync(badFile, JSON.stringify(bad));
  const rBad = run(devNew, { STRATOS_NODE_KEYS: newKeys }, ['pair', 'accept', badFile]);
  assert.strictEqual(rBad.status, 1, 'tampered grant refused');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ ${pass}/${pass} owner-pairing tests passed — explicit ceremony, fail-closed, owner pinned.`);
