# Efficient Labs — Product Requirements (PRD)

> **DERIVES FROM and is SUBORDINATE TO [`DOCTRINE.md`](DOCTRINE.md).** Where this PRD conflicts with the
> doctrine, the doctrine wins. Evidence and the honesty caveats live in [`STRATEGY-BRIEF.md`](STRATEGY-BRIEF.md).
> **Measured status is owned by [`STATE_OF_REALITY.md`](../../STATE_OF_REALITY.md)** — that file, not this one,
> says what is actually shipped. Anything here that is not in `STATE_OF_REALITY.md`'s ✅ WORKING column is
> **direction / target / roadmap**, never a present-tense claim.

---

## 1. What we are building (and what we are not)

Efficient Labs builds **Sovereign Intelligence Infrastructure (SII)**: a system where individuals, developers,
businesses, and eventually agents **own, govern, compound, and execute** intelligence.

**SII is a positioning construct we are defining — not an established analyst category.** We do not present it
as an industry-standard term. We earn the term only by tying it to **concrete, measurable outcomes**: less tool
sprawl, governed execution, portable context, tighter AI/cloud cost control, stronger privacy. If a feature
cannot be traced to one of those outcomes, it does not get to wear the SII label.

Per the doctrine's layer model, the product spans exactly two layers and consumes everything below:

| Layer | Owner | Role in the product |
|---|---|---|
| Layer 0–2 | Internet · Cloud · Models | **Replaceable substrate.** We orchestrate; we never rebuild. |
| **Layer 3 — Atmosphere** | Efficient Labs | **Ownership layer.** Where intelligence lives, who owns it, how it compounds/moves/executes. |
| **Layer 4 — StratosAgent** | Efficient Labs | **Execution layer.** Reads the graph, negotiates with authority, runs work under user-owned policy. |
| Layer 5 | User / Developer / Business | Experiences built on top. |

StratosAgent **never owns intelligence — it executes intelligence.** Atmosphere never executes user work — it
governs, stores, and routes. This boundary is load-bearing; do not blur it in any surface.

---

## 2. The alignment gate (mandatory for every feature)

This is the Product Doctrine + Final Instruction, restated as the build gate. Before any feature is specified,
it must increase **at least one** of:

- **Intelligence Ownership** — the user/org keeps the context, skills, workflows, history, decision graphs.
- **Compounding** — the interaction leaves behind reusable org value (runbooks, preferences, scopes, traces).
- **Portability** — the value moves across models, clouds, and execution environments without re-capture.
- **Sovereignty** — local-first by default; cloud/vendor is opt-in, auditable, never silent.
- **Execution** — the agent can actually do the work, under explicit human authority.

**Decision rule (binary, non-negotiable):**

```
For each proposed feature F:
  axes = { ownership, compounding, portability, sovereignty, execution }
  if F increases >= 1 axis  AND  F does not violate the Human Sovereignty Doctrine:
      -> eligible to build (then prioritize by GTM order, §6)
  else:
      -> DO NOT BUILD. Re-evaluate or drop.
```

Two hard vetoes regardless of axis score:
1. **Human Sovereignty overrides all.** No full autonomous control without explicit governance. Agents execute;
   humans retain final authority, own goals, own permissions.
2. **Capability Doctrine.** If MCP, A2A, Composio, an existing SDK/API/DB already solves it — we **integrate, not
   reinvent.** "We built our own X that already exists" fails the gate.

---

## 3. Product surfaces mapped to the four mandatory layers

The Strategy Brief fixes four mandatory architecture layers. Every surface below names which layer it serves and
its honest status. **Status legend mirrors `STATE_OF_REALITY.md`:** ✅ shipped/verified · 🟡 real code, not yet
wired/live · ⛔ spec/roadmap only. Treat anything not ✅ as **target**, and defer the authoritative call to
`STATE_OF_REALITY.md`.

### Layer A — Identity & Authority (the AUTH layer)

Governs who may act, delegate, execute, approve. Built on boring, proven standards: OAuth/OIDC, NIST zero-trust,
Zanzibar/OPA-style fine-grained authz.

**Two distinct artifacts — separated by PURPOSE and PATH, never by capitalization:**

| Artifact | Purpose | Path / surface | Posture |
|---|---|---|---|
| **Internal AUTH governance manifest** | Ownership, delegation, escalation, risk thresholds, human-approval rules. The internal authority chain `Human → Workspace Owner → Org → Policies → Agents → Tools`. | `/AUTH.md` (governance doc) + the workspace authority config | First-class, ours, always present. |
| **External `auth.md` protocol** | Agent registration / discoverability — protocol-facing, machine-readable for external agents. | A discoverable protocol file (WorkOS `auth.md`, **launched 2026-05-21, very new**). | **Adopt where available; do not depend exclusively.** Never assume universal support. Design must degrade gracefully when a peer does not speak it. |

- **Identity broker** (mints short-lived, audience-bound, scoped assertions; returns only the token, never the
  raw credential; deny-by-default): 🟡 built + tested on a feature stack, **not yet live on the daemon**.
- **Capability gate** (least-privilege caps inside the PQC-sealed manifest; deny-by-default before a skill runs):
  🟡 built + tested, not yet live.
- WorkOS/`auth.md` external registration interop: ⛔ roadmap.

### Layer B — Context & Intelligence Graph (*the real product*)

Per Context Doctrine: **nothing disappears; everything transforms.** Capture prompts, plans, tool calls, outcomes,
failures, approvals, policies, repo facts, preferences, artifacts, cross-agent traces — then transform them along
`Conversation → Decision → Workflow → Skill → Reusable Asset → Organizational Intelligence`. Store **structured
intelligence** (intent, reasoning, actions, results, lessons, approvals, costs, confidence), not raw data only.
OpenTelemetry is the instrumentation spine. This is the **moat** — see §7.

- Conversation memory (per-chat, durable, context-window-honest): ✅ shipped.
- Real vector store + semantic embeddings (LanceDB + `nomic-embed-text`, relevance-gated, no hallucinated recall):
  ✅ shipped.
- **Attribution ledger** — append-only, tamper-evident hash chain recording every verified run, attributed to a
  node's `did:atmos`. `summarize()` reports **measured units per contributor and is explicitly NOT a payout**
  (measurement before rewards): 🟡 built + tested, not yet live.
- Interoperable cross-vendor graph export/import (generalizing vendor "memory/company-knowledge" into a portable
  graph): ⛔ roadmap — this is the wedge, and it is not built yet.

### Layer C — Execution (StratosAgent)

Runtime that reads the graph, negotiates with the authority layer, and chooses tools/models/agents by
**user-owned policy.** MCP = default agent↔tool; A2A = default agent↔agent; Composio for integration breadth
(Capability Registry, not thousands of hand-built connectors).

- Local-first agent loop (Telegram bridge, real local `qwen2.5:7b` via Ollama, self-aware as StratosAgent,
  honest readouts): ✅ shipped.
- Folder-stage pipeline engine (ICM "folders over agents"; hash-freshness, human-editable intermediates): ✅ shipped.
- Self-evolution loop (OBSERVE → LEARN → EXECUTE) for the **deterministic numeric-transform class only**, behind
  flags that default OFF, verify-before-execute: ✅ shipped (narrow scope — do not over-claim).
- Real cross-machine P2P compute mesh (public Hyperswarm DHT + hole-punch, PQC-signed skill gossip,
  proof-of-capacity, parallel job scheduler, HA failover) — proven on the **operator's own fleet**, not a public
  network: ✅ shipped (operator fleet) · public mesh = roadmap.
- MCP gateway / Composio Capability Registry / A2A first-class transport: ⛔ spec/roadmap.
- Multimodal (vision/voice), omni-channel adapters (Slack/Discord/WhatsApp): ⛔ mock/scaffold — roadmap.

### Layer D — Compute & Routing

User/org routing policies, **auditable, explainable, user-owned**. Per Economic Routing Doctrine: **Atmosphere
recommends; users decide; never silently swap models.** Routing profiles: Maximum Quality · Balanced · Lowest Cost
· Private Only · Open Weight Only · Frontier Only · Custom. Model Abstraction Layer exposes `reason()`, `research()`,
`code()`, `analyze()`, `execute()`, `summarize()`, `plan()` — applications never call vendors directly.

- Sovereign model router — **LOCAL is default; `/private` pins local; cloud is opt-in only** (configured BYOK key
  on a genuinely hard prompt, or `/force-cloud`), behind a 402 cost-approval gate: 🟡 consolidated on a feature
  stack; the live daemon still runs the prior policy until merge + reload.
- Universal Model Manager / BYOK (OpenAI, Gemini, Anthropic, OpenRouter; keys never logged; falls back to local
  without a key by design): ✅ built + tested. A real end-to-end frontier call requires the user's own key.
- Consensus Engine surfacing Agreement / Conflict / Confidence / Evidence (Contradiction Doctrine — never hide
  disagreement): ⛔ roadmap.
- P2P as a **governed execution option** (per Distributed Compute Doctrine Phase 2) — not the initial trust anchor;
  cloud/edge/local launch first: ✅ mesh exists (operator fleet) · governed public option = roadmap.

---

## 4. Packaging & pricing

Hybrid model — not pure-seat, not pure-token. Developer-led entry, productized enterprise outcomes.

| Tier | Who | Shape | Price (target) |
|---|---|---|---|
| **Atmosphere Core** | Builders / self-hosters | **Source-available, self-hosted.** The trust engine + execution runtime. Optimize for distribution & developer adoption, not short-term margin. | Free / source-available (BSL-style fork licenses preserve upstream copyright). |
| **Stratos Pro** | Individuals | Hosted sync / backup / observability credits + pay-as-you-go execution beyond an included budget. | **~$20 / mo** |
| **Stratos Team** | Teams | Shared context, admin controls, audit/export, cost policies, model approvals, analytics; pooled execution credits. | **~$29–$39 / user / mo** |
| **Atmosphere Enterprise** | Orgs | Self-hosted / private-cloud, SSO/SCIM, audit logs, policy engine, retention + residency controls, implementation support. | **Annual platform fee + usage** |

Pricing/packaging is **direction**; tiers and amounts are targets pending validation, not committed list prices.

**ROI framing (honesty constraint):** we may hypothesize that sovereign routing + hybrid execution reduces AI/cloud
spend, but we make **no hard dollar-savings claim** ("$X saved", "hundreds of thousands", "millions") in any
surface. Such a number is publishable **only as a hypothesis to be confirmed by a measured pilot**, with the pilot
method stated alongside it.

---

## 5. Go-to-market message

Per the Go-To-Market Doctrine, one promise per audience — *own your intelligence*:

- **Users:** *Own your intelligence.* Your context, memory, and skills are yours and stay portable; local-first by
  default; you approve when work leaves your machine.
- **Developers:** *Own your AI stack.* One Cognitive API over many models; MCP/A2A/Composio breadth; routing and
  permissions you control and can audit; self-hostable from Atmosphere Core.
- **Businesses:** *Own your organizational intelligence.* Capture company context once; govern execution with
  policy-as-code, approvals, and audit/export; route across vendors under your cost and privacy rules.

**Roadmap order — never reverse:** `Save Time → Save Money → Reduce Cloud Dependency → Sovereign Intelligence.`
Lead the market with *Save Time*; earn the right to claim *Sovereign Intelligence*.

Positioning guardrail: we launch as **the operating system for intelligence ownership** — *not* another model,
*not* a general cloud, *not* an agent framework. Use open standards and existing vendors aggressively; let the moat
accrue in the captured, governed intelligence graph.

---

## 6. Success metrics (tied to the intelligence graph)

We measure the **graph compounding**, not vanity usage. Primary metrics, each tied to an alignment axis:

| Metric | Measures | Axis |
|---|---|---|
| **Reusable assets created per active workspace** (skills, runbooks, workflows promoted from raw interactions) | Compounding | Compounding / Ownership |
| **Graph portability events** (successful export/import or cross-model reuse of captured context) | Portability is real, not theoretical | Portability |
| **% executions under explicit user-owned policy** (vs. ungoverned) | Sovereignty in practice | Sovereignty |
| **Local-first execution share** (work served locally / cheapest-acceptable vs. defaulted to frontier) | Cost + dependency reduction | Sovereignty / Execution |
| **Verified, attributed runs in the ledger** (tamper-evident, attributed to a `did:atmos`) | Trust + auditability — **counts of measured work, NOT payouts** | Ownership / Execution |
| **Approval-gate coverage** (privileged actions routed through human approval) | Human Sovereignty Doctrine honored | Sovereignty |
| **Tool-sprawl reduction** (integrations consolidated through the Capability Registry vs. ad-hoc) | Concrete SII outcome | Compounding |

Anti-metric discipline: we do not report "intelligence" as a single magic number, and we do not report a
dollar-savings figure as a result without a stated measured-pilot method behind it.

---

## 7. The moat — intelligence compounding

Not a model moat, probably not even an agent moat — an **intelligence-compounding moat.** Every interaction leaves
reusable org value: repo guidance, preferences, tool scopes, approval habits, reasoning traces, failure patterns,
runbooks, reusable skills, cost envelopes, trust relationships. Incumbents ship fragments of this, each **trapped
inside a vendor boundary.** Our wedge is **portability across models, clouds, and execution environments.** Context
capture is *the product category*, not a side feature.

This is also why the layer ordering is non-negotiable: Atmosphere becomes more valuable precisely because the clouds,
models, and tools below it stay replaceable.

---

## 8. Build vs. do-not-build — the explicit decision rule

```
BUILD when ALL hold:
  1. Passes the alignment gate (§2): increases >= 1 of ownership/compounding/portability/sovereignty/execution.
  2. Does NOT violate Human Sovereignty (no autonomy without governance) — hard veto.
  3. Does NOT reinvent an existing capability (MCP/A2A/Composio/SDK/API/DB) — Capability Doctrine veto.
  4. Earns its SII framing via a concrete, measurable outcome (§1) — no abstract category claims.
  5. Its public claim stays inside what STATE_OF_REALITY.md can measure (§9) — no aspiration sold as shipped.

DO NOT BUILD (or defer) when:
  - It is "another model," "another cloud," or "another agent framework."
  - It scores zero on all five axes -> Stop. Re-evaluate.
  - It requires a hard savings/AGI/"live" claim we cannot measure today.
  - It is economy/rewards/payout logic without product-truth + legal counsel (currently frozen).
  - It assumes universal external-protocol support (e.g. auth.md everywhere) as a dependency.
```

Currently **frozen / deferred** (per `STATE_OF_REALITY.md` build order and `docs/GROUNDED_STRATEGY.md` §6): Solana
token, on-chain settlement, DePIN reward harvesting, headless subscription scraping, frontier-output training, and
AGI / "superintelligence" framing. Measurement and attribution may proceed; **rewards/payouts are counsel-gated and
labeled "Payouts not live" everywhere.**

---

## 9. Shipped today vs. roadmap (defer to STATE_OF_REALITY.md)

This PRD is a **Vision + Architecture** document. The list below is a pointer, not a status authority — the live,
audited truth is `STATE_OF_REALITY.md`. Nothing here may be described as "live" / "done" unless that file's
✅ WORKING column says so.

**✅ Real today (per `STATE_OF_REALITY.md`):** local-first StratosAgent on the live bridge (real `qwen2.5:7b`),
agent self-awareness + honest readouts, per-chat conversation memory, real LanceDB + semantic embeddings
(relevance-gated), real hybrid post-quantum crypto (FIPS 203/204), the folder-stage pipeline engine, the
deterministic-class self-evolution loop (flag-gated), the real cross-machine P2P mesh on the operator's own fleet
(PQC-signed gossip, proof-of-capacity, job scheduler, HA failover), and the BYOK Universal Model Manager (built +
tested).

**🟡 Built, not yet live on the daemon:** the trust trifecta (capability gate · attribution ledger · identity
broker) and the consolidated sovereign model router — real code with passing hermetic tests, pending review →
merge → `pm2 reload`.

**⛔ Roadmap / spec only:** cross-vendor intelligence-graph export/import, MCP gateway + Composio Capability
Registry + first-class A2A, the Consensus Engine, multimodal (vision/voice), omni-channel adapters, a public
(beyond-operator) compute mesh, external `auth.md`/WorkOS agent registration, and the entire economic layer
(token, on-chain settlement, rewards).

> **Reminder to all coding agents:** if you are about to write that something is "live," "done," or "shipped,"
> check `STATE_OF_REALITY.md` first. If it is not ✅ there, write "target" / "roadmap" instead.
