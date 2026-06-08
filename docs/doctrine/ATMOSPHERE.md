# Atmosphere — The Ownership, Governance & Routing Control Plane (Layer 3)

> **Status:** Derived from and **subordinate to** [`DOCTRINE.md`](DOCTRINE.md). Where this document
> conflicts with the doctrine, the doctrine wins. Bounded by the honesty caveats in
> [`STRATEGY-BRIEF.md`](STRATEGY-BRIEF.md) ("Open questions & limitations"). This is a **Vision +
> Architecture** document: it describes the target system and its design, not a present-tense inventory
> of shipped capability. For what is actually built and measured, see the repos' `STATE_OF_REALITY.md` —
> that file, not this one, is the source of truth for "done."

---

## 1. What Atmosphere is (and is not)

Atmosphere is **Layer 3** of the company architecture: the **Ownership Layer**, sitting above Internet
(L0), Cloud Infrastructure (L1), and Models (L2), and below StratosAgent (L4) and end-user experiences
(L5). It is the **control plane** through which owned intelligence is governed, routed, and executed.

Per the doctrine, Atmosphere determines: *where intelligence lives, who owns it, who accesses it, how it
compounds, how it moves, how it executes, and how it is preserved.*

Atmosphere is **not** another cloud provider, **not** another model provider, and **not** another agent
framework. It **orchestrates existing infrastructure** (Capability Doctrine #9): MCP for agent↔tool, A2A
for agent↔agent, Composio as a Capability Registry, OpenTelemetry as the instrumentation spine, and
boring proven authz standards (OAuth/OIDC, NIST zero-trust, Zanzibar/OPA). It becomes more valuable
precisely because the layers below it stay replaceable.

**Positioning honesty (Caveat 1):** Atmosphere realizes a category we are *defining* —
**Sovereign Intelligence Infrastructure (SII)**. SII is a **new positioning construct of ours**, not a
settled or industry-standard analyst category. It earns its meaning only by tying to concrete outcomes:
less tool sprawl, governed and auditable execution, portable context, tighter AI/cloud cost control,
stronger privacy. Nowhere in this document, or in marketing derived from it, may SII be presented as an
established term.

---

## 2. The four mandatory layers

These are the four planes Atmosphere must implement (Strategy Brief, "Architecture implications"). They
are presented here as the **target architecture**. Each layer's build status is tracked in
`STATE_OF_REALITY.md`, not asserted as live here.

### 2.1 Identity & Authority

The internal workspace authority manifest. Governs ownership, delegation, escalation, risk thresholds,
and human-approval rules along the chain:

```
Human → Workspace Owner → Organization → Policies → Agents → Tools
```

This plane answers the AUTH Doctrine's question: **who may act, who may delegate, who may execute, who
may approve.** It is built on proven standards — OAuth, OIDC, NIST zero-trust, Zanzibar-style
fine-grained authz, OPA / policy-as-code — not on novel cryptography invented here.

**Two distinct AUTH surfaces — separated by PURPOSE and PATH, never by capitalization (Caveat 4):**

| Surface | Purpose | Direction | Location intent |
|---|---|---|---|
| **Internal governance manifest** (`AUTH.md` doctrine, `/AUTH.md`) | Who may act/delegate/execute/approve; risk thresholds; human-approval rules | Inward — governs this workspace's agents | A clearly internal, governance path in the workspace |
| **External `auth.md` protocol file** | Discoverable agent registration / identity advertisement to other systems | Outward — protocol-facing | A separate, protocol-discoverable location |

The external `auth.md` protocol (WorkOS, **launched 2026-05-21, very new**) is **adopted where available,
not depended on exclusively** (Caveat 2). Atmosphere must function fully when no peer or platform speaks
`auth.md`; external registration is an enhancement, never a prerequisite. Never assume universal support.

### 2.2 Context & Intelligence Graph

**The real product.** Per the Intelligence Graph Doctrine and Context Doctrine ("Nothing disappears.
Everything transforms."), this plane captures and structures: prompts, plans, tool calls, outcomes,
failures, approvals, policies, repo facts, preferences, artifacts, costs, confidence, and cross-agent
execution traces — as **structured intelligence**, not raw data alone.

```
Conversation → Decision → Workflow → Skill → Reusable Asset → Organizational Intelligence
```

OpenTelemetry (traces/metrics/logs) is the instrumentation spine. The design target is to generalize the
vendor-trapped notions of "memory" and "company knowledge" into one **interoperable graph** that is
**portable across models, clouds, and execution environments** — the part incumbents gesture toward but
none own across vendor boundaries. This portability is the intended moat (intelligence compounding), and
is **direction/target**, not a claim of present completeness.

### 2.3 Execution (StratosAgent boundary)

The runtime (Layer 4, specified in `STRATOS.md`) **reads the graph, negotiates with the authority layer,
and chooses tools/models/agents by user-owned policy.** StratosAgent **consumes** Context, Knowledge,
Trust, Permissions, and Workflows from Atmosphere and **never owns intelligence — it executes it.**

Defaults: **MCP** as the agent↔tool standard, **A2A** as the agent↔agent standard, **Composio** for
integration breadth. Every A2A interaction must carry Identity, Trust Score, Permissions, Audit Trail,
Memory Context, and Execution Trace (A2A Doctrine #5).

### 2.4 Compute & Routing

User/org routing policy, applied to every cognitive call. Policies are expressed as profiles (see §4) and
are **auditable, explainable, and user-owned** — the structural advantage over a black-box vendor router.

---

## 3. The Atmosphere Cognitive API (Model Abstraction Layer)

Per the Model Abstraction Doctrine (#6), applications call **capabilities, never vendors directly.** The
verb set is fixed by the doctrine:

```
reason()  research()  code()  analyze()  execute()  summarize()  plan()
```

Applications remain **model-agnostic**. Atmosphere — not the application — selects the concrete model
(OpenAI, Anthropic, Google, DeepSeek, Qwen, Llama, future models) for each call, under the active routing
policy and authority constraints.

**Design intent of each verb (target contract):**

| Verb | Intent |
|---|---|
| `reason()` | General inference / decision support over supplied context |
| `research()` | Gather, fetch, and synthesize external information |
| `code()` | Generate, edit, or review code |
| `analyze()` | Structured analysis over data, artifacts, or traces |
| `execute()` | Run a plan/action through the Execution layer under policy + approval |
| `summarize()` | Transform-and-preserve, never summarize-and-discard (Context Doctrine) |
| `plan()` | Produce an ordered, inspectable plan for human or agent review |

**Invariant:** every cognitive call is wrapped with identity, policy check, OpenTelemetry trace, recorded
intent/result/confidence/cost, and a routing decision that is **logged and explainable**. The API is the
single chokepoint where ownership, governance, and routing are enforced together. The verb surface is the
**target contract**; per-verb implementation status lives in `STATE_OF_REALITY.md`.

**Why model-agnostic is defensible, not just clean:** capability is diffusing and price/performance is
improving fast (the Strategy Brief records large reported inference-cost declines and a narrowing
open-vs-closed benchmark gap, *as provided, not independently re-verified*). When the model is a weaker
moat, the **system around the model** — evaluation, routing, permissioning, auditability, persistence of
organizational knowledge — is where durable value concentrates.

---

## 4. Economic routing profiles

Per the Economic Routing Doctrine (#7), the governing rule is absolute:

> **Atmosphere recommends. The user decides. Atmosphere never silently swaps models.**

A recommendation is a *suggestion plus rationale*, surfaced for human approval — never an action taken
behind the user's back. Profiles (doctrine §7, refined with Strategy-Brief routing dimensions):

| Profile | Routing intent |
|---|---|
| **Maximum Quality** | Highest-accuracy / highest-capability model regardless of cost |
| **Balanced** | Default trade-off across quality, latency, and cost |
| **Lowest Cost** | Cheapest model that meets an acceptability bar |
| **Private Only** | Local / private-cloud execution; no third-party vendor egress |
| **Open Weight Only** | Restrict to open-weight models |
| **Frontier Only** | Restrict to frontier-class models |
| **Custom** | User/org-authored policy (e.g. *manual approval above a cost threshold*, *fastest*, *highest-trust*, *approved-vendor-only*) |

Each routing decision is auditable: the profile in force, the candidates considered, the model chosen,
and the rationale are recorded in the Intelligence Graph. This is what makes routing **explainable and
user-owned** rather than opaque.

**Cost honesty (Caveat 3):** Atmosphere's premise is that auditable, policy-driven routing and hybrid
execution can reduce AI/cloud waste. Any specific savings figure — in dollars, percentages, or
magnitudes like "hundreds of thousands" — is a **hypothesis that requires a measured pilot** before it
may be stated. This document makes **no hard dollar-savings claim**, and no derived marketing may either
until a measured pilot backs it.

---

## 5. The Contradiction / Consensus engine

Per the Contradiction Doctrine (#8): **models may disagree, and Atmosphere never hides disagreement.**
When more than one model, agent, or reasoning path addresses the same question, Atmosphere preserves the
alternatives instead of collapsing them into a single false-confident answer.

The Consensus Engine emits four signals on every multi-source decision:

| Signal | Meaning |
|---|---|
| **Agreement** | Where the sources converge |
| **Conflict** | Where they diverge, with the competing positions preserved |
| **Confidence** | Calibrated certainty, not a single hidden score |
| **Evidence** | The traces, sources, and reasoning paths behind each position |

These signals are first-class entries in the Intelligence Graph: conflict and uncertainty are **stored,
not discarded**, so the organization can learn from disagreement over time. Human authority (Doctrine #1)
remains the resolver of record — the engine surfaces the disagreement; the human decides.

---

## 6. Orchestrating existing infrastructure

Atmosphere builds **none** of the following from scratch; it composes them (Capability Doctrine #9,
Composio Doctrine #10):

- **MCP** — default **agent↔tool** standard. Atmosphere governs *which* tools an agent may reach, under
  which identity and policy; MCP carries the connection.
- **A2A** — default **agent↔agent** standard. Atmosphere requires every A2A hop to carry identity, trust,
  permissions, audit trail, memory context, and execution trace.
- **Composio** — treated as a **Capability Registry**: thousands of integrations exposed as native
  Atmosphere capabilities, not thousands of hand-built connectors.
- **OpenTelemetry** — the vendor-neutral instrumentation spine feeding the Intelligence Graph.
- **OAuth / OIDC / NIST zero-trust / Zanzibar / OPA** — the Identity & Authority substrate.
- **External `auth.md` (WorkOS)** — adopted where available, never a hard dependency (Caveat 2).

The wedge is **portability across models, clouds, and execution environments** — each incumbent ships
fragments of this, but each fragment is trapped inside a vendor boundary.

---

## 7. Distributed compute — phased, P2P as a LATER governed substrate

Per the Distributed Compute Doctrine (#14) and the Strategy Brief's explicit sequencing:

- **Phase 1 (launch trust anchor):** Cloud · Local · Hybrid. This is where the routing, governance, and
  auditability are proven first.
- **Phase 2:** Peer-to-Peer execution (Pear / Holepunch / Hyperswarm / local hardware / community
  compute) joins **as a governed routing option** under the same policy and authority planes — **not** as
  the initial trust anchor.
- **Phase 3:** Global Sovereign Compute Network.

The objective is to **reduce dependency, increase sovereignty, and increase resilience** — *not*
decentralization for its own sake. P2P does not bypass the Identity & Authority or Compute & Routing
planes; it is admitted *through* them. All phase status beyond Phase 1 is **roadmap/direction**, tracked
in `STATE_OF_REALITY.md`.

---

## 8. Alignment gate (the build filter)

Before any Atmosphere feature is built, it must increase at least one of:

> Context · Knowledge · Trust · Skills · Workflows · Decision Graphs · Intelligence Ownership ·
> Intelligence Compounding

and improve at least one of the five Product Doctrine outcomes: **Ownership, Compounding, Portability,
Sovereignty, Execution.** If it does neither — **stop and re-evaluate.** Roadmap order is never reversed:
**Save Time → Save Money → Reduce Cloud Dependency → Sovereign Intelligence.**

Human Sovereignty (Doctrine #1) overrides all of the above: humans own goals, permissions, and
intelligence and retain final authority. **Atmosphere coordinates; agents execute; the human decides.**

---

## 9. Doctrine cross-reference

| This document (§) | Governing doctrine |
|---|---|
| §1 What Atmosphere is/is not | Atmosphere Definition; Capability #9 |
| §2.1 Identity & Authority | AUTH Doctrine #3 |
| §2.2 Context & Intelligence Graph | Context #2; Intelligence Graph #4; Intelligence Ownership #12; Data Sharecropping #13 |
| §2.3 Execution boundary | StratosAgent Definition; A2A #5 |
| §2.4 / §4 Compute & Routing | Economic Routing #7 |
| §3 Cognitive API | Model Abstraction #6 |
| §5 Consensus engine | Contradiction #8 |
| §6 Orchestration | Capability #9; Composio #10 |
| §7 Distributed compute | Distributed Compute #14 |
| §8 Alignment gate | Human Sovereignty #1; Product #15; Go-To-Market #16 |

> **Final reminder:** This is Vision + Architecture. Where a capability here is described in the present
> tense, read it as the **designed contract**, not a claim of shipped state. Only `STATE_OF_REALITY.md`
> may declare a capability "done."
