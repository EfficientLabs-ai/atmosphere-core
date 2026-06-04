// test-stratos-id-ledger.mjs — the `stratos ledger` + `stratos id` observability surfaces.
// Proves: ledger summary/verify/list read the persisted chain, tamper is caught, `id whoami`
// derives the real did:atmos from a node-keys file, and `id inspect` decodes a brokered token.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-idledger-'));
const { run } = await import('./src/cli/stratos-cli.js');
const { AttributionLedger } = await import('./src/ledger/attribution-ledger.js');
const { IdentityBroker } = await import('./src/identity/identity-broker.js');
const { generateHybridKeyPair } = await import('./src/security/quantum-crypto.js');
const { originId } = await import('./src/memory/skill-seal.js');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const text = (r) => r.lines.join('\n');
const deps = { version: '0.0.0-test' };

console.log('stratos ledger + id — observe the trust substrate\n');

// --- seed a ledger with measured contributions for a node did ---
const DID = 'did:atmos:' + 'a'.repeat(40);
const ledgerFile = path.join(tmp, 'attribution.jsonl');
const led = new AttributionLedger({ path: ledgerFile });
led.append({ kind: 'compute', contributor: DID, subject: 'job.1', units: 3 });
led.append({ kind: 'skill-executed', contributor: DID, subject: 'double.v1', units: 1 });
led.append({ kind: 'skill-executed', contributor: DID, subject: 'gh.v1', units: 1 });
process.env.STRATOS_LEDGER = ledgerFile;

let r = await run(['ledger', 'summary'], deps);
ok(r.code === 0 && text(r).includes('Attribution summary'), 'ledger summary renders');
ok(text(r).includes('5u'), 'summary aggregates measured units (3+1+1 = 5)');
ok(text(r).includes('chain intact'), 'summary reports the chain is intact');
ok(/NOT a payout/i.test(text(r)), 'summary is explicit: measurement, NOT a payout');

r = await run(['ledger', 'verify'], deps);
ok(r.code === 0 && /intact/.test(text(r)), 'verify confirms the hash chain');

r = await run(['ledger', 'list', '2'], deps);
ok(r.code === 0 && text(r).includes('gh.v1') && text(r).includes('double.v1'), 'list shows the last 2 entries');
ok(!text(r).includes('job.1'), 'list 2 excludes the oldest (job.1)');

// --- tamper: edit a persisted unit count → verify must catch it ---
const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
const e0 = JSON.parse(lines[0]); e0.units = 999; lines[0] = JSON.stringify(e0);
fs.writeFileSync(ledgerFile, lines.join('\n') + '\n');
r = await run(['ledger', 'verify'], deps);
ok(r.code === 1 && /BROKEN/.test(text(r)), 'verify FAILS (code 1) on a tampered entry — tamper-evident');

// --- id whoami: derive the real did:atmos from a node-keys file (serialized as the daemon does) ---
const kp = generateHybridKeyPair();
const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
const keyFile = path.join(tmp, 'node-keys.json');
fs.writeFileSync(keyFile, JSON.stringify({ publicKey: enc(kp.publicKey), privateKey: enc(kp.privateKey) }));
process.env.STRATOS_NODE_KEYS = keyFile;
const expectedDid = originId(kp.publicKey);

r = await run(['id', 'whoami'], deps);
ok(r.code === 0 && text(r).includes(expectedDid), 'id whoami shows the real did:atmos derived from the node key');
ok(/Ed25519 \+ ML-DSA/.test(text(r)), 'id whoami names the hybrid PQC identity');

// --- id inspect: decode a brokered, audience-bound, short-lived assertion ---
const broker = new IdentityBroker({ secret: 's3cret' });
broker.grant({ subject: DID, audience: 'api.github.com', scopes: ['issues.read'] });
const token = broker.issue({ subject: DID, audience: 'api.github.com', scope: 'issues.read' });
r = await run(['id', 'inspect', token], deps);
ok(r.code === 0 && text(r).includes('api.github.com') && text(r).includes('issues.read'), 'id inspect decodes audience + scope');
ok(/valid for \d+s/.test(text(r)), 'id inspect shows the short-lived expiry');
ok(/NOT signature-verified/i.test(text(r)), 'id inspect is HONEST: decoded, not signature-verified (no secret in CLI)');

// expired token → EXPIRED
const past = new IdentityBroker({ secret: 's3cret', now: () => 1000, ttlMs: 1000 });
past.grant({ subject: DID, audience: 'api.x', scopes: ['a'] });
const oldTok = past.issue({ subject: DID, audience: 'api.x', scope: 'a' });
r = await run(['id', 'inspect', oldTok], deps);
ok(/EXPIRED/.test(text(r)), 'id inspect flags an expired assertion');

delete process.env.STRATOS_LEDGER; delete process.env.STRATOS_NODE_KEYS;
console.log(`\n✅ ${pass}/${pass} — ledger + id surfaces work; tamper caught, identity real, tokens honest.`);
