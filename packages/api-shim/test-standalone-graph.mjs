/**
 * Standalone-enforcement test (Codex CRITICAL: "Stratos runs standalone" must be ENFORCED, not
 * asserted). Statically walks the api-shim daemon's top-level import graph from index.js, following
 * only RELATIVE imports across the monorepo, and asserts that no mesh / browser / scheduler bare
 * dependency is pulled in at load. If this fails, the shipped agent would drag in code (and npm deps)
 * it must not need to run on a legacy/local model with no mesh.
 *
 * Pure static analysis — no installs, no runtime. Dynamic import() calls are reported as lazy/optional
 * (voice etc.) but not counted against the static-load guarantee.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, 'index.js');

// Bare deps that must NOT be in the standalone agent's static load graph.
const BANNED = new Set([
  'playwright-core', 'playwright',                 // browser automation
  'hyperswarm', 'hyperdht', 'corestore', 'autobase', 'hypercore', // P2P mesh transport
  'node-cron', 'cron',                             // schedulers
  'atmos-core',                                    // the mesh package itself
]);

const STATIC_RE = /(?:^|\s)(?:import|export)\b[^;'"]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\s*['"]([^'"]+)['"]/g;
const DYN_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(src, re) {
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2]);
  return out.filter(Boolean);
}
function resolveRel(fromFile, spec) {
  let p = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.js');
  if (!fs.existsSync(p) && fs.existsSync(p + '.js')) p += '.js';
  return p;
}

const seen = new Set();
const bareStatic = new Map();   // bare specifier → first file that imported it
const dynamic = new Map();      // dynamic specifier → file (lazy/optional)

function walk(file) {
  if (seen.has(file) || !fs.existsSync(file)) return;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const spec of specifiers(src, STATIC_RE)) {
    if (spec.startsWith('node:')) continue;
    if (spec.startsWith('.')) walk(resolveRel(file, spec));
    else if (!bareStatic.has(spec)) bareStatic.set(spec, path.relative(path.join(HERE, '..', '..'), file));
  }
  for (const spec of specifiers(src, DYN_RE)) {
    if (spec.startsWith('node:') || spec.startsWith('.')) { if (spec.startsWith('.')) { /* lazy local — not walked into static graph */ } continue; }
    if (!dynamic.has(spec)) dynamic.set(spec, path.relative(path.join(HERE, '..', '..'), file));
  }
}

walk(ENTRY);

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log(`=== api-shim static load graph: ${seen.size} files, ${bareStatic.size} bare deps ===`);
const violations = [...bareStatic.keys()].filter((d) => BANNED.has(d));
if (violations.length) {
  console.log('  ✗ BANNED deps in static graph:');
  for (const v of violations) console.log(`      - ${v}  (first imported by ${bareStatic.get(v)})`);
}
ok(violations.length === 0, 'no mesh/browser/scheduler dep in the standalone agent static load graph');

for (const dep of ['playwright-core', 'hyperswarm', 'corestore', 'autobase', 'node-cron']) {
  ok(!bareStatic.has(dep), `'${dep}' is NOT statically loaded by the shipped agent`);
}

console.log('\n=== runtime bare deps actually in the static graph (should be the lean runtime set) ===');
console.log('   ', [...bareStatic.keys()].sort().join(', ') || '(none)');
console.log('=== dynamic (lazy/optional) imports — fine, not loaded at boot ===');
console.log('   ', [...dynamic.keys()].sort().join(', ') || '(none)');

console.log(`\n✅ ALL ${pass} standalone-graph checks passed.`);
