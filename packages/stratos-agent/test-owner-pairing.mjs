// test-owner-pairing.mjs — GATE 2: cryptographic owner identity + the node-pairing ceremony.
//
// Hermetic: pure crypto + fs in isolated tmp dirs — no network, no daemon. Proves:
//   1. owner keypair: created 0600, idempotent reload, stable did:atmos.
//   2. pairing request: self-certifying + signed; tamper/did-mismatch fail closed.
//   3. approve: REFUSES without a fingerprint, REFUSES a wrong fingerprint (the comparison IS the
//      ceremony — no blind TOFU), signs a grant on the correct one.
//   4. grant verification: SYMMETRIC — owner fingerprint required on first accept (MITM grant
//      fails the human comparison); node binding refuses replay to another device; field tamper
//      and foreign owners fail closed; a pinned owner overrides and needs no fingerprint.
//   5. runtime storage (agent-config): owner identity + paired nodes round-trip; re-pair replaces.
//   6. END-TO-END through the real CLI: device B requests → owner approves (node fingerprint) →
//      device B accepts (owner fingerprint) + pins in the SEPARATE pairedOwner slot; replay to a
//      third device refused. Separate profile dirs = separate devices.
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

await ok('grant verification: SYMMETRIC ceremony — owner fingerprint required on first accept; node binding; pin enforced', () => {
  const req = createPairingRequest({ nodeKeys: nodeB, now });
  const grant = approvePairing({ ownerKeys: owner, request: req, expectedFingerprint: fingerprint(nodeB.publicKey), now });
  const ownerFp = fingerprint(owner.publicKey);
  // NO blind TOFU in the accept direction either: without pin AND without the owner fingerprint → refused.
  assert.strictEqual(verifyPairingGrant(grant).ok, false, 'first accept without owner fingerprint refused');
  assert.match(verifyPairingGrant(grant).reason, /no blind TOFU/i);
  // wrong owner fingerprint → refused; right one → ok.
  assert.strictEqual(verifyPairingGrant(grant, { expectedOwnerFingerprint: 'dead-beef-dead-beef' }).ok, false);
  assert.strictEqual(verifyPairingGrant(grant, { expectedOwnerFingerprint: ownerFp }).ok, true);
  // node binding: a grant for node B refuses to verify as node C (replay protection).
  const nodeC = generateHybridKeyPair();
  assert.strictEqual(
    verifyPairingGrant(grant, { expectedOwnerFingerprint: ownerFp, expectedNodeDid: originId(nodeC.publicKey) }).ok,
    false, 'grant replayed to a different node refused');
  assert.strictEqual(
    verifyPairingGrant(grant, { expectedOwnerFingerprint: ownerFp, expectedNodeDid: originId(nodeB.publicKey) }).ok,
    true, 'grant accepted on the node it was minted for');
  // tamper any signed field → refused even with the right fingerprint.
  const g1 = JSON.parse(JSON.stringify(grant)); g1.granted_at += 1;
  assert.strictEqual(verifyPairingGrant(g1, { expectedOwnerFingerprint: ownerFp }).ok, false);
  // a FOREIGN owner claiming the real owner's did → did/key mismatch.
  const mallory = generateHybridKeyPair();
  const malloryFp = fingerprint(mallory.publicKey);
  const forged = approvePairing({ ownerKeys: { ...mallory, ownerDid: originId(mallory.publicKey) }, request: req, expectedFingerprint: fingerprint(nodeB.publicKey), now });
  forged.owner_did = owner.ownerDid; // claim to be the real owner
  assert.strictEqual(verifyPairingGrant(forged, { expectedOwnerFingerprint: malloryFp }).ok, false, 'did does not match embedded key');
  // an interceptor self-issuing a grant fails the OWNER-fingerprint comparison (the MITM case).
  const forged2 = approvePairing({ ownerKeys: { ...mallory, ownerDid: originId(mallory.publicKey) }, request: req, expectedFingerprint: fingerprint(nodeB.publicKey), now });
  assert.strictEqual(verifyPairingGrant(forged2, { expectedOwnerFingerprint: ownerFp }).ok, false, 'MITM grant fails the human comparison');
  // pin: a foreign (internally-valid) owner is refused once the real owner is pinned.
  const pinned = Object.fromEntries(Object.entries(owner.publicKey).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  assert.strictEqual(verifyPairingGrant(forged2, { pinnedOwnerPublicKey: pinned }).ok, false, 'pin rejects a foreign owner');
  assert.strictEqual(verifyPairingGrant(grant, { pinnedOwnerPublicKey: pinned }).ok, true, 'pin accepts the real owner (no fingerprint needed once pinned)');
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
    // The PIN lives in its own slot: setting a LOCAL owner identity never clobbers it.
    mod.setPairedOwner('did:atmos:pinned', { x: 'pin' });
    mod.setOwnerIdentity('did:atmos:local-owner', { x: 'local' });
    assert.strictEqual(mod.getPairedOwner().owner_did, 'did:atmos:pinned', 'local owner identity cannot clobber the pin');
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

  // the OWNER's fingerprint, read off the owner device ('stratos owner')
  const rOwner = run(devOwner, ownerEnv, ['owner']);
  assert.strictEqual(rOwner.status, 0, rOwner.stderr);
  const ownerFp = /([0-9a-f]{4}(?:-[0-9a-f]{4}){3})/.exec(rOwner.stdout)?.[1];
  assert.ok(ownerFp, 'owner fingerprint printed');

  // device B: accept WITHOUT the owner fingerprint refuses (symmetric ceremony, first accept)
  const rAccNoFp = run(devNew, { STRATOS_NODE_KEYS: newKeys }, ['pair', 'accept', grantFile]);
  assert.strictEqual(rAccNoFp.status, 1, 'first accept without owner fingerprint refused');
  // with the WRONG owner fingerprint refuses
  const rAccBadFp = run(devNew, { STRATOS_NODE_KEYS: newKeys }, ['pair', 'accept', grantFile, '--owner-fingerprint', '0000-0000-0000-0000']);
  assert.strictEqual(rAccBadFp.status, 1, 'wrong owner fingerprint refused');
  // with the fingerprint the human read off the owner device → verifies + PINS (pairedOwner slot)
  const rAcc = run(devNew, { STRATOS_NODE_KEYS: newKeys }, ['pair', 'accept', grantFile, '--owner-fingerprint', ownerFp]);
  assert.strictEqual(rAcc.status, 0, rAcc.stdout + rAcc.stderr);
  assert.match(rAcc.stdout, /paired to owner/, 'accept confirms');
  const runtime = JSON.parse(fs.readFileSync(path.join(devNew, '.stratos-profile', 'runtime-state.json'), 'utf8'));
  assert.ok(runtime.pairedOwner?.owner_did?.startsWith('did:atmos:'), 'owner PINNED in its own slot on the new device');

  // once pinned, a re-accept needs no fingerprint (the pin is the authority)
  const rAcc2 = run(devNew, { STRATOS_NODE_KEYS: newKeys }, ['pair', 'accept', grantFile]);
  assert.strictEqual(rAcc2.status, 0, 'pinned re-accept works without fingerprint');

  // REPLAY: the same grant on a THIRD device (different node keys) is refused
  const devThird = path.join(TMP, 'cli-third'); fs.mkdirSync(devThird, { recursive: true });
  const thirdNode = generateHybridKeyPair();
  const thirdKeys = path.join(devThird, 'node-keys.json');
  fs.writeFileSync(thirdKeys, JSON.stringify({ publicKey: e(thirdNode.publicKey), privateKey: e(thirdNode.privateKey) }));
  const rReplay = run(devThird, { STRATOS_NODE_KEYS: thirdKeys }, ['pair', 'accept', grantFile, '--owner-fingerprint', ownerFp]);
  assert.strictEqual(rReplay.status, 1, 'grant replay to a different node refused');
  assert.match(rReplay.stdout + rReplay.stderr, /different node/, 'replay refusal names the reason');

  // a tampered grant is refused on accept
  const bad = JSON.parse(fs.readFileSync(grantFile, 'utf8')); bad.granted_at += 1;
  const badFile = path.join(TMP, 'grant-bad.json'); fs.writeFileSync(badFile, JSON.stringify(bad));
  const rBad = run(devNew, { STRATOS_NODE_KEYS: newKeys }, ['pair', 'accept', badFile]);
  assert.strictEqual(rBad.status, 1, 'tampered grant refused');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ ${pass}/${pass} owner-pairing tests passed — explicit ceremony, fail-closed, owner pinned.`);
