# ARCHITECTURE — atmosphere-core monorepo map

**Status:** living map · **Date:** 2026-06-06 · **Scope:** the whole monorepo (`~/atmosphere-core`)

This document maps the monorepo to the **operating architecture** defined in
`/opt/efficient-labs` (the operating map) and the product vision in
`context/product_vision/atmosphere-ai-operating-system.md`. It does not duplicate the per-package
internals or the audit — for those, read the canonical docs this file points to:

- [`NORTH_STAR.md`](NORTH_STAR.md) — the vision + layered (L0–L5) architecture + reverse-engineered roadmap.
- [`STATE_OF_REALITY.md`](STATE_OF_REALITY.md) — **the source of truth** for what is real vs mock (audit-verified).
- [`STATE_OF_THE_ATMOSPHERE.md`](STATE_OF_THE_ATMOSPHERE.md) — legacy Antigravity tracking manifest (read with the STATE_OF_REALITY caveat; much of it is aspirational/mock-as-done).
- [`STRATOS_ULTIMATE_SPEC.md`](STRATOS_ULTIMATE_SPEC.md) — the master spec / four pillars (TARGET document; treat as spec, not status).
- Operating map: `/opt/efficient-labs/README.md` and `context/product_vision/atmosphere-ai-operating-system.md`.

> **Honesty rule (inherited from STATE_OF_REALITY):** every capability below is tagged
> **CURRENT** (exists in code — file cited) or **TARGET** (specified, not built / not wired live).
> "Live on the running daemon" is a stricter bar than "exists in code"; where they differ this
> document follows the bar STATE_OF_REALITY uses and says so.

---

## 1. The monorepo IS the operating system layer

The thesis (`context/product_vision/atmosphere-ai-operating-system.md`): the model is the borrowed
brain; **the durable asset is the operating-system layer underneath agents** — structured context,
routing, memory, traces, skills, permissions. The three durable layers of that OS map onto packages
in this monorepo plus the web repo:

| Operating layer (vision) | Reality on disk | Role |
| :-- | :-- | :-- |
| **Core operating layer** (substrate) | `packages/stratos-agent/src/{security,ledger,memory,routing,pipeline}` (+ `packages/atmos-core`) | event/skill substrate: seal, receipt, capability gate, router, pipeline DAG |
| **Agent-OS layer** (the hands) | `packages/stratos-agent` (CLI + evolution + connectors) and `packages/api-shim` (the live daemon) | task execution, model selection, tool calling, skill acquisition, self-repair |
| **Interface layer** (the face) | `efficientlabs-web/app/app` (TheAtmosphere `/app`) | chat, workspace UI, agent-comms, skills/rewards, approval UX |

> Note on the operating map's naming: `/opt/efficient-labs/README.md` calls the core
> "`packages/atmos-core`". On disk today the real, verified substrate code (pipeline engine, skill
> seal, capability gate, receipts, router) lives under **`packages/stratos-agent/src`**, and
> `packages/atmos-core` is the integration/test surface around it. This doc points at where the
> code actually is.

---

## 2. Package map (what each workspace is)

`package.json` declares `workspaces: ["packages/*"]`. The packages and their operating-layer role:

| Package | Operating-layer role | Status |
| :-- | :-- | :-- |
| `packages/stratos-agent` | **Core substrate + Agent-OS.** The crown jewels: pipeline engine, skill seal/compiler, PQC, capability gate, attribution ledger + capability receipt, identity broker, model router, mesh signal, self-evolution, CLI. | CURRENT — see §3 |
| `packages/api-shim` | **The live daemon (`atmos-secure-bridge`, PM2, :4099).** OpenAI-compatible front door, Telegram bridge, server routes, self-evolution runtime seam, omni-channel adapters. | CURRENT (running) — see §3 |
| `packages/atmos-core` | Integration surface / tests wrapping the stratos-agent substrate. | CURRENT (integration) |
| `packages/maximus-telemetry` | Telemetry/knowledge-base service (`reasoning-bank` path). | CURRENT (degraded "LanceDB Sim" path — see STATE_OF_REALITY) |
| `packages/atmos-desktop` | Tauri desktop shell. | TARGET (scaffold) |
| `packages/efficientlabs-web` | In-repo copy/link of the web surface. | see real site at `~/efficientlabs-web` |
| `packages/forks` | BSL-1.1 forks of Holepunch primitives (hypercore/hyperswarm/corestore/autobase). | CURRENT (vendored) |

The **interface layer** lives in the *other* repo: `~/efficientlabs-web/app/app` (`/app` = TheAtmosphere
OS — `agents/ atmosphere/ integrations/ memory/ projects/ rewards/ settings/ skills/`). Both repos are
symlinked under `/opt/efficient-labs/repos/` (never moved — PM2 + git depend on the real `~` paths).

---

## 3. Operating-layer → code, with honest status

The vision's pipeline is `Input → Capture → Classify → Route → Store → Execute → Trace → Evaluate →
Compress → Improve` (`context/architecture/CONTEXT_CAPTURE_SCHEMA.md`). Mapping each stage to code:

| Pipeline stage | Code that implements it | Status |
| :-- | :-- | :-- |
| **Capture** (event → structured context) | proto-capture only: FTS memory + per-chat memory + capability receipts. `packages/stratos-agent/src/memory/vector-bank.js` (real 768-dim LanceDB), receipts in `src/ledger/`. The first-class `context-capture` engine is **not built**. | TARGET (proto-capture CURRENT) |
| **Classify / Route** | `packages/stratos-agent/src/routing/model-router.js` (one sovereign router, local-default + BYOK frontier) and `packages/api-shim/src/task-router.js` (delegates to it). Mesh routing gated by `src/routing/mesh-signal.js` (file-backed, deny-by-default). | CURRENT |
| **Store** | LanceDB (`vector-bank.js`) for chat RAG; `dist/skills/registry.json` content-addressed skill store; FTS memory DBs at repo root. Whole-system `.stratos/objects/` content-addressed store is **not built**. | CURRENT (scoped) / TARGET (system-wide) |
| **Execute** | `packages/api-shim` daemon (Ollama `gemma2:2b`/`gemma4:e4b` local inference) + `packages/stratos-agent/src/evolution/skill-executor.js` (verify-before-execute wasm skills). | CURRENT |
| **Trace** | `packages/stratos-agent/src/ledger/capability-receipt.js` (PQC-signed, hash-chained) is the cryptographic trace spine. The full `TRACE_SCHEMA.md` record + `trace-engine` are **not built**. | CURRENT (receipt) / TARGET (full trace) |
| **Evaluate** | none as a first-class engine. `src/evolution/trace-analyzer.js` distills traces for the self-evolution loop. The `eval-engine` is **not built**. | TARGET |
| **Compress** | session compression is manual into `/opt/efficient-labs/context/sessions/`; conversation-window planner in `src/memory`. | TARGET (manual CURRENT) |
| **Improve** | `packages/stratos-agent/src/evolution/{self-evolution.js,night-shift-compiler.js,skill-induction.js}` — real for the deterministic numeric-transform class only. See `SELF_IMPROVEMENT_LOOP.md`. | CURRENT (scoped) |

**Substrate primitives that are real and verified** (audit-cited in STATE_OF_REALITY / NORTH_STAR):

- **Pipeline engine** — `packages/stratos-agent/src/pipeline/engine.js` (167 LOC). Content-addressed file/state DAG, fingerprint-based freshness, atomic writes, swappable runner. **REAL/STANDALONE** (not yet the live chat spine). CURRENT.
- **Skill seal + compiler** — `src/memory/skill-seal.js`, `gsi-compiler.js`. Hybrid Ed25519 + ML-DSA-65 over code + manifest; `dist/skills/registry.json` keys by `sha256(wasm)`; 5 compiled skills on disk. CURRENT.
- **PQC** — `src/security/quantum-crypto.js` (`@noble/post-quantum`, FIPS 203/204, fail-closed). CURRENT.
- **Capability gate** — `src/security/capability-gate.js` (106 LOC, deny-by-default, enforced in `SkillExecutor`). CURRENT.
- **Attribution ledger + capability receipt** — `src/ledger/{attribution-ledger.js,capability-receipt.js}` (append-only hash chain; **measurement, explicitly NOT payout**). CURRENT.
- **Identity broker** — `src/connectors/broker-core.js` (ocap; mints scoped short-lived tokens; raw credential never leaves the broker). CURRENT.
- **P2P skill sync / mesh / ACP** — `src/memory/p2p-skill-sync.js`, mesh origin (PM2), `src/.../acp-core.js`. REAL/STANDALONE (built + proven on the operator's own fleet; not on the live request path). CURRENT-code / TARGET-wiring.

> The trust trifecta + consolidated router were built on a stacked feature branch and are 🟡 by the
> "live on the running daemon" bar (STATE_OF_REALITY 2026-06-05). Treat as CURRENT-code,
> pending-merge for live.

---

## 4. The operational unit (files-first contract)

Per `agent-framework-abstraction-layer.md`: **everything is files first.** The operational unit is

```
Workspace > Project > Workflow > Task > Subtask
  instructions.md  tools.json  data/  memory/  outputs/  traces/  evals/  skills/
```

A model reads/writes this tree; swapping the model changes nothing structural. The standard lives in
`/opt/efficient-labs/workspaces/` and `context/architecture/CONTEXT_CAPTURE_SCHEMA.md`. In-repo, the
ICM "folders over agents" scaffold (`src/context/icm-workspace.js`, `stratos icm init|validate`) is
the proto-implementation. Making this tree the **live contract** (not code) is the open TARGET named
in the decision doc and the NORTH_STAR roadmap (Phase 2).

---

## 5. Companion root docs

| Doc | What it maps |
| :-- | :-- |
| [`CONTEXT_ROUTING.md`](CONTEXT_ROUTING.md) | Input→Capture→…→Store: how an event becomes structured context in this repo. |
| [`MODEL_ROUTING.md`](MODEL_ROUTING.md) | the sovereign router: which model class for which task, with code. |
| [`TRACE_SCHEMA.md`](TRACE_SCHEMA.md) | trace/receipt mapping (points to the canonical schema in `/opt/efficient-labs`). |
| [`SELF_IMPROVEMENT_LOOP.md`](SELF_IMPROVEMENT_LOOP.md) | trace → eval → lesson → instruction → skill, with code + honest scope. |

Governance (deny-by-default permissions, approval gates, model/tool policy) is canonical at
`/opt/efficient-labs/governance/*.md`; the in-code enforcement points are `capability-gate.js`,
`broker-core.js`, and `model-router.js`.
