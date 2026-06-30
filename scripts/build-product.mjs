/**
 * build-product.mjs — assemble a public Efficient Labs distributable FROM the private monorepo
 * (Codex CRITICAL #4 + HIGH #5). One parameterized pipeline, a registry of PRODUCTS:
 *   - @efficientlabs/stratos     — the agent (api-shim + stratos-agent), mesh-free
 *   - @efficientlabs/atmosphere  — the mesh node (atmos-core + vendored node-runner verifier)
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
      'node-telegram-bot-api': '^1.1.2', '@lancedb/lancedb': '^0.29.0', '@noble/post-quantum': '^0.6.1',
      'apache-arrow': '^18.1.0',
    },
    optionalDeps: {},
    banned: ['hyperswarm', 'corestore', 'autobase', 'hypercore', 'sodium-universal', 'playwright-core', 'playwright', 'atmos-core', 'wabt', 'node-cron'],
    vendor: [{ from: 'scripts/install.sh', to: 'install.sh' }], // curl-able installer at the repo root
    extraFiles: ['install.sh'],
    // PROPRIETARY MOAT — kept private, NOT shipped in the public client (A+B split). The learning /
    // federated-skill-evolution engine + data flywheel + the full-SDK barrel. The api-shim seam loads
    // the engine lazily, so the client runs fine without it.
    excludePaths: (rel) => /(^|\/)stratos-agent\/(src\/evolution\/|gsi-compiler\.js|gsi-scheduler\.js|reasoning-bank\.js|src\/ingestion\/genesis-harvester\.js|index\.js)$/.test(rel),
    license: 'BUSL-1.1',
    public: true,
  },
  atmosphere: {
    name: '@efficientlabs/atmosphere',
    description: 'The Atmosphere — sovereign P2P compute mesh node. Joins the public Hyperswarm DHT via NAT hole-punch (no open ports) and runs ONLY post-quantum-verified skills (ML-DSA-65 + Ed25519).',
    sources: ['atmos-core'],
    bin: { 'atmos-node': 'atmos-core/node-runner/mesh-node.mjs' },
    exports: { '.': './atmos-core/index.js' },
    deps: {
      '@solana/web3.js': '^1.98.4', autobase: '^6.0.0', b4a: '^1.6.4', corestore: '^6.0.0',
      hypercore: '^10.0.0', hyperswarm: '^4.7.0', 'sodium-universal': '^4.0.0', '@noble/post-quantum': '^0.6.1',
    },
    optionalDeps: {},
    banned: ['express', 'node-telegram-bot-api', '@lancedb/lancedb', 'apache-arrow', 'playwright-core', 'playwright'],
    // The mesh-node bin verifies seals via sibling ./quantum-crypto.js + ./wasm-sections.js, which the
    // platform-bundle build vendors from stratos-agent. Vendor them so the npm bin resolves too.
    vendor: [
      { from: 'packages/stratos-agent/src/core/wasm-sections.js', to: 'atmos-core/node-runner/wasm-sections.js' },
      { from: 'packages/stratos-agent/src/security/quantum-crypto.js', to: 'atmos-core/node-runner/quantum-crypto.js' },
      // p2p-network.js + lattice-messaging.js need these shared security primitives (full closure:
      // did-generator, quantum-crypto, vault-host — all self-contained on node + @noble).
      { from: 'packages/stratos-agent/src/security/did-generator.js', to: 'stratos-agent/src/security/did-generator.js' },
      { from: 'packages/stratos-agent/src/security/quantum-crypto.js', to: 'stratos-agent/src/security/quantum-crypto.js' },
      { from: 'packages/stratos-agent/src/security/vault-host.js', to: 'stratos-agent/src/security/vault-host.js' },
    ],
    // Exclude any build/ops tooling (references build-host paths; produces the separate
    // per-platform zip bundles, not needed to run a node via the npm bin).
    skipExtra: (rel) => /(^|\/)node-runner\/(build\.sh|sign-bundles\.sh|HA\.md|SIGNING\.md|install-unix\.sh|install-windows\.ps1|relay(\/|$))/.test(rel) || rel.endsWith('.ps1'),
    // PROPRIETARY MOAT — the economic/settlement engine (business-model mechanics) stays private;
    // mesh-demo.mjs is a standalone demo that references private moat modules + cross-package files.
    excludePaths: (rel) => /(^|\/)atmos-core\/src\/billing(\/|$)/.test(rel) || /(^|\/)atmos-core\/mesh-demo\.mjs$/.test(rel),
    // The barrel re-exports + describes the (now-private) economic engine; strip the whole block so
    // the public entrypoint resolves AND the settlement architecture isn't described in public source.
    // (The lightweight X402InvoiceEngine export on the next line is kept.)
    patches: [{ file: 'atmos-core/index.js', removeLine: /PaymentEngine|payment test suites|invoice signer\. Previously|silently exported the lighter/ }],
    license: 'BUSL-1.1',
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
    files: [...new Set(p.sources.map((s) => s + '/')), ...(p.extraFiles || []), 'README.md', 'LICENSE', 'provenance.json'],
    engines: { node: '>=18' },
    dependencies: { ...p.deps },
    optionalDependencies: { ...p.optionalDeps },
    license: p.license || 'SEE LICENSE IN LICENSE',
    publishConfig: { access: 'public' },
  };
}

const PRODUCT_SOFTWARE = { '@efficientlabs/stratos': 'StratosAgent', '@efficientlabs/atmosphere': 'The Atmosphere' };
function generateLicense(p) {
  const software = PRODUCT_SOFTWARE[p.name] || p.name;
  return `Business Source License 1.1

Licensor: Efficient Labs
Software: ${software}
Change Date: May 29, 2030
Change License: Apache License, Version 2.0
Additional Use Grant: You may use the Licensed Work for any non-production purpose. For production purposes, you may use the Licensed Work only as part of Atmosphere Network and StratosAgent deployments.

Terms of the License

1. Grant of License. The Licensor hereby grants you the right to copy and modify the Software, and to use the Software, solely for the purposes permitted under the Additional Use Grant.

2. Change of License. Effective on the Change Date, the Licensor hereby grants you a license to use, copy, modify, and distribute the Software under the terms of the Change License.

3. Termination. This License and your rights under it terminate automatically if you breach any of its terms.

4. Intellectual Property. The Licensor reserves all rights not expressly granted under this License. This Software is the proprietary work of Efficient Labs; the published portion is a subset, and Efficient Labs retains all rights in its private components, methods, and business processes.

5. Disclaimer of Warranty. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

Portions of this Software incorporate forks of libraries originally created by Holepunch
(Copyright (c) Holepunch), used under their respective licenses. Those components retain their
original license terms.
`;
}

// Static-import resolution gate: every relative import in the assembled tree must resolve to an
// existing file. Catches a moat exclusion that would break a SHIPPED file. Dynamic import() (lazy /
// optional, e.g. the proprietary engine seam) is intentionally exempt — those may be absent.
const STATIC_IMPORT_RE = /(?:^|\s)(?:import|export)\b[^;'"]*?\sfrom\s*['"](\.[^'"]+)['"]|(?:^|[^.\w])import\s*['"](\.[^'"]+)['"]/g;
export function checkDanglingImports(dir) {
  const dangling = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const pth = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(pth); continue; }
      if (!/\.(m?js|cjs)$/.test(e.name)) continue;
      const src = fs.readFileSync(pth, 'utf8');
      let m;
      const re = new RegExp(STATIC_IMPORT_RE.source, 'g');
      while ((m = re.exec(src)) !== null) {
        const spec = m[1] || m[2];
        if (!spec) continue;
        let target = path.resolve(path.dirname(pth), spec);
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.js');
        if (!fs.existsSync(target) && fs.existsSync(target + '.js')) target += '.js';
        if (!fs.existsSync(target)) dangling.push(`${path.relative(dir, pth)} → ${spec}`);
      }
    }
  };
  walk(dir);
  return dangling;
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
  // Combine ops-skip + proprietary moat-exclude into one predicate.
  const skip = (rel) => (p.skipExtra && p.skipExtra(rel)) || (p.excludePaths && p.excludePaths(rel));
  for (const s of p.sources) copyTree(path.join(ROOT, 'packages', s), path.join(outDir, s), outDir, copied, skip);
  // Vendor extra files the bin needs.
  for (const v of (p.vendor || [])) {
    const dst = path.join(outDir, v.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, v.from), dst);
    copied.push(v.to);
  }
  // Apply patches (e.g. drop a re-export of a now-private module from a kept barrel).
  for (const pt of (p.patches || [])) {
    const fp = path.join(outDir, pt.file);
    if (fs.existsSync(fp) && pt.removeLine) {
      fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').split('\n').filter((l) => !pt.removeLine.test(l)).join('\n'));
    }
  }

  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'README.md'), generateReadme(p, version));
  // Guard the product repo: a stray `npm pack` .tgz / node_modules must never be committed.
  fs.writeFileSync(path.join(outDir, '.gitignore'), '*.tgz\nnode_modules/\n.stratos-profile/\ndist/\n');
  fs.writeFileSync(path.join(outDir, 'LICENSE'), generateLicense(p));

  // HARD GATES (abort before provenance): secrets, anonymization (public), dangling imports.
  const violations = scanTree(outDir);
  if (p.public) violations.push(...checkAnonymization(outDir).map((v) => `anonymization: ${v}`));
  violations.push(...checkDanglingImports(outDir).map((v) => `dangling import (moat-exclude broke a shipped file): ${v}`));
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
