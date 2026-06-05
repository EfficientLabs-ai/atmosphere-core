# StratosAgent — Context Routing

**Date:** 2026-06-06 · **Status:** context/data-flow map (CURRENT vs TARGET, file-cited)

How context moves through StratosAgent, mapped onto the canonical pipeline
(`/opt/efficient-labs/context/architecture/CONTEXT_CAPTURE_SCHEMA.md`):

```
Input → Capture → Classify → Route → Store → Execute → Trace → Evaluate → Compress → Improve
```

Each stage below cites the code that does it and marks **CURRENT** vs **TARGET**. The standard says
*no context lives only in chat*; this doc is honest about which legs of that promise are wired.
Liveness source of truth: `../../STATE_OF_REALITY.md`.

---

## 1. Input

**CURRENT.** Inputs arrive via the CLI (`src/cli/stratos-cli.js`), the local OpenAI-compatible
gateway (api-shim, consumed by `src/pipeline/stage-runners.js`), the Telegram channel (per-chat
memory ring, see `STATE_OF_REALITY.md`), voice/vision (`src/sensory/voice-engine.js`), and ingestion
harvesters (`src/ingestion/genesis-harvester.js`, `unified-dispatcher.js`, `claw-translator.js`,
`legacy-bridge.js`). `CONTEXT_CAPTURE_SCHEMA.md` enumerates the source taxonomy
(chat|file|email|repo|terminal|browser|api|mcp).

## 2. Capture

**Proto-capture CURRENT; full engine TARGET.** Today capture is served by the working memory stores
rather than a dedicated engine:

- conversation turns → `src/memory/fts-memory.js` (FTS5 index per turn);
- successful task I/O → `src/memory/vector-bank.js` `cognitive_skills` (LanceDB);
- user signal → `src/memory/user-model.js` (observations).

The structured **event record** (`CONTEXT_CAPTURE_SCHEMA.md`) and the engine that writes every
meaningful event into the workspace tree (`atmos-core/context-capture`) are **TARGET**. Until it
ships, sessions are compressed manually into `/opt/efficient-labs/context/sessions/`.

## 3. Classify

**CURRENT (transform classes) / TARGET (general).** The router's `difficulty()` heuristic classifies
a prompt's hardness (`src/routing/model-router.js`); the self-evolution runtime classifies whether a
turn belongs to the deterministic numeric-transform class
(`packages/api-shim/src/self-evolution-runtime.js`). General intent/project/workflow classification
into the `Workspace>…>Task` tree is **TARGET**.

## 4. Route

**CURRENT — the strongest leg.** `src/routing/model-router.js` `route(request, ctx)` decides the
model tier under the governance precedence (privacy → capability → cost → fallback):

- local-default; `private` pins local; cloud opt-in only (flag + key + difficulty);
- mesh tier when `src/routing/mesh-signal.js` reports a real `fleet.json`.

Tool routing: `src/integrations/composio-toolkits.js` (`getAction`) + the connector registry
(`src/connectors/connector-registry.js`) resolve which tool/credential/host an action uses, gated by
`src/security/capability-gate.js`. See `MODEL_ROUTING.md` for the full decision table.

Manifest-driven per-task `tools.json` routing against a `/mcp` registry is **TARGET**
(`/opt/efficient-labs/governance/tool_policy.md`).

## 5. Store

**CURRENT.** Memory: FTS5 db (`.stratos-fts-memory.db`), LanceDB (`.stratos-vector-store`),
user-model db. Skills: `dist/skills/*.wasm` + `registry.json` (native, sealed) and
`<skillsDir>/imported/` (foreign SKILL.md, untrusted — `src/skills/skill-store.js`). Config/secrets:
`.stratos-profile/` (config = vault *handles* only; secrets in the vault, `src/connectors/vault.js`).
Proof: `dist/skills/{attribution.jsonl, receipts.jsonl}`.

The canonical `Task/` folder layout as the *live* store (`instructions.md · data/ · memory/ ·
outputs/ · traces/ · evals/ · skills/`) is **TARGET** — `src/context/icm-workspace.js` scaffolds and
validates the 5-layer workspace today (L2 `stages/` + L4 `artifacts/` are live; L0/L1/L3 are
scaffolded contracts).

## 6. Execute

**CURRENT.** Stage execution (`src/pipeline/engine.js` + `stage-runners.js`), sandboxed jobs
(`src/exec/runner.js` → `src/execution/wasi-sandbox.js`), verified WASM skills
(`src/evolution/skill-executor.js`), and sovereign tool calls (`src/integrations/composio-exec.js`).
See `ARCHITECTURE.md` §3 / §5.

## 7. Trace

**CURRENT (cryptographic spine) / TARGET (full record).** The PQC-signed, hash-chained capability
receipt (`src/ledger/capability-receipt.js`) is live — actor/action/node/in-hash/out-hash/cost/
prev-hash, third-party-verifiable. The attribution ledger (`src/ledger/attribution-ledger.js`)
records measured contribution. The *full* `TRACE_SCHEMA.md` operational record (per-step plan/tool/
model/subagent/io with permission + approval) and the `trace-engine` are **TARGET**
(`/opt/efficient-labs/context/architecture/TRACE_SCHEMA.md` — where they overlap, the receipt is the
source of truth).

## 8. Evaluate

**CURRENT (narrow) / TARGET (engine).** `src/evolution/trace-analyzer.js` admits only
`success_rate >= threshold` pathways. The scored `evals/{task-id}.md` rubric loop is **TARGET**.

## 9. Compress

**CURRENT (memory) / TARGET (sessions).** `src/memory/user-model.js` *re-synthesizes* a concise theory
of the user (the dialectic — new model supersedes the old, so the profile stays compact, not
accreting). Session compression into `/context/sessions/{date}/{summary,decisions,...}.md`
(`CONTEXT_CAPTURE_SCHEMA.md` memory rule) is done **manually** today; the automated compressor is
**TARGET**.

## 10. Improve

**CURRENT (numeric class) / TARGET (general).** `src/evolution/self-evolution.js` turns captured
successes into signed, executing WASM skills (OBSERVE→LEARN→…→EXECUTE), flag-gated OFF by default.
See `SELF_IMPROVEMENT_LOOP.md`. The general `trace → eval → lesson → updated instruction → reusable
skill` loop over arbitrary tasks is **TARGET**.

---

## Context-isolation invariants (CURRENT — security-critical)

- **Per-conversation memory isolation** — `user-model.js` keys observations + model by
  `conversationId`; `getUserContext(A)` can never surface conv B (the context-bleed class).
- **Per-entity credential isolation** — `composio-exec.js` keys vault creds `composio_<entity>_<toolkit>`;
  one user's creds are never usable for another (`/opt/efficient-labs/governance/permissions.md`).
- **Untrusted input quarantine** — foreign SKILL.md imports are untrusted-by-default, capability-gated,
  never auto-run (`src/skills/skill-md.js`); the egress firewall fail-closes
  (`src/security/egress-policy.js`) — matches `governance/tool_policy.md` §quarantine.

---

## Summary

The **Route** and **Trace (cryptographic)** legs are the most complete in code. **Capture, Classify,
Compress, Improve** exist today through the memory + self-evolution stores for narrow classes; their
first-class engines (in `atmos-core`) and the live `Task/` folder store are TARGET.
