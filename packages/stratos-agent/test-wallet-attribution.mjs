// test-wallet-attribution.mjs — WALLET-AWARE mesh attribution: "measurement before rewards".
//
// Hermetic: pure crypto/logic/regex — no network, no Ollama, no daemon, no on-disk keys beyond a temp
// keypair generated in-process. Proves a node's compute can be attributed to its OWNER'S Solana wallet:
//   - Solana address validation accepts valid base58 (32-44, no 0/O/I/l) and rejects everything else.
//   - The node-runner + private ghost wallet-resolution contract (flag > config; absent → unattributed;
//     invalid → refuse) — exercised against the same regex both runtimes embed.
//   - A CapabilityReceipt carries owner_wallet IN the SIGNED, hash-chained body: it still signs +
//     verifies, and tampering the wallet is caught fail-closed (hash AND signature).
//   - summarize() aggregates measured cost_units per owner_wallet, with NO price/payout/reward field.
//   - Two nodes with two wallets attribute SEPARATELY; a node with no wallet sums under (unattributed).
//
// Address-only, no keys, no payouts — this is the attribution BASIS, deferred rewards read it later.
import assert from 'node:assert';
import crypto from 'node:crypto';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { originId } from './src/memory/skill-seal.js';
import {
  ReceiptLog, createReceipt, hashContent,
  makeReceiptSigner, makeReceiptVerifier,
  isValidSolanaAddress, normalizeWallet,
} from './src/ledger/capability-receipt.js';

let pass = 0, t = 5000;
const _cases = [];
const ok = (name, fn) => { _cases.push([name, fn]); };
const now = () => (t += 1);
let _n = 0; const jti = () => `wrcpt-${++_n}`;

console.log('wallet-aware mesh attribution — measurement before rewards\n');

// Real, well-formed Solana addresses (base58, 32-44 chars). These are PUBLIC addresses only.
const WALLET_A = '7v91N7iZ9mNicL8WfG6cgSCKyRXydQjLh6UYBWwm6y1Q'; // 44 chars
const WALLET_B = 'DRpbCBMxVnDK7maPGv7US4dp8Gah1b6pZTBVgLRoMUct'; // 44 chars

const node = generateHybridKeyPair();
const NODE_ID = originId(node.publicKey);
const ACTOR = 'did:atmos:actor-wallet';

function freshLog(opts = {}) {
  return new ReceiptLog({
    nodeId: NODE_ID, now, jti,
    signer: makeReceiptSigner(node.privateKey),
    verifier: makeReceiptVerifier(node.publicKey),
    ...opts,
  });
}

// ---------------------------------------------------------------------------------------------------
// 1. SOLANA ADDRESS VALIDATION (the shared contract embedded in node-runner, ghost, origin, receipt)
// ---------------------------------------------------------------------------------------------------
ok('valid Solana addresses accepted; malformed/empty/injection rejected', () => {
  assert.strictEqual(isValidSolanaAddress(WALLET_A), true);
  assert.strictEqual(isValidSolanaAddress(WALLET_B), true);
  // too short / too long
  assert.strictEqual(isValidSolanaAddress('abc'), false);
  assert.strictEqual(isValidSolanaAddress('1'.repeat(45)), false);
  // forbidden base58 chars (0, O, I, l)
  assert.strictEqual(isValidSolanaAddress('0' + WALLET_A.slice(1)), false);
  assert.strictEqual(isValidSolanaAddress('O' + WALLET_A.slice(1)), false);
  assert.strictEqual(isValidSolanaAddress('I' + WALLET_A.slice(1)), false);
  assert.strictEqual(isValidSolanaAddress('l' + WALLET_A.slice(1)), false);
  // injection / metachar payloads never pass the base58 alphabet+length gate
  assert.strictEqual(isValidSolanaAddress("'; DROP TABLE nodes;--"), false);
  assert.strictEqual(isValidSolanaAddress('$(rm -rf /)'), false);
  assert.strictEqual(isValidSolanaAddress('addr with spaces 1234567890123'), false);
  assert.strictEqual(isValidSolanaAddress(''), false);
  assert.strictEqual(isValidSolanaAddress(null), false);
  assert.strictEqual(isValidSolanaAddress(12345), false);
});

ok('normalizeWallet: absent → null (graceful), valid → trimmed addr, invalid-present → false', () => {
  assert.strictEqual(normalizeWallet(null), null);
  assert.strictEqual(normalizeWallet(undefined), null);
  assert.strictEqual(normalizeWallet(''), null);
  assert.strictEqual(normalizeWallet('   '), null);
  assert.strictEqual(normalizeWallet('  ' + WALLET_A + '  '), WALLET_A); // trimmed
  assert.strictEqual(normalizeWallet('not-a-wallet'), false);           // present but invalid → caller error
});

// Mirror the EXACT resolution contract both runtimes (mesh-node.mjs + atmos-ghost.mjs) implement:
// flag overrides config; absent → null (join unattributed); present-but-invalid → refuse (throw here).
function resolveWalletContract({ flag, config } = {}) {
  const raw = flag !== undefined ? flag : config;
  if (raw == null || raw === true) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!isValidSolanaAddress(s)) throw new Error('refuse: invalid Solana address');
  return s;
}
ok('runtime wallet resolution: flag > config; absent → unattributed; invalid → refuse', () => {
  assert.strictEqual(resolveWalletContract({ flag: WALLET_A, config: WALLET_B }), WALLET_A); // flag wins
  assert.strictEqual(resolveWalletContract({ config: WALLET_B }), WALLET_B);                 // config fallback
  assert.strictEqual(resolveWalletContract({}), null);                                       // absent → unattributed
  assert.strictEqual(resolveWalletContract({ flag: true }), null);                           // bare --wallet → unattributed
  assert.throws(() => resolveWalletContract({ flag: 'garbage!!' }), /refuse/);               // invalid → refuse
});

// ---------------------------------------------------------------------------------------------------
// 2. RECEIPT carries owner_wallet IN THE SIGNED BODY (sign + verify + tamper-detect)
// ---------------------------------------------------------------------------------------------------
ok('receipt with owner_wallet signs, verifies, and the wallet is in the signed body', () => {
  const log = freshLog();
  const r = log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'mesh_affine',
    owner_wallet: WALLET_A, input_hash: hashContent('in'), output_hash: hashContent('out'), cost_units: 12 });
  assert.strictEqual(r.owner_wallet, WALLET_A, 'wallet recorded on the receipt');
  assert.ok(r.sig && r.sig.ed25519Sig && r.sig.mldsaSig, 'hybrid signature present');
  assert.strictEqual(log.verify({ requireSig: true }).ok, true);
});

ok('absent owner_wallet → null (unattributed), still signs + verifies', () => {
  const log = freshLog();
  const r = log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'm',
    input_hash: hashContent('a'), output_hash: hashContent('b'), cost_units: 3 });
  assert.strictEqual(r.owner_wallet, null);
  assert.strictEqual(log.verify({ requireSig: true }).ok, true);
});

ok('createReceipt REJECTS a present-but-invalid wallet (never fabricated, never dropped)', () => {
  assert.throws(() => createReceipt({ actor_id: ACTOR, node_id: NODE_ID, action: 'inference',
    owner_wallet: 'totally-not-base58!!', cost_units: 1 }), /owner_wallet must be a valid Solana address/);
});

ok('tamper owner_wallet → hash check catches it (fail-closed)', () => {
  const log = freshLog();
  log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'm',
    owner_wallet: WALLET_A, input_hash: hashContent('a'), output_hash: hashContent('b'), cost_units: 5 });
  log.chain[0].owner_wallet = WALLET_B; // attacker reassigns the contribution to a different wallet
  const v = log.verify();
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /tampered/);
});

ok('tamper owner_wallet + recompute self-hash → SIGNATURE catches it (wallet is in the signed body)', () => {
  const log = freshLog();
  log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'm',
    owner_wallet: WALLET_A, input_hash: hashContent('a'), output_hash: hashContent('b'), cost_units: 5 });
  const r = log.chain[0];
  r.owner_wallet = WALLET_B;             // reassign the reward attribution…
  r.hash = recomputeHash(r);             // …and fix the self-hash so only the PQC sig can catch it
  const v = log.verify();
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /signature/);   // proves owner_wallet is covered by the signature
});

// ---------------------------------------------------------------------------------------------------
// 3. summarize() — per-wallet REWARD-ATTRIBUTION view, MEASUREMENT ONLY (no price)
// ---------------------------------------------------------------------------------------------------
ok('summarize aggregates measured cost per owner_wallet — two wallets attribute separately', () => {
  const log = freshLog();
  // wallet A: two jobs (10 + 7 = 17); wallet B: one job (4); no wallet: one job (3, unattributed)
  log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'm', owner_wallet: WALLET_A, input_hash: hashContent('1'), output_hash: hashContent('2'), cost_units: 10 });
  log.append({ actor_id: ACTOR, action: 'inference', ref: 'm', owner_wallet: WALLET_A, input_hash: hashContent('3'), output_hash: hashContent('4'), cost_units: 7 });
  log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'm', owner_wallet: WALLET_B, input_hash: hashContent('5'), output_hash: hashContent('6'), cost_units: 4 });
  log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'm', /* no wallet */ input_hash: hashContent('7'), output_hash: hashContent('8'), cost_units: 3 });

  const s = log.summarize();
  assert.ok(Array.isArray(s.byWallet), 'byWallet view exists');
  const a = s.byWallet.find((w) => w.owner_wallet === WALLET_A);
  const b = s.byWallet.find((w) => w.owner_wallet === WALLET_B);
  const un = s.byWallet.find((w) => w.attributed === false);
  assert.strictEqual(a.cost_units, 17, 'wallet A measured cost = 10+7');
  assert.strictEqual(a.count, 2);
  assert.deepStrictEqual(a.byAction, { 'skill-run': 10, inference: 7 });
  assert.strictEqual(b.cost_units, 4, 'wallet B measured cost = 4 (separate)');
  assert.strictEqual(b.attributed, true);
  assert.strictEqual(un.cost_units, 3, 'unattributed bucket holds the wallet-less job');
  assert.strictEqual(un.owner_wallet, null);
  // sorted by cost desc → wallet A first
  assert.strictEqual(s.byWallet[0].owner_wallet, WALLET_A);

  // HONEST: measurement, not a payout. No price/reward/payout/token anywhere in the wallet view.
  const blob = JSON.stringify(s.byWallet);
  assert.ok(!/\b(price|reward|payout|token|usd|sol|amount|value)\b/i.test(blob), 'no price/payout/token field');
});

ok('byWallet preserves byActor/byNode views unchanged (additive, no regression)', () => {
  const log = freshLog();
  log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'm', owner_wallet: WALLET_A, input_hash: hashContent('1'), output_hash: hashContent('2'), cost_units: 9 });
  const s = log.summarize();
  assert.strictEqual(s.byActor[0].actor_id, ACTOR);
  assert.strictEqual(s.byNode[0].node_id, NODE_ID);
  assert.strictEqual(s.byNode[0].cost_units, 9);
  assert.strictEqual(s.total, 1);
});

// ---- helper: recompute the self-hash exactly as capability-receipt.js does (incl. owner_wallet) ----
function recomputeHash(r) {
  const canonical = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  };
  const body = { receipt_id: r.receipt_id, ts: r.ts, actor_id: r.actor_id, action: r.action, ref: r.ref,
    node_id: r.node_id, owner_wallet: r.owner_wallet ?? null, input_hash: r.input_hash, output_hash: r.output_hash,
    cost_units: r.cost_units, caller_id: r.caller_id ?? null, prev_hash: r.prev_hash };
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

for (const [name, fn] of _cases) { await fn(); console.log(`  ✓ ${name}`); pass++; }
console.log(`\n✅ ${pass}/${pass} wallet-attribution tests passed — address-only, signed, per-wallet measurement, no payouts.`);
