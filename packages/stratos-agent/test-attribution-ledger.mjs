// test-attribution-ledger.mjs — measurement→attribution, tamper-evident, no rewards.
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttributionLedger, ENTRY_KINDS } from './src/ledger/attribution-ledger.js';

let pass = 0, t = 1000;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const now = () => (t += 1);              // deterministic clock
const A = 'did:atmos:aaaa', B = 'did:atmos:bbbb';

console.log('attribution ledger — measure + attribute, never reward\n');

ok('append validates kind, contributor, and units (deny-by-default)', () => {
  const L = new AttributionLedger({ now });
  assert.throws(() => L.append({ kind: 'mint-tokens', contributor: A }), /unknown attribution kind/);
  assert.throws(() => L.append({ kind: 'compute', contributor: '' }), /needs a contributor/);
  assert.throws(() => L.append({ kind: 'compute', contributor: A, units: -5 }), /non-negative/);
  assert.ok(ENTRY_KINDS.includes('skill-reused'));
});

ok('entries chain + verify() ok', () => {
  const L = new AttributionLedger({ now });
  L.append({ kind: 'compute', contributor: A, subject: 'job1', units: 120 });
  L.append({ kind: 'skill-authored', contributor: A, subject: 'double.v1' });
  L.append({ kind: 'skill-reused', contributor: B, subject: 'double.v1', units: 3 });
  assert.strictEqual(L.length, 3);
  assert.strictEqual(L.verify().ok, true);
  assert.strictEqual(L.entries()[1].prev, L.entries()[0].hash); // chained
});

ok('tamper-evident: editing a past entry breaks the chain', () => {
  const L = new AttributionLedger({ now });
  L.append({ kind: 'compute', contributor: A, units: 100 });
  L.append({ kind: 'compute', contributor: B, units: 50 });
  L.append({ kind: 'compute', contributor: A, units: 25 });
  L.chain[0].units = 999999;            // forge a bigger contribution for A
  const v = L.verify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.brokenAt, 0);
});

ok('summarize = measured units per contributor by kind (NOT a payout)', () => {
  const L = new AttributionLedger({ now });
  L.append({ kind: 'compute', contributor: A, units: 120 });
  L.append({ kind: 'skill-authored', contributor: A, units: 1 });
  L.append({ kind: 'compute', contributor: B, units: 30 });
  L.append({ kind: 'skill-reused', contributor: B, units: 4 });
  const s = L.summarize();
  assert.strictEqual(s[0].contributor, A);              // sorted by total units
  assert.strictEqual(s[0].total, 121);
  assert.deepStrictEqual(s[0].byKind, { compute: 120, 'skill-authored': 1 });
  assert.strictEqual(s.find((x) => x.contributor === B).total, 34);
  assert.ok(!('value' in s[0]) && !('reward' in s[0]) && !('price' in s[0])); // measurement only
});

ok('optional PQC-style signing: signed entries verify; a forged sig is caught', () => {
  const signer = (body) => crypto.createHash('sha256').update('SK' + body).digest('hex');
  const verifier = (body, sig) => sig === crypto.createHash('sha256').update('SK' + body).digest('hex');
  const L = new AttributionLedger({ now, signer, verifier });
  L.append({ kind: 'task-completed', contributor: A, subject: 'wf1', units: 1 });
  assert.ok(L.entries()[0].sig, 'entry signed');
  assert.strictEqual(L.verify().ok, true);
  L.chain[0].sig = 'deadbeef';
  assert.strictEqual(L.verify().ok, false);
});

ok('persistence round-trips and stays verifiable', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'ledger.jsonl');
  const L1 = new AttributionLedger({ path: file, now });
  L1.append({ kind: 'compute', contributor: A, units: 10 });
  L1.append({ kind: 'skill-reused', contributor: B, subject: 's', units: 2 });
  const L2 = new AttributionLedger({ path: file });      // reload from disk
  assert.strictEqual(L2.length, 2);
  assert.strictEqual(L2.verify().ok, true);
  assert.strictEqual(L2.head(), L1.head());
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

console.log(`\n✅ ${pass}/${pass} attribution-ledger tests passed — accounting before rewards, tamper-evident.`);
