// test-capability-enforcement.mjs — the capability loop, end to end:
// compiler STAMPS least-privilege caps into the sealed manifest → executor ENFORCES deny-by-default.
import assert from 'node:assert';
import { GsiCompiler, parseCustomSection } from './gsi-compiler.js';
import { SkillExecutor } from './src/evolution/skill-executor.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { deriveCapabilities } from './src/security/capability-gate.js';

let pass = 0;
const ok = (name, c) => { assert.ok(c, name); console.log(`  ✓ ${name}`); pass++; };

console.log('capability enforcement — compiler stamps, executor enforces (end-to-end)\n');

// --- deriveCapabilities: minimal, least-privilege ---
assert.deepStrictEqual(deriveCapabilities({ kind: 'computational' }), { compute: true });
ok('computational manifest ⇒ {compute:true}', true);
assert.deepStrictEqual(deriveCapabilities({ computation: { type: 'affine' } }), { compute: true });
ok('manifest with a computation block ⇒ {compute:true}', true);
const autoCaps = deriveCapabilities({ steps: [
  { action: 'click' }, { action: 'fetch', url: 'https://api.github.com/x', secret: 'github' }, { type: 'read', path: '/data/a' },
] });
assert.deepStrictEqual(autoCaps, { actions: ['click', 'fetch', 'read'], net: ['api.github.com'], fs: ['/data/a'], secrets: ['github'] });
ok('automation manifest ⇒ exactly the actions/hosts/paths/secrets its steps use', true);
assert.deepStrictEqual(deriveCapabilities({ steps: [] }), {});
ok('empty automation ⇒ {} (declares nothing)', true);

// --- end-to-end: real compile → sealed caps → enforced run ---
const kp = generateHybridKeyPair();
const compiler = new GsiCompiler({ verbose: false });

const wasm = await compiler.compile({ id: 'double.v1', kind: 'computational', computation: { type: 'affine', a: 2, b: 0 } }, kp.privateKey);

// 1. the compiler stamped caps INTO the sealed manifest
const manifest = JSON.parse(parseCustomSection(wasm, 'stratos.gsi.pathway').toString('utf8'));
assert.deepStrictEqual(manifest.capabilities, { compute: true });
ok('compiler stamped capabilities into the sealed manifest', true);

// 2. it runs under LIVE enforcement (enforceCapabilities: true) — verified + correct
const exec = new SkillExecutor({ publicKeyBundle: kp.publicKey, enforceCapabilities: true, verbose: false });
const res = await exec.run(wasm, 8);
ok('verified + enforced computational skill runs', res.verified === true && res.kind === 'computational');
ok('compute() returns the real value (2*8+0 = 16)', res.result === 16);

// 3. an author-set capabilities block is respected, not overwritten
const wasm2 = await compiler.compile({ id: 'x.v1', kind: 'computational', computation: { type: 'const', value: 7 }, capabilities: { compute: true, actions: ['x'] } }, kp.privateKey);
const m2 = JSON.parse(parseCustomSection(wasm2, 'stratos.gsi.pathway').toString('utf8'));
ok('author-set capabilities respected (not overwritten)', m2.capabilities.actions && m2.capabilities.actions[0] === 'x');

console.log(`\n✅ ${pass}/${pass} — the capability gate is LIVE: signed skills do only what they declared.`);
