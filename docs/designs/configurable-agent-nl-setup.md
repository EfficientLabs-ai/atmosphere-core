# Design: Configurable StratosAgent + natural-language setup wizard — P1

**Status:** ✅ BUILT & MERGED-READY (2026-05-31). Design Codex-reviewed (BUILD WITH CHANGES, 7 changes adopted), then the *implementation* Codex-reviewed (4 findings — secret-guard-before-normalize HIGH, narrow-filter HIGH, TOCTOU MED, hypothetical-mutation LOW — all fixed). 75 unit checks green.
**Goal:** make StratosAgent frictionless AND deeply configurable for beginners and experts — a user
can **chat with the agent to set it up** ("call yourself Atlas, use Claude, connect Slack, turn on
the mesh"), pick an Efficient-Labs default, or use the CLI. Beginner-friendly (talk to it) + expert-
friendly (CLI/env/defaults). Honest about what's reliably doable on a CPU-only local model.
**Authority:** subordinate to STATE_OF_REALITY.md. No fabricated claims.

## Problem (audited)
`stratos-ctl init` is a readline CLI wizard saving a few vars to `.env.local`; `identity.js` reads
`STRATOS_AGENT_NAME`. There is **no agent-owned config** the agent can read+write, and **no
natural-language setup**. The model (qwen2.5:7b, CPU) can't be trusted for free-form tool-calling
reliably, so the NL layer must be **deterministic for the common config actions**, not open-ended.

## Design

### 1. Agent-owned config (`agent-config.js`)
One authoritative JSON at `.stratos-profile/agent-config.json` (0600), with a typed schema + safe
read/write + defaults + a `configured` flag:
```
{ agentName, model:{ provider:'local'|'openai'|'anthropic'|'google', name }, permissions:{ files,
  network, skills, shell } (all default OFF), channels:{ telegram, slack, discord }, meshOptIn,
  configured }
```
- **Migration:** on first load, import existing `.env.local` (`STRATOS_AGENT_NAME`, mesh opt-in) so
  nothing is lost. `identity.js` + the bridge read from THIS (single source of truth), env as fallback.
- Atomic writes (tmp+rename); never store secrets here (keys stay in env/vault).

### 2. Natural-language config intents (`config-intents.js`) — DETERMINISTIC v1
A safe, fast intent matcher (regex/keyword, no LLM round-trip) for the common setup actions, each
mapping to a `agent-config` mutation + a confirmation reply:
- "call yourself X" / "your name is X / change your name to X" → set agentName
- "use claude / gpt / gemini / local / qwen" → set model.provider+name (validates against the Model
  Manager; if a cloud provider with no key → tells the user to add the key)
- "connect/enable slack|discord|telegram" → set channels.* = true (+ note what's needed)
- "enable/allow files|network|skills|shell" → grant that permission (explicit, with a warning)
- "turn on/off the mesh" → meshOptIn
- "what can you do / what's your setup / show config" → render capabilities + current config
Anything not matched → falls through to normal chat. **Honest:** this is the *common* setup surface,
not arbitrary configuration; the design notes that openly. (LLM tool-calling is a flagged v2.)

### 3. First-run experience
If `configured===false`, the agent's first reply (Telegram/CLI) is a short guided intro: who it is,
the two paths ("use the Efficient Labs default and start now" / "let's customize — just tell me your
name, which model, and what to connect"), and that everything is opt-in/off-by-default. After the
user picks a default or sets a few things → mark `configured=true`.

### 4. Expert paths unchanged
`stratos-ctl init` (CLI) and env/defaults still work and now write the SAME `agent-config.json`.

## Security / honesty
- Permissions default OFF; granting one via chat requires an explicit affirmative + a one-line warning.
- Secrets (API keys) are NEVER set via chat into the config — the agent tells the user to add the key
  to env/vault (so keys don't land in a world-readable config or chat logs).
- Config writes are localhost/owner-only (the bridge is 127.0.0.1; chat is the owner's Telegram).
- The agent never claims a channel/model is connected unless the config + prerequisites are real.

## Files
- NEW `packages/stratos-agent/src/core/agent-config.js` (schema, load/migrate/save, typed mutations).
- NEW `packages/api-shim/src/config-intents.js` (deterministic matcher → mutations + replies).
- `identity.js` reads agentName/model/permissions from agent-config.
- `telegram-bridge.js`: check config-intents before normal chat; first-run intro.
- `stratos-ctl.js`: write agent-config.json (keep CLI wizard).
- NEW tests: agent-config (migrate/mutate/atomic), config-intents (each intent + fall-through + the
  "no secrets via chat" rule + permission-grant requires affirmative).

## ✅ REVISED per Codex Pattern-C review (verdict: BUILD WITH CHANGES) — this governs

**Chat config is a SECURITY BOUNDARY, not UX.** v1 reshaped accordingly:

1. **Owner binding + DM-only.** No config mutation from chat until an owner is bound (a stable
   Telegram user id, set via `STRATOS_OWNER_CHAT_ID` env or `stratos-ctl bind`). Only the bound
   owner, in a **direct message** (not a group), can run config intents. No owner → read-only.
2. **No privileged grants via chat.** `shell / files / network / mesh` permissions AND **cloud-
   provider switching** (a data-egress/privacy change) are **CLI/local-only**. Chat may *explain*
   how, never *grant*. v1 chat config is the SAFE surface only: set agentName, switch among **local**
   models, read config/capabilities, and guided-setup explanations.
3. **Bridge-level secret interception (critical).** A `secret-guard` runs at the bridge BEFORE the
   model, logs, persistence, or telemetry: if an inbound message contains a key-shaped string
   (`sk-…`, `sk-ant-…`, `AIza…`, bearer-like), it is redacted and refused with "never paste keys
   here — add it to env/vault." Keys NEVER enter model context or any log. No inline-secret exception.
4. **Config authoritative for non-secrets; env = secrets + ONE-TIME import.** After
   `agent-config.json` exists, env no longer overrides non-secret prefs (no silent revert on restart).
5. **Two-tier state.** `agent-config.json` (user prefs, non-secret) vs `runtime-state.json`
   (`ownerBinding`, `setupState`, per-channel `introShown`). Security never gates on `configured`.
6. **Desired vs effective.** Config stores *desired* (`disabled|requested|configured|ready`);
   `effectiveCapabilities()` reports what's actually usable (model ready only if the local model is
   installed or the cloud key is present). Never claim a channel/model is ready when it isn't.
7. **Constrained grammar + confirmation.** Tight phrase matcher; negation/quotes/hypotheticals
   (“don't use Claude”, “should I enable shell?”) must NOT mutate. Marketed as **"setup shortcuts,"**
   not "general natural-language configuration." Confirm before apply.
8. **Revision-guarded writes** (compare-and-swap on a `rev` field) — atomic rename alone doesn't stop
   lost updates.

### 7 required changes (all adopted)
1. Owner binding + DM-only auth. 2. No plain-chat privileged grants / provider switch. 3. Config
authoritative for non-secrets; env=secrets+import. 4. Bridge secret interception/redaction.
5. Separate user-config vs runtime state. 6. Desired/effective (no false readiness). 7. Constrained
grammar + confirmation + revision-guarded writes.

---
## Open questions for Codex (resolved above)
1. Deterministic intent matcher vs. real LLM tool-calling for v1 — is keyword/regex honest+enough, or
   does it over-promise "natural language"? Where's the line so we don't claim more than it does?
2. Config as the single source of truth vs. env: precedence + migration edge cases (env changed after
   config exists?).
3. Permission grants via chat: safe, or should privileged grants (shell/network/files) require the
   CLI / an out-of-band confirm, never chat?
4. First-run state: where to store "configured" + per-channel intro-shown without races?
5. Secret handling: confirm the agent must NEVER accept an API key in chat — only direct the user to
   env/vault. Any case where inline is acceptable?
