# Content Engine

A generic, reusable content pipeline for a creator's personal brand + company. The tool ships in this
repo; **the profile and generated content never do** — they live in a private directory outside the repo
(`CONTENT_DIR`, default `~/founder-content`).

## CLI

```
stratos content generate [--lane personal|labs|both] \
                         [--platform x|linkedin|short-video|carousel|all] \
                         [--tone raw|cinematic|hybrid|all] \
                         [--n N]
```

For each **unused** angle it draws, it generates a structured piece — HOOK, ~60s body (or thread /
carousel slides), CTA, and shot/b-roll notes — marks the angle used, and writes a dated batch under
`$CONTENT_DIR/batches/`. Re-run → fresh pieces, no repeats.

## Inputs (private, off-repo)

- `profile.md` — voice, pillars, audience, honesty rule (the engine's input).
- `angles.json` — an extensible angle bank: `{id, lane, theme, hook_seed, status}`.
- `used.json` — angle ids already generated (so re-runs are fresh).
- `batches/` — dated output.

## Self-growing

Each run mines recent `git log` commit subjects of the build and folds them in as fresh
`build-in-public` angles — "everything we build is content" — so the pipeline keeps producing new material.

## Sovereign by default · configurable model

Generation goes through the local OpenAI-compatible gateway at `127.0.0.1:4099/v1/chat/completions` by
default — no cloud, no API key. Override per the operator's needs:

- `CONTENT_MODEL` — model name (default `gemma2:2b`).
- `CONTENT_ENDPOINT` — full chat-completions URL.

**Honest caveat — output quality tracks the model.** The local fast model produces *drafts*; a stronger
model produces *finished copy*. The hand-written `batch-01.md` is the quality bar. The engine **never
fabricates metrics or claims** — the model is instructed not to, a fully-degraded run produces nothing
(and consumes no angle) rather than faking output, and a model that returns unusable copy degrades
honestly with the reason.

## Privacy

`CONTENT_DIR` lives outside any git worktree, so the profile and batches can never be staged or committed.
This tool embeds no personal data.

## Capability

`stratos content generate` is capability-gated deny-by-default; it declares the single
`content.generate` action (reads local files + a loopback model call — no secrets, no external egress).
