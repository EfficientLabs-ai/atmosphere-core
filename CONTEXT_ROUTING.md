# CONTEXT_ROUTING — how an event becomes structured context

**Status:** living map · **Date:** 2026-06-06

This maps the canonical pipeline (`/opt/efficient-labs/context/architecture/CONTEXT_CAPTURE_SCHEMA.md`)
onto code in this monorepo. It does not redefine the schema — read that doc for the canonical event
record and folder standard. Here we answer: *for each stage, what runs today, and what is target?*

> Tags: **CURRENT** = exists in code (file cited). **TARGET** = specified, not built / not wired.

## The pipeline

```
Input → Capture → Classify → Route → Store → Execute → Trace → Evaluate → Compress → Improve
```

Memory rule (canonical, inherited): **no context lives only in chat.** Every meaningful event
(chat, file, email, repo, terminal, browser, api, mcp) should become a structured context record.

## Stage-by-stage, grounded in code

### Input
Sources that actually reach the system today: **Telegram** (live inbound bridge) and the
**OpenAI-compatible HTTP API** (`packages/api-shim/index.js`, `server.js`, :4099). Omni-channel
adapters (Slack/Discord/WhatsApp/Matrix/Signal) exist as code under
`packages/api-shim/src/omni-gateway/` with tests, but are **not connected to live platforms**
(STATE_OF_REALITY: SCAFFOLD).
- **CURRENT:** Telegram + HTTP API. **TARGET:** the other channels live.

### Capture
The canonical target is a structured event record (see CONTEXT_CAPTURE_SCHEMA `Event record`).
**No first-class `context-capture` engine exists yet.** What serves as proto-capture today:
- **Conversation memory** — per-chat append-only ring + window planner (`src/memory/`), so the agent
  remembers across turns (CURRENT).
- **Vector memory** — `packages/stratos-agent/src/memory/vector-bank.js`: real 768-dim LanceDB with
  `nomic-embed-text` embeddings (CURRENT).
- **Capability receipts** — `src/ledger/capability-receipt.js`: every verified run is captured as a
  signed, hash-chained record (CURRENT). This is the closest thing to per-event capture today.
- **Session compression** — done **manually** into `/opt/efficient-labs/context/sessions/{date}-{name}/`
  (raw/summary/decisions/architecture/next-actions/skills-created) (TARGET as automation).

> **TARGET:** the `context-capture` engine that writes the full `Event record` JSON for every event.

### Classify / Route
This is the **most CURRENT** stage. Two seams, one policy:
- `packages/stratos-agent/src/routing/model-router.js` — the single sovereign router. **Local is the
  default**; `/private` pins local; cloud (BYOK frontier) is opt-in only. See `MODEL_ROUTING.md`.
- `packages/api-shim/src/task-router.js` — the live daemon's classifier; delegates to `model-router.js`
  (it no longer runs a divergent "default to cloud" policy — that sovereignty bug was fixed; see
  STATE_OF_REALITY 2026-06-05).
- `packages/stratos-agent/src/routing/mesh-signal.js` — gates routing heavy work to the mesh; reads a
  self-reported `fleet.json`, **deny-by-default, never invents peers** (returns false with no live
  fleet). CURRENT.

Classification of *content into the Workspace>Project>Workflow>Task tree* is **TARGET** (the router
classifies model/destination, not yet workspace placement).

### Store
- **Chat RAG:** real LanceDB on disk via `vector-bank.js` (CURRENT).
- **Skills:** content-addressed — `dist/skills/registry.json` keys each skill by `sha256(wasm)` and
  dedupes by content hash; `dist/{atmosphere,stratos}/provenance.json` is a per-file hash manifest of
  the published build (CURRENT).
- **Telemetry/knowledge-base:** `reasoning-bank.js` (maximus-telemetry) runs in a degraded
  `[ReasoningBank (LanceDB Sim)]` mode (CURRENT-but-degraded; STATE_OF_REALITY).
- **Whole-system content-addressed store** (`.stratos/objects/`, sha256-keyed, provenance manifest):
  **TARGET** (NORTH_STAR refactor #5 / roadmap Phase 2).

### Execute
- Local inference: Ollama `gemma2:2b`/`gemma4:e4b` via the daemon (CURRENT; CPU-only VPS).
- Skill execution: `src/evolution/skill-executor.js` — verify-before-execute; computational wasm
  skills really run; automation skills are signed replayable manifests; tampered skills refused
  (CURRENT).

### Trace
The cryptographic trace spine is **CURRENT**: `src/ledger/capability-receipt.js` (actor/action/node/
in-hash/out-hash/cost/prev-hash/owner_wallet, PQC-signed, hash-chained) + `attribution-ledger.js`
(append-only, per-`did:atmos` attribution; **measurement, not payout**). The full operational
`TRACE_SCHEMA.md` record and a `trace-engine` are **TARGET**. See `TRACE_SCHEMA.md` (root).

### Evaluate
**TARGET.** No first-class `eval-engine`. `src/evolution/trace-analyzer.js` distills successful traces
to feed the self-improvement loop, which is the only eval-adjacent thing running.

### Compress
Conversation-window compression is CURRENT (`src/memory` window planner — fixed the num_ctx 2048→8192
bug). Session→folder compression is **manual** (TARGET as automation).

### Improve
**CURRENT for the deterministic numeric-transform class only** — see `SELF_IMPROVEMENT_LOOP.md`.
Everything else (free-form prose synthesis → reusable skill) is TARGET.

## One-line current-vs-target

**Classify/Route + Store(skills) + Trace(receipt) + Execute are CURRENT; first-class
Capture/Evaluate engines, system-wide content-addressed Store, and the full Trace record are TARGET.**

## Pointers
- Canonical schema: `/opt/efficient-labs/context/architecture/CONTEXT_CAPTURE_SCHEMA.md`
- Trace: `TRACE_SCHEMA.md` (root) → `/opt/efficient-labs/context/architecture/TRACE_SCHEMA.md`
- Routing: `MODEL_ROUTING.md` (root) + `/opt/efficient-labs/models/routing/model_selection_policy.md`
- Governance: `/opt/efficient-labs/governance/*.md`
