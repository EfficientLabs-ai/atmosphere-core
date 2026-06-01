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
