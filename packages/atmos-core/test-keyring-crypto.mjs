/**
 * KeyringManager real-crypto tests. The headline assertion: the OLD bypass — verify() accepting any
 * 32-byte signature with any 32-byte public key — is GONE. Verification is now real Ed25519.
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import b4a from 'b4a';
import { KeyringManager } from './keyring.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

const k = new KeyringManager('consumer');
await k.init('seed-alice');

console.log('=== real Ed25519 keypair shape ===');
ok(k.keypair.publicKey.length === 32, 'public key is a raw 32-byte Ed25519 key');
const sig = k.sign('hello world');
ok(sig.length === 64, 'signature is a 64-byte Ed25519 detached signature');

console.log('\n=== genuine verify (valid passes, tamper fails) ===');
ok(k.verify('hello world', sig, k.keypair.publicKey) === true, 'valid signature verifies');
ok(k.verify('hello w0rld', sig, k.keypair.publicKey) === false, 'tampered MESSAGE → rejected');
const badSig = b4a.from(sig); badSig[0] ^= 0xff;
ok(k.verify('hello world', badSig, k.keypair.publicKey) === false, 'tampered SIGNATURE → rejected');

console.log('\n=== THE OLD BYPASS IS DEAD ===');
const forgedSig = crypto.randomBytes(64);
const forgedPub = crypto.randomBytes(32);
ok(k.verify('hello world', forgedSig, k.keypair.publicKey) === false, 'random 64-byte sig against real key → rejected');
ok(k.verify('hello world', crypto.randomBytes(32), k.keypair.publicKey) === false, 'random 32-byte sig (old-bypass shape) → rejected');
ok(k.verify('hello world', forgedSig, forgedPub) === false, 'forged sig + forged 32-byte pubkey (the exact old bypass) → rejected');

console.log('\n=== wrong-signer is rejected (no cross-key forgery) ===');
const m = new KeyringManager('maximus'); await m.init('seed-mallory');
ok(m.keypair.publicKey.length === 32 && m.keypair.isHSMBacked === true, 'maximus node: real 32-byte key, HSM-flagged');
ok(k.verify('hello world', m.sign('hello world'), k.keypair.publicKey) === false, "Mallory's signature does NOT verify under Alice's key");
ok(m.verify('hello world', m.sign('hello world'), m.keypair.publicKey) === true, "Mallory's own signature verifies under her own key");

console.log('\n=== determinism (seed → same identity) ===');
const k2 = new KeyringManager('consumer'); await k2.init('seed-alice');
ok(b4a.toString(k2.keypair.publicKey, 'hex') === b4a.toString(k.keypair.publicKey, 'hex'), 'same seed → same public key');
ok(k.verify('cross', k2.sign('cross'), k.keypair.publicKey) === true, 'signature from the deterministic twin verifies under the original key');

console.log('\n=== fail-closed on malformed input ===');
ok(k.verify('x', null, k.keypair.publicKey) === false, 'null signature → false');
ok(k.verify('x', sig, null) === false, 'null public key → false');
ok(k.verify('x', sig, b4a.from([1, 2, 3])) === false, 'malformed (3-byte) public key → false, no throw');

console.log(`\n✅ ALL ${pass} keyring-crypto checks passed.`);
