/**
 * connector vault tests — the security contract: opaque handles, encrypted at rest, separate from
 * config, fail-closed on tamper, and a working NON-EGRESS audit (the sentinel never leaks).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvault-'));
process.chdir(tmp);
const V = await import('./src/connectors/vault.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const SENTINEL = 'ghp_SENTINEL_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // a fake, recognizable secret

console.log('=== opaque handle (no secret material leaks into the handle) ===');
const h = V.putSecret({ connector: 'github', kind: 'oauth', value: SENTINEL });
ok(/^cvault:github:oauth:[a-f0-9]{32}$/.test(h), `handle is opaque: ${h}`);
ok(!h.includes(SENTINEL) && !h.includes(SENTINEL.slice(0, 8)), 'handle contains NONE of the secret');

console.log('\n=== list() is metadata-only ===');
const items = V.list();
ok(items.length === 1 && items[0].connector === 'github' && items[0].kind === 'oauth', 'list shows connector/kind metadata');
ok(!JSON.stringify(items).includes(SENTINEL), 'list() output contains NO secret value');

console.log('\n=== encrypted at rest + separated from agent-config ===');
const onDisk = fs.readFileSync(path.join(tmp, '.stratos-profile', 'connector-vault', 'vault.json'), 'utf8');
ok(!onDisk.includes(SENTINEL), 'vault.json on disk does NOT contain the plaintext secret (AES-256-GCM)');
ok(!fs.existsSync(path.join(tmp, '.stratos-profile', 'agent-config.json')) ||
   !fs.readFileSync(path.join(tmp, '.stratos-profile', 'agent-config.json'), 'utf8').includes(SENTINEL),
   'secret is NOT in agent-config.json (dedicated vault subtree)');
ok(!('GITHUB' in process.env) && !Object.values(process.env).includes(SENTINEL), 'secret is NOT in process env');

console.log('\n=== resolveSecret is the ONE privileged path that returns plaintext ===');
ok(V.resolveSecret(h) === SENTINEL, 'broker can resolve the handle → exact secret');
ok(V.resolveSecret('cvault:github:oauth:deadbeefdeadbeefdeadbeefdeadbeef') === null, 'unknown handle → null');
ok(V.resolveSecret('not-a-handle') === null, 'malformed handle → null');

console.log('\n=== fail-closed on tamper (GCM auth tag) ===');
const store = JSON.parse(fs.readFileSync(path.join(tmp, '.stratos-profile', 'connector-vault', 'vault.json'), 'utf8'));
const id = Object.keys(store)[0];
store[id].ct = store[id].ct.replace(/^../, store[id].ct.slice(0, 2) === 'ff' ? '00' : 'ff'); // flip first byte
fs.writeFileSync(path.join(tmp, '.stratos-profile', 'connector-vault', 'vault.json'), JSON.stringify(store));
ok(V.resolveSecret(h) === null, 'tampered ciphertext → resolve returns null (does NOT throw or leak)');
// restore
fs.writeFileSync(path.join(tmp, '.stratos-profile', 'connector-vault', 'vault.json'), JSON.stringify(store).replace(store[id].ct, store[id].ct)); // noop; re-put below
const h2 = V.putSecret({ connector: 'gmail', kind: 'oauth', value: SENTINEL });

console.log('\n=== NON-EGRESS audit (proves the secret is not in logs/config) ===');
const cleanLog = path.join(tmp, 'clean.log'); fs.writeFileSync(cleanLog, 'normal log line, no secrets here\n');
const leakyLog = path.join(tmp, 'leaky.log'); fs.writeFileSync(leakyLog, `oops we logged ${SENTINEL} by accident\n`);
let a = V.audit({ scanPaths: [cleanLog] });
ok(a.leaks.length === 0 && a.clean === true, 'audit clean when the secret is NOT in the scanned file');
ok(a.modes.masterKey === '0600' && a.modes.store === '0600', 'vault files are 0600');
a = V.audit({ scanPaths: [leakyLog] });
ok(a.leaks.length >= 1 && a.clean === false, 'audit DETECTS a leak when the secret appears in a log (scanner works)');

console.log('\n=== revoke ===');
ok(V.revoke(h2) === true && V.resolveSecret(h2) === null, 'revoke removes the secret (resolve → null after)');
ok(V.revoke('cvault:x:y:deadbeefdeadbeefdeadbeefdeadbeef') === false, 'revoke unknown handle → false');

console.log(`\n✅ ALL ${pass} connector-vault checks passed.`);
