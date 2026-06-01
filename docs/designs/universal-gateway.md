# Design: The Universal Gateway — every model + every tool, sovereign (Build #1)

**Status:** Half A (model gateway) **BUILT** — low-risk, extends PR#6-reviewed BYOK routing. Half B
(connector layer, high-risk) **HOLDS for security review** — the Codex run failed on expired auth
(`codex login --device-auth` to restore), so Half B is NOT built until reviewed (Codex or Gemini).
**Goal:** make StratosAgent the one sovereign endpoint for **all your models** (BYOK to 100+) **and
all your tools** (1,000+ connectors), with **every key stored on the user's hardware.** This is the
"all the value under one roof" core promise. Build on the existing api-shim (OpenAI-compatible
`/v1/chat/completions`, `model-manager.js` `PROVIDERS`/`resolveRoute`, `routers/cloud-byok.js`,
`routers/anthropic-adapter.js`, `secret-guard.js`, the PR#7 owner/permission model).
**Authority:** subordinate to STATE_OF_REALITY.md. No fabricated claims. License: Composio + LiteLLM
are MIT (bundle-compatible with our BSL).

## Two halves

### Half A — Universal model gateway (BYOK to everything)
We already BYOK to OpenAI/Anthropic/Google natively. Add breadth without bloating the Node runtime:
- **Recommended: native-expand `PROVIDERS`** + add **OpenRouter as a meta-provider** (one BYOK key →
  100+ models in OpenAI format). Keeps the stack Node-only, zero new heavy deps, fully sovereign.
- **Optional: detect a local LiteLLM** (MIT) proxy and route to it if the user runs one (power users /
  enterprises who want LiteLLM's full provider matrix + cost tracking). NOT required at runtime.
- Result: `model: "<anything>"` resolves to the right BYOK upstream (or local), keys read from env/
  vault, never logged (existing `secret-guard` + cloud-byok raw-body trust boundary).
- **Decisions for Codex:** native+OpenRouter vs a bundled LiteLLM sidecar (adds a Python dep to an
  `npm i -g` client — friction); how to keep the "100+ models" claim honest (it's "100+ via OpenRouter
  BYOK," not "we integrated 100 SDKs").

### Half B — Sovereign connector layer (Composio, keys on your hardware)
Give the agent tool-use over the user's real accounts (Gmail/Slack/GitHub/Notion/…), with the
**OAuth/credential vault running locally**, never our cloud.
- **Architecture:** StratosAgent acts as an **MCP client** to a **self-hosted Composio MCP server**
  (Rube, MIT) the installer can bring up locally; the credential vault lives in the user's env
  (`.stratos-profile`, 0600, the existing two-tier store). The agent discovers + calls tools via MCP.
- **The trust pitch is credible BECAUSE** the vault is local + the whole stack is source-available
  (BSL) — the opposite of pasting keys into a SaaS.
- **Security surface (the hard part — Codex focus):**
  - Tool-calling lets the model take **state-changing actions on real accounts** (send email, push
    code). On a CPU-local model, tool-call reliability is low → **state-changing actions require
    explicit owner confirmation** (reuse the PR#7 owner/DM gating + a deny-by-default per-connector
    grant). Read-only vs write tools separated.
  - Connector enablement is a **privileged grant — CLI/local only**, never via chat (consistent with
    PR#7: chat explains, never grants).
  - `secret-guard` already refuses keys-in-chat; connector OAuth happens in a local browser flow, not
    chat. Tokens never enter model context or logs.
  - Prompt-injection: a tool result (e.g., an email body) could try to make the agent call another
    tool. Mitigation: tool outputs are untrusted; state-changing calls always confirm; an allow-list
    of enabled connectors; rate limits.

## Files (proposed)
- `packages/api-shim/src/model-manager.js` — extend `PROVIDERS` (OpenRouter +), optional LiteLLM detect.
- NEW `packages/api-shim/src/routers/openrouter.js` — BYOK passthrough (mostly OpenAI-compatible).
- NEW `packages/stratos-agent/src/connectors/` — MCP client + connector registry + local vault binding.
- `stratos-ctl` / `stratos` CLI — `connect <app>` (local OAuth flow), `connectors` (list/grant/revoke).
- agent-config — `connectors: { <app>: { state, scopes } }`, deny-by-default; `permissions` gains
  tool-use grants (CLI-only).
- Tests: model resolution for new providers; connector grant gating; state-changing-action confirm;
  secret-guard on connector flows; "no tool call without an enabled connector."

## Build order (each its own tested increment)
1. **Half A** (universal model BYOK + OpenRouter) — small, high-leverage, low-risk. **Today.**
2. **Half B step 1:** MCP-client + read-only connectors + local vault (no state-changing actions yet).
3. **Half B step 2:** state-changing tools behind explicit owner confirmation + per-connector grants.

## Open questions for Codex
1. Model breadth: native+OpenRouter (lean, Node-only) vs bundling LiteLLM (Python dep, more breadth) —
   right call for a sovereign `npm i -g` client?
2. Connector layer: self-hosted Composio MCP server as a child process vs embedding the SDK — which
   keeps the install frictionless AND the vault local?
3. The tool-calling security model on a weak local model: is "deny-by-default + owner-confirm for
   writes + connector allow-list" sufficient against prompt-injection-driven tool abuse?
4. Where exactly do OAuth tokens live, and how do we prove to a skeptical user they never leave the box?
5. Honest scope: what can we truthfully claim at launch vs mark "expanding"?

---
## ✅ REVISED per Codex Pattern-C SECURITY review (verdict: BUILD WITH CHANGES) — Half B governs
Codex found the design over-relied on secret-guard + chat/owner gating, while existing telemetry /
chat-history / LanceDB / mesh-export paths would make "tokens never leave the box" FALSE. Half B is
**NOT built** until these land. Required (all adopted):

1. **CRITICAL — write approval OUT of chat AND the model loop.** Every state-changing tool call stops
   at a **local CLI/browser approval** showing exact connector, account, scopes, normalized args/diff,
   and an action **nonce**. PR#7 owner-DM gating is necessary but NOT sufficient for writes.
2. **CRITICAL — deterministic BROKER between the model and Composio.** Never expose the raw 1,000+
   catalog; publish only a **curated, risk-tagged subset** with per-tool grants (read / draft / send /
   admin / destructive).
3. **CRITICAL — no autonomous chaining from attacker-controlled tool output.** Connector output is
   **untrusted → inert structured data only**; no follow-on tool call unless rooted in the latest
   owner request or a fresh local approval. **At launch, cross-connector chaining is DISABLED.**
4. **CRITICAL — exclude connector traffic from ALL persistence/export.** Hard-block connector
   requests/results from chat-history, LanceDB/ReasoningBank, telemetry harvest + rollups, and any
   mesh/export path. Only **redacted local audit metadata** is kept.
5. **CRITICAL — OAuth vault separated from config + process env.** Dedicated local vault subtree /
   OS keychain — NOT `agent-config.json` / `runtime-state.json` / chat memory / inherited env. The
   agent gets **opaque handles only**.
6. **HIGH — Composio as a pinned least-privileged SIDECAR** (absolute-path spawn, no shell, stripped
   env, stdio/Unix-socket only, private workdir, version pin + checksum, kill process group on exit).
   Do NOT reuse the generic `LegacyBridge` / `bridged_mcp_*` path.
7. **HIGH — scope/tool-specific grants.** `github.read_repo` must not imply `github.push`/`delete`;
   request minimum OAuth scopes; local revoke.
8. **HIGH — `stratos connectors audit`** — a user-verifiable non-egress proof: vault path/modes,
   sidecar bind, env scrub, destination allowlist, and **sentinel-token absence** from logs, model
   payloads, vector stores, and telemetry artifacts.
9. **HIGH — narrow the launch claim.** "Self-hosted connector layer with **local OAuth custody**,
   selected audited tools, **read-only first, local approval for writes**." NOT "1,000+ safe
   autonomous tools" or absolute "never leaves the box."

**Answers:** (1) native+OpenRouter ✅ built; detect LiteLLM only if present. (2) child-process sidecar,
pinned/stripped/private. (3) deny-by-default+confirm+allowlist is necessary, NOT sufficient — also need
the broker, output-tainting, no-chaining, out-of-band write approval. (4) dedicated local vault +
opaque handles; proof via sentinel integration tests + the audit command. (5) claim local OAuth
custody + curated access; do NOT claim 1,000+ audited or zero egress (calls to the target SaaS are
unavoidable egress).

### Half B build order (each its own tested increment; read-only first)
- **B1 — READ-ONLY connectors only** (no writes, no chaining): dedicated vault + opaque handles +
  deterministic broker + curated read-only tool subset + sidecar isolation + persistence-exclusion +
  `connectors audit`. Shippable after the CRITICAL controls. ← this is the real "Build #1 Half B".
- **B2 — write-capable tools** behind out-of-band local approval + per-tool grants. **Requires a
  SECOND security review before merge.**
