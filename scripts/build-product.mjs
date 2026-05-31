/**
 * build-product.mjs — assemble the public `@efficientlabs/stratos` distributable FROM the private
 * monorepo (Codex CRITICAL #4 + HIGH #5). Allowlist-assemble into a clean tree, prune to runtime
 * deps (NO mesh/browser), HARD-REJECT secrets/local-state, and emit a provenance manifest.
 *
 * Layout trick: the package keeps `api-shim/` and `stratos-agent/` as SIBLINGS, so every existing
 * relative cross-import (`../../stratos-agent/...` from `api-shim/src/...`, `../../api-shim/index.js`
 * from `stratos-agent/bin/...`) resolves unchanged. One root package.json governs deps + bin.
 *
 *   node scripts/build-product.mjs            # dry-run: print plan, no writes
 *   node scripts/build-product.mjs --out DIR  # assemble into DIR (still scans + fails closed)
 *
 * Exported (assembleProduct / scanTree / BUILD_VERSION) for the smoke test; nothing here pushes or
 * publishes — that stays an operator-gated step.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Filesystem secret scan = HIGH-CONFIDENCE key shapes ONLY. We deliberately do NOT reuse the chat
// secret-guard here: its contextual `name=value` heuristic false-positives on source code
// (`const traditionalSecret = …`, `apiKey: process.env.OPENAI_API_KEY`, `'mock-…-secret'`). These
// match only actual provider key material, so a real hardcoded key still aborts the build.
const STRICT_SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,                     // Anthropic (prefix is specific; allow -/_ )
  /sk-proj-[A-Za-z0-9_-]{20,}/,                    // OpenAI project key
  /\bAIza[A-Za-z0-9_-]{35}/,                       // Google API key (fixed length)
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,                  // GitHub PAT
  /\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9-]{20,}/,     // Slack token
  /\bAKIA[0-9A-Z]{16}\b/,                          // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,            // PEM private key
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // JWT (long segments)
];
function hasStrictSecret(text) { return STRICT_SECRET_PATTERNS.some((re) => re.test(text)); }

export const BUILD_VERSION = '1.0.0-assembler1';
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// The two source packages copied as siblings into the product.
const SOURCE_PACKAGES = ['api-shim', 'stratos-agent'];

// Pruned RUNTIME deps (exactly the set proven by api-shim/test-standalone-graph.mjs). Mesh/browser
// deps are intentionally ABSENT.
const RUNTIME_DEPS = {
  express: '^4.19.2', cors: '^2.8.5', 'body-parser': '^1.20.2',
  'node-fetch': '^3.3.2', 'node-telegram-bot-api': '^0.66.0',
  '@lancedb/lancedb': '^0.29.0', '@noble/post-quantum': '^0.6.1',
  'apache-arrow': '^18.1.0', wabt: '^1.0.39',
};
const OPTIONAL_DEPS = { 'node-cron': '^4.2.1' }; // self-evolution scheduler (lazily imported)
// Must NEVER appear in the product manifest:
export const BANNED_DEPS = ['hyperswarm', 'corestore', 'autobase', 'hypercore', 'sodium-universal', 'playwright-core', 'playwright', 'atmos-core'];

// Files/dirs never copied (by basename or predicate).
const SKIP_DIR = new Set(['node_modules', '.git', '.stratos-profile', '.secrets-vault', 'dist', 'runs', 'temp_audio', 'pipelines']);
function skipFile(name) {
  return /^test[-.]/.test(name) || /\.(test|spec)\.(m?js)$/.test(name) || name === 'test.js'
    || name.startsWith('.env') || name.endsWith('.log') || name.endsWith('.key') || name.endsWith('.pem')
    || name.endsWith('.pat') || name === '.DS_Store';
}
// Names that, if present in the assembled tree, ABORT the build (defense in depth vs. the skip list).
const FORBIDDEN_RE = /(^|\/)(\.env|\.secrets-vault|\.stratos-profile)|\.(key|pem|pat)$/i;

function copyTree(srcDir, dstDir, outDir, copied) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      copyTree(src, dst, outDir, copied);
    } else if (entry.isFile()) {
      if (skipFile(entry.name)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(path.relative(outDir, dst));
    }
  }
}

/** Recursively scan a staged tree: forbidden filenames + secret-shaped file CONTENT. Returns violations. */
export function scanTree(dir) {
  const violations = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) { walk(p); continue; }
      if (FORBIDDEN_RE.test('/' + rel)) { violations.push(`forbidden file: ${rel}`); continue; }
      // high-confidence key-material scan (skip binaries by extension)
      if (/\.(js|mjs|cjs|json|md|sh|txt|ya?ml|env)$/i.test(e.name)) {
        try { if (hasStrictSecret(fs.readFileSync(p, 'utf8'))) violations.push(`secret-shaped content: ${rel}`); } catch { /* unreadable */ }
      }
    }
  };
  walk(dir);
  return violations;
}

function sourceCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; }
}

function generatePackageJson(version) {
  return {
    name: '@efficientlabs/stratos',
    version,
    description: 'StratosAgent — your sovereign, local-first AI agent. Runs on your hardware (local or BYOK); The Atmosphere mesh is an optional add-on.',
    type: 'module',
    bin: { stratos: 'stratos-agent/bin/stratos.js' },
    exports: { '.': './api-shim/index.js', './cli': './stratos-agent/src/cli/stratos-cli.js' },
    files: ['api-shim/', 'stratos-agent/', 'README.md', 'LICENSE', 'provenance.json'],
    engines: { node: '>=18' },
    dependencies: { ...RUNTIME_DEPS },
    optionalDependencies: { ...OPTIONAL_DEPS },
    license: 'SEE LICENSE IN LICENSE',
    publishConfig: { access: 'public' },
  };
}

function generateReadme(version) {
  return `# StratosAgent (\`@efficientlabs/stratos\`)

Your sovereign, local-first AI agent. Runs on **your** hardware — private and offline-capable — on a
local open-weights model (via Ollama) or a cloud model with **your own key** (BYOK). The Atmosphere
P2P mesh is an **optional** add-on; StratosAgent works fully standalone without it.

## Install
\`\`\`sh
npm i -g @efficientlabs/stratos@${version}
stratos init      # name your agent + pick a model (local-only setup)
stratos doctor    # read-only preflight — tells you exactly what's missing
stratos start     # run locally on 127.0.0.1
\`\`\`

## Honesty
This package contains no fabricated status, balances, or peers. \`stratos status\`/\`doctor\` report only
what they measure. See the project's STATE_OF_REALITY for the honest capability map.

_Assembled from the Efficient Labs private upstream — see \`provenance.json\` for the source commit._
`;
}

/** Assemble into outDir (or just plan if outDir is null). Returns a summary; throws on a scan violation. */
export function assembleProduct({ outDir = null, version = '0.0.0' } = {}) {
  const pkg = generatePackageJson(version);
  // dep sanity (defense in depth)
  for (const banned of BANNED_DEPS) {
    if (pkg.dependencies[banned] || pkg.optionalDependencies[banned]) throw new Error(`BANNED dep in manifest: ${banned}`);
  }
  const plan = { name: pkg.name, version, sources: SOURCE_PACKAGES, deps: Object.keys(pkg.dependencies), optionalDeps: Object.keys(pkg.optionalDependencies), outDir };
  if (!outDir) return { ...plan, dryRun: true };

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const p of SOURCE_PACKAGES) copyTree(path.join(ROOT, 'packages', p), path.join(outDir, p), outDir, copied);

  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'README.md'), generateReadme(version));
  const lic = path.join(ROOT, 'LICENSE');
  fs.writeFileSync(path.join(outDir, 'LICENSE'), fs.existsSync(lic) ? fs.readFileSync(lic) : 'Copyright (c) Efficient Labs. All rights reserved.\n');

  // HARD GATE: scan the assembled tree; abort on any violation BEFORE provenance is written.
  const violations = scanTree(outDir);
  if (violations.length) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw new Error(`assembly REJECTED — ${violations.length} violation(s):\n  - ${violations.join('\n  - ')}`);
  }

  // Provenance (privacy-preserving traceability: source commit + per-file hashes, no upstream history).
  const hashes = {};
  for (const f of copied.sort()) {
    const abs = path.join(outDir, f);
    try { hashes[f] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16); } catch { /* */ }
  }
  const provenance = { product: pkg.name, version, sourceCommit: sourceCommit(), buildScript: BUILD_VERSION, fileCount: copied.length, hashes };
  fs.writeFileSync(path.join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');

  return { ...plan, fileCount: copied.length, violations: 0, sourceCommit: provenance.sourceCommit };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
  const version = (args.includes('--version') ? args[args.indexOf('--version') + 1] : null) || '1.0.0';
  try {
    const r = assembleProduct({ outDir, version });
    if (r.dryRun) {
      console.log(`📦 ${r.name}@${r.version} (dry-run)\n  sources: ${r.sources.join(', ')}\n  deps: ${r.deps.join(', ')}\n  optional: ${r.optionalDeps.join(', ')}\n  → pass --out <dir> to assemble.`);
    } else {
      console.log(`✅ assembled ${r.name}@${r.version} → ${outDir}\n   ${r.fileCount} files, 0 secret/forbidden violations, source ${r.sourceCommit.slice(0, 12)}`);
      console.log('   Next (operator-gated): cd ' + outDir + ' && npm pack   # inspect the tarball; npm publish is a deliberate release step.');
    }
  } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
}
