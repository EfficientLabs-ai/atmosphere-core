/**
 * Smoke test for the product assembler. Proves the assembled @efficientlabs/stratos tree is correct,
 * lean (no mesh/browser deps), secret-free, provenance-stamped, and that its relative imports resolve.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { assembleProduct, scanTree, BANNED_DEPS, checkDanglingImports } from './build-product.mjs';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const exists = (p) => fs.existsSync(p);

console.log('=== dry-run ===');
const dry = assembleProduct({ version: '9.9.9' });
ok(dry.dryRun === true && dry.name === '@efficientlabs/stratos', 'dry-run returns the plan, writes nothing');
ok(dry.deps.includes('express') && dry.deps.includes('@lancedb/lancedb'), 'plan includes runtime deps');
ok(!dry.deps.some((d) => BANNED_DEPS.includes(d)), 'plan has NO mesh/browser deps');

console.log('\n=== assemble to temp ===');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-pkg-'));
const r = assembleProduct({ outDir: out, version: '9.9.9' });
ok(r.fileCount > 20 && r.violations === 0, `assembled ${r.fileCount} files, 0 violations`);

const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
ok(pkg.name === '@efficientlabs/stratos' && pkg.bin.stratos === 'stratos-agent/bin/stratos.js', 'manifest: name + bin correct');
ok(pkg.engines.node === '>=18' && pkg.exports['.'] && Array.isArray(pkg.files), 'manifest: engines + exports + files present');
ok(pkg.dependencies.express && pkg.dependencies['@lancedb/lancedb'], 'manifest: runtime deps present');
ok(!BANNED_DEPS.some((d) => pkg.dependencies[d] || (pkg.optionalDependencies || {})[d]), 'manifest: NO banned (mesh/browser) deps');
ok(JSON.stringify(pkg).indexOf('hyperswarm') === -1, 'manifest: "hyperswarm" string absent entirely');

console.log('\n=== structure: siblings preserved so relative imports resolve ===');
ok(exists(path.join(out, 'stratos-agent/bin/stratos.js')), 'stratos-agent/bin/stratos.js present');
ok(exists(path.join(out, 'api-shim/index.js')), 'api-shim/index.js present (sibling)');
ok(exists(path.join(out, 'stratos-agent/src/cli/stratos-cli.js')), 'CLI core present');

console.log('\n=== excluded: no tests / local state / secrets copied ===');
ok(!exists(path.join(out, 'stratos-agent/test-stratos-cli.mjs')), 'test files NOT copied');
ok(!exists(path.join(out, 'api-shim/test-standalone-graph.mjs')), 'api-shim tests NOT copied');
ok(!exists(path.join(out, 'stratos-agent/.stratos-profile')), 'no .stratos-profile');
ok(!fs.readdirSync(out, { recursive: true }).some((f) => String(f).includes('.env')), 'no .env* anywhere');

console.log('\n=== provenance ===');
const prov = JSON.parse(fs.readFileSync(path.join(out, 'provenance.json'), 'utf8'));
ok(prov.sourceCommit && prov.fileCount === r.fileCount && prov.product === '@efficientlabs/stratos', 'provenance: source commit + file count + product');
ok(exists(path.join(out, 'README.md')) && exists(path.join(out, 'LICENSE')), 'README + LICENSE generated');

console.log('\n=== the assembled CLI core actually imports (relative graph resolves) ===');
const cliUrl = url.pathToFileURL(path.join(out, 'stratos-agent/src/cli/stratos-cli.js')).href;
const { run } = await import(cliUrl);
const res = await run(['version'], { version: '9.9.9' });
ok(res.code === 0 && res.lines.join('').includes('9.9.9'), 'assembled CLI core runs (cross-module relative imports resolve in the package tree)');

console.log('\n=== secret/forbidden hard-gate works ===');
const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-bad-'));
fs.writeFileSync(path.join(bad, 'leak.js'), 'const k = "sk-ant-api03-AAAABBBBCCCCDDDDEEEE";');
fs.writeFileSync(path.join(bad, '.env'), 'SECRET=1');
const v = scanTree(bad);
ok(v.some((x) => /secret-shaped/.test(x)) && v.some((x) => /forbidden/.test(x)), 'scanTree flags a planted secret AND a forbidden .env file');

fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(bad, { recursive: true, force: true });

console.log('\n=== ATMOSPHERE product (mesh node) ===');
const ad = assembleProduct({ product: 'atmosphere', version: '9.9.9' });
ok(ad.name === '@efficientlabs/atmosphere' && ad.deps.includes('hyperswarm') && ad.deps.includes('@noble/post-quantum'), 'atmosphere plan: mesh + PQC deps');
ok(!ad.deps.includes('express') && !ad.deps.includes('@lancedb/lancedb'), 'atmosphere plan: NO agent/web deps');

const aout = fs.mkdtempSync(path.join(os.tmpdir(), 'atmos-pkg-'));
const ar = assembleProduct({ product: 'atmosphere', outDir: aout, version: '9.9.9' });
ok(ar.fileCount > 10 && ar.violations === 0, `atmosphere assembled ${ar.fileCount} files, 0 violations (anonymization gated)`);
const apkg = JSON.parse(fs.readFileSync(path.join(aout, 'package.json'), 'utf8'));
ok(apkg.name === '@efficientlabs/atmosphere' && apkg.bin['atmos-node'] === 'atmos-core/node-runner/mesh-node.mjs', 'atmosphere manifest: name + atmos-node bin');
ok(apkg.dependencies.hyperswarm && apkg.dependencies['@noble/post-quantum'] && !apkg.dependencies.express, 'atmosphere manifest: mesh deps, no express');

console.log('  -- vendored node verifier (so the bin resolves) --');
ok(exists(path.join(aout, 'atmos-core/node-runner/mesh-node.mjs')), 'mesh-node bin present');
ok(exists(path.join(aout, 'atmos-core/node-runner/quantum-crypto.js')), 'vendored quantum-crypto.js present (./quantum-crypto.js resolves)');
ok(exists(path.join(aout, 'atmos-core/node-runner/wasm-sections.js')), 'vendored wasm-sections.js present');

console.log('  -- ops tooling + internal codename excluded --');
ok(!exists(path.join(aout, 'atmos-core/node-runner/build.sh')), 'build.sh (references build-host paths) excluded');
ok(!exists(path.join(aout, 'atmos-core/node-runner/relay')), 'relay/ ops scripts excluded');
ok(!exists(path.join(aout, 'atmos-core/test.js')), 'atmos-core tests excluded');
const allText = fs.readdirSync(aout, { recursive: true }).filter((f) => /\.(js|mjs|json|md)$/.test(String(f)))
  .map((f) => { try { return fs.readFileSync(path.join(aout, String(f)), 'utf8'); } catch { return ''; } }).join('\n');
ok(!/maximus/i.test(allText), 'no "Maximus" codename anywhere in the atmosphere package');

console.log('  -- atmosphere: economic moat private + BSL --');
ok(!exists(path.join(aout, 'atmos-core/src/billing')), 'billing/ (economic engine) EXCLUDED — stays private');
ok(!exists(path.join(aout, 'atmos-core/mesh-demo.mjs')), 'mesh-demo.mjs (leaks moat) excluded');
ok(!fs.readFileSync(path.join(aout, 'atmos-core/index.js'), 'utf8').includes('PaymentEngine'), 'barrel patched: no PaymentEngine re-export');
ok(/Business Source License 1\.1/.test(fs.readFileSync(path.join(aout, 'LICENSE'), 'utf8')) && apkg.license === 'BUSL-1.1', 'atmosphere: BSL 1.1 license + manifest');
fs.rmSync(aout, { recursive: true, force: true });

console.log('\n=== A+B SPLIT: stratos ships the client, the learning MOAT stays private ===');
const sout = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-moat-'));
const sr = assembleProduct({ product: 'stratos', outDir: sout, version: '9.9.9' });
ok(sr.violations === 0, `stratos assembled ${sr.fileCount} files, 0 violations (incl. dangling-import gate)`);
for (const moat of ['stratos-agent/src/evolution', 'stratos-agent/gsi-compiler.js', 'stratos-agent/gsi-scheduler.js', 'stratos-agent/reasoning-bank.js', 'stratos-agent/src/ingestion/genesis-harvester.js', 'stratos-agent/index.js']) {
  ok(!exists(path.join(sout, moat)), `MOAT excluded: ${moat}`);
}
ok(exists(path.join(sout, 'stratos-agent/bin/stratos.js')) && exists(path.join(sout, 'api-shim/src/self-evolution-runtime.js')), 'client surface KEPT (CLI + the lazy engine seam)');
const spkg = JSON.parse(fs.readFileSync(path.join(sout, 'package.json'), 'utf8'));
ok(spkg.license === 'BUSL-1.1' && /Business Source License/.test(fs.readFileSync(path.join(sout, 'LICENSE'), 'utf8')), 'stratos: BSL 1.1 license + manifest');
ok(!spkg.dependencies.wabt && !spkg.optionalDependencies?.['node-cron'], 'moat-only deps (wabt/node-cron) pruned from the client');

console.log('  -- dangling-import gate works (clean tree → none) --');
ok(checkDanglingImports(sout).length === 0, 'no dangling static imports in the assembled client');
fs.rmSync(sout, { recursive: true, force: true });

console.log(`\n✅ ALL ${pass} build-product checks passed.`);
