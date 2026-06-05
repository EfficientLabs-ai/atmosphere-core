# SELF_IMPROVEMENT_LOOP — the flywheel

**Status:** living map · **Date:** 2026-06-06

The self-improvement loop is the compounding asset of the operating system: **every execution should
yield trace → eval → lesson → updated instruction → reusable skill** (canonical:
`/opt/efficient-labs/context/decisions/agent-framework-abstraction-layer.md` and
`TRACE_SCHEMA.md §Self-improvement output`). This doc maps that loop to code in this monorepo and is
honest about exactly how far the loop actually closes today.

> Tags: **CURRENT** = exists in code (file cited). **TARGET** = specified, not built / not wired live.

## The canonical loop

```
trace ──► evaluation (/evals/{task-id}.md) ──► lesson ──► updated instruction ──► reusable skill
                                                              /skills/{name}/skill.md
                                                              /skills/{name}/examples/
                                                              /skills/{name}/tools.json
```

## What runs today (StratosAgent "Night Shift")

The loop is **REAL end-to-end for one class of work**: the **deterministic numeric-transform class**
(a prompt with an integer operand → an integer answer). Code:

| Loop step | Code | Status |
| :-- | :-- | :-- |
| **Harvest traces** | `src/evolution/trace-analyzer.js` — reads successful skills/exchanges (`success_rate=1.0`) from LanceDB | CURRENT |
| **Distill / classify** | `trace-analyzer.js` `distill()` — computational vs automation | CURRENT |
| **Induce the spec** (the "lesson") | `src/evolution/skill-induction.js` — exact program synthesis (const/affine/quadratic), Occam-ordered, accepted only if it reproduces *every* example; non-deterministic → honest `null`, never a guess | CURRENT (deterministic class only) |
| **Compile** | `gsi-compiler.js` → real WASM (via `wabt`) | CURRENT |
| **Seal** (sign the skill) | `src/memory/skill-seal.js` — hybrid Ed25519 + ML-DSA-65 over **code bytes AND manifest**; content-hash dedupe; `dist/skills/registry.json` keyed by `sha256(wasm)` | CURRENT |
| **Verify-before-execute** | `src/evolution/skill-executor.js` — runs the wasm skill only if its seal verifies; tampered skills refused; capability gate enforced | CURRENT |
| **Serve instead of LLM** | `packages/api-shim/src/self-evolution-runtime.js` — Hook E (EXECUTE) serves the verified wasm skill instead of the ~100 s LLM call | CURRENT (flag-gated) |

### The three live hooks (flag-gated, default OFF)
`self-evolution-runtime.js` connects `SelfEvolutionEngine` to the api-shim daemon via one seam:
- **Hook A — OBSERVE:** captures typed numeric I/O from successful chat exchanges.
- **Hook B — LEARN:** the night-shift scheduler (the "2 AM" compilation cycle) runs on boot.
- **Hook E — EXECUTE:** serves a verified wasm skill when a matching prompt arrives.

With no `STRATOS_EVOLUTION*` env var set, all three are inert and the daemon is byte-identical to
before. On this VPS the flags are set and a real round-trip is verified (e.g. "triple 9" → 27 served
through the verify gate). Three correctness fixes are in: upsert-by-id writes (no dup rows), examples
accumulate under one skill id, and the inducer **refuses to synthesize from a single observation**
(≥2 distinct inputs required) so one chat reply can't mint a constant-returning skill.

## Honest scope (what the loop does NOT do yet)

- **Only the deterministic numeric-transform class closes the loop.** Free-form prose carries no typed
  examples, so OBSERVE records nothing and EXECUTE never matches it — by design, not stub.
- **Tier B (arbitrary algorithms with control flow/loops):** TARGET. Planned path: LLM-propose-a-program
  → verify against trace examples in the sandbox → library-learning (egg/Stitch) to compound
  primitives. Research-mapped, not built.
- **No first-class eval-engine.** The "evaluation" step is the inducer's accept/reject (reproduces
  every example or returns null). A general `/evals/{task-id}.md` evaluation + lesson-extraction for
  non-deterministic work is TARGET.
- **Instruction-update loop** (lesson → updated `instructions.md` in a Task folder) is TARGET — it
  depends on the Workspace>…>Task tree being the live contract (see `ARCHITECTURE.md §4`).
- **Skill folder standard** (`/skills/{name}/skill.md + examples/ + tools.json`): skills are compiled
  to wasm + sealed today; the human-readable skill-folder contract is the TARGET surface.
- **P2P DISTRIBUTE/VERIFY** of learned skills is built + unit-proven in the engine but **deliberately
  NOT wired** into the live daemon (no second trusted peer from the bridge yet). CURRENT-code /
  TARGET-wiring.

## How it connects to the rest of the OS

- It consumes **traces** (`TRACE_SCHEMA.md`) — today the receipt/ledger + LanceDB successful exchanges.
- It writes **content-addressed skills** (`sha256(wasm)`-keyed registry) — the Store stage of
  `CONTEXT_ROUTING.md`.
- It is gated by the **capability gate** and respects the **sovereign router** (a served skill is the
  cheapest possible "local" path — zero tokens on a cache hit).

## One-line current-vs-target

**The full harvest→induce→compile→seal→verify→serve flywheel is CURRENT and live (flag-gated) for the
deterministic numeric-transform class only; Tier B program induction, a general eval-engine, the
lesson→instruction update loop, the skill-folder contract, and live P2P skill distribution are
TARGET.**

## Pointers
- Decision: `/opt/efficient-labs/context/decisions/agent-framework-abstraction-layer.md`
- Trace: `TRACE_SCHEMA.md` (root) → `/opt/efficient-labs/context/architecture/TRACE_SCHEMA.md`
- Evolution code: `packages/stratos-agent/src/evolution/` + `packages/api-shim/src/self-evolution-runtime.js`
- Honest status: `STATE_OF_REALITY.md` (Night Shift / self-evolution sections)
- Roadmap context: `NORTH_STAR.md` (Phase 2 / §2.1 pipeline-as-spine)
