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
  // NODE HEARTBEAT (B5 2026-06-12) — periodic local liveness telemetry for the mesh node (no
  // endpoint by design; a stale file IS the alarm). Hermetic: tmp files, injected counters.
  'atmos-core': ['test-node-heartbeat.mjs'],
  'api-shim': [
    'test-discord-adapter.mjs', 'test-slack-adapter.mjs', 'test-matrix-adapter.mjs', 'test-signal-adapter.mjs',
    'test-compliance-gateway.mjs', 'test-compliance-router.mjs', 'test-language-gateway.mjs', 'test-secret-guard.mjs',
    'test-anthropic-adapter.mjs', 'test-model-manager.mjs', 'test-memory-window.mjs', 'test-config-intents.mjs',
    'test-content-orchestrator.mjs', 'test-standalone-graph.mjs',
    'test-local-inference-model.mjs',
    'test-no-fake-model-ids.mjs',
    'test-acp.mjs', 'test-mcp-rce.mjs', 'test-v1-messages-route.mjs', 'test-gate-failclosed.mjs', 'test-approval-flow.mjs',
    'test-gateway-auth.mjs', 'test-upstream-breaker.mjs', 'test-active-vision-honesty.mjs',
    // ATMOS TERMINAL slice 1 (2026-06-12) — read-only /term APIs: fs jail (traversal/secret-name/
    // symlink-escape deny), redacted reads + log streams, MEASURED-only metrics, receipt export
    // verifying with the PUBLIC key only, SSE client cap.
    'test-terminal-readonly.mjs',
    // ATMOS TERMINAL slice 2 (2026-06-12) — PTY sessions via injected fake backend (node-pty is an
    // optionalDependency, never required hermetically): sanitized env/cwd, single-use attach
    // tokens, ownership, ring replay, flow control, idle reaping, WS frames, signed receipts.
    'test-terminal-sessions.mjs',
    // PRODUCT API F1 (2026-06-12) — FE-unblocking read APIs + onboarding state: runtime-score
    // artifact server, receipt verify HTTP wrapper, honest single-node status, onboard/state
    // checklist (providers names-only, nothing faked). Hermetic: tmp profile, fake readers.
    'test-product-api.mjs',
    // INTELLIGENCE API F2 (2026-06-12) — compute.route dry-run (decision only, no spend) +
    // continuity store/retrieve (receipt over content HASHES only). Hermetic: real router engine,
    // real signed recorder, tmp profile.
    'test-intelligence-api.mjs',
    // ENTITLEMENT F3 (2026-06-12) — the LOCAL offline entitlement verifier (the SAFE slice of the
    // Stripe plan; no Stripe/money/signing here). Real hybrid verify; every failure falls to Free
    // Forever (fail-to-free, never fail-closed). Inert — not yet gating any route.
    'test-entitlement.mjs',
    // ENTITLEMENT GRANTING SIDE (2026-06-13, Track A slice 1) — the signer (exact inverse of the
    // verifier: byte-array hybrid sig, reserved-claim guard, round-trip + inert-snapshot parity vs
    // input-shape attacks, bounded fail-to-free read) + the read-only GET /entitlements surface +
    // the loopback CORS lockdown (unset origin → reflect none). All hermetic; dual-Codex APPROVE.
    'test-entitlement-signer.mjs', 'test-entitlements-api.mjs', 'test-gateway-cors.mjs',
    // NODE→ACCOUNT LINK (2026-06-13, Track A slice 2) — the keystone's second signed link. The
    // account-link-api route (node-side prover, fail-closed account-link receipt, private key never
    // returned) is here; the pure prover/verifier module test lives under stratos-agent below.
    'test-account-link-api.mjs',
    // CONSOLE SCOPED TOKEN (2026-06-14, CONSOLE_UI_SPEC) — the node-served console holds a short-TTL,
    // read-scoped token (minted via the master secret) INSTEAD of the master secret. Store + the
    // makeConsoleReadAuth gate (loopback-only, rebinding-refused, fall-through to strict) + mint route.
    'test-console-token.mjs',
    // LANE B (2026-06-13) — onboarding completion + remaining unified API wrappers. All hermetic:
    // tmp profiles, real hybrid keys/seal/recorder, ephemeral ports, no live services.
    //  - onboard-state: the §2 onboarding state machine (disk evidence only; export/activation
    //    honestly unobservable).
    //  - score-api: per-user GET /score — MEASURED or not_measured+reason, never synthetic.
    //  - nodes-register: POST /v1/nodes/register — mint-or-REUSE identity, registry, receipt.
    //  - workflows-api: workflow.execute — injected classifier, fail-closed, per-step receipts.
    //  - skills-publish: skill.publish — public ALWAYS refused (L5), lifecycle gate fail-closed.
    'test-onboard-state.mjs', 'test-score-api.mjs', 'test-nodes-register.mjs',
    'test-workflows-api.mjs', 'test-skills-publish.mjs',
    // sovereign router (classify() consolidated onto model-router.js; now hermetic — the LanceDB RAG
    // probe that needed a live vector store was removed in the consolidation):
    'test-task-router.js', 'test-classify-live.mjs',
    // ALIVE Telegram chat path (this session) — hermetic: the Telegram bot (sendChatAction/sendMessage/
    // editMessageText) and the Ollama NDJSON stream are mocked, with an injected clock + sleep. Covers the
    // persistent typing indicator (re-fires on interval, clears with no leak), throttled typewriter edits,
    // the >4096 split into a new message, the edit-failure → full-sendMessage fail-safe (reply never lost),
    // 429 backoff, and the streamOllamaChat NDJSON parser (incl. throw-on-non-OK for the fallback).
    // ATM-SEC-001: the bridge itself also initializes in dry-run mode without a token, network client, or
    // local vault probe.
    'test-telegram-bridge-dry-run.mjs',
    'test-telegram-streamer.mjs',
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
    'test-superintelligence-depin.js', 'test-vector-sensory.js', 'test-vector-isolation.mjs', 'test-exec-sandbox-contract.mjs',
    'test-p2p-skill-ingest.mjs', 'test-safe-env.mjs',
    // trust substrate (this session) — all hermetic: pure crypto/logic/file, no live services:
    'test-model-router.mjs', 'test-mesh-signal.mjs', 'test-stratos-route.mjs', 'test-stratos-id-ledger.mjs',
    'test-capability-gate.mjs', 'test-capability-enforcement.mjs', 'test-attribution-ledger.mjs',
    // DENIAL AUDIT (2026-06-12) — every refusal leaves a persistent, bounded, secret-safe trace:
    // node-authz audit hook · CapabilityError construction · gateway 401s · pair-ceremony failures.
    'test-denial-audit.mjs',
    'test-identity-broker.mjs', 'test-trifecta-live.mjs', 'test-icm-workspace.mjs',
    // FTS5 cross-session memory (this session) — hermetic: in-memory SQLite, injected summarizer,
    // no network/Ollama; tests the search path, conversation filter, injection-safety, degrade, gate.
    'test-fts-memory.mjs',
    // DIALECTIC USER-MODELING (this session) — "the agent that grows with you". Hermetic: in-memory
    // SQLite + an INJECTED summarizer (no Ollama/network). Covers observe-accrual (assistant turns
    // skipped), synthesis that SUPERSEDES the prior model (dialectic, not a fact-pile), capped
    // prompt-injection context, STRICT per-conversation isolation (no context bleed), fail-open on a
    // broken store/throwing summarizer, forget, and the capability-gated `stratos user show|forget` CLI.
    'test-user-model.mjs',
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
    // WALLET-AWARE MESH ATTRIBUTION (this session) — "measurement before rewards": every node's compute
    // is attributed to its owner's PUBLIC Solana wallet. Hermetic: pure crypto/regex/logic, no network/
    // Ollama/keys-on-disk. Covers Solana base58 validation (accept valid, reject malformed/injection),
    // the runtime flag>config>unattributed resolution contract, owner_wallet carried IN the signed +
    // hash-chained receipt body (signs/verifies/tamper-detects via both hash and PQC sig), per-wallet
    // summarize aggregation (measurement only, no price/payout), and two wallets attributed separately.
    'test-wallet-attribution.mjs',
    // "$0 bill" WIRED VERTICAL-SLICE demo (this session) — hermetic: the gateway fetch is MOCKED and the
    // node keypair is INJECTED, so it tests the end-to-end slice (real-response contract, sovereign-local
    // decision, signed receipt verified with the public key only, honest $0-vs-illustrative-cloud bill,
    // and the down-daemon degrade) with no live daemon, no Ollama, no on-disk keys. The CLI test also
    // covers `stratos demo` output, --json, --prompt, the capability gate (deny-by-default), and help.
    'test-demo-harness.mjs', 'test-stratos-demo.mjs',
    // POLICY-AS-CODE EGRESS FIREWALL (this session) — hermetic: pure policy parse/match + the WASI
    // sandbox's composed (caps ∩ host-policy) egress check + the `stratos egress` CLI. No network, no
    // live services. Covers default-DENY, fail-closed on malformed/missing policy, SAFE suffix matching
    // with anti-spoofing (evil-github.com / x.github.com.evil.com → DENY), per-method/path granularity,
    // caps∩policy intersection both directions, hot-reload on mtime change, the env-allowlist discipline,
    // and the capability-gated CLI (deny-by-default).
    'test-egress-policy.mjs', 'test-egress-sandbox.mjs', 'test-stratos-egress.mjs',
    // REUSABLE CONTENT ENGINE (this session) — the personal-brand + company content pipeline. Hermetic:
    // a TEMP private content dir, an INJECTED model fetch (no live daemon/Ollama/network), injected
    // build-log + clock. Covers angle selection skipping used angles, per-platform structure assembly from
    // the mocked model JSON, used.json updates (re-run → fresh, no repeats), build-log self-grow, the
    // capability gate (deny-by-default), the honest fail-open degrade when the model is down (no fabrication),
    // and the missing-profile/help guards. The tool is generic; the profile + batches stay PRIVATE off-repo.
    'test-content-engine.mjs',
    // SOVEREIGN COMPOSIO ADAPTER (Path A) — 1000+ integration surface from Composio's MIT toolkit
    // catalog, run on OUR stack (vault + identity-broker + capability-gate). Hermetic: the APP API
    // (fetch) is MOCKED, the vault is a real encrypted-at-rest store in a TEMP dir, the broker is real.
    // NO composio.dev. Covers MIT-catalog load (1000 toolkits), getAction spec resolution, GitHub
    // end-to-end (PAT→api.github.com, token NEVER returned), capability-gate deny-by-default, per-entity
    // isolation, zero-composio.dev, the OAuth scaffold (provider-only exchange + operator-config gating),
    // connector-registry registration, and the `stratos tool list/run` CLI.
    'test-composio-sovereign.mjs',
    // FILES-FIRST OPERATING CORE (Increment 1) — the durable operational map: workspace-tree +
    // context-capture + trace-engine. Hermetic: pure fs/crypto in an isolated tmp dir, in-process
    // keypair (no on-disk keys), no network/Ollama/daemon. Covers the 8-entry task scaffold +
    // path-traversal rejection + idempotency, capture() matching every CONTEXT_CAPTURE_SCHEMA field
    // (raw→data/, record→memory/, workspace session log) + deterministic classify() + the off-by-
    // default LLM-assist hook, the TRACE_SCHEMA record + a receipt-chained tamper-evident spine that
    // verifies with the public key only + fail-closed tamper detection + fail-open emission, and the
    // capability-gated `stratos workspace|task|capture|trace` CLI (deny-by-default).
    'test-operating-core.mjs',
    // EVAL-ENGINE (Increment 2) — the trace→evaluation→lesson hop. Hermetic: pure fs/crypto in an
    // isolated tmp dir, in-process keypair (no on-disk keys), no network/Ollama/daemon. Covers
    // evaluate() writing evals/{id}.md + .json (EvalRecord shape), the deterministic default rubric
    // (clean ok-trace PASSES; error-step/no-outputs FAILS the right criteria; cost-budget), the
    // TRACE-INTEGRITY verify-as-a-criterion (PASSES for a verifying receipt, FAILS CLOSED for a
    // tampered trace/receipt, never passes unverified), the bidirectional eval↔trace link, candidate
    // lessons per failed criterion, determinism (same input → same score), the off-by-default LLM-judge
    // hook (throwing judge degrades, never fabricates), input validation, and the gated `stratos eval` CLI.
    'test-eval-engine.mjs',
    // SELF-IMPROVEMENT COMPRESSION (Increment 3) — the closing loop trace→eval→lesson→instruction→skill.
    // Hermetic: pure fs/crypto in an isolated tmp dir, in-process keypair (no on-disk keys), no network/
    // Ollama/daemon. Covers a FAILED eval distilling a lesson + appending its suggested_instruction to
    // instructions.md with IDEMPOTENT re-runs (no duplicate, applied-id ledger), a PASSED eval scaffolding
    // a reusable skill (skill.md + examples/ + tools.json) in the EXISTING SKILL.md format that the
    // existing SkillStore loads back (a failed run never promotes a skill), determinism (same input → same
    // lesson), the off-by-default distiller hook (throwing degrades, never fabricates), input validation,
    // and the capability-gated `stratos improve` CLI (deny-by-default).
    'test-self-improve.mjs',
    // MODEL-AGNOSTIC ROUTING (Increment 4) — the unified model-adapter seam over the EXISTING
    // model-router.js (wraps route(), does not fork it). Hermetic: injected FAKE provider adapters,
    // NO network anywhere (each provider's call() is a local stub). Proves the policy precedence
    // Privacy > Capability > Cost > Fallback: a private task never reaches a frontier provider even
    // with a key+mesh, a high-reasoning class routes to frontier (when the router allows cloud) while
    // batch/extraction stays open-weight/local, the cheaper/$0-local provider wins within an acceptable
    // tier, provider error/timeout degrades along the chain logging each hop (deterministic, exhausted
    // chain fails honestly with the full hop log), and a user-provided model plugs into the SAME
    // interface + precedence with no special path. Policy docs: /opt/efficient-labs/models/routing/.
    'test-model-adapter.mjs',
    // OPERATING-CORE TAP (Increment 5, final) — the flag-gated, DEFAULT-OFF, FAIL-OPEN observational
    // wrap that wires the operating core into the live request path. Hermetic: pure fs/crypto in an
    // isolated tmp dir, in-process injected keypair (no on-disk keys), no network/Ollama/daemon. Covers
    // the disabled path being a byte-identical no-op (exact result returned, thrown error unchanged,
    // ZERO fs writes, operating core never touched), the enabled path writing a capture + a receipt-
    // chained trace (verifying with the public key only) for a success AND a result:"error" trace for a
    // thrown exec while the error still propagates unchanged, FAIL-OPEN (an injected capture that throws
    // still returns exec()'s result), exec()-called-exactly-once, input validation, and determinism.
    'test-operating-tap.mjs',
    // LIVE RECEIPT TAP (P1 residue closed 2026-06-11) — the daemon-shaped DEFAULT path: observe() with
    // NOTHING injected mints signed, public-key-verifiable, appending receipts into STRATOS_RECEIPTS and
    // stays fail-open on an unwritable path. Supervised child, 60s cap. Previously excluded as "hangs":
    // the old unwritable path lived under /proc, where mkdir can BLOCK uninterruptibly (hidepid procfs
    // mounts) instead of returning EPERM — the path choice hung, not the tap. Now uses a portable
    // ENOTDIR blocker (a file used as a directory) and completes in <1s.
    'test-live-receipts.mjs',
    // GATE 2 — OWNER IDENTITY + NODE PAIRING (2026-06-11). Hermetic: in-process hybrid keypairs,
    // tmp profile dirs, the real CLI driven via spawnSync (two devices simulated as two dirs).
    // Proves the explicit ceremony end to end: signed self-certifying request · approve REFUSES
    // without/with-wrong fingerprint (the human comparison IS the trust step — no blind TOFU) ·
    // grant signed by the owner suite · accept verifies BOTH signature halves and PINS the owner
    // key · pinned owner rejects a foreign (internally-valid) grant · runtime storage round-trips.
    'test-owner-pairing.mjs',
    // PAIRING RECEIPT (2026-06-13, Lane B) — a successful `pair accept` appends a signed
    // action:'pairing' receipt (the onboarding step-3 evidence artifact); refusals mint nothing;
    // the chain stays third-party verifiable. Hermetic: real CLI in tmp dirs, STRATOS_RECEIPTS
    // pinned to a tmp file.
    'test-pairing-receipt.mjs',
    // GATE 2b — MESH AUTHORIZATION + REVOCATION (2026-06-11). Deny-by-default command authorization
    // against the device trust set: owner + paired nodes authorized; unknown/revoked/tampered/
    // stale/replayed/impersonating senders DENIED; owner-signed revocations are peer-verifiable
    // (foreign owner + tamper fail closed). Includes a real-CLI end-to-end revoke→deny.
    'test-node-authz.mjs',
    // NODE→ACCOUNT LINK module (2026-06-13, Track A slice 2) — the pure prover/verifier. Round-trip
    // oracle: real proof verifies; tamper/wrong-account/wrong-or-replayed-challenge/stale/future/
    // DID↔key-mismatch/forged-key all fail-closed; the verifier refuses without its bindings.
    'test-account-link.mjs',
  ],
};

// Hermetic suites that live in scripts/ (not packages/) — business-automation jobs. Mocked external
// I/O (Stripe fetch + Telegram send injected), no live services, no real keys.
const SCRIPTS_SUITES = {
  'scripts': ['test-finance-digest.mjs', 'test-check-carve-sync.mjs', 'test-claim-lint.mjs'],
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
