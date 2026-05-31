/**
 * Smoke test for the product assembler. Proves the assembled @efficientlabs/stratos tree is correct,
 * lean (no mesh/browser deps), secret-free, provenance-stamped, and that its relative imports resolve.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { assembleProduct, scanTree, BANNED_DEPS } from './build-product.mjs';

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
console.log(`\n✅ ALL ${pass} build-product checks passed.`);
