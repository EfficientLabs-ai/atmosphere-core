> **Derived from and subordinate to [`DOCTRINE.md`](DOCTRINE.md).** Where this file conflicts with the doctrine, the doctrine wins. This is the Context Doctrine spec (Doctrine §2 + §4); evidence and honesty caveats live in [`STRATEGY-BRIEF.md`](STRATEGY-BRIEF.md).

# Context Doctrine — The Intelligence Graph

> **Document class:** Vision + Architecture. This file describes the **target** Context Doctrine and the Intelligence Graph it produces. Anything not yet built is labeled **TARGET / direction / roadmap**. For the *measured* state of what is actually running, the source of truth is [`../../STATE_OF_REALITY.md`](../../STATE_OF_REALITY.md) — never this file.

---

## 1. The one rule

```
Nothing disappears. Everything transforms.
```

Conventional AI tooling **summarizes and discards**: a chat ends, a context window rolls over, a
session closes, and the reasoning that produced an outcome evaporates. The Context Doctrine inverts
this. Every meaningful event entering the system becomes a **structured, durable record** that feeds
the next stage of a transformation pipeline. We never summarize-and-throw-away. We **transform-and-preserve**.

This is the mechanism behind the Doctrine's moat claim: the durable asset is not the model, the
cloud, or the agent — all replaceable — but the **Intelligence Graph** compounded from context,
permissions, workflows, execution history, trust, and reusable skills. Context capture is **the
product category**, not a side feature (Strategy Brief, "The moat").

---

## 2. The transformation pipeline

The lifecycle of intelligence, per Doctrine §2:

```
Conversation → Decision → Workflow → Skill → Reusable Asset → Organizational Intelligence
```

| Stage | What it is | What gets preserved |
|---|---|---|
| **Conversation** | Raw interaction (chat, email, repo event, terminal, browser, MCP call) | Intent, source, raw input, timestamp |
| **Decision** | A choice made — by a human or proposed by an agent | Reasoning, alternatives considered, confidence, who approved |
| **Workflow** | A repeatable sequence of stages that executed the decision | Ordered steps, tools used, inputs/outputs, cost |
| **Skill** | A workflow distilled into a reusable, parameterized capability | The sealed skill + its least-privilege capabilities |
| **Reusable Asset** | A skill promoted to a shared, governed artifact | Provenance, trust attribution, usage history |
| **Organizational Intelligence** | The compounding graph across all of the above | The whole graph — owned by the human/org, portable across vendors |

Each arrow is a **transformation, never a deletion**. A conversation that produces a decision does
not erase the conversation; the decision *links back* to it. A workflow that becomes a skill keeps
its execution history. This back-linking is what makes the graph queryable and auditable rather than
a pile of summaries.

### The operating-core pipeline (the implementation contract)

The transformation pipeline above is the *narrative*; the **operating core** implements it as a
deterministic, files-first pipeline (see [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)):

```
Input → Capture → Classify → Route → Store → Execute → Trace → Evaluate → Compress → Improve
```

The filesystem is the contract; the model is a swappable detail behind it. Capture, Classify, Trace,
and Evaluate run as a **deterministic core — no LLM, no network** — with any model-assisted step left
as an explicit, off-by-default hook so the durable layer never silently depends on a vendor.

---

## 3. The six graphs

Atmosphere maintains six interlocking graphs (Doctrine §4). They are views over the same durable
substrate, not six separate databases.

1. **Knowledge Graph** — facts, repo guidance, preferences, artifacts, documents, learned domain
   context. *What is true and known.*
2. **Trust Graph** — identities (`did:atmos`), trust scores, attribution, which actors/agents/peers
   are trusted for what, proof-of-capacity. *Who and what can be relied on.*
3. **Decision Graph** — choices, the reasoning behind them, alternatives, confidence, approvals,
   and — per the **Contradiction Doctrine** (§8) — preserved disagreement and competing reasoning
   paths. *Why we chose what we chose, including what we rejected.*
4. **Workflow Graph** — repeatable stage sequences ("folders over agents"), their dependencies, and
   freshness/invalidation state. *How work repeats.*
5. **Skill Graph** — reusable capabilities distilled from workflows, each with its sealed code and
   least-privilege capability set. *What the system can now do on its own.*
6. **Execution Graph** — the full trace of every run: steps, tools, models, costs, results, failures,
   and the cryptographic receipt chain that makes it tamper-evident. *What actually happened.*

The graphs cross-reference: an Execution record cites the Decision it served and the Skill it ran; a
Skill cites the Workflow it was distilled from; a Decision cites the Conversation that prompted it and
the Trust scores that gated its approval. The value is in the **edges**, not the nodes.

---

## 4. What to store — and what NOT to store

The Doctrine is explicit (§4): store **structured intelligence**, not raw data only.

**STORE (the intelligence):**

- **Intent** — what the human or agent was trying to achieve.
- **Context** — the surrounding state that made the request meaningful.
- **Reasoning** — *why* a path was chosen, not just the choice.
- **Actions** — the concrete tool calls / model calls / steps taken.
- **Results** — outputs (by hash + reference), and whether they met the goal.
- **Failures** — errors, dead-ends, and rejected approaches (failures are first-class signal).
- **Lessons** — structured candidates emitted when an evaluation criterion fails.
- **Approvals** — who authorized what, under which policy, at which risk threshold.
- **Costs** — token/compute/dollar cost per step, against a budget envelope.
- **Confidence** — the model's / system's stated certainty, preserved alongside the result.

**DO NOT store raw data *only*.** A transcript with no intent, no reasoning, no approval, and no
result is dead weight — it is exactly the "summarize and discard" failure mode wearing a different
mask (an undifferentiated dump you cannot query, govern, or compound). Raw input **is** preserved
(the unprocessed source of truth lives in each task's `data/`), but it is always paired with the
**structured record** in `memory/` that carries the intelligence. Raw without structure is not the
asset; **structured intelligence over raw inputs** is the asset.

This is the difference between "we logged everything" and "we own an Intelligence Graph."

---

## 5. OpenTelemetry as the instrumentation spine

Per the Strategy Brief (Architecture Implications §2), **OpenTelemetry is the instrumentation spine**
of the Intelligence Graph: vendor-neutral traces, metrics, and logs are the standard, portable wire
format for capturing actions, costs, and execution flow across models, tools, clouds, and devices.
Choosing a vendor-neutral standard is itself a sovereignty decision — the captured telemetry is **not
trapped inside a vendor boundary** (Strategy Brief, "What the market is validating").

**Honest status:** OpenTelemetry is the **TARGET** instrumentation standard for the Intelligence
Graph and the interoperability surface we design toward. It is **direction, not a present-tense
shipped capability** of this monorepo. What exists today is the operating core's own deterministic
trace record (§6) plus the PQC capability-receipt spine; the OTel *export/ingest* surface that makes
those traces portable as standard telemetry is roadmap. Defer measured status to `STATE_OF_REALITY.md`.

The receipt and the trace are the *internal* tamper-evident truth; OpenTelemetry is the *external,
portable* representation we map onto. Where they overlap, the **PQC-signed capability receipt is the
source of truth** (it is cryptographically verifiable; a telemetry span is not).

---

## 6. Mapping onto the StratosAgent operating core (exists vs target)

StratosAgent already implements a **files-first operating core** whose primitive is the user's living
operational map. This is the concrete substrate the Intelligence Graph is built from. The map below
is honest about what is **CURRENT** (real code, file cited) vs **TARGET** (specified, not built).

### The operational unit — CURRENT

`packages/stratos-agent/src/workspace/workspace-tree.js` creates and resolves the durable tree
`Workspace > Project > Workflow > Task > Subtask` on disk, framework-agnostic, path-traversal-safe,
idempotent (re-creating never overwrites a user's files). Each **Task** scaffolds the eight canonical
entries that *are* the per-task slice of the Intelligence Graph:

```
instructions.md   tools.json   data/   memory/   outputs/   traces/   evals/   skills/
```

- `data/` — raw input (unprocessed source of truth).
- `memory/` — the **structured context record** (the durable intelligence; §4).
- `traces/` — the Execution Graph slice for this task.
- `evals/` — the scorecards that drive the self-improvement loop.
- `skills/` — distilled reusable capabilities.

### Capture leg — CURRENT

`packages/stratos-agent/src/context/context-capture.js` — "No context lives only in chat." Every
meaningful event becomes a structured record: raw input → `data/`, structured record → `memory/`, one
line appended to a workspace-level `session.log` (the chronological index). Classification is a pure,
rule-based mapper over the canonical source taxonomy (`chat · file · email · repo · terminal ·
browser · api · mcp`), deny-by-default. An LLM summarizer is an explicit **off-by-default** hook.

### Trace leg + the capability-receipt spine — CURRENT

`packages/stratos-agent/src/trace/trace-engine.js` writes the full trace record to
`<task>/traces/{task-id}.json` (per step: who requested it, which model, what data it touched by
hash, what permission allowed it, what output by hash, whether approval was required). On
`endTrace` it mints a **PQC-signed, hash-chained capability receipt** via
`packages/stratos-agent/src/ledger/capability-receipt.js` — the **cryptographic spine** of the
Execution Graph, verifiable by a third party with only the node's public key. This is real and is the
tamper-evident primitive ([`../../TRACE_SCHEMA.md`](../../TRACE_SCHEMA.md)). The signer/verifier are injected so the core stays
deterministic and hermetically testable.

### Attribution ledger — CURRENT

`packages/stratos-agent/src/ledger/attribution-ledger.js` — append-only hash chain attributing every
verified run to this node's `did:atmos`. `summarize()` reports **measured units per contributor and
is explicitly NOT a payout** (measurement before rewards — the Vision/Architecture/Claim discipline).
Observable via `stratos ledger summary | verify | list` (`verify` fails closed on any tamper).

### Capability gate — CURRENT (partial)

`packages/stratos-agent/src/security/capability-gate.js` enforces least-privilege, deny-by-default
capabilities (carried *inside* the PQC-sealed skill manifest) before a skill runs; grants/denials feed
the receipt. A complete *per-tool-call* trace log (every field for every tool call, not just verified
skill runs) is **TARGET**.

### Evaluate leg — CURRENT

`packages/stratos-agent/src/eval/eval-engine.js` scores a finished trace against a deterministic
rubric, writing both human-readable (`<task>/evals/{task-id}.md`) and structured
(`<task>/evals/{task-id}.json`) scorecards and linking them back into the trace (bidirectional
`trace.eval_path`). The load-bearing criterion is **TRACE-INTEGRITY**: it re-runs the receipt's verify
path, so a tampered trace fails the eval, fail-closed. Each failed criterion emits a structured
candidate **lesson** — the seam into the self-improvement loop. A pluggable LLM-judge is an honest,
**off-by-default** TARGET that degrades to deterministic-only and never fabricates a score.

### Transform-to-skill (the compounding leg) — CURRENT, narrow

The self-evolution / GSI pipeline distils observed examples into PQC-sealed, capability-stamped skills
(harvest → classify → dedupe → compile → seal → verify-before-execute). Per `STATE_OF_REALITY.md`
this is **real but narrow** today (the deterministic numeric-transform class) and gated OFF by
default. The *general* "any workflow → reusable skill → organizational intelligence" transformation is
**TARGET**. Treat the broad claim as direction; defer measured scope to `STATE_OF_REALITY.md`.

### Compress / Improve legs — TARGET

The `Compress` (loss-aware compaction that preserves intelligence, not lossy summarization) and the
general `Improve` (consume lessons → propose updated instructions / new skills across all classes)
legs are **specified, not built** as general capabilities. They are the roadmap completion of the
"Everything transforms" pipeline.

---

## 7. Identity, authority, and the two `auth` surfaces

The Intelligence Graph is **owned and governed**, not merely stored. Every record carries the AUTH
context that produced it (Doctrine §3): who acted, under which permission, with what approval. Two
distinct surfaces govern this, and the Context Doctrine **keeps them separate by purpose and path,
never by capitalization alone** (Strategy Brief honesty caveat §4):

- **Internal governance manifest** — `AUTH.md` and the in-workspace authority configuration. Governs
  ownership, delegation, escalation, risk thresholds, and human-approval rules over the graph. This is
  the *who-may-act* layer; it is the source of the **Approvals** field stored in §4.
- **External protocol-facing `auth.md`** — a discoverable, agent-registration protocol (the WorkOS
  `auth.md` convention, launched 2026-05-21). It is **very new**; we **adopt it where available and do
  not depend on it exclusively** — never assume universal support across agents or platforms.

The Trust Graph (§3) is where these surfaces deposit their durable output: short-lived, audience-bound,
scoped assertions minted by the identity broker (which returns **only the token, never the raw
credential**), and the `did:atmos` identities the attribution ledger credits. Per the **Human
Sovereignty Doctrine** (§1, overrides all): humans own intent, permissions, and the graph itself;
agents execute, Atmosphere coordinates, and full autonomous control is never built without explicit
governance.

---

## 8. The alignment gate for context work

Before building anything that touches context capture, apply the Doctrine's final alignment gate.
A context feature is aligned only if it **increases at least one of**:

> Context · Knowledge · Trust · Skills · Workflows · Decision Graphs · Intelligence Ownership ·
> Intelligence Compounding

Concretely, for this doctrine:

- Does it **preserve** something that would otherwise be summarized-and-discarded? (the one rule)
- Does it store **structured intelligence**, not raw data only? (§4)
- Does it keep the graph **owned and portable** across vendors, clouds, and execution environments?
  (the moat; the Intelligence Ownership Doctrine §12)
- Does it carry **identity, permission, and approval** with every record? (AUTH; §7)

If the answer is **no** to all of these: **Stop. Re-evaluate.** The feature is likely not aligned —
it is probably a logging convenience, not Intelligence Infrastructure.

---

## 9. The positioning caveat (binding)

The category this doctrine serves — **Sovereign Intelligence Infrastructure (SII)** — is a **new
positioning construct that Efficient Labs is defining**. It is **not** an established or
industry-standard analyst category. Anywhere this document or its descendants invoke SII, it must be
tied to **concrete outcomes** the Intelligence Graph produces — less tool sprawl, governed and
auditable execution, portable context across vendors, tighter AI/cloud cost control, stronger privacy
— never presented as a settled term of art (Strategy Brief honesty caveat §1).

And the discipline that bounds every claim in this file (Strategy Brief §5): **no hard dollar-savings
claims.** The compounding Intelligence Graph is *hypothesized* to reduce wasted re-work and AI/cloud
spend; any "$X saved" figure is a **hypothesis requiring a measured pilot**, not a present-tense
result — and it lives nowhere near launch marketing until a pilot backs it.
