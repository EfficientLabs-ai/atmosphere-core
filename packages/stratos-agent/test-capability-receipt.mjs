// test-capability-receipt.mjs — the SIGNED CAPABILITY RECEIPT proof rail.
//
// Hermetic: pure crypto/logic/file — no network, no Ollama, no daemon. Proves the keystone moat:
// a third party holding ONLY the node's PUBLIC key can confirm a receipt's hybrid-PQC signature AND
// detect ANY altered field or any removed/reordered receipt in the chain. Verification is fail-CLOSED.
// Also proves emission is fail-OPEN (a broken signer/log degrades to no-receipt, never throws) and
// that summarize() attributes measured cost per actor/node with NO price field.
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { originId } from './src/memory/skill-seal.js';
import {
  ReceiptLog, createReceipt, hashContent, verifyBundle,
  makeReceiptSigner, makeReceiptVerifier, RECEIPT_ACTIONS,
} from './src/ledger/capability-receipt.js';
import { SkillExecutor } from './src/evolution/skill-executor.js';

let pass = 0, t = 2000;
const _cases = [];
const ok = (name, fn) => { _cases.push([name, fn]); }; // registered now, run sequentially at the end
const now = () => (t += 1);                 // deterministic clock
let _n = 0; const jti = () => `rcpt-${++_n}`; // deterministic receipt ids

console.log('capability receipt — cross-machine, PQC-signed, hash-chained proof rail\n');

// One node identity, reused across tests. The PRIVATE half signs; the PUBLIC half is all a verifier needs.
const node = generateHybridKeyPair();
const NODE_ID = originId(node.publicKey);
const ACTOR = 'did:atmos:actor0001';

function freshLog(opts = {}) {
  return new ReceiptLog({
    nodeId: NODE_ID, now, jti,
    signer: makeReceiptSigner(node.privateKey),
    verifier: makeReceiptVerifier(node.publicKey),
    ...opts,
  });
}
function seed(log, n = 3) {
  for (let i = 0; i < n; i++) {
    log.append({ actor_id: ACTOR, action: i % 2 ? 'skill-run' : 'inference', ref: `m${i}`,
      input_hash: hashContent('in' + i), output_hash: hashContent('out' + i), cost_units: 10 + i });
  }
}

ok('createReceipt validates action, ids, and cost (deny-by-default; cost is measured, not priced)', () => {
  assert.throws(() => createReceipt({ action: 'mint', actor_id: ACTOR, node_id: NODE_ID, cost_units: 1 }), /unknown receipt action/);
  assert.throws(() => createReceipt({ action: 'inference', actor_id: '', node_id: NODE_ID, cost_units: 1 }), /actor_id/);
  assert.throws(() => createReceipt({ action: 'inference', actor_id: ACTOR, node_id: '', cost_units: 1 }), /node_id/);
  assert.throws(() => createReceipt({ action: 'inference', actor_id: ACTOR, node_id: NODE_ID, cost_units: -5 }), /non-negative/);
  assert.deepStrictEqual([...RECEIPT_ACTIONS], ['inference', 'skill-run']);
});

ok('create → sign → verify round-trip (chain + hybrid PQC signature)', () => {
  const log = freshLog();
  seed(log, 3);
  assert.strictEqual(log.length, 3);
  assert.ok(log.entries()[0].sig && log.entries()[0].sig.ed25519Sig && log.entries()[0].sig.mldsaSig, 'hybrid sig present');
  assert.strictEqual(log.entries()[1].prev_hash, log.entries()[0].hash, 'hash-chained');
  const v = log.verify({ requireSig: true });
  assert.strictEqual(v.ok, true);
});

ok('privacy: receipts store HASHES, never content', () => {
  const log = freshLog();
  log.append({ actor_id: ACTOR, action: 'inference', ref: 'm', input_hash: hashContent('SECRET PROMPT'), output_hash: hashContent('SECRET ANSWER'), cost_units: 5 });
  const r = log.entries()[0];
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes('SECRET PROMPT') && !blob.includes('SECRET ANSWER'), 'no plaintext content');
  assert.strictEqual(r.input_hash, hashContent('SECRET PROMPT'));
});

ok('tamper a FIELD → verify fails (fail-closed)', () => {
  const log = freshLog(); seed(log, 3);
  log.chain[1].cost_units = 999999;        // forge a bigger contribution
  const v = log.verify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.brokenAt, 1);
  assert.match(v.reason, /tampered/);
});

ok('tamper a field but recompute its hash → SIGNATURE catches it (fail-closed)', () => {
  const log = freshLog(); seed(log, 3);
  // Sophisticated forgery: edit the field AND fix the self-hash so the hash check passes — only the
  // PQC signature (which the forger cannot produce without the private key) still catches it.
  log.chain[1].cost_units = 1;
  // recompute hash exactly as the module does (canonical body, excluding hash/sig)
  log.chain[1].hash = recomputeHash(log.chain[1], crypto);
  const v = log.verify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.brokenAt, 1);
  assert.match(v.reason, /signature/);
});

ok('remove a receipt → chain link breaks (fail-closed)', () => {
  const log = freshLog(); seed(log, 4);
  log.chain.splice(2, 1);                   // drop the 3rd receipt
  const v = log.verify();
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /chain link|removed|reordered/);
});

ok('reorder receipts → chain link breaks (fail-closed)', () => {
  const log = freshLog(); seed(log, 4);
  [log.chain[1], log.chain[2]] = [log.chain[2], log.chain[1]]; // swap two
  const v = log.verify();
  assert.strictEqual(v.ok, false);
});

ok('export → verifyBundle round-trip with ONLY the public key (third-party acceptance)', () => {
  const log = freshLog(); seed(log, 4);
  const bundle = log.exportBundle({ publicKeyBundle: node.publicKey });
  // A third party reconstructs verification from the bundle alone — no private key, no node access.
  const round = JSON.parse(JSON.stringify(bundle)); // simulate transit over JSON
  const v = verifyBundle(round);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.count, 4);
  assert.strictEqual(v.node_id, NODE_ID);
  // No private material leaked into the bundle; the public key IS present (base64 fields).
  assert.ok(!JSON.stringify(round).includes('privateKey'), 'no private key in bundle');
  assert.ok(typeof round.public_key.ed25519Der === 'string' && round.public_key.ed25519Der.length, 'public key embedded');
});

ok('verifyBundle detects an altered receipt in an exported bundle (fail-closed)', () => {
  const log = freshLog(); seed(log, 3);
  const bundle = JSON.parse(JSON.stringify(log.exportBundle({ publicKeyBundle: node.publicKey })));
  bundle.receipts[1].cost_units = 42;       // tamper post-export
  const v = verifyBundle(bundle);
  assert.strictEqual(v.ok, false);
});

ok('verifyBundle is fail-CLOSED without a public key', () => {
  const log = freshLog(); seed(log, 2);
  const bundle = log.exportBundle({ /* no publicKeyBundle */ });
  const v = verifyBundle(bundle);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /public key/);
});

ok('export --since filters by ts and still verifies as a partial chain', () => {
  const log = freshLog();
  log.append({ actor_id: ACTOR, action: 'inference', ref: 'old', input_hash: hashContent('a'), output_hash: hashContent('b'), cost_units: 1 });
  const cut = now(); now(); // advance the clock past the first receipt
  log.append({ actor_id: ACTOR, action: 'inference', ref: 'new1', input_hash: hashContent('c'), output_hash: hashContent('d'), cost_units: 2 });
  log.append({ actor_id: ACTOR, action: 'inference', ref: 'new2', input_hash: hashContent('e'), output_hash: hashContent('f'), cost_units: 3 });
  const bundle = log.exportBundle({ since: cut, publicKeyBundle: node.publicKey });
  assert.strictEqual(bundle.receipts.length, 2, 'only receipts at/after the cut');
  const v = verifyBundle(bundle);               // partial chain anchors on the first receipt's prev_hash
  assert.strictEqual(v.ok, true);
});

ok('legacy v0 receipts (no owner_wallet key) verify by the body they actually signed — and presence-tamper fails both ways', () => {
  // Reconstruct what the pre-owner_wallet writer persisted: body WITHOUT the field, hash and
  // hybrid signature over that exact body, and NO owner_wallet key on the stored object.
  const canonical = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  };
  const legacyBody = {
    receipt_id: 'legacy-0001', ts: now(), actor_id: ACTOR, action: 'inference', ref: 'old-model',
    node_id: NODE_ID, input_hash: hashContent('in'), output_hash: hashContent('out'),
    cost_units: 7, caller_id: null, prev_hash: '0'.repeat(64),
  };
  const legacy = { ...legacyBody };
  legacy.hash = crypto.createHash('sha256').update(canonical(legacyBody)).digest('hex');
  legacy.sig = makeReceiptSigner(node.privateKey)(canonical(legacyBody));

  // A mixed chain: the legacy receipt, then a current-format receipt chained onto it.
  const log = freshLog();
  log.chain.push(legacy);
  log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'new-skill', input_hash: hashContent('i2'), output_hash: hashContent('o2'), cost_units: 3 });
  const bundle = log.exportBundle({ publicKeyBundle: node.publicKey });
  assert.strictEqual(verifyBundle(bundle).ok, true, 'mixed legacy+current chain verifies');

  // Presence tamper A: ADD owner_wallet to the legacy receipt → hash AND signature break.
  const tA = JSON.parse(JSON.stringify(bundle));
  tA.receipts[0].owner_wallet = null;
  const vA = verifyBundle(tA);
  assert.strictEqual(vA.ok, false);
  assert.strictEqual(vA.brokenAt, 0);

  // Presence tamper B: STRIP owner_wallet from the current receipt → same fail-closed result.
  const tB = JSON.parse(JSON.stringify(bundle));
  delete tB.receipts[1].owner_wallet;
  const vB = verifyBundle(tB);
  assert.strictEqual(vB.ok, false);
  assert.strictEqual(vB.brokenAt, 1);
});

ok('a DIFFERENT node\'s public key cannot verify these receipts (wrong signer rejected)', () => {
  const log = freshLog(); seed(log, 2);
  const other = generateHybridKeyPair();
  const bundle = JSON.parse(JSON.stringify(log.exportBundle({ publicKeyBundle: node.publicKey })));
  // Swap in a foreign public key — signatures must now fail.
  const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  bundle.public_key = enc(other.publicKey);
  const v = verifyBundle(bundle);
  assert.strictEqual(v.ok, false);
});

ok('summarize attributes measured cost per actor AND per node — no price field', () => {
  const log = freshLog();
  const A2 = 'did:atmos:actor0002';
  log.append({ actor_id: ACTOR, action: 'inference', ref: 'm', input_hash: hashContent('1'), output_hash: hashContent('2'), cost_units: 100 });
  log.append({ actor_id: ACTOR, action: 'skill-run', ref: 's', input_hash: hashContent('3'), output_hash: hashContent('4'), cost_units: 5 });
  log.append({ actor_id: A2, action: 'inference', ref: 'm', input_hash: hashContent('5'), output_hash: hashContent('6'), cost_units: 30 });
  const s = log.summarize();
  assert.strictEqual(s.byActor[0].actor_id, ACTOR);
  assert.strictEqual(s.byActor[0].cost_units, 105);
  assert.deepStrictEqual(s.byActor[0].byAction, { inference: 100, 'skill-run': 5 });
  assert.strictEqual(s.byActor.find((x) => x.actor_id === A2).cost_units, 30);
  // all three receipts ran on THIS node:
  assert.strictEqual(s.byNode.length, 1);
  assert.strictEqual(s.byNode[0].node_id, NODE_ID);
  assert.strictEqual(s.byNode[0].cost_units, 135);
  // honest: measurement, not a payout — no value/reward/price anywhere.
  const blob = JSON.stringify(s);
  assert.ok(!/\b(price|reward|payout|value)\b/.test(blob), 'no price/reward field');
});

ok('persistence round-trips and stays verifiable from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
  const file = path.join(dir, 'receipts.jsonl');
  const L1 = freshLog({ path: file });
  seed(L1, 3);
  const L2 = new ReceiptLog({ path: file, verifier: makeReceiptVerifier(node.publicKey) });
  assert.strictEqual(L2.length, 3);
  assert.strictEqual(L2.verify({ requireSig: true }).ok, true);
  assert.strictEqual(L2.head(), L1.head());
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- FAIL-OPEN emission: a broken signer/log degrades to no-receipt, never throws --------------
ok('emit is FAIL-OPEN: a throwing signer never breaks the run, just yields no receipt', () => {
  const log = freshLog({ signer: () => { throw new Error('signer exploded'); } });
  // SkillExecutor._emitReceipt swallows the error; here we exercise the same contract directly via a
  // tiny executor with no real wasm — _emitReceipt must not throw.
  const exec = new SkillExecutor({ requireSignature: false, contributorId: NODE_ID, receiptLog: log, verbose: false });
  assert.doesNotThrow(() => exec._emitReceipt({ id: 'x' }, 'in', 'out', 1));
  assert.strictEqual(log.length, 0, 'no receipt written when the signer fails');
});

ok('emit is a NO-OP without a node identity (contributorId) — fail-open', () => {
  const log = freshLog();
  const exec = new SkillExecutor({ requireSignature: false, contributorId: null, receiptLog: log, verbose: false });
  assert.doesNotThrow(() => exec._emitReceipt({ id: 'x' }, 'in', 'out', 1));
  assert.strictEqual(log.length, 0);
});

ok('SkillExecutor emits a signed skill-run receipt on a verified computational run', async () => {
  // Build + seal a real computational wasm with the node key, then run it through an executor wired
  // with a receipt log — proving the skill-run emission path end-to-end.
  const { GsiCompiler } = await import('./gsi-compiler.js');
  const compiler = new GsiCompiler({ distSkillsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'skz-')), verbose: false });
  // double(x) = 2x + 0 — the repo's affine computation shape; capabilities:{compute:true} so the gate allows it.
  const wasmBytes = await compiler.compile(
    { id: 'double.v1', kind: 'computational', computation: { type: 'affine', a: 2, b: 0 },
      capabilities: { compute: true } },
    node.privateKey,
  );
  const log = freshLog();
  const exec = new SkillExecutor({ publicKeyBundle: node.publicKey, contributorId: NODE_ID, receiptLog: log, enforceCapabilities: true, verbose: false });
  const out = await exec.run(wasmBytes, 21);
  assert.strictEqual(out.verified, true);
  assert.strictEqual(out.result, 42);
  assert.strictEqual(log.length, 1, 'one skill-run receipt emitted');
  assert.strictEqual(log.entries()[0].action, 'skill-run');
  assert.strictEqual(log.entries()[0].ref, 'double.v1');
  assert.strictEqual(log.verify({ requireSig: true }).ok, true);
});

// ---- tiny helpers used by the sophisticated-forgery test --------------------------------------
function recomputeHash(r, crypto) {
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

// Run every registered case in order (deterministic clock + chain ordering preserved).
for (const [name, fn] of _cases) { await fn(); console.log(`  ✓ ${name}`); pass++; }

console.log(`\n✅ ${pass}/${pass} capability-receipt tests passed — third-party-verifiable, fail-closed, fail-open emission, honest.`);
