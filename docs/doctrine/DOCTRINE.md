# Efficient Labs — Founding Operating Doctrine

> **Status:** Root artifact. This is the constitution. `VISION.md`, `PRD.md`, `AUTH.md`,
> `CONTEXT.md`, `ATMOSPHERE.md`, `STRATOS.md`, and `ROADMAP.md` are **derived from and subordinate to**
> this file. Where any derived doc, README, or line of code conflicts with this doctrine, this doctrine
> wins — or the doctrine is amended deliberately, never contradicted silently.
>
> **Scope of enforcement:** `atmosphere-core`, `TheAtmosphere`, `StratosAgent`, and the VPS architecture.
>
> **Companion:** [`STRATEGY-BRIEF.md`](STRATEGY-BRIEF.md) — the market/historical evidence and the
> honesty caveats that bound how this doctrine may be claimed in public.

---

## Mission

Efficient Labs does **not** build AI agents.
Efficient Labs does **not** build frontier models.
Efficient Labs does **not** build cloud infrastructure.

Efficient Labs builds **Sovereign Intelligence Infrastructure (SII)**:

> A system where individuals, developers, businesses, and eventually agents **own, govern, compound, and
> execute** intelligence.

---

## Core Thesis

The cloud revolutionized **where computation runs**.

Atmosphere revolutionizes **where computation runs** *and* **where intelligence lives**.

The future asset is not **data**, **models**, or **agents**. The future asset is:

- Context
- Knowledge
- Trust
- Workflows
- Execution History
- Skills
- Decision Graphs
- Relationships
- Permissions

Collectively: **Intelligence**.

---

## Company Architecture

| Layer | Name |
|---|---|
| Layer 0 | Internet |
| Layer 1 | Cloud Infrastructure |
| Layer 2 | Models |
| Layer 3 | **Atmosphere** — Sovereign Intelligence Infrastructure (the ownership layer) |
| Layer 4 | **StratosAgent** — the execution layer |
| Layer 5 | User / Developer / Business experiences |

Atmosphere sits **above** clouds, models, and tools and becomes more valuable precisely because those
layers below it remain replaceable.

---

## Atmosphere Definition

Atmosphere is **the Ownership Layer**. It determines:

- Where intelligence lives
- Who owns intelligence
- Who accesses intelligence
- How intelligence compounds
- How intelligence moves
- How intelligence executes
- How intelligence is preserved

Atmosphere is **NOT** another cloud provider, another model provider, or another agent framework.
**Atmosphere orchestrates existing infrastructure.**

---

## StratosAgent Definition

StratosAgent is **the Execution Layer**. It exists to **reason, plan, execute, observe, and learn.**

StratosAgent **consumes** Context, Knowledge, Trust, Permissions, and Workflows **from Atmosphere**.

StratosAgent **never owns intelligence. It executes intelligence.**

---

## The Doctrines

### 1. Human Sovereignty Doctrine — *overrides all others*

- Humans own goals.
- Humans own permissions.
- Humans own intelligence.
- Humans retain final authority.
- Agents execute. Atmosphere coordinates.

**Never build full autonomous control without explicit governance.**

### 2. Context Doctrine — `/CONTEXT.md`

**Rule: Nothing disappears. Everything transforms.**

```
Conversation → Decision → Workflow → Skill → Reusable Asset → Organizational Intelligence
```

Never summarize and discard. Always transform and preserve.

### 3. AUTH Doctrine — `/AUTH.md`

Governs Identity, Authority, Ownership, Permissions, Trust, Delegation, Escalation, Human Approval
Rules, and Agent Boundaries.

```
Human → Workspace Owner → Organization → Policies → Agents → Tools
```

`AUTH.md` governs **who may act, who may delegate, who may execute, who may approve.**

> **Design note (see STRATEGY-BRIEF):** the *internal* authority manifest (`AUTH.md`, governance) is
> distinct from any *external*, protocol-facing `auth.md` (agent registration, discoverable). Separate
> them by **purpose and path**, never by capitalization alone.

### 4. Intelligence Graph Doctrine

Atmosphere maintains the Knowledge, Trust, Decision, Workflow, Skill, and Execution graphs.

Store **Intent, Context, Reasoning, Actions, Results, Failures, Lessons, Approvals, Costs, Confidence** —
not raw data only. Store **structured intelligence.**

### 5. Agent-to-Agent (A2A) Doctrine

Every agent interaction must carry **Identity, Trust Score, Permissions, Audit Trail, Memory Context,
Execution Trace.** Agent communication is **first-class infrastructure.**

### 6. Model Abstraction Layer — the Atmosphere Cognitive API

Applications call `reason()`, `research()`, `code()`, `analyze()`, `execute()`, `summarize()`, `plan()` —
**never vendors directly.** Atmosphere chooses the model (OpenAI, Anthropic, Google, DeepSeek, Qwen,
Llama, future models). Applications remain **model-agnostic.**

### 7. Economic Routing Doctrine

**Atmosphere recommends. Users decide. Never silently swap models.**

Routing profiles: Maximum Quality · Balanced · Lowest Cost · Private Only · Open Weight Only ·
Frontier Only · Custom. Atmosphere may recommend; **humans approve.**

### 8. Contradiction Doctrine

Models may disagree. **Never hide disagreement.** Preserve alternative viewpoints, uncertainty, and
competing reasoning paths. A **Consensus Engine** outputs Agreement, Conflict, Confidence, Evidence.

### 9. Capability Doctrine

Do not build tools that already exist. Use MCP, Composio, existing SDKs/APIs/databases/infrastructure.
**Efficient Labs orchestrates; it does not reinvent.**

### 10. Composio Doctrine

Treat thousands of integrations as **native Atmosphere capabilities.** Build a **Capability Registry**,
not thousands of custom integrations.

### 11. Agent Browser Doctrine

StratosAgent must eventually **See, Hear, Speak, Reason, Execute** (Vision · Audio · Speech · Execution
layers). **Browser automation remains mandatory — the world is still human-first.**

### 12. Intelligence Ownership Doctrine

Users own Context, Knowledge, Skills, Workflows, History, Decision Graphs. Models **temporarily access**
intelligence; models **never own** it. Atmosphere protects ownership.

### 13. Data Sharecropping Doctrine

Today: users create value, platforms capture it. Atmosphere: **users create value, users own value,
Atmosphere organizes value.** Foundational belief.

### 14. Distributed Compute Doctrine

- **Phase 1:** Cloud · Local · Hybrid
- **Phase 2:** Peer-to-Peer execution (Holepunch / Hyperswarm / local hardware / community compute)
- **Phase 3:** Global Sovereign Compute Network

Objective: **reduce dependency, increase sovereignty, increase resilience** — not decentralization for
its own sake.

### 15. Product Doctrine

Every feature must improve at least one of: **Intelligence Ownership, Compounding, Sovereignty,
Portability, Execution.** If it does not — **do not build it.**

### 16. Go-To-Market Doctrine

- Users: *Own your intelligence.*
- Developers: *Own your AI stack.*
- Businesses: *Own your organizational intelligence.*

Roadmap order (never reverse): **Save Time → Save Money → Reduce Cloud Dependency → Sovereign
Intelligence.**

---

## Final North Star

> Google indexed information. Facebook indexed people. LinkedIn indexed professional relationships.
> **Atmosphere indexes intelligence.**
>
> AWS changed *where computation runs*. **Atmosphere changes where computation runs *and* where
> intelligence lives.**

---

## Final Instruction To All Coding Agents (the alignment gate)

Before building **any** feature, ask: *does this increase* —

Context? · Knowledge? · Trust? · Skills? · Workflows? · Decision Graphs? · Intelligence Ownership? ·
Intelligence Compounding?

If the answer is **no**: **Stop. Re-evaluate.** The feature is likely not aligned with the mission.

---

## One-paragraph doctrine (the handle)

> Efficient Labs builds **Sovereign Intelligence Infrastructure**. **Atmosphere** is the ownership,
> governance, and routing layer. **StratosAgent** is the execution layer. Models, clouds, and most tools
> are interchangeable; the durable asset is the **intelligence graph** created from context, permissions,
> workflows, execution history, trust, and reusable skills. Every feature must improve at least one of
> five things: intelligence **ownership, compounding, portability, sovereignty, or execution.**
