# MODEL_ROUTING — the sovereign router

**Status:** living map · **Date:** 2026-06-06

How the monorepo decides *which model runs a task*. The canonical policy is
`/opt/efficient-labs/models/routing/model_selection_policy.md` and the governance constraint is
`/opt/efficient-labs/governance/model_policy.md` — this doc maps that policy to the code that
enforces it and marks each piece CURRENT vs TARGET.

> Tags: **CURRENT** = exists in code (file cited). **TARGET** = specified, not built.

## Policy (canonical, summarized — do not duplicate)

- **Local-first / sovereign default.** Cloud/frontier is opt-in; auto-escalation off by default.
- **Privacy overrides cost and capability.** Sensitive/regulated data is forced local/open-weight,
  never egressed to a frontier API.
- **BYOK only for frontier.** User keys sealed in the vault; the agent receives brokered access, not
  raw keys.
- **Three model classes** route by task: frontier (high-reasoning/ambiguous/business-critical),
  open-weight (extraction/classification/batch/local), user-provided (same rules + user prefs).
- **Every model invocation is recorded** in the trace (`model_used`, `model_class`).

## Code that implements it

### The single router — CURRENT
`packages/stratos-agent/src/routing/model-router.js` is the one sovereign router. Behavior
(audit-verified, STATE_OF_REALITY 2026-06-05):

- **LOCAL is the default.** `/private` pins local. **Cloud is opt-in only** — a configured BYOK key on
  a genuinely hard prompt, or explicit `/force-cloud`.
- A *named* cloud model from an OpenAI-compatible client no longer forces cloud (clients send a model
  name on every call; that alone must not break sovereignty).
- This **fixed a real sovereignty bug**: the old fallback *"default to Cloud to ensure maximum
  intelligence"* sent general prompts to frontier APIs by default — and even tried to escalate to
  cloud with **no API key configured** (a call that could not succeed).

### The daemon seam — CURRENT
`packages/api-shim/src/task-router.js` is the live daemon's classifier. It **delegates to
`model-router.js`** rather than running a second divergent policy. (It was trimmed 185→80 lines; the
non-hermetic LanceDB probe and dead RAG-probe code were removed.)

> Honest note: `task-router.js`'s classification is still essentially heuristic (token estimate +
> markers), labeled honestly — NORTH_STAR refactor #4 replaces it with an explicit deterministic cost
> model `route = f(token_estimate, installed_capacity, content-hash cache-hit)`. That is **TARGET**.

### Mesh routing — CURRENT (deny-by-default), wiring TARGET
`packages/stratos-agent/src/routing/mesh-signal.js`: the router can route heavy work to the mesh, but
only if a live fleet actually exists. It reads the same self-reported `fleet.json` the CLI surfaces;
**deny-by-default, never invents peers.** Returns false today (no persistent `fleet.json`), which is
the honest current state; flips true when a real mesh node writes a fleet with `nodes>0 + cores>0`.

### The local model ladder — CURRENT
`packages/api-shim/src/model-manager.js` (+ tests) manages the local open-weight ladder. Today:
**Ollama `gemma2:2b`** is the live local fast-default model and **`gemma4:e4b`** is the installed
chat/vision model (`qwen2.5:7b` was removed — see `docs/PROGRAM_STATUS.md`); the ladder is
fallback-safe with degradation. The "cloud" upstream (`:5001`) is currently a **local-Ollama-backed stand-in**,
not a real frontier endpoint (STATE_OF_REALITY 🟡).

## Routing decision flow (today, honest)

```
prompt ──► task-router.js (classify) ──► model-router.js (sovereign policy)
                                          │
       privacy? sensitive ───────────────┤ force LOCAL (TARGET: privacy_policy.md not yet a file)
       /private ──────────────────────────┤ pin LOCAL
       hard prompt + BYOK key configured ─┤ allow CLOUD (opt-in)
       /force-cloud ──────────────────────┤ allow CLOUD
       else ──────────────────────────────► LOCAL (default)  ──► model-manager.js ladder
                                                                  (gemma2:2b fast-default; gemma4:e4b chat/vision)
       heavy + live fleet (mesh-signal) ──► route to mesh (CURRENT gate; live mesh on path = TARGET)
```

## Gaps vs the canonical policy

| Policy element | Status |
| :-- | :-- |
| Local-first default | CURRENT |
| BYOK frontier, key never reaches agent (brokered) | CURRENT (broker-core.js) |
| Privacy overrides cost/capability | **TARGET** — the precedence is policy; `privacy_policy.md`, `cost_policy.md`, `fallback_policy.md` are not yet written, and there is no automatic sensitive-data detector forcing local. |
| Deterministic cost-model routing | TARGET (refactor #4) |
| Real frontier cloud upstream | TARGET (`:5001` is a local stand-in today) |
| model_used / model_class in every trace | CURRENT via receipts; full trace record TARGET (see `TRACE_SCHEMA.md`) |
| Fallback chain (frontier→alt→open-weight→local), logged per hop | TARGET |

## One-line current-vs-target

**The sovereign router (local-default + BYOK frontier + mesh gate + local ladder) is CURRENT and the
"default to cloud" bug is fixed; the privacy-override detector, deterministic cost model, real
frontier upstream, and explicit policy files (privacy/cost/fallback) are TARGET.**

## Pointers
- Canonical policy: `/opt/efficient-labs/models/routing/model_selection_policy.md`
- Governance: `/opt/efficient-labs/governance/model_policy.md`, `permissions.md`, `tool_policy.md`
- Broker (BYOK / no raw tokens): `packages/stratos-agent/src/connectors/broker-core.js`
