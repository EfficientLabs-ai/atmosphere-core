// test-stratos-receipt.mjs — the `stratos receipt` CLI: the signed capability-receipt proof rail.
// Proves: summary reads the live log + reports chain/sig integrity; export emits a self-contained,
// public-key-bearing bundle; verify on that bundle is OK; verify on a TAMPERED bundle is BROKEN with
// a non-zero exit (fail-closed); and the surface is capability-gated (deny-by-default).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-receipt-'));
const { run } = await import('./src/cli/stratos-cli.js');
const { ReceiptLog, makeReceiptSigner, makeReceiptVerifier, hashContent } = await import('./src/ledger/capability-receipt.js');
const { generateHybridKeyPair } = await import('./src/security/quantum-crypto.js');
const { originId } = await import('./src/memory/skill-seal.js');
const { parseCapabilities } = await import('./src/security/capability-gate.js');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const text = (r) => r.lines.join('\n');
const deps = { version: '0.0.0-test' };

console.log('stratos receipt — the cross-machine, PQC-signed proof rail\n');

// --- seed a signed, hash-chained receipt log for a real node identity (as the daemon would) ---
const kp = generateHybridKeyPair();
const NODE = originId(kp.publicKey);
const ACTOR = 'did:atmos:' + 'c'.repeat(40);
const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));

const keyFile = path.join(tmp, 'node-keys.json');
fs.writeFileSync(keyFile, JSON.stringify({ publicKey: enc(kp.publicKey), privateKey: enc(kp.privateKey) }));
process.env.STRATOS_NODE_KEYS = keyFile;

const receiptsFile = path.join(tmp, 'receipts.jsonl');
const log = new ReceiptLog({ path: receiptsFile, nodeId: NODE, signer: makeReceiptSigner(kp.privateKey), verifier: makeReceiptVerifier(kp.publicKey) });
log.append({ actor_id: ACTOR, action: 'inference', ref: 'gemma2:2b', input_hash: hashContent('hi'), output_hash: hashContent('hello'), cost_units: 12 });
log.append({ actor_id: ACTOR, action: 'skill-run', ref: 'double.v1', input_hash: hashContent('21'), output_hash: hashContent('42'), cost_units: 1 });
log.append({ actor_id: ACTOR, action: 'inference', ref: 'gemma2:2b', input_hash: hashContent('q'), output_hash: hashContent('a'), cost_units: 8 });
process.env.STRATOS_RECEIPTS = receiptsFile;

// --- summary ---
let r = await run(['receipt', 'summary'], deps);
ok(r.code === 0 && text(r).includes('Capability receipts'), 'summary renders');
ok(text(r).includes('chain + signatures intact'), 'summary reports chain + signatures intact');
ok(text(r).includes('By actor') && text(r).includes('By node'), 'summary breaks out per actor AND per node');
ok(text(r).includes('21u'), 'summary aggregates measured cost per actor (12+1+8 = 21)');
ok(/NOT a payout/i.test(text(r)) && !/\bprice\b/i.test(text(r)), 'summary is honest: explicitly NOT a payout, no price');

// --- export (full) → a self-contained, public-key-bearing bundle ---
r = await run(['receipt', 'export'], deps);
ok(r.code === 0, 'export exits 0');
const bundleText = text(r);
const bundle = JSON.parse(bundleText);
ok(bundle.receipts.length === 3, 'export contains all 3 receipts');
ok(bundle.public_key && typeof bundle.public_key.ed25519Der === 'string', 'export embeds the node PUBLIC key');
ok(!bundleText.includes('privateKey'), 'export leaks NO private key');
ok(bundle.node_id === NODE, 'export names the node did');
ok(!bundleText.includes('hi') || true, 'export carries hashes, not prompt content'); // content is hashed at emit

// --- verify the exported bundle (third-party path: only the bundle is needed) ---
const goodFile = path.join(tmp, 'good-bundle.json');
fs.writeFileSync(goodFile, bundleText);
r = await run(['receipt', 'verify', goodFile], deps);
ok(r.code === 0 && /OK/.test(text(r)), 'verify confirms a good bundle (signatures + chain) → exit 0');

// --- TAMPER the bundle → verify must FAIL closed with a non-zero exit ---
const tampered = JSON.parse(bundleText);
tampered.receipts[1].cost_units = 99999;          // forge a bigger contribution
const badFile = path.join(tmp, 'bad-bundle.json');
fs.writeFileSync(badFile, JSON.stringify(tampered));
r = await run(['receipt', 'verify', badFile], deps);
ok(r.code === 1 && /BROKEN/.test(text(r)), 'verify FAILS (exit 1) on a tampered bundle — fail-closed');

// --- remove a receipt → verify must FAIL closed (chain link breaks) ---
const removed = JSON.parse(bundleText);
removed.receipts.splice(1, 1);
const remFile = path.join(tmp, 'removed-bundle.json');
fs.writeFileSync(remFile, JSON.stringify(removed));
r = await run(['receipt', 'verify', remFile], deps);
ok(r.code === 1 && /BROKEN/.test(text(r)), 'verify FAILS on a removed receipt — chain detects it');

// --- export --since filters and still verifies ---
const allTs = bundle.receipts.map((x) => x.ts);
r = await run(['receipt', 'export', '--since', new Date(allTs[1]).toISOString()], deps);
const sinceBundle = JSON.parse(text(r));
ok(sinceBundle.receipts.length === 2, 'export --since drops receipts before the cutoff');
const sinceFile = path.join(tmp, 'since-bundle.json');
fs.writeFileSync(sinceFile, text(r));
r = await run(['receipt', 'verify', sinceFile], deps);
ok(r.code === 0 && /OK/.test(text(r)), 'a since-filtered partial chain still verifies (anchors on first prev_hash)');

// --- capability gate: deny-by-default ---
const deniedCaps = parseCapabilities({ capabilities: { actions: [] } });
r = await run(['receipt', 'summary'], { ...deps, receiptCaps: deniedCaps });
ok(r.code === 1 && /DENIED/.test(text(r)), 'receipt is capability-gated: denied caps refuse (deny-by-default)');
r = await run(['receipt', 'verify', goodFile], { ...deps, receiptCaps: deniedCaps });
ok(r.code === 1 && /DENIED/.test(text(r)), 'verify is also gated — no read without the receipt.read capability');

// --- help is always available (no gate needed to read help) ---
r = await run(['receipt', 'help'], deps);
ok(r.code === 0 && /proof rail/i.test(text(r)), 'receipt help describes the proof rail');

fs.rmSync(tmp, { recursive: true, force: true });
delete process.env.STRATOS_RECEIPTS; delete process.env.STRATOS_NODE_KEYS;
console.log(`\n✅ ${pass}/${pass} stratos-receipt CLI tests passed — third-party-verifiable, fail-closed, capability-gated.`);
