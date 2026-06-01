/**
 * ACP alpha tests: REAL hybrid-signed envelopes, per-peer capability grants (deny-by-default),
 * replay protection, no ambient authority. Proves the scaffold's "intentSig exists → trusted" bypass
 * is gone: forged/tampered/unregistered/ungranted/replayed/misaddressed envelopes are all rejected.
 */
import assert from 'node:assert';
import { createAcpNode } from './src/omni-gateway/acp-core.js';
import { generateHybridKeyPair } from '../stratos-agent/src/security/quantum-crypto.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

const A = createAcpNode({ keyPair: generateHybridKeyPair(), name: 'A' });
const B = createAcpNode({ keyPair: generateHybridKeyPair(), name: 'B' });
const M = createAcpNode({ keyPair: generateHybridKeyPair(), name: 'Mallory' });

// B pins A and grants ONLY 'summarize'. B has never registered Mallory.
B.registerPeer(A.publicBundle, ['summarize']);
let handled = null;
const handler = (t) => { handled = t; return { done: true }; };

console.log('=== a properly signed, granted task is accepted ===');
const env = A.createEnvelope({ toDid: B.did, action: 'summarize', payload: { text: 'hi' }, ts: 1000 });
const r = B.receiveTask(env, handler);
ok(r.ok === true && r.result.done === true, 'A→B summarize: signed + granted → accepted + handler ran');
ok(handled && handled.sender === A.did && handled.payload.text === 'hi', 'handler received the verified sender + payload');

console.log('\n=== the scaffold bypass is dead: forgery/tamper are rejected ===');
const tampered = { ...env, payload: { text: 'rm -rf /' }, nonce: 'n2' };
ok(B.receiveTask(tampered, handler).ok === false, 'editing the payload after signing → rejected (real signature check, not existence)');
const forgedSig = { ...A.createEnvelope({ toDid: B.did, action: 'summarize', payload: { text: 'hi' }, ts: 1000, nonce: 'n3' }), sig: M.createEnvelope({ toDid: B.did, action: 'summarize', payload: { text: 'hi' }, ts: 1000, nonce: 'n3' }).sig };
ok(B.receiveTask(forgedSig, handler).ok === false, "Mallory's signature on an A-labelled envelope → rejected");
ok(B.receiveTask({ sender: A.did, recipient: B.did, action: 'summarize', payload: {}, ts: 1, nonce: 'x', sig: { ed25519Sig: 'AA', mldsaSig: 'AA' } }, handler).ok === false, 'a hand-crafted envelope with a junk sig → rejected');

console.log('\n=== authorization: deny-by-default, no ambient authority ===');
const ungranted = A.createEnvelope({ toDid: B.did, action: 'delete_all', payload: {}, ts: 1001 });
ok(B.receiveTask(ungranted, handler).ok === false, "an action B never granted to A ('delete_all') → rejected");
const fromMallory = M.createEnvelope({ toDid: B.did, action: 'summarize', payload: {}, ts: 1002 });
ok(B.receiveTask(fromMallory, handler).ok === false, 'a validly-signed task from an UNREGISTERED peer → rejected');

console.log('\n=== addressing + replay ===');
const misaddressed = A.createEnvelope({ toDid: M.did, action: 'summarize', payload: {}, ts: 1003 });
ok(B.receiveTask(misaddressed, handler).ok === false, 'an envelope addressed to someone else → rejected');
const once = A.createEnvelope({ toDid: B.did, action: 'summarize', payload: { text: 'x' }, ts: 1004, nonce: 'replay-me' });
ok(B.receiveTask(once, handler).ok === true, 'first delivery of a nonce → accepted');
ok(B.receiveTask(once, handler).ok === false, 'the SAME envelope replayed → rejected (single-use nonce)');

console.log('\n=== revocation ===');
const C = createAcpNode({ keyPair: generateHybridKeyPair(), name: 'C' });
const cDid = B.registerPeer(C.publicBundle, ['summarize']);
ok(B.receiveTask(C.createEnvelope({ toDid: B.did, action: 'summarize', payload: {}, ts: 2000 }), handler).ok === true, 'C granted → accepted');
B.revokePeer(cDid);
ok(B.receiveTask(C.createEnvelope({ toDid: B.did, action: 'summarize', payload: {}, ts: 2001 }), handler).ok === false, 'after revoke → rejected');

console.log(`\n✅ ALL ${pass} ACP-alpha checks passed.`);
