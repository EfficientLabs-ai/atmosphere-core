# atmos-core — Model Routing

**Status:** mixed CURRENT / TARGET · **Date:** 2026-06-06

> Policy source of truth: `/opt/efficient-labs/models/routing/model_selection_policy.md` +
> `/opt/efficient-labs/governance/model_policy.md`. State source of truth:
> `../../STATE_OF_REALITY.md`. This documents *how this layer works in code* — it references the
> policy, it does not duplicate it.
>
> **Honesty rule:** every line is **CURRENT** (in code, cited) or **TARGET** (specified, not built).

## Principle

Support **frontier and open-weight models natively**; user-provided models plug into the **same
routing + permissions layer** — no special path. The model is the borrowed brain; routing is part of
the durable substrate. **No code calls a model SDK outside the model-abstraction interface**
(`governance/model_policy.md`).

## Policy precedence (`model_selection_policy.md`)

1. **Privacy** — sensitive/regulated data is forced local/open-weight; never egresses to a frontier
   API. Overrides cost and capability.
2. **Capability** — match task class to model class (frontier: high-reasoning/ambiguous/high-risk/
   planning/architecture/multimodal; open-weight: extraction/classification/summarization/batch/
   local/private/cheap-repetitive).
3. **Cost** — within a capability tier, prefer the cheaper model; prefer local ($0 marginal).
4. **Fallback** — on error/timeout/unavailable, degrade frontier → alternate frontier → strong
   open-weight → local, logging each hop in the trace.

## Implementation

### CURRENT — one sovereign router
`../stratos-agent/src/routing/model-router.js` is the single consolidated policy:
- **LOCAL is the default.** `/private` pins local. **Cloud is opt-in only** — a configured BYOK key
  on a genuinely hard prompt, or `/force-cloud`. A *named* cloud model from an OpenAI-compatible
  client no longer forces cloud (clients send a model on every call).
- Per `STATE_OF_REALITY.md` (2026-06-05) this consolidation **fixed a real sovereignty bug**: the
  old path defaulted to cloud ("default to Cloud to ensure maximum intelligence") and escalated to
  cloud on a complexity score even with no API key configured. The classifier
  (`TaskClassifierRouter.classify()`) now delegates to this one router — no second divergent policy.

### CURRENT — local model ladder
The local model manager selects among installed open-weight models: `gemma2:2b` (fast default) +
`gemma4:e4b` (chat/vision) via Ollama, fallback-safe (`qwen2.5:7b` was removed — see
`docs/PROGRAM_STATUS.md`). Local inference is verified real (`STATE_OF_REALITY.md`).

### CURRENT — mesh as a routing target
`../stratos-agent/src/routing/mesh-signal.js` lets the router send heavy work to the fleet **only if
a real `fleet.json` reports nodes>0 + cores>0** — deny-by-default, never invents peers (returns
false with no live mesh — the honest current state). Wired into `classify()` and `stratos route`.

### CURRENT — BYOK / sovereignty of keys
BYOK is frontier-only; user keys are sealed in the vault (`../stratos-agent/src/security/vault-host.js`),
never handed to the agent, never logged. The agent receives brokered access via
`../stratos-agent/src/identity/identity-broker.js`, not raw keys (`governance/model_policy.md`).

### TARGET
- The companion policy files `cost_policy.md`, `privacy_policy.md`, `fallback_policy.md` and the
  per-provider notes under `models/frontier` + `models/openweight` (as `model_selection_policy.md`
  states).
- The full **fallback chain** as an explicit, trace-logged degradation ladder.
- `STRATOS_CLOUD_AUTO_ESCALATE` remains **default-off**; auto-escalation logic is intentionally not
  enabled.

## Every invocation is recorded (CURRENT)

Each model invocation feeds the trace/attribution primitive: a capability receipt with
`action: "inference"`, `ref: <model>`, measured `cost_units`, and input/output **hashes**
(`../stratos-agent/src/ledger/capability-receipt.js`). `model_used`/`model_class` in the full Trace
Schema record (`TRACE_SCHEMA.md`) is TARGET.

## Current-vs-Target (one line)

CURRENT: one consolidated local-first sovereign router (`routing/model-router.js`), a fallback-safe
local model ladder, deny-by-default mesh routing, vault-sealed BYOK with brokered access, and
per-inference receipts — all cited. TARGET: the cost/privacy/fallback policy files, the explicit
trace-logged fallback chain, and provider notes.
