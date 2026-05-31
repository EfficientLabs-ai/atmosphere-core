/**
 * agent-config unit tests — two-tier state, revision-guarded writes, migration, desired/effective.
 * Runs in an isolated temp cwd so the real .stratos-profile is never touched.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate: fresh temp cwd BEFORE importing the module (it resolves paths off process.cwd()).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-cfg-'));
process.chdir(tmp);

const {
  getConfig, updateConfig, setAgentName, setLocalModel, getAgentName,
  effectiveCapabilities, getOwner, bindOwner, isOwner, markConfigured, _reset,
} = await import('./src/core/agent-config.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log('=== defaults + secure-by-default ===');
let c = getConfig();
ok(c.agentName === 'StratosAgent' && c.rev === 0, 'fresh config → default name, rev 0');
ok(c.permissions.shell === 'disabled' && c.permissions.files === 'disabled' && c.permissions.network === 'disabled', 'all privileged permissions default-OFF');
ok(c.model.provider === 'local', 'model defaults to local (no cloud egress by default)');
ok(fs.existsSync(path.join(tmp, '.stratos-profile', 'agent-config.json')), 'config persisted to .stratos-profile/agent-config.json');

console.log('\n=== safe setters + revision bump ===');
const before = getConfig().rev;
setAgentName('Atlas');
ok(getAgentName() === 'Atlas', 'setAgentName → name updated');
ok(getConfig().rev === before + 1, 'rev incremented on write');
setLocalModel('gemma2:9b');
ok(getConfig().model.name === 'gemma2:9b' && getConfig().model.provider === 'local', 'setLocalModel → local model updated');

console.log('\n=== setLocalModel rejects non-local (no cloud switch via this path) ===');
let threw = false;
try { setLocalModel('gpt-4o'); } catch { threw = true; }
ok(threw, 'setLocalModel("gpt-4o") throws — cloud provider switch is NOT a local-model change');
ok(getConfig().model.name === 'gemma2:9b', 'config unchanged after rejected switch');

console.log('\n=== revision-guarded compare-and-swap (lost-update protection) ===');
// Simulate a concurrent external writer bumping rev on disk after we read.
const cfgPath = path.join(tmp, '.stratos-profile', 'agent-config.json');
_reset();
getConfig(); // prime cache at current rev
const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
disk.rev = disk.rev + 5; disk.agentName = 'ExternallyChanged';
fs.writeFileSync(cfgPath, JSON.stringify(disk));
let cas = false;
try { updateConfig((x) => { x.agentName = 'Mine'; }); } catch { cas = true; }
ok(cas, 'updateConfig throws when on-disk rev advanced concurrently (no silent lost update)');

console.log('\n=== cross-process lock (atomic CAS — another writer holds the lock) ===');
_reset(); getConfig();
const lockFile = path.join(tmp, '.stratos-profile', '.config.lock');
fs.writeFileSync(lockFile, String(process.pid));      // simulate another live process inside the CS
let locked = false;
try { setAgentName('ShouldBlock'); } catch (e) { locked = /another process/.test(e.message); }
ok(locked, 'updateConfig throws while another process holds the lock (no concurrent write)');
fs.unlinkSync(lockFile);                                // release
setAgentName('AfterUnlock');
ok(getAgentName() === 'AfterUnlock', 'write succeeds once the lock is released');
ok(!fs.existsSync(lockFile), 'lock file is removed after a successful write (no leak)');

console.log('\n=== desired vs effective (never overstate readiness) ===');
_reset();
setLocalModel('qwen2.5:7b');
let e = effectiveCapabilities({ installedModels: [], env: {} });
ok(e.model.state === 'requested', 'local model NOT installed → state "requested" (not "ready")');
e = effectiveCapabilities({ installedModels: ['qwen2.5:7b'], env: {} });
ok(e.model.state === 'ready', 'local model installed → state "ready"');
updateConfig((x) => { x.model = { provider: 'openai', name: 'gpt-4o' }; });
e = effectiveCapabilities({ installedModels: [], env: {} });
ok(e.model.state === 'requested', 'cloud model, no key → "requested"');
e = effectiveCapabilities({ installedModels: [], env: { OPENAI_API_KEY: 'sk-test' } });
ok(e.model.state === 'ready', 'cloud model + key present → "ready"');

console.log('\n=== owner binding (separate runtime state; env wins) ===');
ok(getOwner({}) === null, 'no owner bound, no env → null');
bindOwner('123456');
ok(getOwner({}) === '123456', 'bindOwner persists to runtime-state.json');
ok(isOwner('123456', {}) === true && isOwner('999', {}) === false, 'isOwner matches only the bound id');
ok(getOwner({ STRATOS_OWNER_CHAT_ID: '777' }) === '777', 'env STRATOS_OWNER_CHAT_ID overrides bound owner');
ok(fs.existsSync(path.join(tmp, '.stratos-profile', 'runtime-state.json')), 'owner stored in SEPARATE runtime-state.json (not user config)');
const userCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
ok(userCfg.ownerChatId === undefined, 'owner id is NOT written into the user config file');

console.log('\n=== migration from .env.local (one-time, names preserved) ===');
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-mig-'));
fs.writeFileSync(path.join(tmp2, '.env.local'), 'STRATOS_AGENT_NAME="Nova"\nATMOSPHERE_P2P_OPT_IN="true"\n');
process.chdir(tmp2);
_reset();
const m = getConfig();
ok(m.agentName === 'Nova', 'migrated agentName from .env.local');
ok(m.meshOptIn === true, 'migrated mesh opt-in from .env.local');

console.log(`\n✅ ALL ${pass} agent-config checks passed.`);
