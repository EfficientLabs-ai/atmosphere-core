/**
 * exec-controller identity tests: real hybrid PQC identity (content-addressed), tamper-evident signed
 * job receipts, fail-closed against forged signer / tampered body / wrong spec / cross-controller replay.
 */
import assert from 'node:assert';
import { createExecController, verifyReceipt, specHash } from './src/exec/controller-identity.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const SPEC = { image: 'node:22', cmd: ['npm', 'test'], mounts: ['/work'], net: 'none' };

console.log('=== identity is content-addressed + possession-bound ===');
const a = createExecController();
const b = createExecController();
ok(/^exec:[a-f0-9]{40}$/.test(a.id) && a.id !== b.id, 'each controller has a distinct content-addressed id');
const kp = generateHybridKeyPair();
ok(createExecController(kp).id === createExecController(kp).id, 'the id is a deterministic function of the public bundle (same keys → same id)');

console.log('\n=== a valid receipt verifies under the controller pinned public bundle ===');
const receipt = a.issueReceipt({ jobId: 'job-1', spec: SPEC, status: 'success', ts: 1000 });
ok(verifyReceipt(receipt, a.publicBundle) === true, 'a-signed receipt verifies under a.publicBundle');
ok(verifyReceipt(receipt, a.publicBundle, { expectedSpec: SPEC }) === true, 'receipt confirms the EXACT spec that ran');
ok(receipt.body.specHash === specHash(SPEC), 'receipt commits to the spec hash');

console.log('\n=== fail-closed: tamper / wrong signer / wrong spec ===');
ok(verifyReceipt(receipt, b.publicBundle) === false, "a's receipt does NOT verify under b's bundle (no cross-controller forgery)");
const tamperedBody = { ...receipt, body: { ...receipt.body, status: 'success-but-actually-failed' } };
ok(verifyReceipt(tamperedBody, a.publicBundle) === false, 'tampering the receipt body → rejected (hybrid sig breaks)');
ok(verifyReceipt(receipt, a.publicBundle, { expectedSpec: { ...SPEC, cmd: ['rm', '-rf'] } }) === false, 'a receipt for a different spec → rejected');
// claim a's id but sign with b's keys: id matches a, but the signature is b's → must fail
const forged = { body: { ...receipt.body }, sig: b.issueReceipt({ jobId: 'job-1', spec: SPEC, status: 'success', ts: 1000 }).sig };
ok(verifyReceipt(forged, a.publicBundle) === false, "forging a's body with b's signature → rejected");

console.log('\n=== malformed inputs fail closed ===');
ok(verifyReceipt(null, a.publicBundle) === false, 'null receipt → false');
ok(verifyReceipt(receipt, { ed25519Der: Buffer.alloc(4) }) === false, 'bogus/short public bundle → false');
ok(verifyReceipt({ body: receipt.body, sig: { ed25519Sig: '!!notb64', mldsaSig: 'x' } }, a.publicBundle) === false, 'garbage signature → false');
let threw = false; try { a.issueReceipt({ jobId: 'x', status: 'ok' }); } catch { threw = true; }
ok(threw, 'issuing a receipt without a timestamp throws (no implicit Date.now())');

console.log(`\n✅ ALL ${pass} exec-controller identity checks passed.`);
