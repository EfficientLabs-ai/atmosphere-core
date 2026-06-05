# StratosAgent — Architecture

**Date:** 2026-06-06 · **Status:** package architecture (CURRENT vs TARGET, file-cited)

StratosAgent is the **Agent-OS layer** of the Atmosphere operating system — the *hands* that execute
tasks, select models, call tools, build skills, and organize files. It is **not an agent framework**;
it is the durable operating structure underneath agents (see the canonical decision:
`/opt/efficient-labs/context/decisions/agent-framework-abstraction-layer.md`).

This file is the package-level map. Companions in this directory: `CONTEXT_ROUTING.md`,
`MODEL_ROUTING.md`, `SELF_IMPROVEMENT_LOOP.md`. The operator-facing operating map lives at
`/opt/efficient-labs/context/architecture/stratosagent-operating-architecture.md`.

> **Honesty bar.** This package's `../../STATE_OF_REALITY.md` is the source of truth for what is
> *live on the running daemon*. This doc cites code that *exists*; it does not claim an unbuilt
> engine is live. `NORTH_STAR.md` and `STRATOS_ULTIMATE_SPEC.md` (repo root) hold the vision.

---

## The primitive

Everything is the operational unit `Workspace > Project > Workflow > Task > Subtask`, each Task folder
holding `instructions.md · tools.json · data/ · memory/ · outputs/ · traces/ · evals/ · skills/`, and
the pipeline `Input → Capture → Classify → Route → Store → Execute → Trace → Evaluate → Compress →
Improve`. The filesystem is the contract; the model is a swappable detail behind it
(`src/context/icm-workspace.js`).

---

## Source layout (what each directory is)

```
src/
  cli/          stratos-cli.js (front door), wizard.js (onboarding), demo-harness.js, probes.js
  core/         agent-config.js (prefs/secrets two-tier), config.js, identity.js, languages.js,
                wasm-hot-loader.js, wasm-sections.js
  pipeline/     engine.js (folder-stage planner/executor), stage-runners.js (injected runners)
  context/      icm-workspace.js (the 5-layer "folders over agents" workspace contract)
  routing/      model-router.js (one sovereign router), mesh-signal.js (real fleet.json signal)
  exec/         runner.js, job-policy.js (sanitizer), controller-identity.js (signed receipts)
  execution/    wasi-sandbox.js (WASI isolation + egress firewall)
  evolution/    self-evolution.js, skill-induction.js, skill-executor.js, trace-analyzer.js,
                night-shift-compiler.js  (the skill-builder loop)
  skills/       skill-md.js (SKILL.md portability), skill-store.js (imported-skill index)
  memory/       fts-memory.js (FTS5), vector-bank.js (LanceDB), user-model.js (dialectic),
                skill-seal.js (PQC seal), p2p-skill-sync.js, telemetry-exporter.js
  security/     capability-gate.js, egress-policy.js, quantum-crypto.js (ML-DSA/ML-KEM),
                vault-host.js, did-generator.js, audit-zeroization.js
  identity/     identity-broker.js (IDJAG short-lived scoped tokens)
  ledger/       capability-receipt.js (signed proof rail), attribution-ledger.js (measurement)
  integrations/ composio-toolkits.js (MIT catalog), composio-exec.js (sovereign executor), oauth, creds
  connectors/   connector-registry.js, broker-core.js, broker-process.js, mcp-stdio-transport.js,
                vault.js, write-approval.js, safe-env.js
  sensory/      voice-engine.js (Piper TTS / local STT+vision), audio-*
  content/      content-engine.js (sovereign content pipeline)
  ingestion/    genesis-harvester.js, unified-dispatcher.js, claw-translator.js, legacy-bridge.js
gsi-compiler.js     WAT→WASM skill compiler + full-module PQC seal
reasoning-bank.js   reasoning trace store (confirmed in use)
index.js            public exports
```

---

## Layered view

```
                       ┌───────────────────────────────────────────────┐
   FRONT DOOR          │  cli/stratos-cli.js · wizard.js                │  CURRENT
                       └───────────────────────────────────────────────┘
                                          │
   PLAN  ──────────────  pipeline/engine.js (folder-stage; freshness model)   CURRENT
                         LLM goal→tree planner                                 TARGET
                                          │
   ROUTE  ─────────────  routing/model-router.js (local-default, privacy,     CURRENT
                         opt-in cloud) · routing/mesh-signal.js
                                          │
   EXECUTE  ───────────  pipeline/stage-runners.js (trusted first-party)      CURRENT
                         exec/runner.js → execution/wasi-sandbox.js (untrusted)CURRENT
                         evolution/skill-executor.js (verify-before-run WASM)  CURRENT
                         subagent spawn / self-repair loop                     TARGET
                                          │
   TOOLS  ─────────────  integrations/composio-* · connectors/* ·             CURRENT
                         identity/identity-broker.js · write-approval.js
                                          │
   MEMORY  ────────────  memory/fts-memory.js · vector-bank.js · user-model.js CURRENT
                         unified memory graph + Task/memory/ live store        TARGET
                                          │
   TRACE/PROOF  ───────  ledger/capability-receipt.js (PQC, hash-chained)     CURRENT
                         ledger/attribution-ledger.js (measurement)           CURRENT
                         full TRACE_SCHEMA trace-engine                        TARGET
                                          │
   EVAL  ──────────────  evolution/trace-analyzer.js (success-rate gate)      CURRENT (narrow)
                         full eval-engine (scored rubric per task)            TARGET
                                          │
   IMPROVE  ───────────  evolution/self-evolution.js (OBSERVE→LEARN→          CURRENT (numeric class,
                         DISTRIBUTE→VERIFY→EXECUTE) · gsi-compiler.js          flag-gated, OFF default)
```

---

## Security spine (cross-cutting, CURRENT)

Deny-by-default everywhere (`/opt/efficient-labs/governance/`):

- **Capability gate** (`src/security/capability-gate.js`) — a signed skill may do ONLY what its
  PQC-sealed manifest declares (compute/actions/net/fs/secrets; absent ⇒ denied). Editing the caps
  breaks the seal.
- **Egress firewall** (`src/security/egress-policy.js`) — default-DENY, fail-closed; effective
  allowlist = intersection of skill `net` caps ∧ host policy.
- **Identity broker** (`src/identity/identity-broker.js`) — mints short-lived, audience-bound, scoped
  tokens; the agent never holds a raw credential.
- **Vault** (`src/connectors/vault.js`, `src/security/vault-host.js`) — secrets sealed, opaque
  handles only in config/registry; `resolveSecret` is the single privileged plaintext path, never
  called by the model.
- **Write gate** (`src/connectors/write-approval.js`) — outward writes need explicit human approval
  (nonce-bound, single-use, TTL, tamper-evident).
- **PQC** (`src/security/quantum-crypto.js`) — real `@noble/post-quantum` ML-DSA-65 + ML-KEM-768
  (FIPS 203/204), hybrid with Ed25519; both must verify.
- **Proof rail** (`src/ledger/capability-receipt.js`) — every inference / verified skill-run emits a
  signed, hash-chained receipt verifiable with only the node's public key (hashes, never content).

---

## Honest current-vs-target summary

**CURRENT (in code, cited):** CLI front door · folder-stage plan/execute engine with freshness ·
one sovereign local-default router + real mesh signal · sandboxed job runner with signed receipts ·
verify-before-execute WASM skills · sovereign Composio tool execution + connector/MCP broker + human
write gate · FTS5 + LanceDB + dialectic user-model memory · capability gate / egress firewall /
identity broker / vault / PQC security spine · attribution ledger + capability receipt · the
self-evolution skill-builder loop (numeric-transform class, flag-gated OFF by default).

**TARGET (specified, not built):** LLM goal→task-tree planner · subagent spawn/fan-out/join ·
autonomous self-repair loop · the full `atmos-core` engines (context-capture, trace-engine,
eval-engine, memory graph) as first-class · the unified model-adapter interface with per-provider
notes · per-task `tools.json` resolution against a full `/mcp` registry.
