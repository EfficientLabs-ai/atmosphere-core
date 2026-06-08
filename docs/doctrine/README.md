# Efficient Labs — Doctrine Canon

This directory is the **constitution and canonical doctrine** of Efficient Labs. It is the root from
which product, architecture, auth, context, and roadmap decisions are derived **and enforced** across
`atmosphere-core`, `TheAtmosphere`, `StratosAgent`, and the VPS architecture.

It is **private by design** — it encodes positioning and strategy (the moat). The public repos are
governed *by* this canon without publishing it. Public-facing status lives in each repo's
[`../../STATE_OF_REALITY.md`](../../STATE_OF_REALITY.md), never here.

## The canon

| Artifact | Role |
|---|---|
| **[DOCTRINE.md](DOCTRINE.md)** | **Root artifact — the constitution.** Mission, core thesis, the L0–L5 architecture, the Atmosphere/StratosAgent definitions, the 16 doctrines, the North Star, and the alignment gate. Everything below is subordinate to it. |
| **[STRATEGY-BRIEF.md](STRATEGY-BRIEF.md)** | The market/historical evidence behind the doctrine **and the binding honesty caveats** (SII is a new construct; `auth.md` is new; no unbacked savings claims; external `auth.md` ≠ internal `AUTH`; Vision/Architecture/Claim discipline). |
| [VISION.md](VISION.md) | The *why* + the category. SII positioning, the North Star, why-now, what we are not, the 5 dimensions as the lens. |
| [PRD.md](PRD.md) | Product requirements. The alignment gate, surfaces mapped to the 4 layers, packaging & pricing, GTM, success metrics, build-vs-don't-build rule. |
| [AUTH.md](AUTH.md) | The **internal** authority/governance manifest (`Human → Workspace Owner → Org → Policies → Agents → Tools`) — explicitly distinct from any external `auth.md` protocol. |
| [CONTEXT.md](CONTEXT.md) | The Context Doctrine + the Intelligence Graph (six graphs). "Nothing disappears, everything transforms." OpenTelemetry spine. |
| [ATMOSPHERE.md](ATMOSPHERE.md) | The Layer-3 ownership/governance/routing control plane: 4 layers, the Cognitive API, economic routing, consensus engine, orchestration of MCP/A2A/Composio. |
| [STRATOS.md](STRATOS.md) | The Layer-4 execution layer: reason/plan/execute/observe/learn; consumes from Atmosphere, never owns; MCP/A2A; the Agent Browser doctrine. |
| [ROADMAP.md](ROADMAP.md) | The phased roadmap: *Save Time → Save Money → Reduce Cloud Dependency → Sovereign Intelligence*; distributed-compute Phases 1→3. |

## Doctrine → artifact map

Each derived doc carries specific doctrines from `DOCTRINE.md`:

- **Human Sovereignty / AUTH / A2A** doctrines → **AUTH.md**
- **Context / Intelligence Graph** doctrines → **CONTEXT.md**
- **Model Abstraction / Economic Routing / Contradiction / Capability / Composio / Distributed Compute** → **ATMOSPHERE.md**
- **Agent Browser / A2A (execution side)** → **STRATOS.md**
- **Intelligence Ownership / Data Sharecropping / core thesis / North Star** → **VISION.md**
- **Product / Go-To-Market** doctrines → **PRD.md** + **ROADMAP.md**

## How this is enforced

1. **Conflict rule.** Where any derived doc, README, or line of code conflicts with `DOCTRINE.md`,
   the doctrine wins — or the doctrine is amended deliberately, never contradicted silently.
2. **The alignment gate.** Before building any feature: *does this increase intelligence ownership,
   compounding, portability, sovereignty, or execution?* If no → stop and re-evaluate.
3. **Claim discipline.** These are Vision + Architecture documents. Public *claims* stay inside what
   `STATE_OF_REALITY.md` can measure. Aspiration is labeled aspiration.

*Authored and honesty-reviewed via a multi-agent workflow; the two anchors (DOCTRINE, STRATEGY-BRIEF)
were written by hand to stay faithful to the founder's words.*
