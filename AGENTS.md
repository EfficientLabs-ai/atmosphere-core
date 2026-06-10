# AGENTS.md — how AI agents work in this repo (private core)

> Governance for AI coding agents (Claude, Codex, Gemini, and any assistant) contributing to
> `atmosphere-core` — the PRIVATE monorepo. The public mirrors (StratosAgent, TheAtmosphere)
> carry their own public-safe AGENTS.md; this one may reference internal infrastructure.
> These rules are non-negotiable. If a change can't satisfy them, don't ship it.

## The operating layer (read first)

The source of truth lives in the **command-center** at `/opt/efficient-labs/command-center/`:
`00_truth/` (unified audit, WHY/TRUST/LIFECYCLE/ECONOMIC_GRAPH, doctrine) · `01_roles/` (role
contracts) · `05_decisions/` (ADRs). **The file system is the boss** — truth flows
`Repository → Context → Decision → Skill → Workflow → Graph`, never from an agent's chat memory.

## The truth gate

**Only tested capability is labeled "done."** Not covered by a passing test + verified to run = WIP.
- Mocks are labeled `mock`/`stub`/`fake` everywhere — never described as working features.
- No inflated status; aspiration is labeled aspiration. Verify against reality before claiming.
- CI enforces part of this: `scripts/claim-lint.mjs` (banned/false public claims),
  `scripts/check-carve-sync.mjs` (trust-spine mirror identity), the hermetic allowlist suite.

## Definition of Done (the merge gate — ADR-0003)

A change merges only when ALL hold:
1. **Tests green** — `node scripts/ci-test.mjs` (hermetic allowlist) + a new assertion for new behavior.
2. **Codex verification on record** — an independent `mcp__codex__codex` review verdict
   (APPROVE / APPROVE_WITH_NOTES). Codex blocks the merge until clean; Gemini is the fallback
   verifier when Codex is unreachable. Two perspectives beat one perspective twice.
3. **Behavioral check** — the thing was run and observed, not merely compiled.
4. Reason + test + rollback note in the PR; docs reflect the new reality.

## Roles (fixed)

Claude (Fable 5) = architect + builder · Codex = independent verifier (merge gate) ·
Gemini = research + synthesis · ShadowsAgent = operator interface · **Founder = sovereign decider.**

## Protected actions — founder-only, never autonomous

`ATMOS_GATEWAY_SECRET` provisioning (agents must NEVER generate, read, or echo it — issue #58) ·
pricing / public-claim publication · npm publish · destructive actions outside an approved
CLEANUP_MANIFEST. PR merges are agent-executable ONLY behind a recorded Codex verdict (ADR-0003).

## Secret hygiene (incidents made these rules; keep them)

- Never read/echo/interpolate `.env*`, vault contents, keys, tokens — in any output, log, commit, or PR.
- **No `bash -x`** (or tracing) on any script that sources secrets.
- Never hand a raw token to another agent or tool — vault-aware helpers only (`~/bin/mem-handoff`).
- Secret-scan before commit (`scripts/check-anonymization.mjs` gates the public-surface staging).
- The live daemon's env is fragile: PM2 changes go through `ecosystem.config.cjs` +
  `pm2 reload --update-env`, never a bare restart.

## The alignment gate (before building anything)

Does this increase **intelligence ownership · compounding · portability · sovereignty · execution**?
If no — stop and re-evaluate (it probably shouldn't be built). The architecture is mature enough
that **activation is the rule and addition is the exception** (Unified Audit; SPRINT_001 #86).

## Lifecycle (binding — 00_truth/LIFECYCLE.md)

Every produced entity (skill, workflow, knowledge, decision, graph) carries a lifecycle state
(`created → validated → promoted → deprecated → archived`); promotion requires a cited validation
gate; graphs derive truth from sources, never originate it.
