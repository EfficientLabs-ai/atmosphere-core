# Efficient Labs — AUTH Doctrine (Internal Authority & Governance Manifest)

> **Status:** Derived from and **subordinate to** [`DOCTRINE.md`](DOCTRINE.md). Where this file conflicts
> with the constitution, the constitution wins. This is the internal authority manifest referenced by
> **AUTH Doctrine #3**; it governs *who may act, who may delegate, who may execute, who may approve* inside
> an Atmosphere workspace. The market evidence and the **honesty caveats** that bound how any of this may be
> claimed publicly live in [`STRATEGY-BRIEF.md`](STRATEGY-BRIEF.md).

---

## 0. Scope and the one rule above all rules

This manifest covers **Identity, Authority, Ownership, Permissions, Trust, Delegation, Escalation,
Human-Approval Rules, Agent Boundaries, and Risk Thresholds** for `atmosphere-core`, `TheAtmosphere`,
`StratosAgent`, and the VPS architecture.

Above every mechanism described below sits the **Human Sovereignty Doctrine** (DOCTRINE §"The Doctrines" 1):

> Humans own goals. Humans own permissions. Humans own intelligence. Humans retain final authority.
> Agents execute. Atmosphere coordinates. **Never build full autonomous control without explicit
> governance.**

No identity, policy, trust score, or delegation chain in this document may be constructed so as to remove a
human's final authority over their own intelligence. If a design choice would, it is **wrong by
construction** — not a tradeoff to be tuned.

> **Vision vs. Architecture vs. Claim (STRATEGY-BRIEF caveat 5):** This is a *Vision + Architecture*
> document. It describes the authority model Atmosphere is being built toward. Anything here that is not yet
> implemented is **direction / target / roadmap**, not a shipped capability. Measured status of what
> actually exists lives in each repo's `STATE_OF_REALITY.md` — that file, not this one, is authoritative for
> "what works today."

---

## 1. The authority hierarchy

DOCTRINE fixes the spine; this manifest fills it in:

```
Human → Workspace Owner → Organization → Policies → Agents → Tools
```

| Rank | Principal | What it is | Can it hold ultimate authority? |
|---|---|---|---|
| 1 | **Human** | A natural person. The only principal that can *own* intelligence. | **Yes — always, non-transferable.** |
| 2 | **Workspace Owner** | The human (or designated human role) accountable for a workspace's intelligence graph. | Holds it *on behalf of* the human; cannot exceed the human's grant. |
| 3 | **Organization** | A collection of workspaces under shared admin policy (SSO/SCIM domain). | No — bounded by Workspace Owner grants and org policy. |
| 4 | **Policies** | Declarative, versioned rules (policy-as-code) that constrain everything below. | No — policies *constrain*; they never *originate* authority. |
| 5 | **Agents** | StratosAgent instances and sub-agents. Execute; never own. | **No — execution authority only, always derived and revocable.** |
| 6 | **Tools** | MCP servers, Composio integrations, APIs, model endpoints. | No — capabilities, scoped per call. |

**Authority only ever flows downward and only ever narrows.** A principal can never grant a capability it
does not itself hold (the *no-amplification* rule). An agent's effective permission set is the
**intersection** of: the delegating human's grant ∩ org policy ∩ workspace policy ∩ the agent's own
declared boundary ∩ the tool's scope. The most restrictive layer wins — this is deliberate, and mirrors
NIST zero-trust ("never trust, always verify; least privilege by default").

---

## 2. Identity

Every actor that can request an action carries a **verifiable identity**. We do not invent an identity
system; we lean on proven standards (DOCTRINE §"Capability Doctrine"; STRATEGY-BRIEF "Build with what
already exists").

- **Humans** authenticate via **OIDC** (OpenID Connect on top of OAuth 2.x). Enterprise workspaces use
  **SSO/SCIM** for provisioning and de-provisioning. The OIDC subject is the durable human identifier.
- **Workspaces / Organizations** are identity *containers*, not authenticators — they map an OIDC subject
  (or SCIM-provisioned user) to a role within an ownership boundary.
- **Agents** receive a **derived, attenuated credential** minted *from* a human or workspace-owner session,
  never a standalone root identity. An agent token is: short-lived, audience-scoped, carries the delegation
  chain it was minted under, and is independently revocable. (OAuth token-exchange / on-behalf-of pattern.)
- **Tools** present their own credentials (OAuth client creds, API keys held in the vault, MCP server auth).
  A tool credential is **never** handed to an agent in raw form; the authority layer brokers the call so the
  secret stays inside the workspace boundary.

Per A2A Doctrine (DOCTRINE §5), **every agent interaction must carry Identity, Trust Score, Permissions,
Audit Trail, Memory Context, Execution Trace.** Identity is therefore not a login event — it is an
attribute attached to every message and every tool call, for the lifetime of the trace.

---

## 3. Ownership

Ownership is the load-bearing concept of the whole company (DOCTRINE §"Intelligence Ownership Doctrine",
§"Data Sharecropping Doctrine"). In authority terms:

- The **human owns** the intelligence graph created in their workspace: context, knowledge, skills,
  workflows, execution history, decision graphs, trust relationships, permissions.
- The **Workspace Owner** is *custodian*, not *owner* — accountable for governance but bounded by the
  human's grant.
- **Agents and models temporarily access** intelligence to execute; they **never own** it. Access is always
  a lease against an owner's grant, always scoped, always revocable, always audited.
- Ownership implies **portability**: an owner can export and move their intelligence graph (the moat is that
  it stays *theirs* across models, clouds, and execution environments — STRATEGY-BRIEF "The moat"). The
  authority layer must never become a lock-in mechanism that contradicts this.

> **Honesty note (STRATEGY-BRIEF, "regulatory tailwind" note — we make no formal legal-ownership claim):** We say "the user owns their
> intelligence" as a **design and product commitment**, not as a claim that current law recognizes
> "intelligence ownership" as a formal legal category. It does not. The regulatory *direction* (GDPR Art.
> 20 portability, EU Data Act on switching/multi-cloud) favors portability and control; we build toward
> that, and we do not overstate it.

---

## 4. Permissions — fine-grained, relationship-based

Coarse role checks ("is admin?") are insufficient for an intelligence graph where access is inherently
relational (this *agent*, acting for this *human*, on this *workflow*, in this *workspace*, using this
*tool*, up to this *cost*). We adopt a **Zanzibar-style fine-grained authorization** model and express the
rules as **policy-as-code (OPA / Rego-style)**.

- **Relationship tuples** express access as `⟨object, relation, subject⟩` —
  e.g. `⟨workflow:deploy-prod, executor, agent:stratos-7 (for human:neo)⟩`,
  `⟨graph:context/finance, reader, org:efficient-labs/finance-team⟩`. This lets permissions follow the
  shape of the intelligence graph instead of a flat role matrix.
- **Policies are declarative, versioned, and reviewable.** Policy-as-code means an authority decision is a
  pure function of (request, policy, relationship graph) — auditable and explainable, which is exactly the
  property STRATEGY-BRIEF identifies as the wedge ("routing is auditable, explainable, user-owned").
- **Default deny.** Absence of an explicit grant is denial, not permission (zero-trust least privilege).
- **Permissions are evaluated per action, not per session.** A long-running agent re-checks authority at
  each privileged step; a credential being valid does not mean every action under it is authorized.

Permission decisions and their inputs are themselves first-class intelligence (DOCTRINE §"Intelligence
Graph Doctrine": store *Approvals, Permissions, Confidence*). A denied action, the policy that denied it,
and the reason are preserved — nothing disappears (DOCTRINE §"Context Doctrine").

---

## 5. Trust

Trust is **earned, scored, and decaying** — never assumed from identity alone (zero-trust). Per A2A
Doctrine every interaction carries a **Trust Score**.

- Trust attaches to (agent, capability, context) tuples, not globally to a principal. An agent trusted to
  draft text is not thereby trusted to execute a deploy.
- Trust is **evidence-weighted**: it rises with successful, audited, low-risk executions and human
  approvals; it falls with failures, policy violations, contradicted outputs (DOCTRINE §"Contradiction
  Doctrine"), or staleness.
- Trust **modulates required oversight, never replaces it.** Higher trust may *widen the band* of actions an
  agent can take before escalating — but it can never cross a human-approval threshold that the owner has
  set (see §7). Trust tunes friction within the human-set envelope; it does not move the envelope.

---

## 6. Delegation

Delegation is how a human's authority reaches an agent and how an agent reaches a sub-agent. It is governed,
not implicit.

- **Every delegation is explicit, scoped, time-bounded, and recorded.** A delegation grant names: the
  delegator, the delegate, the capability set (a subset of the delegator's own), the constraints (cost
  ceiling, data scope, tool allowlist, risk threshold), and an expiry.
- **No-amplification (restated):** a delegate's grant is always ⊆ the delegator's authority. An agent cannot
  delegate to a sub-agent a capability it was not itself granted.
- **The delegation chain travels with the request.** When StratosAgent calls a tool or another agent, the
  full chain (human → workspace owner → agent → sub-agent) is carried in the execution trace, so any action
  is attributable back to the originating human grant (A2A Doctrine: Identity + Audit Trail + Execution
  Trace).
- **Delegation is revocable at any point in the chain** by any ancestor principal, and revocation is
  immediate — in-flight privileged actions must re-validate against the (now-revoked) grant before
  completing.

---

## 7. Human-approval rules and escalation

This is where the Human Sovereignty Doctrine becomes mechanism. Atmosphere coordinates and StratosAgent
executes, but **a human approves** at the thresholds the owner defines (DOCTRINE §"Economic Routing
Doctrine": *Atmosphere recommends. Users decide. Never silently swap models.*).

**Risk-threshold model.** Every requested action is assigned a **risk tier**, and each tier maps to a
required oversight level set by workspace/org policy. The tiers below are the *default* posture
(direction/target); concrete enforcement status is tracked in `STATE_OF_REALITY.md`.

| Risk tier | Examples | Default oversight |
|---|---|---|
| **R0 — Read / reversible** | Read context, summarize, search, draft (no send), local-only compute. | Agent may act autonomously within scope; logged. |
| **R1 — Low-impact write** | Create a draft artifact, write to a sandbox, propose a workflow. | Autonomous if trust ≥ policy floor; otherwise notify. |
| **R2 — External / costly / shared-state** | Send communications, spend above the included budget, call a paid model beyond a routing profile, write to shared org context. | **Human approval or pre-authorized policy** (e.g. standing budget grant). |
| **R3 — Irreversible / high-blast-radius** | Production deploys, deletions, financial transactions, credential/permission changes, granting another agent authority. | **Explicit human approval, every time. No standing auto-approval.** |

Rules that bind regardless of trust score:

1. **Crossing a higher risk tier triggers escalation** to the lowest-ranked human principal authorized to
   approve it, with full context (intent, plan, predicted effect, cost, confidence, dissent if any).
2. **Never silently swap models or route around a profile.** Recommending a cheaper/faster/private model is
   R0; *acting* on a swap that changes cost or privacy posture beyond the owner's profile is R2+ and
   requires approval (Economic Routing + Contradiction Doctrines).
3. **Approval is logged as intelligence** — who approved, what they saw, when, under which policy version.
   Approval habits and cost envelopes become reusable org intelligence (STRATEGY-BRIEF "the moat").
4. **No standing approval may be created for R3.** Owners may *raise* friction but the floor under R3 is
   fixed.
5. **Timeout = denial.** An escalation that is not approved within its window fails closed.

---

## 8. Agent boundaries

Agents are bounded by *construction*, not by good behavior. Each agent carries a **declared boundary**: the
maximum capability set it may ever request, independent of what it is delegated. Effective authority is the
intersection (§1).

- An agent **cannot self-elevate**: it cannot grant itself a capability, raise its own trust, lower a risk
  tier, or extend its own delegation. Those are R3 actions requiring a human (§7).
- An agent **cannot read its way out of its data scope.** Context and graph reads are permissioned (§4);
  default-deny applies to memory and knowledge access just as to tool calls.
- An agent **cannot exfiltrate a tool credential.** The authority layer brokers tool calls so secrets stay
  in the workspace boundary; agents receive results, not keys (consistent with the global hard rule:
  *no raw tokens to agents*).
- **Browser/vision automation** (DOCTRINE §"Agent Browser Doctrine") is itself a scoped capability under
  this manifest — a "human-first web" action surface is high-leverage and is permissioned and risk-tiered
  like any other tool, not exempt from it.
- **P2P / distributed execution** (DOCTRINE §"Distributed Compute Doctrine"; STRATEGY-BRIEF "P2P is a later
  execution substrate") joins as a **governed option**, not a trust anchor. A peer/community-compute node is
  a tool with a trust score and a risk tier; it does not bypass the authority hierarchy.

---

## 9. Standards we lean on (do not reinvent)

Per DOCTRINE §"Capability Doctrine" and STRATEGY-BRIEF "Build with what already exists," the internal
authority layer is assembled from proven, boring standards. We adopt; we do not rebuild plumbing the market
is standardizing.

| Concern | Standard we adopt |
|---|---|
| Human authn / session | **OAuth 2.x + OIDC**; SSO/SCIM for orgs |
| Agent credentials | OAuth token-exchange / on-behalf-of (attenuated, short-lived) |
| Trust model | **NIST zero-trust** (never trust, always verify; least privilege) |
| Fine-grained authz | **Zanzibar-style** relationship tuples |
| Policy expression | **OPA / policy-as-code** (declarative, versioned, reviewable) |
| Audit / trace | **OpenTelemetry** as the instrumentation spine for authority decisions |

The value Efficient Labs adds is **not** a novel auth primitive — it is binding these standards to the
**intelligence graph** so that authority, delegation, and approval become *owned, portable, and auditable
across models, clouds, and execution environments*. That cross-vendor portability is the wedge incumbents
gesture at but do not fully own (STRATEGY-BRIEF "What the market is already validating").

> **Positioning honesty (caveat 1):** "Sovereign Intelligence Infrastructure (SII)" is a **positioning
> construct we are defining**, not an established analyst category. In this manifest it means one concrete
> thing: an authority and governance layer where a human owns, governs, and can port the permissions, trust,
> and delegation graph behind their intelligence. Claim it by that outcome, never as an industry-standard
> term.

---

## 10. REQUIRED — Internal AUTH manifest vs. external `auth.md` protocol

> This section is mandatory and load-bearing. The two artifacts below are **different things**, separated by
> **purpose and path** — never by capitalization alone (STRATEGY-BRIEF caveat 4; DOCTRINE §"AUTH Doctrine"
> design note).

### 10.1 THIS file — the internal governance manifest

- **What it is:** the authority and governance constitution *for inside a workspace* — the hierarchy,
  ownership, permissions, trust, delegation, escalation, human-approval, and risk-threshold rules above.
- **Purpose:** governs *who may act, who may delegate, who may execute, who may approve* over an owner's
  intelligence graph.
- **Path:** `docs/doctrine/AUTH.md` (this file), subordinate to `DOCTRINE.md`. It is internal doctrine, not
  a network-discoverable endpoint. It is consumed by the authority layer, by StratosAgent, and by coding
  agents building either.
- **Authority:** binding on Efficient Labs' own systems. It does not assume, require, or wait on any
  external standard.

### 10.2 A future EXTERNAL `auth.md` protocol file — adopt where available, do not depend

- **What it is (separate, future):** a **discoverable, protocol-facing** file an external service publishes
  so that agents can find out *how to register and authenticate with that service* — analogous to the
  WorkOS-style `auth.md` agent-registration proposal.
- **Purpose:** machine-readable, outward-facing **agent registration / discovery** — the public handshake an
  agent reads before talking to a third-party system. This is the *external* side of identity, distinct from
  *internal* governance.
- **Path:** a discoverable location on the *external service's* surface (well-known-style discovery), **not**
  in this repo's `docs/doctrine/`. If Efficient Labs ever publishes one, it lives at a discoverable web path
  and is generated from, but is not, this manifest.
- **Adoption stance (caveat 2):** **`auth.md` (WorkOS) launched 2026-05-21 and is very new.** Atmosphere will
  **adopt it where available** to streamline agent registration with cooperating services — and will **not
  depend on it exclusively or assume universal support.** Where a service does not publish `auth.md`, the
  authority layer falls back to OAuth/OIDC and the standards in §9. The external protocol is a convenience
  for interop; the *internal* manifest (this file) is the source of truth for governance and never waits on
  external adoption.

| | Internal AUTH manifest (this file) | External `auth.md` protocol (future, separate) |
|---|---|---|
| **Purpose** | Governance: who may act/delegate/execute/approve | Discovery: how an agent registers/authenticates with a service |
| **Direction** | Inward (workspace) | Outward (network, third parties) |
| **Path** | `docs/doctrine/AUTH.md` | Discoverable path on the external service |
| **Dependency** | Always authoritative; depends on nothing external | Adopt where available; never depended on exclusively |
| **Maturity** | Founding doctrine | Very new (WorkOS, 2026-05-21) — directional |

---

## 11. Economics — no unbacked savings claims

A governed authority + routing layer (budgets, model-approval thresholds, cost envelopes per §7) is
*intended* to reduce wasted spend and tool sprawl, and that is part of the GTM ordering
(*Save Time → Save Money → Reduce Cloud Dependency → Sovereign Intelligence*, DOCTRINE §"Go-To-Market").

> **Honesty constraint (caveat 3):** Any specific dollar-savings figure is a **hypothesis requiring a
> measured pilot** — it is never to be stated as an achieved result in this manifest, in product copy, or in
> launch marketing. We do **not** write "$X saved," "hundreds of thousands," or "millions" as fact. The
> claim we are allowed to make is structural: authority and routing decisions here are *auditable,
> explainable, and owned* — and whether that yields a given saving must be **shown by a pilot**, then
> recorded against `STATE_OF_REALITY.md`.

---

## 12. The alignment gate (applied to authority)

Before adding any authority/identity/permission mechanism, apply DOCTRINE's gate: does it increase
**Trust? · Permissions clarity? · Intelligence Ownership? · auditability of the graph?** If a proposed
control centralizes power away from the human, hides disagreement, or makes intelligence less portable —
**Stop. Re-evaluate.** It contradicts the Human Sovereignty Doctrine and is out of scope by construction.

> Atmosphere coordinates. StratosAgent executes. **The human governs.** Everything in this manifest exists
> to keep that sentence true.
