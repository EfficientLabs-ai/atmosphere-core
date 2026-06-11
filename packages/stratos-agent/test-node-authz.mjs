// test-node-authz.mjs — GATE 2b: mesh-side command authorization + revocation.
//
// Hermetic: in-process hybrid keypairs, pure verification (no daemon/network). Proves the
// enforcement matrix is FAIL-CLOSED:
//   authorized  → the pinned owner; a paired node.
//   DENIED      → unknown sender · revoked sender · tampered body · wrong signer · stale ts ·
//                 replayed nonce · sender_did not matching its pinned key.
//   revocation  → owner-signed, peer-verifiable; a foreign owner cannot revoke; tamper fails.
//   END-TO-END  → real CLI: owner revokes a node → authz of that node's command now DENIED.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateHybridKeyPair, signPayload } from './src/security/quantum-crypto.js';
import { originId } from './src/memory/skill-seal.js';
import { buildTrustSet, authorizeMeshCommand, commandBody } from './src/identity/node-authz.js';
import { createRevocation, verifyRevocation, fingerprint } from './src/identity/owner-identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };

console.log('node-authz — Gate 2b mesh authorization + revocation, fail-closed\n');

const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
const encSig = (s) => ({ ed25519Sig: s.ed25519Sig.toString('base64'), mldsaSig: s.mldsaSig.toString('base64') });

const owner = generateHybridKeyPair();
const nodeA = generateHybridKeyPair(); // a paired node
const stranger = generateHybridKeyPair();
const ownerDid = originId(owner.publicKey);
const nodeADid = originId(nodeA.publicKey);

const state = {
  pairedOwner: { owner_did: ownerDid, owner_public_key: enc(owner.publicKey) },
  pairedNodes: [{ node_did: nodeADid, node_public_key: enc(nodeA.publicKey) }],
  revokedNodes: [],
};

// Mint a signed command envelope as `signer` claiming `senderDid`.
function envelope(signer, senderDid, { action = 'route', params = { x: 1 }, ts = 1000, nonce = 'n1' } = {}) {
  const e = { action, params, sender_did: senderDid, ts, nonce };
  e.sig = encSig(signPayload(commandBody(e), signer.privateKey));
  return e;
}
const NOW = () => 1000; // deterministic clock at ts

ok('authorized: a paired node and the owner', () => {
  const trust = buildTrustSet(state);
  assert.strictEqual(authorizeMeshCommand(envelope(nodeA, nodeADid), trust, { now: NOW }).ok, true);
  const o = authorizeMeshCommand(envelope(owner, ownerDid), trust, { now: NOW });
  assert.strictEqual(o.ok, true); assert.strictEqual(o.role, 'owner');
});

ok('DENIED: unknown sender (no TOFU on commands)', () => {
  const trust = buildTrustSet(state);
  const v = authorizeMeshCommand(envelope(stranger, originId(stranger.publicKey)), trust, { now: NOW });
  assert.strictEqual(v.ok, false); assert.match(v.reason, /not a paired node or the owner/);
});

ok('DENIED: impersonation — stranger signs but claims a paired did', () => {
  const trust = buildTrustSet(state);
  // stranger signs an envelope claiming to be nodeA → signature checked against nodeA's PINNED key → fails.
  const e = envelope(stranger, nodeADid);
  const v = authorizeMeshCommand(e, trust, { now: NOW });
  assert.strictEqual(v.ok, false); assert.match(v.reason, /signature failed/);
});

ok('DENIED: tampered body after signing', () => {
  const trust = buildTrustSet(state);
  const e = envelope(nodeA, nodeADid);
  e.params = { x: 999 }; // change after signing
  assert.strictEqual(authorizeMeshCommand(e, trust, { now: NOW }).ok, false);
});

ok('DENIED: stale envelope outside the freshness window', () => {
  const trust = buildTrustSet(state);
  const e = envelope(nodeA, nodeADid, { ts: 1000 });
  const v = authorizeMeshCommand(e, trust, { now: () => 1000 + 5 * 60_000 }); // 5 min later
  assert.strictEqual(v.ok, false); assert.match(v.reason, /freshness window/);
});

ok('DENIED: replayed nonce', () => {
  const trust = buildTrustSet(state);
  const seen = new Set();
  const e = envelope(nodeA, nodeADid, { nonce: 'dup' });
  assert.strictEqual(authorizeMeshCommand(e, trust, { now: NOW, seenNonces: seen }).ok, true);
  assert.strictEqual(authorizeMeshCommand(e, trust, { now: NOW, seenNonces: seen }).ok, false, 'second use denied');
});

ok('DENIED: revoked sender (even with a perfect signature)', () => {
  const trust = buildTrustSet({ ...state, revokedNodes: [nodeADid] });
  const v = authorizeMeshCommand(envelope(nodeA, nodeADid), trust, { now: NOW });
  assert.strictEqual(v.ok, false); assert.match(v.reason, /REVOKED/);
});

ok('revocation: owner-signed, peer-verifiable; foreign owner + tamper fail closed', () => {
  const rev = createRevocation({ ownerKeys: owner, nodeDid: nodeADid, now: () => 2000 });
  assert.strictEqual(verifyRevocation(rev).ok, true);
  const pin = { owner_public_key: enc(owner.publicKey) }; // not used directly; pass the bundle
  const pinned = enc(owner.publicKey);
  assert.strictEqual(verifyRevocation(rev, { pinnedOwnerPublicKey: pinned }).ok, true);
  // a foreign owner revoking, then claiming the real owner's did → fails (did/key mismatch).
  const mal = generateHybridKeyPair();
  const malRev = createRevocation({ ownerKeys: mal, nodeDid: nodeADid, now: () => 2000 });
  malRev.owner_did = ownerDid;
  assert.strictEqual(verifyRevocation(malRev).ok, false);
  // pinned-owner mode rejects a different (internally valid) owner's revocation.
  const malRev2 = createRevocation({ ownerKeys: mal, nodeDid: nodeADid, now: () => 2000 });
  assert.strictEqual(verifyRevocation(malRev2, { pinnedOwnerPublicKey: pinned }).ok, false);
  // tamper the revoked did.
  const t = JSON.parse(JSON.stringify(rev)); t.node_did = 'did:atmos:' + 'f'.repeat(40);
  assert.strictEqual(verifyRevocation(t).ok, false);
  void pin;
});

ok('END-TO-END via the real CLI: owner revoke → that node\'s command is DENIED by authz', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2b-'));
  const dev = path.join(TMP, 'dev'); fs.mkdirSync(dev, { recursive: true });
  const profile = path.join(dev, '.stratos-profile'); fs.mkdirSync(profile, { recursive: true });
  // seed runtime state: this device pairs the owner + nodeA (as if pairing already happened).
  fs.writeFileSync(path.join(profile, 'runtime-state.json'), JSON.stringify({
    pairedOwner: state.pairedOwner, pairedNodes: state.pairedNodes,
  }));
  // owner keys on disk so `pair revoke` can sign with the same owner identity.
  fs.writeFileSync(path.join(profile, 'owner-keys.json'), JSON.stringify({ publicKey: enc(owner.publicKey), privateKey: enc(owner.privateKey) }), { mode: 0o600 });
  const bin = path.join(HERE, 'bin', 'stratos.js');
  const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: dev, env: { ...process.env, STRATOS_PROFILE_DIR: profile }, encoding: 'utf8', timeout: 60000 });

  // a fresh, well-formed command from nodeA — authorized BEFORE revocation.
  const e = envelope(nodeA, nodeADid, { ts: Date.now(), nonce: 'live1' });
  const envFile = path.join(TMP, 'env.json'); fs.writeFileSync(envFile, JSON.stringify(e));
  assert.strictEqual(run(['pair', 'authz', envFile]).status, 0, 'authorized before revoke');

  // owner revokes nodeA.
  const rRev = run(['pair', 'revoke', nodeADid]);
  assert.strictEqual(rRev.status, 0, rRev.stderr);

  // same command now DENIED (revoked). Use a fresh ts/nonce so only revocation is the cause.
  const e2 = envelope(nodeA, nodeADid, { ts: Date.now(), nonce: 'live2' });
  const env2 = path.join(TMP, 'env2.json'); fs.writeFileSync(env2, JSON.stringify(e2));
  const rAuthz = run(['pair', 'authz', env2]);
  assert.strictEqual(rAuthz.status, 1, 'denied after revoke');
  assert.match(rAuthz.stdout + rAuthz.stderr, /REVOKED/);

  // list shows it REVOKED.
  assert.match(run(['pair', 'list']).stdout, /REVOKED/);
  fs.rmSync(TMP, { recursive: true, force: true });
  void fingerprint;
});

console.log(`\n✅ ${pass}/${pass} node-authz tests passed — deny-by-default mesh authorization, revocation enforced.`);
