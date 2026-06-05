# StratosAgent — Model Routing

**Date:** 2026-06-06 · **Status:** routing reference (CURRENT vs TARGET, file-cited)

How StratosAgent chooses a model. Implements `/opt/efficient-labs/models/routing/model_selection_policy.md`
and `/opt/efficient-labs/governance/model_policy.md`. Liveness source of truth:
`../../STATE_OF_REALITY.md`.

The design choice (Codex-reviewed) is deliberate: **one simple, honest router — not a four-layer ML
routing stack.** Don't stack semantic-router + RouteLLM + vLLM tiering before a stable backend exists.

---

## The router — CURRENT

`src/routing/model-router.js`. Single transparent policy, `route(request, ctx) → { tier, cloud,
model?, difficulty, reason }`.

### Tiers

```js
TIERS = ['local-fast', 'local-strong', 'mesh', 'frontier']
```

- `local-fast` / `local-strong` — local open-weight via Ollama (the router picks the *tier*;
  `model-manager` / `agent-config.js` picks the concrete local model within it).
- `mesh` — your other machines (still sovereign), only when a real fleet exists.
- `frontier` — BYOK cloud (Anthropic / OpenAI / Google), opt-in only.

### Decision order (as coded)

1. **Explicit model.** A deliberately-passed model is honored. A cloud-family slug
   (`gpt|o\d|claude|gemini|grok`, or any `vendor/model` slash slug) ⇒ `frontier` — *unless*
   `private`, which keeps it local. A local-family name (`qwen|gemma|llama|mistral|phi|deepseek`) ⇒
   local tier by difficulty.
   - Important sovereignty guard: the live OpenAI-compatible shim (`task-router.js`) deliberately does
     **not** pass the wire `model` here — clients auto-send a default like `gpt-4o`, and treating that
     as opt-in would silently break sovereignty.
2. **Privacy.** `request.private === true` ⇒ local only — never cloud, never mesh. Overrides cost and
   capability (`model_policy.md`: privacy overrides everything).
3. **Cloud escalation — opt-in only.** `escalate && hasFrontierKey && difficulty >= 4` ⇒ `frontier`.
   `autoEscalateEnabled()` requires `STRATOS_CLOUD_AUTO_ESCALATE=true` (default off) — closes the
   heuristic-injection / forced-spend + data-egress vector.
4. **Mesh.** `difficulty >= 4 && meshAvailable` ⇒ `mesh` (`src/routing/mesh-signal.js`).
5. **Default.** Local — `local-strong` if `difficulty >= 3`, else `local-fast`.

### Difficulty signal — honest heuristic, not a classifier

`difficulty(prompt)` returns 0–5 from length + a few markers (reasoning verbs, code fences, math).
Documented in-code as a heuristic, not an ML model.

### Mesh availability — never invents peers

`src/routing/mesh-signal.js` reads the same self-reported `fleet.json` the CLI surfaces; deny-by-default.
Returns **false** with no fleet (the honest current state on this VPS); flips true only when a live
node writes `nodes>0 + cores>0`.

---

## Model configuration — CURRENT

`src/core/agent-config.js`:

- `model: { provider: 'local', name: 'gemma2:2b' }` — the default brain (provider switch is CLI-only).
- `modelSources: { local: { enabled, name }, providers: {} }` — providers hold ONLY a **vault handle**
  to the API key; the key itself is encrypted in the vault, never in config (`model_policy.md`: BYOK
  keys sealed, agent gets brokered access not raw keys).
- `routing: { saveApiSpend, costApproval: 'ask' | 'auto-local' | 'always-spend' }` — the cost-approval
  posture read by the gateway.

The local-model ladder includes Gemma 4 as preferred-when-installed, fallback-safe (falls through to
`qwen2.5:7b` when not pulled) — see `STATE_OF_REALITY.md`.

---

## Adapters — CURRENT (local) / TARGET (unified)

- **Local adapter — CURRENT.** `src/pipeline/stage-runners.js` `defaultModelRunner()` posts the
  OpenAI chat format to `127.0.0.1:${PORT}/v1/chat/completions`; the gateway secret attaches **only**
  for loopback hosts (never leaked to a remote endpoint a caller points the runner at).
- **Embeddings — CURRENT.** `nomic-embed-text` (768-dim) via Ollama (`src/memory/vector-bank.js`),
  with a logged non-semantic fallback.
- **Frontier (BYOK) — CURRENT path, opt-in.** Reachable via the `frontier` tier on explicit opt-in.
- **Unified model-adapter interface — TARGET.** One seam where frontier + open-weight + user-provided
  models all plug in, with *no model SDK called outside it* (`model_policy.md`), plus per-provider
  notes under `/models/frontier` + `/models/openweight`. Not built.

---

## Policy precedence (governance) — CURRENT enforcement

Per `model_selection_policy.md`: **Privacy → Capability → Cost → Fallback.**

- Privacy + Capability: enforced in `route()` (steps 2 + 1/5).
- Cost: partially — `costApproval` posture in config + cloud opt-in gating; the full
  `cost_policy.md` is **TARGET**.
- Fallback: the degrade chain (frontier → alternate frontier → strong open-weight → local) is
  specified in `fallback_policy.md` (**TARGET**); the router today degrades toward local by default
  but the explicit multi-hop fallback chain with per-hop trace logging is not built.

Every invocation is meant to record `model_used` + `model_class` in the trace
(`/opt/efficient-labs/context/architecture/TRACE_SCHEMA.md`); the capability receipt
(`src/ledger/capability-receipt.js`, `inference` action) is the live cryptographic record of a run.

---

## Summary

The sovereign decision policy (local-default, privacy-forces-local, opt-in cloud, real mesh signal)
is **CURRENT and live in the request path**. The unified multi-provider adapter interface, the
companion cost/fallback policy files, and per-hop fallback-chain logging are **TARGET**.
