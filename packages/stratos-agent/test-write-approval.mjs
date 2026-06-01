/**
 * write-approval tests: deny-by-default, nonce-bound, single-use, TTL, tamper-evident.
 * The model can PROPOSE but never self-approve; an approved yes executes exactly one matching write.
 */
import assert from 'node:assert';
const W = await import('./src/connectors/write-approval.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const WRITE = { connector: 'gmail', account: 'me', action: 'send', args: { to: 'a@b.com', subject: 'hi' } };

console.log('=== deny by default + model never sees the nonce ===');
W._reset();
const prop = W.proposeWrite(WRITE);
ok(prop.requiresApproval === true && !('nonce' in prop), 'proposal is returned to the model WITHOUT a nonce');
ok(W.consumeApproval({ id: prop.id, ...WRITE }).ok === false, 'an un-approved write cannot execute (deny by default)');

console.log('\n=== nonce-bound approval (the model can\'t self-approve) ===');
ok(W.approve(prop.id, 'guessed-wrong-nonce').ok === false, 'approve with a wrong nonce → rejected');
const chal = W.approvalChallenge(prop.id); // owner channel obtains the nonce out-of-band
ok(typeof chal.nonce === 'string' && chal.nonce.length === 32, 'owner challenge yields the real nonce');
ok(W.approve(prop.id, chal.nonce).ok === true, 'approve with the correct nonce → ok');

console.log('\n=== single-use: one yes = one matching write ===');
ok(W.consumeApproval({ id: prop.id, ...WRITE }).ok === true, 'the approved write executes once');
ok(W.consumeApproval({ id: prop.id, ...WRITE }).ok === false, 'the SAME approval cannot be replayed (single-use)');

console.log('\n=== tamper-evident: args changed after approval fail closed ===');
W._reset();
const p2 = W.proposeWrite(WRITE);
W.approve(p2.id, W.approvalChallenge(p2.id).nonce);
const tampered = W.consumeApproval({ id: p2.id, connector: 'gmail', account: 'me', action: 'send', args: { to: 'attacker@evil.com', subject: 'hi' } });
ok(tampered.ok === false && tampered.reason === 'action changed after approval', 'changing the recipient after approval → rejected');

console.log('\n=== TTL: a stale approval does not execute ===');
W._reset();
const p3 = W.proposeWrite({ ...WRITE, ttlMs: 1 });
W.approve(p3.id, W.approvalChallenge(p3.id).nonce);
await new Promise((r) => setTimeout(r, 5));
ok(W.consumeApproval({ id: p3.id, ...WRITE }).ok === false, 'an expired approval is not executable');

console.log('\n=== deny + unknown ===');
W._reset();
const p4 = W.proposeWrite(WRITE);
ok(W.deny(p4.id) === true && W.approve(p4.id, W.approvalChallenge(p4.id)?.nonce || 'x').ok === false, 'a denied proposal cannot later be approved');
ok(W.consumeApproval({ id: 'deadbeef', ...WRITE }).ok === false, 'unknown id → not executable');

console.log(`\n✅ ALL ${pass} write-approval checks passed.`);
