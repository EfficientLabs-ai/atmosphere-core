# Design: Folder-Stage Pipeline Engine (ICM "folders over agents") — P1

**Status:** DRAFT for Codex Pattern-C review before implementation.
**Thesis:** replace brittle framework orchestration (AutoGen/CrewAI-style) with plain filesystem
stages + plain-text interfaces — Unix-pipeline / multi-pass-compiler discipline applied to an
agent. Each stage does ONE job, reads files from the prior stage, writes files to its own folder.
**Authority:** subordinate to STATE_OF_REALITY.md. No hype metrics ("95% cost reduction" etc.).

## Why (grounded)
StratosAgent already favors discrete artifacts (signed skills, plain manifests). This makes the
orchestration layer match: a workflow is a **folder of ordered stages**, not a code graph. Benefits
that are real (not quoted percentages): resilience (a stage is just a folder + a prompt; nothing
to break when an API changes), transparency (every intermediate is a human-readable file you can
edit mid-run), sovereignty (plain text, local files, runs on the local model), and mesh-readiness
(a stage with strict file I/O can later be dispatched to a mesh node).

## Shape

### A pipeline (the "factory", configured once)
```
pipelines/<name>/
  pipeline.md            # ordered stage list + description (frontmatter: stages: [...])
  stages/
    01-research/stage.md # ONE job. frontmatter: { type: model|script, model?, inputs?, reads? }
    02-draft/stage.md
    03-format/stage.md
  reference/             # stable rules/constraints (loaded only by stages that declare `reads:`)
```
`stage.md` = frontmatter + a markdown body that is the stage's instructions (the system prompt for
a `model` stage, or ignored for a `script` stage). **One stage, one job** (research ≠ write ≠ format).

### A run (each execution → a new deliverable)
```
runs/<runId>/
  input.md               # the run's initial input (seed)
  01-research/output.md   # stage outputs — plain text, HUMAN-EDITABLE between stages
  02-draft/output.md
  03-format/output.md
  run.json               # status per stage (pending|done|edited|failed) + timings
```

### The engine (`packages/stratos-agent/src/pipeline/`)
`runPipeline(pipelineDir, { runId, input, stopAfter?, fromStage?, model? })`:
1. Parse `pipeline.md` → ordered stages. Validate each `stage.md` (type, single job).
2. For each stage in order (from `fromStage`):
   - **Layered context (ICM #3):** load ONLY this stage's `stage.md` body + the **previous stage's
     `output.md`** + any files named in `reads:` (from `reference/`). Not the whole history.
   - `type: model` → POST to the local completion endpoint (`127.0.0.1:PORT/v1/chat/completions`)
     with `[{system: stage body}, {user: prior output + declared reads}]`; write the reply to
     `runs/<runId>/<stage>/output.md`.
   - `type: script` → run a bounded script (Node child_process with timeout + cwd=run dir +
     NO network by default) reading prior output from argv/stdin, writing `output.md`. (WASI is
     the eventual sandbox; v1 = child_process with a hard timeout + no inherited secrets.)
   - Update `run.json`. **Mixed-initiative (ICM #4):** if `output.md` already exists and run.json
     marks it `edited`, REUSE it (the human edited it) — do not overwrite. `stopAfter: <stage>`
     halts for review; re-invoking with `fromStage` resumes.
3. Idempotent/resumable: existing non-stale outputs are reused unless `--force`.

### Honest boundaries (v1)
- **Sequential only.** No parallel DAG, no fan-out. (Mesh fan-out is a later, separate step.)
- Model stages go through the EXISTING local-inference endpoint, so identity + Tier-0 window apply.
- Script stages: child_process + timeout + no network/secrets in v1 (WASI hardening later — flagged).
- Token budget per stage is bounded by Tier 0 already; pipeline does not add its own LLM summarizer.
- No state outside the run folder. A run is fully described by its files (inspect/diff/replay).

## Eval / proof (`test-pipeline.mjs`)
A tiny 3-stage demo pipeline (deterministic, no model needed for the test): a `script` stage that
uppercases input → a `script` stage that reverses → a `script` stage that wraps in a banner. Assert:
(a) each stage reads the prior `output.md` and writes its own; (b) a human "edit" to stage 1's
output is RESPECTED on resume (not overwritten); (c) `stopAfter` halts and `fromStage` resumes;
(d) a failing stage marks `failed` and does not corrupt later outputs. A separate manual smoke
uses a real `model` stage through the live endpoint.

## Files
- NEW `packages/stratos-agent/src/pipeline/engine.js` (parse + run, pure-ish core + injected runners).
- NEW `packages/stratos-agent/src/pipeline/stage-runners.js` (model runner, script runner).
- NEW `packages/stratos-agent/pipelines/example-brief/` (a real 3-stage demo).
- NEW `packages/stratos-agent/test-pipeline.mjs`.
- Export `runPipeline` from `packages/stratos-agent/index.js`; optional `stratos-ctl pipeline run <name>`.

## ✅ REVISED per Codex Pattern-C review (verdict: BUILD WITH CHANGES) — this section governs

### Ordering authority (one source of truth)
The **numbered stage directories** (`stages/01-*/`, `02-*/`, …) ARE the order. `pipeline.md` is
optional description only — never a second stage list.

### Precise freshness / invalidation model (the biggest risk — defined BEFORE code)
For each stage `S` at index `i`, in order:
- `effectiveInput(S)` = canonical concat of: the stage.md (frontmatter+body) + the PRIOR stage's
  `output.md` (or the run's `input.md` for i=0) + the resolved contents of each `reads:` file +
  the model id + the runner id. Snapshotted to `runs/<id>/<stage>/prompt.md` (provenance).
- `inputFingerprint(S)` = sha256(effectiveInput(S)). `outputHash` = sha256(output.md).
- Decide per stage using its `meta.json`:
  - no meta → **pending** → run.
  - `meta.inputFingerprint === current`:
    - on-disk `output.md` hash === `meta.outputHash` → **done/fresh** → reuse, skip.
    - else → **edited** (human changed the output) → reuse the edited output, do NOT overwrite;
      but because its output changed, downstream `inputFingerprint`s change → they recompute.
  - `meta.inputFingerprint !== current` → **stale** → run.
- Because each stage's fingerprint includes the prior `output.md`, re-running or editing any stage
  naturally invalidates every downstream stage (their input changed). No separate cascade needed.
- A stage whose prior stage is **failed** is **blocked** (not run).

### State machine + durability
States: `pending | running | done | edited | stale | failed | blocked`. `running` is written before
execution and cleared after; a `running` found at start = a prior crash → treat as stale. ALL writes
(`output.md`, `prompt.md`, `meta.json`) are atomic: write `*.tmp` then `rename`.

### Security boundaries (honest)
- Path safety: canonicalize `runId`, stage ids, `reads:`, and script paths with `realpath`; REJECT
  anything resolving outside the pipeline root or run root (no `..`, no absolute, no symlink escape).
- Script stages are **trusted first-party only** in v1 — `child_process` + hard timeout + input via
  **stdin/file (never argv)** + no inherited secrets. This is NOT a sandbox; WASI is future work.

### Injected runners
`runPipeline(pipelineDir, { runId, input, runners, stopAfter?, fromStage?, force? })` where
`runners = { model, script }`. The default `model` runner calls the local HTTP endpoint; tests
inject deterministic runners. Engine = file/state orchestration only.

### Provenance per stage (run folder)
`runs/<id>/<stage>/`: `prompt.md` (effective input snapshot), `output.md` (authoritative), `meta.json`
(status, inputFingerprint, outputHash, runner, model, startedAt/endedAt, error?). Multi-artifact
output deferred — one authoritative `output.md`; scripts may emit sidecars as non-authoritative debug.

---
## Open questions for Codex (resolved above)
1. Stage I/O contract: single `output.md` per stage, or allow a stage to emit multiple named
   artifacts (a folder)? (Simplicity vs. real multi-output stages.)
2. Resumability/edit-detection: trust `run.json` status, or hash outputs to detect human edits?
3. Script stage isolation in v1: child_process+timeout sufficient, or must it be WASI from day one
   given the security thesis?
4. Where does the engine live — stratos-agent (agent runtime) or a new top-level package?
5. Is coupling model stages to the HTTP endpoint right, or should the runner be injected (so the
   engine stays testable + the model is swappable: local / BYOK / mesh)?
