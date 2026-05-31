/**
 * build-product.mjs — assemble a public Efficient Labs distributable FROM the private monorepo
 * (Codex CRITICAL #4 + HIGH #5). One parameterized pipeline, a registry of PRODUCTS:
 *   - @efficientlabs/stratos     — the agent (api-shim + stratos-agent), mesh-free
 *   - @efficientlabs/atmosphere  — the mesh node (atmos-core + vendored ghost-node verifier)
 *
 * For each product: allowlist-assemble the source package(s) as SIBLINGS (so existing relative
 * cross-imports resolve unchanged), vendor any extra files the bin needs, generate one root
 * package.json with PRUNED + BANNED-checked deps, HARD-REJECT secrets/local-state, run the
 * anonymization gate for public products, and emit a provenance manifest.
 *
 *   node scripts/build-product.mjs [stratos|atmosphere]            # dry-run plan
 *   node scripts/build-product.mjs [stratos|atmosphere] --out DIR  # assemble (fails closed)
 *
 * Nothing here pushes or publishes — that stays an operator-gated step.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkAnonymization } from './check-anonymization.mjs';

export const BUILD_VERSION = '1.0.0-assembler2';
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Filesystem secret scan = HIGH-CONFIDENCE key shapes ONLY (NOT the chat secret-guard, which
// false-positives on source like `const traditionalSecret =` / `apiKey: process.env...`).
const STRICT_SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/, /sk-proj-[A-Za-z0-9_-]{20,}/, /\bAIza[A-Za-z0-9_-]{35}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/, /\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
];
const hasStrictSecret = (t) => STRICT_SECRET_PATTERNS.some((re) => re.test(t));

// ---- Product registry --------------------------------------------------------------------------
const PRODUCTS = {
  stratos: {
    name: '@efficientlabs/stratos',
    description: 'StratosAgent — your sovereign, local-first AI agent. Runs on your hardware (local or BYOK); The Atmosphere mesh is an optional add-on.',
    sources: ['api-shim', 'stratos-agent'],
    bin: { stratos: 'stratos-agent/bin/stratos.js' },
    exports: { '.': './api-shim/index.js', './cli': './stratos-agent/src/cli/stratos-cli.js' },
    deps: {
      express: '^4.19.2', cors: '^2.8.5', 'body-parser': '^1.20.2', 'node-fetch': '^3.3.2',
      'node-telegram-bot-api': '^0.66.0', '@lancedb/lancedb': '^0.29.0', '@noble/post-quantum': '^0.6.1',
      'apache-arrow': '^18.1.0', wabt: '^1.0.39',
    },
    optionalDeps: { 'node-cron': '^4.2.1' },
    banned: ['hyperswarm', 'corestore', 'autobase', 'hypercore', 'sodium-universal', 'playwright-core', 'playwright', 'atmos-core'],
    vendor: [],
    public: true,
  },
  atmosphere: {
    name: '@efficientlabs/atmosphere',
    description: 'The Atmosphere — sovereign P2P compute mesh node. Joins the public Hyperswarm DHT via NAT hole-punch (no open ports) and runs ONLY post-quantum-verified skills (ML-DSA-65 + Ed25519).',
    sources: ['atmos-core'],
    bin: { 'atmos-ghost': 'atmos-core/ghost-node/atmos-ghost.mjs' },
    exports: { '.': './atmos-core/index.js' },
    deps: {
      '@solana/web3.js': '^1.98.4', autobase: '^6.0.0', b4a: '^1.6.4', corestore: '^6.0.0',
      hypercore: '^10.0.0', hyperswarm: '^4.7.0', 'sodium-universal': '^4.0.0', '@noble/post-quantum': '^0.6.1',
    },
    optionalDeps: {},
    banned: ['express', 'node-telegram-bot-api', '@lancedb/lancedb', 'apache-arrow', 'playwright-core', 'playwright'],
    // The ghost-node bin verifies seals via sibling ./quantum-crypto.js + ./wasm-sections.js, which the
    // platform-bundle build vendors from stratos-agent. Vendor them so the npm bin resolves too.
    vendor: [
      { from: 'packages/stratos-agent/src/core/wasm-sections.js', to: 'atmos-core/ghost-node/wasm-sections.js' },
      { from: 'packages/stratos-agent/src/security/quantum-crypto.js', to: 'atmos-core/ghost-node/quantum-crypto.js' },
    ],
    // Exclude ghost-node BUILD/OPS tooling (references build-host paths; produces the separate
    // per-platform zip bundles, not needed to run a node via the npm bin).
    skipExtra: (rel) => /(^|\/)ghost-node\/(build\.sh|sign-bundles\.sh|HA\.md|SIGNING\.md|install-unix\.sh|install-windows\.ps1|atmos-ghost\.(cmd|sh)|relay(\/|$))/.test(rel) || rel.endsWith('.ps1'),
    public: true,
  },
};
// Back-compat export used by the stratos smoke test.
export const BANNED_DEPS = PRODUCTS.stratos.banned;

// ---- copy / scan helpers -----------------------------------------------------------------------
const SKIP_DIR = new Set(['node_modules', '.git', '.stratos-profile', '.secrets-vault', 'dist', 'runs', 'temp_audio', 'pipelines']);
function skipFile(name) {
  return /^test[-.]/.test(name) || /\.(test|spec)\.(m?js)$/.test(name) || name === 'test.js'
    || name.startsWith('.env') || name.endsWith('.log') || name.endsWith('.key') || name.endsWith('.pem')
    || name.endsWith('.pat') || name === '.DS_Store';
}
const FORBIDDEN_RE = /(^|\/)(\.env|\.secrets-vault|\.stratos-profile)|\.(key|pem|pat)$/i;

function copyTree(srcDir, dstDir, outDir, copied, skipExtra) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    const rel = path.relative(outDir, dst);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      if (skipExtra && skipExtra(rel + '/')) continue;
      copyTree(src, dst, outDir, copied, skipExtra);
    } else if (entry.isFile()) {
      if (skipFile(entry.name)) continue;
      if (skipExtra && skipExtra(rel)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(rel);
    }
  }
}

/** Recursively scan a staged tree: forbidden filenames + high-confidence secret content. */
export function scanTree(dir) {
  const violations = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) { walk(p); continue; }
      if (FORBIDDEN_RE.test('/' + rel)) { violations.push(`forbidden file: ${rel}`); continue; }
      if (/\.(js|mjs|cjs|json|md|sh|txt|ya?ml|env)$/i.test(e.name)) {
        try { if (hasStrictSecret(fs.readFileSync(p, 'utf8'))) violations.push(`secret-shaped content: ${rel}`); } catch { /* */ }
      }
    }
  };
  walk(dir);
  return violations;
}

function sourceCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; }
}

function generatePackageJson(p, version) {
  return {
    name: p.name, version, description: p.description, type: 'module',
    bin: p.bin, exports: p.exports,
    files: [...new Set(p.sources.map((s) => s + '/')), 'README.md', 'LICENSE', 'provenance.json'],
    engines: { node: '>=18' },
    dependencies: { ...p.deps },
    optionalDependencies: { ...p.optionalDeps },
    license: 'SEE LICENSE IN LICENSE',
    publishConfig: { access: 'public' },
  };
}

function generateReadme(p, version) {
  const installLine = Object.keys(p.bin)[0];
  return `# ${p.name}

${p.description}

## Install
\`\`\`sh
npm i -g ${p.name}@${version}
${installLine} --help
\`\`\`

This package contains no fabricated status or metrics; commands report only what they measure.
_Assembled from the Efficient Labs private upstream — see \`provenance.json\` for the source commit._
`;
}

/** Assemble a product into outDir (or just plan if outDir is null). Throws on any gate violation. */
export function assembleProduct({ product = 'stratos', outDir = null, version = '0.0.0' } = {}) {
  const p = PRODUCTS[product];
  if (!p) throw new Error(`unknown product "${product}" (have: ${Object.keys(PRODUCTS).join(', ')})`);
  const pkg = generatePackageJson(p, version);
  for (const banned of p.banned) {
    if (pkg.dependencies[banned] || pkg.optionalDependencies[banned]) throw new Error(`BANNED dep in ${p.name}: ${banned}`);
  }
  const plan = { product, name: p.name, version, sources: p.sources, deps: Object.keys(pkg.dependencies), optionalDeps: Object.keys(pkg.optionalDependencies), public: !!p.public, outDir };
  if (!outDir) return { ...plan, dryRun: true };

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const s of p.sources) copyTree(path.join(ROOT, 'packages', s), path.join(outDir, s), outDir, copied, p.skipExtra);
  // Vendor extra files the bin needs.
  for (const v of (p.vendor || [])) {
    const dst = path.join(outDir, v.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, v.from), dst);
    copied.push(v.to);
  }

  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'README.md'), generateReadme(p, version));
  // Guard the product repo: a stray `npm pack` .tgz / node_modules must never be committed.
  fs.writeFileSync(path.join(outDir, '.gitignore'), '*.tgz\nnode_modules/\n.stratos-profile/\ndist/\n');
  const lic = path.join(ROOT, 'LICENSE');
  fs.writeFileSync(path.join(outDir, 'LICENSE'), fs.existsSync(lic) ? fs.readFileSync(lic) : 'Copyright (c) Efficient Labs. All rights reserved.\n');

  // HARD GATES (abort before provenance): secrets/forbidden files, then anonymization for public pkgs.
  const violations = scanTree(outDir);
  if (p.public) violations.push(...checkAnonymization(outDir).map((v) => `anonymization: ${v}`));
  if (violations.length) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw new Error(`assembly REJECTED — ${violations.length} violation(s):\n  - ${violations.join('\n  - ')}`);
  }

  const hashes = {};
  for (const f of copied.sort()) {
    try { hashes[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(outDir, f))).digest('hex').slice(0, 16); } catch { /* */ }
  }
  fs.writeFileSync(path.join(outDir, 'provenance.json'), JSON.stringify({ product: p.name, version, sourceCommit: sourceCommit(), buildScript: BUILD_VERSION, fileCount: copied.length, hashes }, null, 2) + '\n');
  return { ...plan, fileCount: copied.length, violations: 0, sourceCommit: sourceCommit() };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const product = args.find((a) => !a.startsWith('--') && PRODUCTS[a]) || 'stratos';
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
  const version = (args.includes('--version') ? args[args.indexOf('--version') + 1] : null) || '1.0.0';
  try {
    const r = assembleProduct({ product, outDir, version });
    if (r.dryRun) {
      console.log(`📦 ${r.name}@${r.version} (dry-run)\n  sources: ${r.sources.join(', ')}\n  deps: ${r.deps.join(', ')}\n  optional: ${r.optionalDeps.join(', ') || '(none)'}\n  public-gated: ${r.public}\n  → pass --out <dir> to assemble.`);
    } else {
      console.log(`✅ assembled ${r.name}@${r.version} → ${outDir}\n   ${r.fileCount} files, 0 violations, source ${r.sourceCommit.slice(0, 12)}`);
      console.log('   Next (operator-gated): cd ' + outDir + ' && npm pack   # inspect; npm publish is a deliberate release step.');
    }
  } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
}
