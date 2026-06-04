// test-icm-workspace.mjs — the ICM "folders over agents" workspace contract.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ICM_LAYERS, scaffoldWorkspace, validateWorkspace, resolveLayer } from './src/context/icm-workspace.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-'));

console.log('ICM workspace — folders over agents\n');

ok('scaffold creates all 5 layers + the ICM.md contract + seeds', () => {
  const r = scaffoldWorkspace(ws);
  for (const l of ICM_LAYERS) assert.ok(fs.existsSync(path.join(ws, l.dir)), `${l.dir} exists`);
  assert.ok(fs.existsSync(path.join(ws, 'ICM.md')), 'ICM.md exists');
  assert.ok(fs.existsSync(path.join(ws, 'identity/identity.md')), 'L0 identity seeded');
  assert.ok(fs.existsSync(path.join(ws, 'routing/routes.md')), 'L1 routing seeded');
  assert.ok(r.created.includes('ICM.md'), 'reports ICM.md created');
});

ok('L2 is `stages/` (aligns with the live pipeline engine)', () => {
  const l2 = ICM_LAYERS.find((l) => l.layer === 'L2');
  assert.strictEqual(l2.dir, 'stages');
  assert.strictEqual(l2.live, true);
  assert.strictEqual(resolveLayer(ws, 'stages'), path.join(ws, 'stages'));
});

ok('validateWorkspace ⇒ ok after scaffold', () => {
  assert.deepStrictEqual(validateWorkspace(ws).ok, true);
});

ok('scaffold is idempotent — never overwrites, reports existed', () => {
  fs.writeFileSync(path.join(ws, 'ICM.md'), 'MY EDIT'); // human edit must survive
  const r = scaffoldWorkspace(ws);
  assert.strictEqual(fs.readFileSync(path.join(ws, 'ICM.md'), 'utf8'), 'MY EDIT', 'edit preserved');
  assert.ok(r.existed.includes('ICM.md'));
  assert.deepStrictEqual(r.created, []);
});

ok('validate is deny-by-default — a missing layer is flagged', () => {
  fs.rmSync(path.join(ws, 'reference'), { recursive: true, force: true });
  const v = validateWorkspace(ws);
  assert.strictEqual(v.ok, false);
  assert.ok(v.missing.some((m) => m.startsWith('reference/')), 'reference flagged missing');
});

ok('resolveLayer rejects unknown ids and cannot escape root', () => {
  assert.throws(() => resolveLayer(ws, 'etc'), /unknown ICM layer/);
  assert.throws(() => resolveLayer(ws, '../../etc'), /unknown ICM layer/); // not a known id
});

fs.rmSync(ws, { recursive: true, force: true });
console.log(`\n✅ ${pass}/${pass} ICM workspace tests passed — the file architecture is the contract.`);
