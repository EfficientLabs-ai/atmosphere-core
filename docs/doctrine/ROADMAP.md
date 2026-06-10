# Efficient Labs — Roadmap

> **Status:** Derived from and **subordinate to** [`DOCTRINE.md`](DOCTRINE.md); bounded by the honesty
> caveats in [`STRATEGY-BRIEF.md`](STRATEGY-BRIEF.md). Where this file conflicts with the doctrine, the
> doctrine wins. This is a **Vision + Architecture** document: it states direction and targets. The only
> authority on *what is actually shipped and verified* is the repos' `STATE_OF_REALITY.md` — never read a
> target here as a present-tense shipped capability.

---

## What this roadmap is (and is not)

This is a **phased** plan, not a dated one. It orders *what gets built and sold in what sequence* so the
sequence itself reinforces the mission. It carries **no hard dates** and **no dollar-savings claims** —
any economic benefit is a **hypothesis that requires a measured pilot** before it appears in marketing
(STRATEGY-BRIEF §"Open questions" #3).

Two axes run through every phase and they must stay locked:

1. **The Go-To-Market order** (Doctrine §16) — never reverse:
   **Save Time → Save Money → Reduce Cloud Dependency → Sovereign Intelligence.**
2. **The Distributed Compute progression** (Doctrine §14) — never skip:
   **Phase 1 (Cloud · Local · Hybrid) → Phase 2 (P2P: Holepunch / Hyperswarm) → Phase 3 (Global Sovereign
   Compute Network).**

These two axes are not the same clock. The **GTM order is how we earn trust and revenue**; the
**compute progression is how the substrate matures underneath it.** A customer can be deep in "Save Time"
while the compute layer is still Phase 1. We climb the compute ladder only as far as a real customer
outcome justifies — "reduce dependency, increase sovereignty, increase resilience, **not** decentralization
for its own sake" (Doctrine §14).

Everything below ties back to the **five intelligence dimensions** every feature must advance (Doctrine
§15, the one-paragraph handle): **Ownership · Compounding · Portability · Sovereignty · Execution.** A line
item that advances none of them does not belong on this roadmap.

---

## On "Sovereign Intelligence Infrastructure" (SII)

SII is **a positioning construct we are defining**, not a settled analyst category or industry-standard
term (STRATEGY-BRIEF §"Open questions" #1). This roadmap therefore never sells "SII" as a recognized thing
to buy. It sells **concrete outcomes** that, taken together, *are* SII: less tool sprawl, governed
execution, portable context, tighter AI/cloud cost control, stronger privacy, and a compounding,
user-owned intelligence graph. Each phase below is anchored to one of those outcomes. The category earns
its name from the outcomes, not the other way around.

---

## The GTM ladder — the order in which value is *sold*

The doctrine fixes the order. Here is what each rung means in product terms and which intelligence
dimensions it primarily advances. **A later rung never ships before its predecessor has a real,
demonstrable wedge** — that is what "never reverse" means.

### Rung 1 — Save Time *(the wedge)*
**Outcome sold:** stop re-deriving the same context, decisions, and workflows. The agent remembers, the
graph persists, intelligence is captured instead of summarized-and-discarded (Context Doctrine §2:
*nothing disappears, everything transforms*).
**Primary dimensions:** Compounding, Execution.
**Why first:** time saved is *immediately felt and self-evidently true* — no pilot required to believe it.
It is the cheapest honest claim we own. Developer-led entry (STRATEGY-BRIEF §pricing) lives here.

### Rung 2 — Save Money
**Outcome sold:** sovereign, auditable, user-owned **routing** (Economic Routing Doctrine §7) — local by
default, frontier only on opt-in, cost/quality/privacy profiles the *human approves*. Cut spend on
needless frontier calls and reduce tool sprawl.
**Primary dimensions:** Sovereignty, Ownership.
**Honesty gate:** no specific savings number ships until a **measured pilot** produces it. "Lower cost" is
framed as *the mechanism* (local-default routing, no silent vendor swaps), not a guaranteed dollar figure.

### Rung 3 — Reduce Cloud Dependency
**Outcome sold:** the same work runs across cloud, local, and (later) peer compute under one
**user-owned policy**, so no single vendor or cloud is load-bearing. Portability becomes the buyer's
insurance policy (regulatory tailwind toward portability per STRATEGY-BRIEF; we do **not** claim law
recognizes "intelligence ownership" as a legal category).
**Primary dimensions:** Portability, Sovereignty.

### Rung 4 — Sovereign Intelligence
**Outcome sold:** the customer *owns, governs, and compounds* their intelligence graph across every model,
cloud, and execution environment — the Data Sharecropping Doctrine (§13) inverted: users create value,
**users own value**, Atmosphere organizes it.
**Primary dimensions:** Ownership, Compounding, Sovereignty.
**Why last:** this is the full thesis. It is only *credible* once Rungs 1–3 are real, because it is their
sum, not a separate product.

---

## The three layers we map milestones onto

From Doctrine §"Company Architecture", milestones below attach to:

- **Atmosphere** (Layer 3, the **ownership layer**) — `atmosphere-core`. Where intelligence lives, who
  owns it, how it compounds, how it routes. The intelligence graph + AUTH governance + economic routing.
- **StratosAgent** (Layer 4, the **execution layer**) — reasons, plans, executes, observes, learns;
  *consumes* context/permissions/workflows from Atmosphere and **never owns** intelligence.
- **TheAtmosphere** (Layer 5 surfaces + distribution) — the user/developer/business experiences and the
  public surface, including the honest status page that points at `STATE_OF_REALITY.md`.

A note on two files that look alike but are not (STRATEGY-BRIEF §"Open questions" #2 & #4):
- The **external `auth.md` protocol** — protocol-facing, discoverable, for **agent registration** (WorkOS,
  launched 2026-05-21, *very new*). We **adopt it where available and never depend on it exclusively**;
  universal support is not assumed.
- The **internal `AUTH.md` governance manifest** — a *separate path and purpose*: ownership, delegation,
  escalation, risk thresholds, human-approval rules (Doctrine §3). These are distinguished **by purpose
  and path, never by capitalization alone.**

---

## Distributed Compute — Phase 1 → 2 → 3

This is the substrate progression (Doctrine §14). It advances **only as far as a real outcome requires**.

### Phase 1 — Cloud · Local · Hybrid *(the launch substrate)*
The initial trust anchor. Launch cloud/edge/local first; routing is **auditable, explainable,
user-owned** (STRATEGY-BRIEF §architecture-4). LOCAL is the default; cloud is opt-in BYOK behind a
cost-approval gate; hybrid splits work by policy. This is the substrate under GTM Rungs 1–2 and the start
of Rung 3.
**Intelligence dimensions:** Sovereignty (local-default), Portability (multi-vendor), Execution.

### Phase 2 — Peer-to-Peer execution *(Holepunch / Hyperswarm)*
P2P is a **later execution substrate, joined as a *governed* option — not the initial trust anchor**
(STRATEGY-BRIEF §architecture, "Two more"). Public DHT + hole-punch (no open ports), PQC-signed skill
gossip, proof-of-capacity so a node cannot inflate claimed compute, parallel job scheduling, and
multi-machine failover. P2P deepens Rung 3 (Reduce Cloud Dependency) by making non-cloud compute a
first-class, *trusted* routing target rather than a stand-in.
**Intelligence dimensions:** Sovereignty, Portability, Execution (resilience).

### Phase 3 — Global Sovereign Compute Network *(the direction)*
A large, public, **trust-gated** fleet — strangers' capacity admitted only behind a public-mesh
proof-of-capacity challenge, attribution recorded per contributor. This is **the Phase-3 target**, the
full expression of GTM Rung 4. It is explicitly **roadmap, not present-tense**: the objective is
*reduce dependency, increase sovereignty, increase resilience* — never decentralization as an end in
itself.
**Intelligence dimensions:** all five, culminating in Ownership + Compounding at network scale.

---

## Near-term milestones — honestly shippable *now* vs *later*

The split below is the planning view. **The binding, measured status lives in
[`../../STATE_OF_REALITY.md`](../../STATE_OF_REALITY.md)** and the live status surface; this section must be
read against it. Nothing here is asserted as "live" or "done" except where it cross-references that
document's verified rows, and even then defer to the doc on conflict.

### Honestly shippable now (verified foundation to build the GTM wedge on)
These are the Phase-1 / GTM-Rung-1 building blocks that `STATE_OF_REALITY.md` records as verified real,
and which we are *therefore permitted to lead with*:

- **Local-first execution** — a running StratosAgent answering from a real local model (Ollama
  `gemma2:2b`), with sovereign **local-default routing** and opt-in BYOK cloud behind a cost-approval
  gate. *(Substrate for Rung 1 "Save Time" + Rung 2 routing.)*
- **Conversation memory / context persistence** — durable per-chat memory and honest context-window
  management. The first concrete proof of the Context Doctrine: *nothing disappears.* *(Compounding.)*
- **Real cross-machine P2P mesh** — public DHT + hole-punch, PQC-signed gossip, proof-of-capacity, a
  working parallel job scheduler, and multi-machine HA failover, verified across the operator's **own**
  hardware. This is the **seed** of Phase 2 — proven on a private fleet, **not** a public network.
- **Real PQC + real vector store + real embeddings** — the cryptographic and graph plumbing the ownership
  layer requires, recorded as verified-real (not mock) in the status doc.

> Honest scope (must travel with every claim above): the mesh is the **operator's own machines**, not a
> global network; "cloud" defaults to local fallback without a user BYOK key; the self-evolution loop
> serves only a narrow deterministic class. Lead with what's real; carry the caveat with it.

### Built but pending / behind gates (real code, not yet live on the running daemon)
Per `STATE_OF_REALITY.md`, these exist as reviewed, tested code on a stacked branch but are **not live**
on the running bridge until an operator merge + reload. Treat as **target, not shipped**:

- **Trust trifecta** — capability gate (least-privilege caps inside the PQC-sealed manifest, deny-by-
  default), attribution ledger (tamper-evident hash chain; **measurement, explicitly NOT a payout**), and
  identity broker (short-lived, audience-bound, scoped assertions; returns only the token). *Direction:
  the AUTH + A2A doctrines made executable.*
- **One consolidated sovereign model router** — local-default, `/private` pins local, cloud opt-in only.
  *Direction: Economic Routing Doctrine §7 in the live path.*
- **File-backed mesh signal** — routes heavy work to the mesh only if a real `fleet.json` exists;
  deny-by-default, never invents peers (returns false today, honestly). *Direction: Phase-1→2 seam.*
- **Observability + ICM surfaces** (`stratos id · ledger · route`, folder-stage pipeline). *Direction:
  the auditable, user-owned control plane.*

### Later (direction / target — not yet built)
Labeled aspiration per the Vision/Architecture/Claim discipline (STRATEGY-BRIEF #5). These are **roadmap**:

- **MemGPT Tier-1 async recall**, mesh-dispatched pipeline stages, and the **public-mesh proof-of-capacity
  gate** that admits strangers' compute — the bridge from Phase 2 (private fleet) toward Phase 3.
- **Model Abstraction Layer** as the full Atmosphere Cognitive API (`reason()/research()/code()/…`,
  Doctrine §6) — applications model-agnostic, Atmosphere chooses the model.
- **Composio-backed Capability Registry** (Doctrine §9–10) — thousands of integrations as native
  capabilities, not hand-built connectors.
- **Agent Browser** (Vision · Audio · Speech · Execution, Doctrine §11) — necessary while the web stays
  human-first.
- **Consensus Engine** (Contradiction Doctrine §8) — surface Agreement / Conflict / Confidence / Evidence;
  never hide model disagreement.

### Explicitly frozen / deferred (counsel- and product-truth-gated)
Per `STATE_OF_REALITY.md` build order #7, these are **not** on the near-term roadmap and must never be
implied as imminent: the **economic layer** (Solana token, on-chain settlement, DePIN reward harvesting),
**multimodal** voice/vision, **omni-channel** adapters, the ACP/DID/SD-JWT/Z3 **specs**, headless
subscription scraping, frontier-output training, and any **AGI / "superintelligence"** framing.
Attribution is *measurement before rewards*: the ledger counts contribution; **payouts are not live** and
are labeled as future eligibility everywhere.

---

## How a phase advances (the gate)

Before any milestone moves from "later" to "now," it passes the **alignment gate** (Doctrine §"Final
Instruction"): does it increase Context · Knowledge · Trust · Skills · Workflows · Decision Graphs ·
Ownership · Compounding? If **no — stop and re-evaluate.** And it passes the **honesty gate**: is the
claim something `STATE_OF_REALITY.md` can back with a test that fails if the feature breaks? If not, it
ships as **direction**, not as a present-tense capability.

We climb the GTM ladder in order, mature the compute substrate Phase 1 → 2 → 3 only as real outcomes
justify, tie every step to one of the five intelligence dimensions, and let the moat accrue where the
strategy says it does — in the **portable, user-owned intelligence graph** that incumbents gesture toward
but none fully own across models, clouds, and execution environments.

> Google indexed information. Facebook indexed people. LinkedIn indexed professional relationships.
> **Atmosphere indexes intelligence** — and this roadmap is the order in which we earn the right to say so.
