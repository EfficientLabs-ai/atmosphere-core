# ACTIVATION.md — the activation-flag matrix (issue #79)

> THE "built but not switched on" fix: one canonical map of every capability gate — what it gates,
> the **code default**, the **live bridge state** (the PM2 `atmos-secure-bridge` deployment on this
> box), and how to prove it. The audits graded activation ~40% against code defaults; this matrix is
> the ground truth for what is actually ON. Update it in the SAME PR as any flag change.
> Live state verified 2026-06-11 via `pm2 jlist` env. Metrics: `node scripts/intelligence-metrics.mjs`.

## Core activation flags

| Flag | Gates | Code default | LIVE bridge | Proof |
|---|---|---|---|---|
| `STRATOS_OPERATING_CORE` | the observational tap: workspace→context→trace→eval on the live request path (operating-tap.js) | OFF | **ON (=1)** | a chat request writes a trace + mints a receipt; `STRATOS_OPERATING_CORE_DEBUG=1` logs tap activity |
| `STRATOS_EVOLUTION` | the self-evolution engine master switch (self-evolution-runtime.js) | OFF | **ON (=1)** | LEARN scheduler starts at boot (`index.js`) |
| `STRATOS_EVOLUTION_OBSERVE` | OBSERVE: capture deterministic numeric-transform successes into cognitive_skills | OFF | **ON (=1)** | `cognitive_skills` row count grows on int→int prompts |
| `STRATOS_EVOLUTION_EXECUTE` | EXECUTE: serve a PQC-verified learned skill before the LLM | OFF | **ON (=1)** | matching prompt answered from a verified skill (logged) |
| `LOCAL_FALLBACK_ENABLED` | local inference fallback when the upstream agent is down | OFF | **ON (=true)** | upstream down → local answer, not 502 |
| `ATMOS_UPSTREAM_BREAKER` | EFL-014 circuit breaker (default ON; `off` disables) | ON | **ON** | `/health` → `upstreamBreaker.state` |
| `ATMOS_GATEWAY_SECRET` | gateway auth enforcement on spend + /mcp routes | unset = warn+allow (loopback) | **SET — enforced 2026-06-11 (vault-hydrated #101; #58 CLOSED)** | set → requests without the secret get 401 |
| `STRATOS_CLOUD_AUTO_ESCALATE` | router may auto-escalate to BYOK cloud on difficulty | OFF | **OFF** | cloud requires explicit opt-in + key |
| `STRATOS_USER_MODEL` | dialectic per-conversation user model | ON | **ON** | `.stratos-user-model.db` WAL grows |
| `STRATOS_MESH_AVAILABLE` / `STRATOS_FLEET` | mesh routing signal (deny-by-default, never invents peers) | OFF/unset | **OFF** | `meshAvailable()` false absent a live fleet.json |
| `STRATOS_SYNTHETIC_VISION` | labeled synthetic demo output on the vision path (EFL-002) | OFF | **OFF** | `/vision` answers honestly; no fabricated analysis |
| `STRATOS_NIGHTSHIFT_CRON` | night-shift skill compilation schedule | `0 2 * * *` (when evolution ON) | active (evolution ON) | gsi-scheduler logs at 02:00 |
| `STRATOS_PQC_MODE` | PQC strictness for seals/receipts | hybrid | hybrid | receipt verify (public-key-only) |
| `CARVE_SYNC_STRICT` | carve-sync drift gate fails on unreachable mirrors (#75/#76) | OFF locally / **ON in CI** | n/a (CI) | ci.yml gate step |

Config/path knobs (not activation): `STRATOS_{SKILLS,PROFILE,WORKSPACES,VAULT}_DIR`, `STRATOS_{DB,VECTOR_STORE}_PATH`, `STRATOS_FTS_DB`, `STRATOS_USER_MODEL_{DB,SYNTH_EVERY,MAX_CHARS}`, `STRATOS_NODE_KEYS`, `STRATOS_MODEL`, `STRATOS_SENSORY_MODEL`, `STRATOS_AGENT_{NAME,URL}`, `STRATOS_TIMEOUT`, `STRATOS_RECEIPTS`, `STRATOS_LEDGER`, `STRATOS_EGRESS_POLICY`, `STRATOS_BROKER_REGISTRY`, `STRATOS_COMPOSIO_DATA`, `ATMOS_GATEWAY_ORIGINS`, `ATMOS_UPSTREAM_BREAKER_{THRESHOLD,COOLDOWN_MS}`.

## Status metrics — measure compounding intelligence, not just uptime

Per the founder's directive (plan §Phase 1 P2): the status surface reports **Context Nodes ·
Knowledge Nodes · Skills · Workflows · Decisions · Trust Events · Execution Traces · Predictions ·
Cost Saved · Time Saved** — produced by `scripts/intelligence-metrics.mjs` (read-only over the live
stores; each source independent, honest `null` + reason when a store is absent). Wire-up to the
public status page tracks under the web repo.

## Rules
1. **A flag flip on the live bridge is a deployment** — through `ecosystem.config.cjs` + `pm2 reload --update-env`, never a bare restart (env fragility incident, 2026-05-31).
2. **This matrix changes in the same PR as the flag** — drift here is a claim-lint-class honesty bug.
3. Activation follows LIFECYCLE: a capability turns ON only after its validation gate passed (tests + Codex), and the flip is logged in `05_decisions/`.
