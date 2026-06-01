/**
 * connector-registry tests: onboarding stores the credential in the VAULT (encrypted), the registry
 * holds only the opaque handle + pinned sidecar (never the secret), list is metadata-only, remove revokes.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creg-vault-'));
const PDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creg-prof-'));
process.env.STRATOS_VAULT_DIR = VDIR;     // where the vault stores encrypted secrets
process.env.STRATOS_PROFILE_DIR = PDIR;   // where the connector registry lives
const reg = await import('./src/connectors/connector-registry.js');
const vault = await import('./src/connectors/vault.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const SECRET = 'ghp_CONNECTOR_ONBOARD_SENTINEL_xxxxxxxxxx';

console.log('=== onboarding: secret → vault, registry holds only the handle ===');
const added = reg.addConnector({ name: 'github', kind: 'oauth', secret: SECRET, command: 'node', args: ['gh-mcp.js'], authEnvVar: 'GITHUB_TOKEN' });
ok(added.hasCredential && /^cvault:github:oauth:/.test(added.credentialHandle), 'returns an opaque vault handle');
const onDisk = fs.readFileSync(reg.registryPath(), 'utf8');
ok(!onDisk.includes(SECRET), 'connectors.json on disk contains NO plaintext secret');
ok(onDisk.includes('gh-mcp.js') && onDisk.includes('GITHUB_TOKEN'), 'registry holds the pinned sidecar command + auth env var');
ok(vault.resolveSecret(added.credentialHandle) === SECRET, 'the broker can resolve the handle → the exact secret (via the vault)');

console.log('\n=== list is metadata-only ===');
const list = reg.listConnectors();
ok(list.length === 1 && list[0].name === 'github' && list[0].hasCredential === true, 'lists the connector + that it has a credential');
ok(!JSON.stringify(list).includes(SECRET), 'list output contains NO secret');

console.log('\n=== a connector with no secret is allowed (e.g. a local/unauth sidecar) ===');
const noSec = reg.addConnector({ name: 'filesystem', command: 'node', args: ['fs-mcp.js'] });
ok(noSec.hasCredential === false && reg.listConnectors().length === 2, 'credential-less connector registered');

console.log('\n=== remove revokes the vault credential + drops the entry ===');
ok(reg.removeConnector('github') === true, 'remove returns true');
ok(vault.resolveSecret(added.credentialHandle) === null, 'the vault credential is revoked (resolve → null)');
ok(reg.listConnectors().some((c) => c.name === 'github') === false, 'the registry entry is gone');
ok(reg.removeConnector('nope') === false, 'removing an unknown connector → false');

console.log('\n=== validation ===');
let t1 = false; try { reg.addConnector({ name: 'bad name!', command: 'x' }); } catch { t1 = true; }
ok(t1, 'an invalid connector name is rejected');
let t2 = false; try { reg.addConnector({ name: 'ok', secret: 'x' }); } catch { t2 = true; }
ok(t2, 'a connector with no pinned command is rejected');

fs.rmSync(VDIR, { recursive: true, force: true });
fs.rmSync(PDIR, { recursive: true, force: true });
console.log(`\n✅ ALL ${pass} connector-registry checks passed.`);
