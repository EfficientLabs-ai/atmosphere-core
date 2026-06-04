# Trust-substrate review — 2026-06-05 (pre-merge)

Independent Pattern-C review of this session's sovereignty-critical, live-request-path changes
(`model-router.js`, `mesh-signal.js`, `task-router.js`). Reviewer: **Gemini** (Claude could not reach
Codex in this session — codex CLI not on PATH, MCP tool not surfaced; the operator should still run
the canonical Codex review at merge). Packet: `/tmp/codex-substrate-review.txt`.

The brief asked specifically: can any prompt reach cloud **silently**? Correctness of difficulty /
escalation? Mesh-signal honesty? Regression vs the `{decision,reason,targetModel}` contract? Bypass
via directives?

## Findings + disposition

**1. [MEDIUM] Doc contradiction — explicit-cloud-model opt-in vs. classify() omitting the wire model.**
`model-router.js` said "choosing a cloud model IS the opt-in," but `task-router.js` deliberately does
NOT pass the client's wire `model` into `route()`. The *omission is correct* (OpenAI-compatible clients
auto-send a model, often a default like `gpt-4o`; treating that as opt-in would silently break
sovereignty). → **FIXED (doc):** clarified in `model-router.js` §1 that the explicit-model branch is
for *deliberate* callers (`stratos route --model`, a future explicit BYOK channel), and that the live
shim intentionally omits the wire model. No behavior change.

**2. [MEDIUM] Difficulty heuristic is gameable → cloud escalation WHEN A KEY IS CONFIGURED.**
A long (≥1200 char) keyword-stuffed prompt hits `difficulty ≥ 4`; with a BYOK key set, that escalates
to cloud without `/force-cloud`. Low risk in today's single-user (operator-is-the-input) deployment,
but a real vector for a **multi-tenant / untrusted-input** agent: a hostile prompt could force cloud
spend + data egress without the operator's per-request consent. → **FLAGGED FOR OPERATOR — design
decision, NOT changed autonomously.** Recommended hardening: make difficulty-based auto-escalation
opt-in at config (e.g. `STRATOS_CLOUD_AUTO_ESCALATE`, default **off** = secure-by-default), so cloud
requires an explicit per-request `/force-cloud` even with a key. This is the more sovereign default but
changes the approved "key = standing opt-in for hard prompts" UX, so it's the operator's call.
(Mitigating today: no frontier key is configured by default ⇒ everything stays local regardless.)

**3. [LOW] Mesh signal is file-honest, not liveness-honest.**
`mesh-signal.js` trusts `fleet.json`'s self-report; it does not confirm the listed nodes are reachable
now, so a stale file could route heavy work to a dead node (then the caller falls back). → **DOCUMENTED**
in the module header as an honest limit; a heartbeat/liveness gate is follow-up work for when the mesh
runs (needs ≥1 live peer to test). No behavior change.

**4. [LOW] Directives parsed only in the last user message.**
`/force-local` · `/force-cloud` · `/private` are read from `extractLastUserMessage`, so a directive in
a system prompt or an earlier turn is ignored. → **ACCEPTED AS DESIGNED:** a routing directive should
apply to the *current* ask (the last user message), not leak from prior turns. Noted for awareness.

## Net
No SILENT-cloud path found (the core guarantee holds): with no key, everything is local; with a key,
escalation needs `difficulty ≥ 4` — finding #2 is about hardening that threshold against hostile input,
not a default-on leak. Two doc fixes applied; one design decision (#2) flagged for the operator; one
liveness limit (#3) documented. All 53 hermetic tests remain green after the doc-only edits.
