/**
 * test-account-link.mjs — the round-trip oracle for the node→account ownership proof.
 * Proves the prover and the verifier are exact inverses, and that EVERY failure mode is fail-closed:
 * tamper, wrong account, wrong/replayed challenge, stale/future, DID↔key mismatch, forged key, and
 * the verifier's mandatory bindings (it refuses without expectedAccountId/expectedChallenge).
 * Run: node test-account-link.mjs
 */
import assert from 'node:assert';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { createNodeAccountProof, verifyNodeAccountProof } from './src/identity/account-link.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

const node = generateHybridKeyPair();
const stranger = generateHybridKeyPair();
const ACCT = 'acct_abc123';
const CHALLENGE = 'a'.repeat(64); // a nonce the account issued
const baseVerify = { expectedAccountId: ACCT, expectedChallenge: CHALLENGE };

console.log('account-link — node→account ownership proof\n');

// 1. HAPPY PATH — real proof verifies; carries node identity.
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  const r = verifyNodeAccountProof(proof, baseVerify);
  ok(r.ok === true, `valid proof → ok (reason: ${r.reason || 'none'})`);
  ok(r.accountId === ACCT, 'account_id carried through');
  ok(/^did:atmos:[0-9a-f]{40}$/.test(r.nodeDid), 'node_did is a valid did:atmos');
  ok(typeof r.nodeFingerprint === 'string' && r.nodeFingerprint.includes('-'), 'node fingerprint returned');
}

// 2. TAMPER — flip each signed field after signing → fail-closed.
for (const field of ['account_id', 'challenge', 'node_did', 'issued_at']) {
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  proof[field] = field === 'issued_at' ? proof.issued_at + 1 : 'tampered-' + field;
  // realign the verify expectations to the tampered values where they'd otherwise pre-empt the sig check
  const opts = { ...baseVerify };
  if (field === 'account_id') opts.expectedAccountId = proof.account_id;
  if (field === 'challenge') opts.expectedChallenge = proof.challenge;
  ok(verifyNodeAccountProof(proof, opts).ok === false, `tampered ${field} → fail-closed`);
}

// 3. ACCOUNT binding — proof for ACCT must not verify for a different account.
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  ok(verifyNodeAccountProof(proof, { ...baseVerify, expectedAccountId: 'acct_other' }).ok === false, 'cross-account replay refused (account_id mismatch)');
}

// 4. CHALLENGE binding — proof carrying a different challenge than issued → fail.
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: 'b'.repeat(64) });
  ok(verifyNodeAccountProof(proof, baseVerify).ok === false, 'wrong challenge → fail');
}

// 5. SINGLE-USE — a consumed challenge is refused on replay.
{
  const seen = new Set();
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  ok(verifyNodeAccountProof(proof, { ...baseVerify, seenChallenges: seen }).ok === true, 'first use → ok');
  ok(verifyNodeAccountProof(proof, { ...baseVerify, seenChallenges: seen }).ok === false, 'replayed challenge → refused (single-use)');
}

// 6. FRESHNESS — stale and future-dated proofs are refused.
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE, now: () => 1_000_000 });
  ok(verifyNodeAccountProof(proof, { ...baseVerify, now: () => 1_000_000 + 5 * 60_000 }).ok === false, 'stale (> skew) → fail');
  ok(verifyNodeAccountProof(proof, { ...baseVerify, now: () => 1_000_000 - 5 * 60_000 }).ok === false, 'future-dated (> skew) → fail');
  ok(verifyNodeAccountProof(proof, { ...baseVerify, now: () => 1_000_000 + 30_000 }).ok === true, 'within skew → ok');
}

// 7. DID↔KEY binding — swap in a stranger's public bundle (keeping the claimed did) → fail.
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  const strangerProof = createNodeAccountProof({ nodeKeys: stranger, accountId: ACCT, challenge: CHALLENGE });
  proof.node_public_key = strangerProof.node_public_key; // node_did still claims `node`, key is stranger's
  ok(verifyNodeAccountProof(proof, baseVerify).ok === false, 'embedded key not matching node_did → fail');
}

// 8. FORGED — signed by a stranger but claiming to be `node` → fail (sig won't verify vs the claimed did's key).
{
  const proof = createNodeAccountProof({ nodeKeys: stranger, accountId: ACCT, challenge: CHALLENGE });
  proof.node_did = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE }).node_did;
  ok(verifyNodeAccountProof(proof, baseVerify).ok === false, 'forged node_did with stranger key → fail');
}

// 9. MANDATORY BINDINGS — the verifier refuses if the account does not state what it issued.
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  ok(verifyNodeAccountProof(proof, { expectedChallenge: CHALLENGE }).ok === false, 'no expectedAccountId → refused');
  ok(verifyNodeAccountProof(proof, { expectedAccountId: ACCT }).ok === false, 'no expectedChallenge → refused');
  ok(verifyNodeAccountProof(null, baseVerify).ok === false, 'null proof → refused (no throw)');
  ok(verifyNodeAccountProof({ kind: 'wrong' }, baseVerify).ok === false, 'wrong kind → refused');
}

// 10. PROVER INPUT VALIDATION — bad inputs throw at provision time (not a silent bad proof).
{
  const bad = [
    [{ nodeKeys: node, accountId: '', challenge: CHALLENGE }, 'empty account_id'],
    [{ nodeKeys: node, accountId: ACCT, challenge: '' }, 'empty challenge'],
    [{ nodeKeys: node, accountId: 'x'.repeat(300), challenge: CHALLENGE }, 'oversized account_id'],
    [{ nodeKeys: null, accountId: ACCT, challenge: CHALLENGE }, 'missing node keypair'],
  ];
  for (const [args, label] of bad) {
    let threw = false;
    try { createNodeAccountProof(args); } catch { threw = true; }
    ok(threw, `prover rejects ${label}`);
  }
}

// 11. NULL OPTIONS (dual-Codex round 1 fix) — must return {ok:false}, never throw.
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  let threw = false, r;
  try { r = verifyNodeAccountProof(proof, null); } catch { threw = true; }
  ok(!threw && r && r.ok === false, 'verify(proof, null) → {ok:false}, no throw');
  try { r = verifyNodeAccountProof(proof); } catch { threw = true; }
  ok(!threw && r && r.ok === false, 'verify(proof) with no opts → {ok:false}, no throw');
}

// 12. EXOTIC issued_at (dual-Codex round 1 fix) — a coercion object that LOOKS fresh to Number() but
//     is not a primitive must be rejected (it would otherwise diverge from the signed bytes).
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  proof.issued_at = { valueOf: () => Date.now() }; // fresh under Number(), not a primitive
  ok(verifyNodeAccountProof(proof, baseVerify).ok === false, 'non-primitive issued_at → fail (no check/body divergence)');
}

// 13. EXOTIC node_public_key (dual-Codex round 1 fix) — a non-string leaf (e.g. a nested toJSON
//     object) must be rejected; the snapshot only accepts base64-string leaves.
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  proof.node_public_key = { ...proof.node_public_key, evil: { toJSON: () => 'x' } };
  ok(verifyNodeAccountProof(proof, baseVerify).ok === false, 'node_public_key with a non-string leaf → fail');
}

// 14. REPLAY-KEY INJECTIVITY (dual-Codex round 1 fix) — ('a:b','c') and ('a','b:c') must NOT collide;
//     consuming one must not burn the other.
{
  const seen = new Set();
  const p1 = createNodeAccountProof({ nodeKeys: node, accountId: 'a:b', challenge: 'c' });
  const p2 = createNodeAccountProof({ nodeKeys: node, accountId: 'a', challenge: 'b:c' });
  const r1 = verifyNodeAccountProof(p1, { expectedAccountId: 'a:b', expectedChallenge: 'c', seenChallenges: seen });
  const r2 = verifyNodeAccountProof(p2, { expectedAccountId: 'a', expectedChallenge: 'b:c', seenChallenges: seen });
  ok(r1.ok === true && r2.ok === true, "('a:b','c') and ('a','b:c') do not collide in the replay cache");
}

// 15. __proto__ KEY in node_public_key (dual-Codex round 2 fix) — a crafted own `__proto__` key must
//     be handled faithfully (null-proto snapshot) and never pollute Object.prototype; fail-closed.
{
  const proof = createNodeAccountProof({ nodeKeys: node, accountId: ACCT, challenge: CHALLENGE });
  proof.node_public_key = JSON.parse('{"__proto__":"QUFBQQ==","ed25519Der":"x","mldsaDer":"y"}'); // own __proto__
  let threw = false, r;
  try { r = verifyNodeAccountProof(proof, baseVerify); } catch { threw = true; }
  ok(!threw && r && r.ok === false, '__proto__ in node_public_key → fail-closed, no throw');
  ok(({}).ed25519Der === undefined && Object.prototype.ed25519Der === undefined, 'no prototype pollution from the snapshot');
}

console.log(`\n${fail ? '✖' : '✓'} account-link: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
