/**
 * ACP alpha tests: REAL hybrid-signed envelopes, per-peer capability grants (deny-by-default),
 * freshness-window + single-use-nonce replay protection, no ambient authority. Proves the scaffold's
 * "intentSig exists → trusted" bypass is gone AND that a captured envelope can't be replayed — including
 * against a freshly-restarted node.
 */
import assert from 'node:assert';
import { createAcpNode } from './src/omni-gateway/acp-core.js';
import { generateHybridKeyPair } from '../stratos-agent/src/security/quantum-crypto.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

const NOW = 1_700_000_000_000;
const WINDOW = 300_000; // matches the node's default maxClockSkewMs
const aKp = generateHybridKeyPair(); const bKp = generateHybridKeyPair(); const mKp = generateHybridKeyPair();
const A = createAcpNode({ keyPair: aKp, name: 'A' });
const B = createAcpNode({ keyPair: bKp, name: 'B' });
const M = createAcpNode({ keyPair: mKp, name: 'Mallory' });
B.registerPeer(A.publicBundle, ['summarize']); // B pins A, grants ONLY 'summarize'. B never registers Mallory.

let handled = null;
const handler = (t) => { handled = t; return { done: true }; };
const recv = (node, env, now = NOW) => node.receiveTask(env, handler, { now });

console.log('=== a properly signed, granted, fresh task is accepted ===');
const env = A.createEnvelope({ toDid: B.did, action: 'summarize', payload: { text: 'hi' }, ts: NOW });
const r = recv(B, env);
ok(r.ok === true && r.result.done === true, 'A→B summarize: signed + granted + fresh → accepted + handler ran');
ok(handled && handled.sender === A.did && handled.payload.text === 'hi', 'handler received the verified sender + payload');

console.log('\n=== the scaffold bypass is dead: forgery/tamper are rejected ===');
ok(recv(B, { ...env, payload: { text: 'rm -rf /' }, nonce: 'n2' }).ok === false, 'editing the payload after signing → rejected (real signature check, not existence)');
const forgedSig = { ...A.createEnvelope({ toDid: B.did, action: 'summarize', payload: { text: 'hi' }, ts: NOW, nonce: 'n3' }), sig: M.createEnvelope({ toDid: B.did, action: 'summarize', payload: { text: 'hi' }, ts: NOW, nonce: 'n3' }).sig };
ok(recv(B, forgedSig).ok === false, "Mallory's signature on an A-labelled envelope → rejected");
ok(recv(B, { sender: A.did, recipient: B.did, action: 'summarize', payload: {}, ts: NOW, nonce: 'x', sig: { ed25519Sig: 'AA', mldsaSig: 'AA' } }).ok === false, 'a hand-crafted envelope with a junk sig → rejected');

console.log('\n=== authorization: deny-by-default, no ambient authority ===');
ok(recv(B, A.createEnvelope({ toDid: B.did, action: 'delete_all', payload: {}, ts: NOW })).ok === false, "an action B never granted to A ('delete_all') → rejected");
ok(recv(B, M.createEnvelope({ toDid: B.did, action: 'summarize', payload: {}, ts: NOW })).ok === false, 'a validly-signed task from an UNREGISTERED peer → rejected');

console.log('\n=== addressing ===');
ok(recv(B, A.createEnvelope({ toDid: M.did, action: 'summarize', payload: {}, ts: NOW })).ok === false, 'an envelope addressed to someone else → rejected');

console.log('\n=== replay protection: nonce + freshness window ===');
const once = A.createEnvelope({ toDid: B.did, action: 'summarize', payload: { text: 'x' }, ts: NOW, nonce: 'replay-me' });
ok(recv(B, once).ok === true, 'first delivery of a nonce → accepted');
ok(recv(B, once).ok === false, 'the SAME envelope replayed → rejected (single-use nonce)');
ok(recv(B, A.createEnvelope({ toDid: B.did, action: 'summarize', payload: {}, ts: NOW - WINDOW - 1 })).ok === false, 'a STALE envelope (ts older than the window) → rejected');
ok(recv(B, A.createEnvelope({ toDid: B.did, action: 'summarize', payload: {}, ts: NOW + WINDOW + 1 })).ok === false, 'a FUTURE-dated envelope → rejected');

console.log('\n=== restart-replay regression: a captured envelope fails against a freshly-built node ===');
const captured = A.createEnvelope({ toDid: B.did, action: 'summarize', payload: { text: 'capture' }, ts: NOW, nonce: 'captured-1' });
const B2 = createAcpNode({ keyPair: bKp, name: 'B-restarted' }); // same identity, empty nonce memory
B2.registerPeer(A.publicBundle, ['summarize']);
ok(B2.receiveTask(captured, handler, { now: NOW + WINDOW + 1 }).ok === false, 'replaying the captured envelope after the window against a fresh node → rejected (ts freshness defends restart)');

console.log('\n=== revocation ===');
const C = createAcpNode({ keyPair: generateHybridKeyPair(), name: 'C' });
const cDid = B.registerPeer(C.publicBundle, ['summarize']);
ok(recv(B, C.createEnvelope({ toDid: B.did, action: 'summarize', payload: {}, ts: NOW })).ok === true, 'C granted → accepted');
B.revokePeer(cDid);
ok(recv(B, C.createEnvelope({ toDid: B.did, action: 'summarize', payload: {}, ts: NOW })).ok === false, 'after revoke → rejected');

console.log(`\n✅ ALL ${pass} ACP-alpha checks passed.`);
