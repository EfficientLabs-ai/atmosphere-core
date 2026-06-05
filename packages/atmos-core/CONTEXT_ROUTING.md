# atmos-core — Context Routing

**Status:** mixed CURRENT / TARGET · **Date:** 2026-06-06

> Schema source of truth: `/opt/efficient-labs/context/architecture/CONTEXT_CAPTURE_SCHEMA.md`.
> State source of truth: `../../STATE_OF_REALITY.md`. This file documents *how this package
> participates* in the capture pipeline — it references the schema, it does not duplicate it.
>
> **Honesty rule:** every line is **CURRENT** (in code, cited) or **TARGET** (specified, not built).

## The pipeline

```
Input → Capture → Classify → Route → Store → Execute → Trace → Evaluate → Compress → Improve
```

The rule (`CONTEXT_CAPTURE_SCHEMA.md`): every meaningful event — chat, file, email, repo, terminal,
browser, api, mcp — becomes a structured context record. **No context lives only in chat.** The
event record shape (`id, timestamp, source, repo, project, workflow, task, user_intent,
raw_input_path, summary, entities, decisions, tools_used, outputs, next_actions, permissions,
model_used, trace_path, eval_path`) is defined in that schema.

## Stage by stage

### Input + Capture
- **CURRENT — multi-source ingestion.** `../stratos-agent/src/ingestion/unified-dispatcher.js`
  routes input from multiple sources into the system; `genesis-harvester.js`, `legacy-bridge.js`,
  `claw-translator.js` normalize/harvest specific sources.
- **CURRENT — proto-capture into recallable memory.** Every conversation turn is captured into
  `../stratos-agent/src/memory/fts-memory.js` (SQLite FTS5 keyword recall, bm25-ranked, snippet
  highlights) and `../stratos-agent/src/memory/vector-bank.js` (LanceDB semantic RAG, 768-dim
  embeddings). Per-chat durable memory persists across turns (`STATE_OF_REALITY.md`).
- **TARGET — the `context-capture` engine** that emits the full event record and the
  `/context/sessions/{date}-{name}/{raw,summary,decisions,architecture,next-actions,skills-created}.md`
  fan-out (`CONTEXT_CAPTURE_SCHEMA.md`). Until it ships, sessions are compressed manually and the
  memory banks + capability receipts serve as the proto-capture/trace layer (as the schema states).

### Classify + Route
- **CURRENT — model routing.** `../stratos-agent/src/routing/model-router.js` (local-first; see
  `MODEL_ROUTING.md`) classifies a request and routes it to local vs cloud vs mesh.
- **CURRENT — mesh routing.** `../stratos-agent/src/routing/mesh-signal.js` routes heavy work to the
  fleet only if a real `fleet.json` reports live nodes — deny-by-default, never invents peers.
- **TARGET — content *type* classification of the event record** (entities/decisions extraction,
  destination-folder routing within the `Workspace>…>Task` tree). Today classification is request→
  model-class; record-level classify/route is specified, not built.

### Store
- **CURRENT — signed append-only log.** `storage.js` (`StorageManager`) appends signed JSON blocks
  (`{data, signer, signature, timestamp}`) to a Corestore + Autobase grid — local-first, replicable,
  tamper-evident at the block level.
- **CURRENT — local memory stores** (FTS + LanceDB), sovereign by construction (zero network on the
  store path).
- **TARGET — routing useful pieces into the right `context/{architecture,decisions}/` and workspace
  `skills/` folders** automatically (`CONTEXT_CAPTURE_SCHEMA.md` "Memory rule"). Done manually today.

### Execute → Trace → Evaluate → Compress → Improve
Documented in `SELF_IMPROVEMENT_LOOP.md`. Trace is the PQC-signed capability receipt
(`../stratos-agent/src/ledger/capability-receipt.js`, CURRENT); the full per-step Trace Schema
record + the eval/compress engines are TARGET (`TRACE_SCHEMA.md`).

## Sovereignty property (CURRENT)

The capture + store path is **100% local** by construction: SQLite + LanceDB + on-disk
Corestore/Autobase, no external service required. This is the architecture behind the local-first
promise in `../../NORTH_STAR.md`.

## Current-vs-Target (one line)

CURRENT: multi-source ingestion, local FTS+vector proto-capture, model/mesh routing, and a signed
append-only store — all on disk and cited. TARGET: the unifying `context-capture` engine, the full
event record, record-level classify/route, automatic folder routing, and the live session fan-out
specified in `CONTEXT_CAPTURE_SCHEMA.md`.
