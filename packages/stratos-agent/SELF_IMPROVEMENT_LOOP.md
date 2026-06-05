# StratosAgent — Self-Improvement Loop

**Date:** 2026-06-06 · **Status:** loop reference (CURRENT vs TARGET, file-cited)

The flywheel from `/opt/efficient-labs/context/architecture/TRACE_SCHEMA.md`:

```
trace → evaluation → lesson → updated instruction → reusable skill
```

In StratosAgent this is the **skill-builder loop** — the most-built self-improvement machinery in the
package. It turns successful task outcomes into signed, executing WASM skills that replace LLM calls
for the classes it covers. Liveness source of truth: `../../STATE_OF_REALITY.md`.

> **Honest scope up front.** The loop is REAL and wired, but NARROW: it learns and serves the
> *deterministic numeric-transform class* (a prompt with an integer operand and an integer answer).
> Free-form prose carries no typed examples, so it is observed/served by design = nothing — not a
> stub, a deliberate boundary. Every capability is OFF by default behind `STRATOS_EVOLUTION*` flags.

---

## The five phases — CURRENT

`src/evolution/self-evolution.js` integrates five separately-built components into one loop:

### OBSERVE — `captureSuccess()`
Records a successful task + its typed input/output examples into the LanceDB `cognitive_skills`
store (`src/memory/vector-bank.js`). Never throws into the request path — a failure degrades to "no
capture". Correctness guards (`STATE_OF_REALITY.md`): writes are **upsert-by-id** (no duplicate
rows), examples **accumulate** under one skill id, and the inducer **refuses to synthesize from a
single observation** (≥2 distinct inputs required) so one chat reply can't mint a constant skill.

### LEARN — `runNightShift()`
1. `src/evolution/trace-analyzer.js` — admit only `success_rate >= threshold` (default 1.0) pathways.
2. `src/evolution/skill-induction.js` — **Tier-A deterministic program synthesis**: fit const /
   affine (`a*x+b`) / poly2 (`c2*x²+c1*x+c0`) by exact integer fitting, **Occam order** (simplest
   hypothesis that fits *all* examples wins). Accepted only if it reproduces every observed example;
   otherwise returns `null` — an honest "could not synthesize", never a guess.
3. `gsi-compiler.js` — compile the spec to **real executing WASM** (WAT→WASM via wabt).
4. **Full-module hybrid-PQC seal** — `src/memory/skill-seal.js` + `src/security/quantum-crypto.js`
   (Ed25519 + ML-DSA-65; the seal binds skillId + wasmHash + manifest, so editing code *or* the
   declared capabilities breaks it). `src/evolution/night-shift-compiler.js` is the thin overnight
   orchestrator over `GsiCompiler.compileFromDatabase`.

### DISTRIBUTE — `broadcastSkill()`
Appends the signed skill to the P2P mesh ledger (`src/memory/p2p-skill-sync.js`). **Built +
unit-proven; NOT wired live** (no second peer on this VPS — live broadcast would be untested).

### VERIFY — `ingestRemoteSkill()`
Re-verifies an inbound peer's seal against the **origin** node's pinned public key (not ours) before
trusting it — zero-trust, quantum-resistant. Built + unit-proven; activates with a real second node.

### EXECUTE — `resolveAndExecute()`
Runs a matching verified WASM skill **instead of the LLM** via `src/evolution/skill-executor.js`.
Triple-gated: `executeEnabled` (default OFF) **and** PQC signature valid **and** strict
semantic-match distance (`matchMaxDistance` default 0.25 — only a confident match runs). On any miss,
degrades to the LLM fallback — self-evolution can't break serving.

---

## Live wiring — CURRENT, flag-gated OFF by default

`packages/api-shim/src/self-evolution-runtime.js` is the ONE seam into the live daemon:

- **Master switch** `STRATOS_EVOLUTION` gates engine construction (one kill switch). Sub-flags
  `OBSERVE` / `EXECUTE` do nothing unless the master is on.
- With no `STRATOS_EVOLUTION*` set, the module is **fully inert** — a PM2 reload changes nothing.
- OBSERVE + EXECUTE never throw into the request path.
- `STATE_OF_REALITY.md` records a verified live round-trip on this VPS: "What is double of 8?" →
  qwen "16", captured as `auto_4aed46eee216` (1 example; correctly won't compile until a 2nd distinct
  input arrives).

The engine constructor (`src/evolution/self-evolution.js`) wires the **trust trifecta** live: every
verified run is recorded in the `AttributionLedger`, emits a PQC-signed `capability-receipt`, and is
capability-gated (`enforceCapabilities: true`) — the GSI compiler stamps least-privilege caps via
`deriveCapabilities()` (`src/security/capability-gate.js`).

---

## Proof + measurement — CURRENT

- **Capability receipt** (`src/ledger/capability-receipt.js`) — every inference / verified skill-run
  emits a PQC-signed, hash-chained receipt (actor/action/node/in-hash/out-hash/cost/prev-hash),
  third-party-verifiable with only the public key. `RECEIPT_ACTIONS = ['inference', 'skill-run']`.
- **Attribution ledger** (`src/ledger/attribution-ledger.js`) — append-only tamper-evident chain of
  contribution (`compute`, `skill-authored`, `skill-executed`, `skill-reused`, `task-completed`),
  attributed to a `did:atmos` identity. `summarize()` is **measured units per contributor, explicitly
  NOT a payout** — measurement before rewards (the Vision/Architecture/Claim discipline).

---

## Portability (the network-effect rail) — CURRENT

`src/skills/skill-md.js` imports/exports the portable SKILL.md format (agentskills.io / clawhub
interop) **without discarding the sovereign seal**. A foreign `.md` is untrusted-by-default,
capability-gated, never auto-run; only a sealed, locally-recompiled skill (requires THIS node's key)
can ever touch net/fs/secrets/compute. Imported skills are indexed separately
(`src/skills/skill-store.js`) so a foreign skill can never masquerade as a sealed one.

---

## What is TARGET

- **General self-improvement** beyond the deterministic numeric class — the loop over arbitrary tasks
  (`trace → eval → lesson → updated instruction`) producing prose/skill updates. Tier B
  (LLM-propose + verify) is named as the fallback above Tier A but not built.
- **The full eval-engine** — scored `evals/{task-id}.md` rubric (today: success-rate gate only).
- **The trace-engine** — the full `TRACE_SCHEMA.md` per-step record (today: capability receipt is the
  cryptographic spine; the full operational record is TARGET).
- **Live DISTRIBUTE/VERIFY** — needs a real second mesh node.
- **Self-repair** — consuming a failed/partial trace to re-plan (`ARCHITECTURE.md` §8).

---

## Summary

The skill-builder loop (OBSERVE→LEARN→DISTRIBUTE→VERIFY→EXECUTE) is **CURRENT** for the deterministic
numeric-transform class, with real PQC sealing, the live trust trifecta, and SKILL.md portability —
all OFF by default behind master/sub flags. General-task self-improvement, the eval/trace engines,
live mesh distribution, and self-repair are **TARGET**.
