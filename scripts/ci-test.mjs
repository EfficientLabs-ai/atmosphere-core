#!/usr/bin/env node
/**
 * ci-test.mjs — the hermetic test runner used by CI (.github/workflows/ci.yml) and `npm run test:ci`.
 *
 * It runs an EXPLICIT allowlist of tests that pass without any live service (no Ollama, no network, no
 * running daemon). Each test is spawned in its own process; any non-zero exit fails the whole run.
 *
 * Why an allowlist (not "run every test-*.js"): a few suites in this repo are integration/E2E and need
 * live services (e.g. test-deepscan-telegram, test-genesis-inference, test-stratos-refinement). Those
 * are intentionally EXCLUDED here so CI stays honest — green means "the unit/route layer is sound",
 * never a false all-clear. Add a test here only once it's verified to run hermetically.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Hermetic suites, verified green on Node 22 with no live services.
const SUITES = {
  'api-shim': [
    'test-discord-adapter.mjs', 'test-slack-adapter.mjs', 'test-matrix-adapter.mjs', 'test-signal-adapter.mjs',
    'test-compliance-gateway.mjs', 'test-compliance-router.mjs', 'test-language-gateway.mjs', 'test-secret-guard.mjs',
    'test-anthropic-adapter.mjs', 'test-model-manager.mjs', 'test-memory-window.mjs', 'test-config-intents.mjs',
    'test-content-orchestrator.mjs', 'test-standalone-graph.mjs',
    'test-acp.mjs', 'test-mcp-rce.mjs', 'test-v1-messages-route.mjs', 'test-gate-failclosed.mjs',
    // EXCLUDED (not hermetic): test-evolution-seam.mjs depends on ambient Ollama — it passes locally
    // only because this dev box runs Ollama, and fails in the clean CI runner (no inference service).
    // test-chat-memory.mjs likewise fails in the clean GitHub runner. Both are integration tests; make
    // them service-independent (inject/msk the inference call) before re-adding to the hermetic set.
  ],
  'stratos-agent': [
    'test-agent-config.mjs', 'test-broker-process.mjs', 'test-broker.mjs', 'test-connector-registry.mjs',
    'test-connector-vault.mjs', 'test-controller-identity.mjs', 'test-job-policy.mjs', 'test-mcp-stdio.mjs',
    'test-pipeline.mjs', 'test-runner.mjs', 'test-skill-seal.mjs', 'test-stratos-cli.mjs', 'test-wizard.mjs',
    'test-write-approval.mjs', 'test-chaos-pqc.js', 'test-gsi-compiler.js', 'test-quantum-ingestion.js',
    'test-superintelligence-depin.js', 'test-vector-sensory.js',
  ],
};

const TIMEOUT_MS = 90_000;
let total = 0, failed = 0;
const failures = [];

for (const [pkg, tests] of Object.entries(SUITES)) {
  const dir = path.join(ROOT, 'packages', pkg);
  console.log(`\n\x1b[1m━━ ${pkg} (${tests.length}) ━━\x1b[0m`);
  for (const t of tests) {
    total++;
    const file = path.join(dir, t);
    const r = spawnSync(process.execPath, [file], { cwd: dir, timeout: TIMEOUT_MS, encoding: 'utf8' });
    if (r.status === 0) {
      console.log(`  \x1b[32m✓\x1b[0m ${t}`);
    } else {
      failed++;
      failures.push(`${pkg}/${t}`);
      const why = r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
      const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n      ');
      console.log(`  \x1b[31m✗\x1b[0m ${t}  (${why})\n      ${tail}`);
    }
  }
}

console.log(`\n${'─'.repeat(48)}`);
if (failed === 0) {
  console.log(`\x1b[32m✅ ALL ${total} hermetic tests passed.\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m❌ ${failed}/${total} failed:\x1b[0m\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
