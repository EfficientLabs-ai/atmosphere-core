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
    'test-acp.mjs', 'test-mcp-rce.mjs', 'test-v1-messages-route.mjs', 'test-gate-failclosed.mjs', 'test-approval-flow.mjs',
    'test-gateway-auth.mjs',
    // sovereign router (classify() consolidated onto model-router.js; now hermetic — the LanceDB RAG
    // probe that needed a live vector store was removed in the consolidation):
    'test-task-router.js', 'test-classify-live.mjs',
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
    'test-superintelligence-depin.js', 'test-vector-sensory.js', 'test-exec-sandbox-contract.mjs',
    'test-p2p-skill-ingest.mjs', 'test-safe-env.mjs',
    // trust substrate (this session) — all hermetic: pure crypto/logic/file, no live services:
    'test-model-router.mjs', 'test-mesh-signal.mjs', 'test-stratos-route.mjs', 'test-stratos-id-ledger.mjs',
    'test-capability-gate.mjs', 'test-capability-enforcement.mjs', 'test-attribution-ledger.mjs',
    'test-identity-broker.mjs', 'test-trifecta-live.mjs', 'test-icm-workspace.mjs',
    // FTS5 cross-session memory (this session) — hermetic: in-memory SQLite, injected summarizer,
    // no network/Ollama; tests the search path, conversation filter, injection-safety, degrade, gate.
    'test-fts-memory.mjs',
    // native local sensory surface (this session) — hermetic: all Piper/Ollama/whisper I/O is
    // injected, so it tests the talk/hear/see honesty contract + `stratos voice` gate with no
    // binaries, no network, no live Ollama.
    'test-voice-engine.mjs',
    // SKILL.md / agentskills.io portability (this session) — hermetic: pure parse/emit + deny-by-default
    // import logic + CLI gating, no network, no crypto/live services. Covers round-trip, frontmatter edge
    // cases, conservative least-privilege import, export provenance, injection/oversized guards.
    'test-skill-md.mjs',
    // SIGNED CAPABILITY RECEIPT — the cross-machine proof rail (this session). Hermetic: pure hybrid
    // PQC + hash-chain + file, no network/Ollama. Covers create→sign→verify, field-tamper + recompute-
    // hash forgery (caught by the PQC sig), remove/reorder detection, export→verifyBundle with ONLY the
    // public key, fail-CLOSED verification, fail-OPEN emission, per-actor/per-node measured-cost summary,
    // and a real SkillExecutor skill-run receipt. The CLI test covers `stratos receipt export|verify|
    // summary` incl. the capability gate (deny-by-default) and non-zero exit on a broken bundle.
    'test-capability-receipt.mjs', 'test-stratos-receipt.mjs',
    // "$0 bill" WIRED VERTICAL-SLICE demo (this session) — hermetic: the gateway fetch is MOCKED and the
    // node keypair is INJECTED, so it tests the end-to-end slice (real-response contract, sovereign-local
    // decision, signed receipt verified with the public key only, honest $0-vs-illustrative-cloud bill,
    // and the down-daemon degrade) with no live daemon, no Ollama, no on-disk keys. The CLI test also
    // covers `stratos demo` output, --json, --prompt, the capability gate (deny-by-default), and help.
    'test-demo-harness.mjs', 'test-stratos-demo.mjs',
  ],
};

// Hermetic suites that live in scripts/ (not packages/) — business-automation jobs. Mocked external
// I/O (Stripe fetch + Telegram send injected), no live services, no real keys.
const SCRIPTS_SUITES = {
  'scripts': ['test-finance-digest.mjs'],
};

const TIMEOUT_MS = 90_000;
let total = 0, failed = 0;
const failures = [];

const PKG_BASE = (pkg) => pkg === 'scripts' ? path.join(ROOT, 'scripts') : path.join(ROOT, 'packages', pkg);

for (const [pkg, tests] of Object.entries({ ...SUITES, ...SCRIPTS_SUITES })) {
  const dir = PKG_BASE(pkg);
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
