# atmos-core — Self-Improvement Loop

**Status:** mixed CURRENT / TARGET · **Date:** 2026-06-06

> Schema source of truth: `/opt/efficient-labs/context/architecture/TRACE_SCHEMA.md`. State source of
> truth: `../../STATE_OF_REALITY.md`. Vision: `../../NORTH_STAR.md`. This documents *how the flywheel
> works in code* — it references the schemas, it does not duplicate them.
>
> **Honesty rule:** every line is **CURRENT** (in code, cited) or **TARGET** (specified, not built).

## The flywheel

```
Execute → Trace → Evaluate → Lesson → Updated instruction → Reusable (signed) skill → Execute …
```

A system that compounds beats one that is merely capable (`NORTH_STAR.md`). Every execution should
leave the system a little stronger: a trace, an evaluation, a lesson, and — where a pattern repeats
— a reusable, content-addressed, signed skill.

## Stage by stage

### Execute (CURRENT)
Verified runs execute through `../stratos-agent/src/evolution/skill-executor.js` with the capability
gate enforced (`../stratos-agent/src/security/capability-gate.js`, deny-by-default) — a skill runs
only if its PQC-sealed manifest carries the required least-privilege capabilities.

### Trace (CURRENT — keystone primitive)
Every verified run emits a **capability receipt**:
`../stratos-agent/src/ledger/capability-receipt.js`. Append-only, **hash-chained**, **hybrid-PQC
signed** (Ed25519 + ML-DSA-65), storing input/output **hashes never content**, `verify()`
fail-closed, third-party-verifiable via `exportBundle()`/`verifyBundle()` with **only the public
key**. `summarize()` gives measured cost per actor/node/wallet — **measurement before rewards, never
a payout**. The full per-step Trace Schema record + a `trace-engine` are **TARGET** (`TRACE_SCHEMA.md`).

### Evaluate (CURRENT — scoped)
`../stratos-agent/src/evolution/trace-analyzer.js` evaluates historical action traces and isolates
high-confidence success patterns (`success_rate = 1.0`) as compilation candidates. A general
per-task `eval-engine` writing `/evals/{task-id}.md` is **TARGET**.

### Lesson → Updated instruction → Reusable skill (CURRENT — scoped to deterministic class)
The self-evolution loop **OBSERVE → LEARN → EXECUTE**:
- `../stratos-agent/src/evolution/self-evolution.js` orchestrates the loop and is wired into the live
  api-shim daemon (behind default-off flags — `STATE_OF_REALITY.md`).
- `../stratos-agent/src/evolution/skill-induction.js` induces a deterministic computation spec
  (Tier A: const/affine/quadratic) from observed examples. It **refuses to synthesize from a single
  observation** (≥2 distinct inputs required) — one chat reply cannot mint a constant-returning skill.
- `../stratos-agent/src/evolution/night-shift-compiler.js` harvests → classifies → dedupes →
  compiles to **real WASM** → **PQC-seals code + manifest** → registers by `sha256(wasm)`.
- `../stratos-agent/src/memory/skill-seal.js` produces the hybrid Ed25519+ML-DSA-65 seal;
  **verify-before-execute** is enforced in the executor — unsigned/tampered/wrong-origin skills are
  refused.

### Distribute (CURRENT)
`../stratos-agent/src/memory/p2p-skill-sync.js` gossips sealed skills across the mesh (Corestore +
Autobase append-only log over Hyperswarm), trust-by-provenance, seal-verified for remote blocks.
`storage.js` in this package provides the underlying signed append-only log.

## The honesty boundary (CURRENT scope)

Per `../../STATE_OF_REALITY.md`: the self-evolution loop is **real and live** but **scoped to the
deterministic numeric-transform class** (const/affine/quadratic). It does not yet self-improve
arbitrary task classes. A real round-trip is verified (e.g. "What is double of 8?" → captured live,
correctly won't compile until a 2nd distinct input arrives). Do not describe this as general AGI-style
self-improvement — it is a correct, bounded, verifiable loop for the class it covers.

## TARGET

- The full Trace Schema record + `trace-engine` (`TRACE_SCHEMA.md`).
- A general per-task `eval-engine` (`/evals/{task-id}.md`).
- **General-class compression**: turn a whole session's traces into reusable
  instruction/skill artifacts for arbitrary (not just deterministic-numeric) task classes — the
  `/skills/{skill-name}/{skill.md, examples/, tools.json}` output in `TRACE_SCHEMA.md`.
- The live `Workspace>Project>Workflow>Task>Subtask` tree as the place lessons and skills are written.

## Current-vs-Target (one line)

CURRENT and cited: gated execution, the PQC-signed capability-receipt trace, scoped trace evaluation,
and a real WASM-compiled + PQC-sealed self-evolution loop with verify-before-execute and P2P skill
distribution — bounded to the deterministic numeric-transform class. TARGET: the full trace-engine,
a general eval-engine, general-class compression into reusable skills, and the live task tree.
