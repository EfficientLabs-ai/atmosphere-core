/**
 * connector vault tests (hardened per Codex impl review): opaque handles, AES-256-GCM + AAD-bound
 * metadata, fail-CLOSED on tamper/forgery, fail-HARD on missing-key-over-data / corruption, and a
 * hygiene audit that never decrypts.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvault-'));
process.env.STRATOS_VAULT_DIR = VDIR;           // vault lives OUTSIDE any model-readable cwd
const V = await import('./src/connectors/vault.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const SENTINEL = 'ghp_SENTINEL_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const storeFile = path.join(VDIR, 'vault.json');
const keyFile = path.join(VDIR, 'master.key');
const readStore = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));
const writeStore = (s) => fs.writeFileSync(storeFile, JSON.stringify(s));

console.log('=== opaque handle + encrypted at rest, outside cwd, separate from config/env ===');
const h = V.putSecret({ connector: 'github', kind: 'oauth', value: SENTINEL });
ok(/^cvault:github:oauth:[a-f0-9]{32}$/.test(h) && !h.includes('SENTINEL'), `opaque handle: ${h}`);
ok(!fs.readFileSync(storeFile, 'utf8').includes(SENTINEL), 'vault.json on disk has NO plaintext (AES-256-GCM)');
ok(!JSON.stringify(V.list()).includes(SENTINEL), 'list() is metadata-only');
ok(!Object.values(process.env).includes(SENTINEL), 'secret not in process env');

console.log('\n=== resolveSecret is the one plaintext path; bad/forged → null ===');
ok(V.resolveSecret(h) === SENTINEL, 'broker resolves the handle → exact secret');
ok(V.resolveSecret('not-a-handle') === null && V.resolveSecret('cvault:x:y:' + 'a'.repeat(32)) === null, 'malformed/unknown → null');

console.log('\n=== AAD: forging metadata breaks authentication ===');
const s1 = readStore(); const id1 = Object.keys(s1)[0];
s1[id1].connector = 'evilcorp'; writeStore(s1);            // forge the connector field
ok(V.resolveSecret(h) === null, 'original handle no longer resolves after metadata forgery (connector mismatch)');
ok(V.resolveSecret(`cvault:evilcorp:oauth:${id1}`) === null, 'a handle crafted to match the forged metadata also fails (AAD auth)');
fs.rmSync(VDIR, { recursive: true, force: true }); // reset for the next groups

console.log('\n=== fail-CLOSED on ciphertext tamper ===');
const h2 = V.putSecret({ connector: 'gmail', value: SENTINEL });
const s2 = readStore(); const id2 = Object.keys(s2)[0];
s2[id2].ct = (s2[id2].ct.slice(0, 2) === 'ff' ? '00' : 'ff') + s2[id2].ct.slice(2); writeStore(s2);
ok(V.resolveSecret(h2) === null, 'tampered ciphertext → null (GCM auth fails, no throw/leak)');

console.log('\n=== fail-HARD: missing key over a non-empty store = tampering, not regeneration ===');
fs.rmSync(VDIR, { recursive: true, force: true });
const h3 = V.putSecret({ connector: 'slack', value: SENTINEL });
fs.unlinkSync(keyFile);                                     // key gone, store has data
let threw = false; try { V.putSecret({ connector: 'x', value: 'y' }); } catch { threw = true; }
ok(threw, 'putSecret refuses to regenerate a master key over an existing store (throws)');
ok(V.audit().keyConsistent === false && V.audit().healthy === false, 'audit flags the missing-key-over-data state as unhealthy');

console.log('\n=== corruption ≠ empty: a corrupt store surfaces a fault ===');
fs.rmSync(VDIR, { recursive: true, force: true });
V.putSecret({ connector: 'notion', value: SENTINEL });
fs.writeFileSync(storeFile, '{ this is not json');
const aCorrupt = V.audit();
ok(aCorrupt.fault !== null && aCorrupt.healthy === false, 'corrupt store → audit.fault set + unhealthy (NOT a silent empty/clean)');

console.log('\n=== hygiene audit (no decryption) on a healthy vault ===');
fs.rmSync(VDIR, { recursive: true, force: true });
const h4 = V.putSecret({ connector: 'github', value: SENTINEL });
const a = V.audit();
ok(a.modes.masterKey === '0600' && a.modes.store === '0600', 'vault files are 0600');
ok(a.encryptedAtRest === true && a.healthy === true && a.fault === null, 'audit: encrypted-at-rest + healthy, never decrypts');
ok(!JSON.stringify(a).includes(SENTINEL), 'audit output contains NO secret (it does not materialize plaintext)');

console.log('\n=== revoke ===');
ok(V.revoke(h4) === true && V.resolveSecret(h4) === null, 'revoke → resolve null after');
ok(V.revoke('cvault:x:y:' + 'a'.repeat(32)) === false, 'revoke unknown → false');

fs.rmSync(VDIR, { recursive: true, force: true });
console.log(`\n✅ ALL ${pass} connector-vault checks passed.`);
