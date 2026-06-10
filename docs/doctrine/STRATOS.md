> **Derived from and subordinate to [`DOCTRINE.md`](DOCTRINE.md).** Where this file conflicts with the doctrine, the doctrine wins. This is the StratosAgent / Execution-Layer spec (Doctrine §3 StratosAgent Definition · §5 A2A · §6 Model Abstraction · §7 Economic Routing · §9 Capability · §11 Agent Browser); evidence and honesty caveats live in [`STRATEGY-BRIEF.md`](STRATEGY-BRIEF.md).

# StratosAgent — The Execution Layer (Layer 4)

> **Document class:** Vision + Architecture. This file describes the **target** execution layer and how it is meant to behave. Anything not yet built is labeled **TARGET / direction / roadmap**. For the *measured* state of what is actually running on the live daemon, the source of truth is [`../../STATE_OF_REALITY.md`](../../STATE_OF_REALITY.md) (SoR) — never this file. No capability is described here as "live" or "done" unless it is explicitly tied to a ✅ line in SoR.

---

## 0. Position in the layer model

Per `DOCTRINE.md` §Company Architecture, StratosAgent is **Layer 4**:

| Layer | Name |
|---|---|
| Layer 3 | **Atmosphere** — the ownership layer (Context, Knowledge, Trust, Permissions, Workflows) |
| Layer 4 | **StratosAgent** — the execution layer (Reason · Plan · Execute · Observe · Learn) |
| Layer 5 | User / Developer / Business experiences |

StratosAgent exists to **reason, plan, execute, observe, and learn** (§StratosAgent Definition). It **consumes** Context, Knowledge, Trust, Permissions, and Workflows **from Atmosphere**. It **never owns intelligence — it executes intelligence.** Every capability below either serves that mandate or, per the §15 Product Doctrine alignment gate, should not be built.

This document is one of the concrete outcomes that gives the **Sovereign Intelligence Infrastructure (SII)** thesis substance. SII is a positioning construct **we are defining** (Strategy-Brief §Open questions #1) — not a settled analyst category — so this spec is written to back it with measurable execution-layer behavior (less tool sprawl, governed execution, portable context, user-owned routing) rather than to assert a category that exists in the market.

---

## 1. The execution cycle: Reason → Plan → Execute → Observe → Learn

StratosAgent's runtime is a five-phase loop. Each phase **reads from** and **writes back to** the Atmosphere Intelligence Graph (Doctrine §4); StratosAgent holds no durable intelligence of its own between cycles.

```
        ┌───────────────────────── Atmosphere (Layer 3) ─────────────────────────┐
        │  Context · Knowledge · Trust · Permissions · Workflows · Decision Graph │
        └───────▲──────────▲──────────▲───────────┬───────────┬──────────┬───────┘
                │ read      │ read     │ read      │ write     │ write    │ write
            ┌───┴───┐   ┌───┴───┐  ┌───┴────┐  ┌───┴────┐  ┌───┴────┐ ┌───┴────┐
            │REASON │──▶│ PLAN  │─▶│EXECUTE │─▶│OBSERVE │─▶│ LEARN  │─▶ (loop)
            └───────┘   └───────┘  └────────┘  └────────┘  └────────┘
```

1. **Reason.** Pull relevant Context/Knowledge from Atmosphere; form intent. Models are called through the **Atmosphere Cognitive API** (`reason()`, `plan()`, `analyze()` — Doctrine §6), never a vendor SDK directly. Where models disagree, the Contradiction Doctrine (§8) applies: surface conflict, never hide it.
2. **Plan.** Decompose intent into a workflow of steps. Negotiate each step against the **AUTH** authority manifest (§AUTH Doctrine): who may act, what scopes, what requires human approval. Plans are workflows-as-assets, not throwaway prompts (Context Doctrine §2: *Conversation → Decision → Workflow → Skill*).
3. **Execute.** Run each step through the right substrate: **MCP** for agent↔tool, **A2A** for agent↔agent, signed skills for compiled capabilities, the model router for inference. Capabilities are enforced **deny-by-default** before any step runs.
4. **Observe.** Capture the full execution trace — inputs, tool calls, outputs, failures, costs, confidence — and emit it to Atmosphere (Strategy-Brief §Architecture-Layer-2: OpenTelemetry is the instrumentation spine; **TARGET** for full OTel coverage).
5. **Learn.** Distill repeated, verified successes into reusable, signed skills (the self-evolution loop). Nothing disappears; everything transforms into compounding intelligence.

**Human Sovereignty Doctrine overrides all of the above.** Humans own goals and permissions; agents execute; Atmosphere coordinates. StratosAgent must never construct full autonomous control without explicit governance.

---

## 2. The interaction envelope (A2A Doctrine, §5)

Agent communication is **first-class infrastructure**. Every agent↔agent interaction StratosAgent participates in must carry the six-field envelope from Doctrine §5:

| Field | Meaning | Source of truth |
|---|---|---|
| **Identity** | who is acting (`did:atmos:…`) | Atmosphere AUTH / on-disk node key |
| **Trust Score** | the counterparty's standing | Atmosphere Trust graph |
| **Permissions** | least-privilege scopes for this exchange | AUTH manifest |
| **Audit Trail** | append-only, tamper-evident record | attribution ledger |
| **Memory Context** | the relevant slice of the Intelligence Graph | Atmosphere Context |
| **Execution Trace** | the steps + results of the run | OBSERVE phase output |

These fields are not optional metadata — they are the **unit of A2A**. An interaction missing Identity or Permissions is, by doctrine, not a valid interaction.

### Default protocols

- **MCP = the default agent↔tool protocol.** StratosAgent reaches every external system through MCP rather than bespoke integrations (Capability Doctrine §9 + Composio Doctrine §10: *do not reinvent; orchestrate*). The repo ships a real MCP client and stdio transport (`packages/stratos-agent/src/connectors/mcp-client.js`, `mcp-stdio-transport.js`) plus a connector broker (`broker-core.js`) — see SoR for which paths are wired into the live request flow vs. built-but-not-wired.
- **A2A = the default agent↔agent protocol.** Cross-agent calls carry the full envelope above. The mesh's PQC-signed skill gossip and node cards (SoR ✅ *Real cross-machine P2P mesh*) are the transport-identity foundation A2A builds on; the richer A2A semantic envelope (trust-scored, audience-bound assertions) is **TARGET** beyond what SoR marks live.

---

## 3. Identity, AUTH, and the two distinct `auth` surfaces

StratosAgent obeys the **AUTH Doctrine** (§3): `Human → Workspace Owner → Organization → Policies → Agents → Tools`. It governs who may act, delegate, execute, and approve.

Two `auth` surfaces exist and must **never be conflated by capitalization alone** — they differ by **purpose and path** (Doctrine §3 design note; Strategy-Brief §Open questions #4):

| Surface | Purpose | Where it lives |
|---|---|---|
| **Internal `AUTH.md` governance manifest** | the workspace authority manifest — ownership, delegation, escalation, risk thresholds, human-approval rules; governs *who may act* | `docs/doctrine/AUTH.md` (governance, in-workspace) |
| **External `auth.md` protocol** | protocol-facing, discoverable agent registration (WorkOS-style) | a published, protocol-facing location separate from the governance manifest |

The external `auth.md` protocol (WorkOS, launched 2026-05-21) is **very new**. StratosAgent must **adopt it where available and never depend on it exclusively** (Strategy-Brief §Open questions #2): registration and discovery degrade gracefully to boring, proven standards — OAuth/OIDC, NIST zero-trust, Zanzibar/OPA-style fine-grained authz — when an external registry is absent. No flow may assume universal `auth.md` support.

**Identity broker (TARGET, real code per SoR 🟡):** the **Identity broker** (`packages/stratos-agent/src/identity/identity-broker.js`) is the IDJAG / `auth.md`-style component that mints **short-lived, audience-bound, scoped** assertions and returns *only* the token, never the raw credential — deny-by-default (no grant / scope-beyond / undeclared-audience ⇒ refused). Per SoR it is built and hermetically tested on the trust-substrate feature stack but **not yet reloaded onto the live daemon**; it is therefore a target until SoR marks it ✅ live.

---

## 4. Model abstraction & sovereign routing (§6 + §7)

StratosAgent never calls a vendor directly. Inference flows through the **Atmosphere Cognitive API** (`reason()`, `code()`, `analyze()`, `execute()`, …) and is dispatched by **one** sovereign router.

**Local-default model router (real code per SoR; consolidated into the live request path):**

- One router policy — `packages/stratos-agent/src/routing/model-router.js` — into which `task-router.js`'s classifier delegates (SoR notes this consolidation closed a real sovereignty bug where the old fallback defaulted general prompts to frontier cloud, even with no API key configured).
- **LOCAL is the default.** `/private` pins local. Cloud is **opt-in only**: a configured BYOK key on a genuinely hard prompt, or explicit `/force-cloud`, behind a **402 cost-approval gate**.
- Routing profiles per Economic Routing Doctrine §7: *Maximum Quality · Balanced · Lowest Cost · Private Only · Open Weight Only · Frontier Only · Custom.* **Atmosphere recommends; humans approve. Never silently swap models.**
- **BYOK Universal Model Manager** (SoR ✅ built + tested 2026-06-08): OpenAI / Gemini / Anthropic natively + OpenRouter; real `fetch()` to official endpoints; keys read from env/vault and **never logged**. Without a key it falls back to local *by design*, not as a stub. A real end-to-end frontier call requires the user's own key.
- **Mesh signal** (`routing/mesh-signal.js`, SoR real code): the router may route heavy work to the compute mesh **only if a real `fleet.json` reports nodes>0** — deny-by-default, **never invents peers**. It honestly returns "no mesh" until a live node writes a real fleet.

The verified local inference path today is **Ollama `gemma2:2b`** (fast default; `gemma4:e4b` for chat/vision) on a CPU-only VPS. Frontier-quality reasoning at low latency is a routing/compute concern, not a capability StratosAgent claims to own.

---

## 5. Signed skills: verify-before-run (the Learn phase made safe)

The **LEARN** phase turns repeated, verified successes into **compiled, signed skills** — the mechanism by which intelligence *compounds* (Doctrine §15) instead of being re-derived every call.

Pipeline (SoR ✅ *real self-evolution pipeline*, flag-gated, default OFF):

```
harvest (success_rate=1.0 traces)  →  classify (computational vs automation)
   →  content-hash dedupe  →  compile to wasm  →  FULL-MODULE PQC seal
   →  SkillExecutor: VERIFY-BEFORE-RUN  →  execute | REFUSE (on tamper)
```

- **Verify-before-run is mandatory.** `SkillExecutor` (`packages/stratos-agent/src/evolution/skill-executor.js`) checks the seal before a skill runs; a tampered skill is **refused before execution**.
- **The seal covers code AND manifest.** The hybrid **Ed25519 + ML-DSA-65** signature (`security/quantum-crypto.js`, real `@noble/post-quantum`, FIPS 203/204 per SoR) covers the *entire module* — flipping a single code byte fails verification. The earlier integrity gap (manifest-only signing) is closed.
- **Capability receipts / least-privilege caps (SoR 🟡, trust-substrate stack).** Signed skills carry least-privilege capabilities **inside the PQC-sealed manifest** (`compute/actions/net/fs/secrets`; absent ⇒ denied). `capability-gate.js` enforces deny-by-default before a skill runs (path-traversal proven blocked). The **attribution ledger** (`src/ledger/attribution-ledger.js`) is an append-only, tamper-evident hash chain recording every verified run, attributed to this node's `did:atmos` — `summarize()` reports **measured units per contributor and is explicitly NOT a payout** (measurement before rewards; Vision/Architecture/Claim discipline). Per SoR these are tested on a feature branch, **not yet live on the daemon** — TARGET until SoR says otherwise.
- **Honest scope of learning.** The live chat path today learns/serves **only the deterministic numeric-transform class** (integer operand → integer answer), with the Tier-A inducer (`skill-induction.js`) synthesizing const/affine/quadratic specs from observed examples and **refusing to synthesize from a single observation**. Arbitrary control-flow/loop synthesis (Tier B) is **research-mapped, not built** (SoR). Free-form prose carries no typed examples, so OBSERVE records nothing and EXECUTE never matches it — by design, not stub.

This is the operating core's value proposition in miniature: a skill is **owned** (by `did:atmos`), **portable** (a signed wasm module), **trustworthy** (verify-before-run), and **compounding** (deduped, accumulated) — exactly the durable assets Doctrine names, executed rather than owned by Stratos.

---

## 6. The Agent Browser doctrine (§11)

Per Doctrine §11, StratosAgent must eventually **See · Hear · Speak · Reason · Execute** across four sensory layers, and **browser automation remains mandatory while the world is still human-first**:

| Layer | Mandate | Status (defer to SoR) |
|---|---|---|
| **Vision** | perceive screens / pages / visual UIs | **TARGET.** SoR: Active Vision is MOCK (GDI mock display buffer). |
| **Audio** | hear / transcribe | **TARGET.** SoR: Whisper STT is MOCK. |
| **Speech** | speak | **TARGET.** SoR: TTS scrapped ("1990s robot"); not real. |
| **Execution** | act on tools, APIs, and **browsers** | Tool/API execution via MCP is real-code (see §2); real *browser* execution of automation manifests needs a Playwright/harness driver bound to `SkillExecutor.actionExecutor` — the interface is real, the default is an **honest verified dry-run** (SoR). |

**Why the browser is non-negotiable (Strategy-Brief §Architecture):** automation through a browser stays necessary as long as the web is built for humans, not agents — most systems StratosAgent must reach expose no MCP server and no API. The browser is the universal fallback execution surface. Automation skills are therefore modeled as **signed, replayable 3-step manifests** (SoR), so a browser action is the same kind of owned, verified, portable asset as a compiled computational skill — not an unaudited side effect.

The four sensory layers are an **aspiration labeled as aspiration**: Vision/Audio/Speech are MOCK today and must not be described as shipped. Lead with what is real (text reasoning + tool execution); grow the senses behind the verify-before-run gate.

---

## 7. Mapping to the real StratosAgent repo

The execution layer is not a greenfield spec — it maps to code in `packages/stratos-agent/` and `packages/api-shim/`. The table below names real modules; the **Status** column always defers to `STATE_OF_REALITY.md`, which is the only place a capability is called live.

| Doctrine concept | Real module(s) | Status — see SoR |
|---|---|---|
| Operating core / live bridge | `packages/api-shim` (PM2 `atmos-secure-bridge`, :4099) | ✅ daemon online, Telegram inbound, real `gemma2:2b` |
| Agent identity / self-awareness | `src/core/identity.js`, `src/security/did-generator.js` | ✅ introduces as StratosAgent + zero-ambient-authority model; fabricated readouts removed |
| Reason/Execute via local model | Ollama `gemma2:2b`/`gemma4:e4b` + `src/routing/model-router.js` | ✅ real local inference (CPU-only) |
| Sovereign model routing | `routing/model-router.js`, `api-shim/src/task-router.js` | ✅ LOCAL-default consolidated into live path (fixed a real sovereignty bug) |
| BYOK cloud (opt-in) | `api-shim/src/routers/cloud-byok.js`, `anthropic-adapter.js` | ✅ built + tested 2026-06-08; falls back to local without a key |
| Mesh routing signal | `routing/mesh-signal.js` | real code; honestly "no mesh" until a real `fleet.json` exists |
| MCP agent↔tool | `connectors/mcp-client.js`, `mcp-stdio-transport.js`, `broker-core.js` | real code; check SoR for live-wiring scope |
| A2A transport identity | mesh PQC-signed gossip + node cards; `KeyringManager` (Ed25519) | ✅ mesh real cross-machine; full A2A semantic envelope is TARGET |
| Signed skills / verify-before-run | `evolution/skill-executor.js`, `memory/skill-seal.js`, `security/quantum-crypto.js` | ✅ real PQC seal (code+manifest); refuses tampered skills |
| Capability receipts (least-privilege) | `security/capability-gate.js` | 🟡 real + tested on trust-substrate stack; **not yet on live daemon** |
| Attribution ledger (measurement, not payout) | `src/ledger/attribution-ledger.js` | 🟡 real + tested; not yet live; explicitly NOT a payout |
| Identity broker (`auth.md`-style) | `src/identity/identity-broker.js` | 🟡 real + tested; not yet live |
| Self-evolution / LEARN | `evolution/self-evolution.js`, `skill-induction.js`, `night-shift-compiler.js`, `api-shim/src/self-evolution-runtime.js` | ✅ wired into daemon, flag-gated default OFF; deterministic numeric class only |
| Observe / execution trace | `src/trace/trace-engine.js`, `memory/telemetry-exporter.js` | real code; full OTel spine is TARGET |
| Workflow / pipeline engine (ICM) | `src/pipeline/engine.js`, `context/icm-workspace.js` | ✅ folder-stage engine, 12/12 tests |
| Conversation memory | `src/memory/*` (MemGPT-lite, per-chat ring) | ✅ Tier 0 + Telegram per-chat memory |
| Multimodal (Vision/Audio/Speech) | `src/sensory/*` | ⛔ MOCK (Active Vision / STT / TTS) — TARGET |
| Omni-channel adapters | `src/ingestion/*` | ⛔ SCAFFOLD; not connected to live platforms |

**Built-but-not-wired is not the same as shipped.** Several trust-substrate modules (capability gate, attribution ledger, identity broker, consolidated mesh signal) are real, hermetically tested code on a feature stack that the operator has **not yet merged + `pm2 reload`-ed** onto the running bridge. By the strict "live on the daemon" bar they are 🟡 / TARGET. This spec treats them as **direction**, not present-tense capability, until SoR's status flips.

---

## 8. Economic discipline (Vision / Architecture / Claim)

StratosAgent measures before it rewards. The attribution ledger records **measured units of verified work per contributor** (`did:atmos`); it is **explicitly not a payout** and contains no "earning" code. The entire **economic layer** — Solana token, on-chain settlement, DePIN reward harvesting — is **intentionally not live** (counsel-gated, labeled "Payouts not live" everywhere; SoR).

Accordingly, this document makes **no hard dollar-savings claims** (Strategy-Brief §Open questions #3). Any statement about cost reduction from local-default routing, reduced tool sprawl, or governed execution is a **hypothesis that requires a measured pilot** — never a quoted figure. The honest ROI story is *architectural* (LOCAL-default routing, BYOK-with-approval, auditable execution, portable owned skills), and its dollar value is to be **measured**, not asserted.

---

## 9. The execution-layer alignment gate

Before StratosAgent gains any new capability, apply the Doctrine §15 / final-instruction gate. A feature is in-scope only if it increases at least one of:

**Context · Knowledge · Trust · Skills · Workflows · Decision Graphs · Intelligence Ownership · Intelligence Compounding.**

And it must respect the execution-layer invariants:

1. **Stratos executes; it never owns intelligence.** Durable assets live in Atmosphere.
2. **Every A2A interaction carries the full six-field envelope.** No envelope, no interaction.
3. **MCP for tools, A2A for agents** — orchestrate, don't reinvent (§9, §10).
4. **LOCAL is the default; cloud is opt-in, approved, never silent** (§6, §7).
5. **Verify-before-run for every skill.** Tampered ⇒ refused.
6. **Human sovereignty overrides everything.** No full autonomy without explicit governance.

If a proposed capability violates any invariant, or fails to increase one of the eight assets: **Stop. Re-evaluate.** It is likely misaligned with the mission.

---

> **One-line handle.** StratosAgent is the **execution layer** that *reasons, plans, executes, observes, and learns* — consuming Context, Knowledge, Trust, Permissions, and Workflows from Atmosphere, reaching tools over **MCP** and agents over **A2A**, running every skill **verify-before-run**, routing **LOCAL-first**, and **never owning** the intelligence it executes. For what is actually running today, read [`STATE_OF_REALITY.md`](../../STATE_OF_REALITY.md).
