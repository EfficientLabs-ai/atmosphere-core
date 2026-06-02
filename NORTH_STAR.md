> **Draft — structured by a research workflow (Claude Opus + 5 agents), 2026-06-02, for the operator to refine.**
> Grounded in `STATE_OF_REALITY.md` (the source of truth). Not a final commitment; the positioning is the operator's call.

# Atmosphere + StratosAgent — North Star

**Efficient Labs · Chief Architect's vision, structured**
*Status date: 2026-05-31. Every "what we have" claim is anchored in the architecture audit (grounded in `STATE_OF_REALITY.md`). Anything not so anchored is explicitly marked **[ROADMAP]**.*

---

## 1. North Star

We are not building an AI product. We are founding **infrastructure** — the plumbing for an agentic internet — and treating "agentic" as the thin ambiguity-handling layer that rides on top of it. The North Star is a **content-addressed, capability-secured, DHT-meshed, supervision-reliable, end-to-end-sovereign file architecture** on which sovereign local-first nodes discover each other, communicate agent-to-agent, sync skills globally, and trade compute over a peer-to-peer mesh — with no central server able to seize, censor, or surveil any of it. The work is to **automate the file architecture, not the AI wrapper**: a correctly-designed file/dataflow architecture does most of the work *deterministically* — cheap, reproducible, auditable, near-zero token cost — and an agent earns its place *only* where genuine ambiguity lives. Everywhere else, an agent is expensive, non-reproducible glue we refuse to ship.

This vision is not novel in its principles; that is its strength. It descends directly from the ideas in computer science that *survived* because they pushed intelligence to the edges and kept the core dumb, deterministic, and composable:

- **Do one thing well; compose over a universal interface.** (Unix, 1969–78 — Thompson/Ritchie/McIlroy.) The file/dataflow architecture *is* the universal interface; agents and skills are tools composed by deterministic plumbing.
- **Dumb core, smart edges (end-to-end).** (Saltzer/Reed/Clark 1984; TCP/IP; DNS; BGP.) Keep the transport dumb and the sovereign node smart. Delegated, decentralized naming — no central registry.
- **Identity through integrity (content-addressing).** (Merkle 1979; Git 2005; IPFS 2014; Hypercore.) Name data by the hash of its content; trust the data, not the source.
- **Capabilities, not ambient authority (POLA).** (Dennis & Van Horn 1966; Miller's ocap; WASI.) The reference *is* the permission. Hand out the minimum. No raw tokens — ever.
- **Isolation, message-passing, supervision.** (Hewitt 1973; Armstrong's Erlang/OTP.) Agents are actors with private state; let it crash; restart to a known-good state via supervision trees.
- **Decentralized coordination with explicit intent.** (Contract Net 1980; FIPA-ACL 1997; blackboard systems.) Announce/bid/award; speech-act-typed messages; a shared append-only blackboard.
- **Determinism over agents.** The LLM is one node — the ambiguity node — inside an otherwise deterministic, cached, content-addressed dataflow.

**The honesty moat.** We will not claim capabilities we do not have. The same `STATE_OF_REALITY` discipline that grounds this document is the brand: we publish a per-capability status matrix (GA / beta / mock / planned), in public, because honesty *is* the differentiator in a market saturated with agent hype.

---

## 2. Architectural Principles → Concrete Atmosphere Mechanisms

Each principle is tied to a mechanism that **already exists in the repo** (audit-verified) or is **[ROADMAP]**.

### 2.1 File-architecture-first / determinism over agents
The dataflow contract is a **file, not code**. Orchestration is *data* that is diffable in git, not non-reproducible glue.
- **Mechanism (real):** `packages/stratos-agent/src/pipeline/engine.js` — the crown jewel. A pure file/state DAG with a content-addressed freshness model: `inputFingerprint = sha256(stage body + prior output + resolved reads + model + runner)`. Same fingerprint + matching output hash → skip (cache hit, zero tokens). Different on-disk hash → respect the human edit. Different fingerprint → re-run. Because each fingerprint folds in the prior stage's output, **downstream invalidation is automatic — no cascade code.** Atomic tmp+rename writes, realpath path containment, swappable runner injection (model / script / mesh). This is make/Nix/Bazel-grade. *The AI fills only the genuinely-ambiguous `model` stage.* **This is the template the rest of the repo converges to.**
- **Doctrine import:** Van Clief/McDermott's CONTEXT.md stage contract (Inputs table with source+scope+why / Process / Outputs) becomes the declarative descriptor for every Atmosphere worker stage. Output of stage *N* is the input of stage *N+1* — Unix pipe by filesystem.

### 2.2 Content-addressing = identity through integrity
Name everything reproducible by `sha256` of its content; verify against a Merkle root; dedupe to zero.
- **Mechanism (real):** the content-addressed **skill seal** — `skill-seal.js` + `gsi-compiler.js`. Skills compile to real WASM (via `wabt`); a hybrid **Ed25519 + ML-DSA-65** seal covers code bytes *and* manifest (canonical-JSON over `{skillId, wasmHash, metadata}`). `dist/skills/registry.json` keys each skill by `sha256(wasm)` and dedupes by content hash. Verify-before-execute is enforced in `SkillExecutor`. **5 real compiled skills on disk.** `dist/{atmosphere,stratos}/provenance.json` is a per-file hash manifest of the published build — a content-addressed release.
- **[ROADMAP]** Promote content-addressing from skills to *everything the agent produces* — RAG telemetry, chat history, pipeline intermediates — under a `.stratos/objects/` content-addressed store with the existing `provenance.json` manifest pattern.

### 2.3 Capability security (POLA), not ambient authority
The reference *is* the permission. No ambient authority; no raw bearer tokens handed to any agent.
- **Mechanism (real):** the **connector broker** — `broker-core.js`. Textbook ocap: per-session timing-safe capability token; read-only tool subset advertised to the model; write → single-use human approval; the **broker (not the model) owns the credential destination** (SSRF/exfil allow-list); secret plaintext never leaves the broker; no auto-chaining of tool output. This *encodes our "never hand agents raw tokens" hard rule as architecture, not discipline.*
- **[ROADMAP]** Run untrusted skills in **WASI/Wasm sandboxes with preopens** — zero authority by default, every capability a typed import. Make capability tokens themselves unforgeable (signed / content-addressed).

### 2.4 End-to-end / dumb core, smart edges
Reliability, security, and correctness live at the sovereign endpoints; the transport stays dumb and general.
- **Mechanism (real):** **real PQC** in `quantum-crypto.js` — `@noble/post-quantum` ML-DSA-65 + ML-KEM-768 (FIPS 203/204), hybrid with classical Ed25519/X25519, **fail-closed** (`classicalOk && pqOk`). Not mock. Security is an endpoint property.
- **Mechanism (real):** **P2P skill sync** — `p2p-skill-sync.js`: Corestore + Autobase append-only log over Hyperswarm; trust by *provenance* (which core a block came from), seal-verified for remote blocks, explicit refusal of in-band "trusted" flags (anti-spoof).
- **Mechanism (real):** **ACP a2a** — `acp-core.js`: hybrid-signed envelopes, per-peer explicit capability grants (deny-by-default), single-use nonce replay protection, no transitive forwarding. Honestly scoped as alpha / single-hop.

### 2.5 Isolation + supervision (actors)
Agents are actors: private state, message-passing only, let-it-crash, supervised restart to known-good.
- **Mechanism (partial):** the PM2 daemon fabric (`atmos-secure-bridge`, `stratos-agent-upstream`, `atmos-mesh-origin`) is a *primitive* supervisor. **[ROADMAP]** Formalize it into actual **supervision trees** with known-good restart semantics.

### 2.6 Decentralized coordination with explicit intent
- **Mechanism (partial):** cross-agent shared memory (ADR-0013) is a **blackboard** — formalize it as one. **[ROADMAP]** add **Contract Net** announce/bid/award dispatch and **speech-act-typed** performatives so agent intent is machine-checkable, not parsed from prose.

---

## 3. The Layered Architecture of the Agentic Internet We're Building

Honest status tags: **[LIVE]** wired and running · **[REAL/STANDALONE]** built and unit-proven, not on the live path · **[MOCK]** placeholder theater · **[ROADMAP]** not built.

```
┌─────────────────────────────────────────────────────────────────────┐
│ L5  ECONOMY        compute/skill market: announce→bid→award,         │
│                    metered settlement                                 │
│       off-chain accounting only [REAL/limited] · on-chain x402 [ROADMAP]
├─────────────────────────────────────────────────────────────────────┤
│ L4  SKILL SYNC     global, content-addressed skill distribution      │
│                    Corestore+Autobase append-only log, seal-verified  │
│       p2p-skill-sync.js [REAL/STANDALONE — deliberately not wired:    │
│       no 2nd trusted peer from the bridge yet]                        │
├─────────────────────────────────────────────────────────────────────┤
│ L3  A2A            agent-to-agent: hybrid-signed envelopes,           │
│                    deny-by-default capability grants, nonce replay    │
│       acp-core.js [REAL/STANDALONE — alpha, single-hop]              │
├─────────────────────────────────────────────────────────────────────┤
│ L2  MESH           Hyperswarm DHT + hole-punch + Noise, zero ports   │
│       atmos-mesh-origin (PM2 id 4, mesh-demo.mjs) [LIVE but isolated];│
│       bridge reads fleet.json if present, else honest "not joined"    │
├─────────────────────────────────────────────────────────────────────┤
│ L1  NODE           sovereign local-first node: pipeline engine,       │
│                    skill seal + PQC, broker, LanceDB RAG, Ollama      │
│       Telegram→qwen2.5:7b [LIVE] · self-evolution OBS/LEARN/EXEC      │
│       [LIVE, flags ON, 5 wasm skills] · pipeline engine               │
│       [REAL/STANDALONE] · broker/ACP [REAL/STANDALONE]               │
├─────────────────────────────────────────────────────────────────────┤
│ L0  SUBSTRATE      content-addressed store + Merkle/provenance        │
│       dist/.../provenance.json + registry.json (sha256 keys) [REAL,   │
│       skill-scoped] · whole-system object store [ROADMAP]             │
└─────────────────────────────────────────────────────────────────────┘
```

**Reading the layers honestly:** L0–L1 are where the real computer science lives and runs. L2 runs but is isolated (no real second node was ever connected before this date). L3–L4 are genuinely good, content-addressed, capability-secured code that is **built, tested, and deliberately not yet on the live path**. L5 is off-chain accounting that never touches a chain. The mesh, A2A, skill-sync, and economy are the North Star's defining layers — and they are precisely the layers still to be *wired and proven*, not invented from scratch. The substrate beneath them is real.

---

## 4. Where We Deviate From the Ideal Today + Highest-Leverage Refactors

The repo is **bimodal**. The *library tier* — pipeline engine, skill seal, PQC, broker, content-addressed dist — is real, durable, new-internet plumbing, mostly already built. The *daemon tier* — the HTTP self-call mesh, the keyword router, a surviving 3-dimensional mock, mock harnesses — is the AI-wrapper-shaped glue that violates the thesis. **The fastest path to the ideal is subtraction and rewiring, not building more.**

### Current deviations (audit-verified)
1. **Two disjoint vector stores — one real, one toy.** The chat RAG path uses real **768-dim LanceDB** (`vector-bank.js` + `nomic-embed-text`). But `server.js` runs a *separate 3-dimensional char-sum toy vector* (`queryToVector(q, 3)`) for the `/mcp atmos_vector_search` tool and the telemetry knowledge-base, via a degraded `reasoning-bank.js` ("LanceDB Sim"). The MCP-exposed semantic search is **non-semantic theater** sitting beside the real engine. (`server.js:115,168,205,747`)
2. **Routing classifier is a regex keyword bag** (`task-router.js`): greps for "post-quantum", "deadlock", `length > 800` to decide local-vs-cloud, *defaulting to cloud* — i.e., spending money on ambiguity. Deterministic (good) but mislabeled as "semantic complexity."
3. **The product front door is HTTP self-calls.** `telegram-bridge.js:206` does `fetch(127.0.0.1:4099/v1/chat/completions)` to reach a module in *its own process*. Three internal hops (bridge → server route → local-inference) serialize JSON over loopback; every hop re-parses, re-classifies, re-runs the gate. The AI-wrapper pattern at the transport layer.
4. **Mock harnesses are load-bearing.** `MockBrowserHarness` returns `"Mocked page content..."`; `bridged_mcp_*` returns `status: 'bridged_execution_success'` without running anything; voice writes a 44-byte fake WAV then "transcribes" it.
5. **Economic layer is off-chain accounting only** — never broadcast on-chain.

### Highest-leverage file-architecture refactors (ordered by leverage)
1. **Make the pipeline engine the spine, not a side library.** Re-express the live RAG path — retrieve → augment → infer → observe — as pipeline stages. Then the *only* non-deterministic node is the model call; retrieval/augmentation/observation become cached, hash-invalidated, reproducible, and free on cache hits. **Biggest token-cost win.**
2. **Collapse the loopback HTTP self-calls into in-process function calls.** Bridge → local-inference becomes a direct `await`. Keep the HTTP surface only for *external* OpenAI/Anthropic clients. Removes two JSON round-trips + double classification per message; makes the dataflow a traceable call graph.
3. **Delete the 3-dim toy vector store; route `/mcp atmos_vector_search` and telemetry through the real 768-dim LanceDB.** One embedding function, one store. A delete-code refactor.
4. **Replace the keyword-bag router with a deterministic cost model:** `route = f(token_estimate, installed_capacity, content-hash cache-hit)`. Default local; escalate to BYOK only on a measured budget breach.
5. **Promote content-addressing to everything the agent produces** (`.stratos/objects/`, `sha256`-keyed, `provenance.json` manifest) — the auditability the skill layer already has, extended system-wide, deduping repeated work to zero tokens.
6. **Wire the standalone-but-real modules onto the live path behind flags** — same pattern self-evolution already uses (`self-evolution-runtime.js` is the model). Broker and ACP are genuinely good capability code doing nothing live.

---

## 5. The Reverse-Engineered Roadmap: Now → North Star

Reverse-engineered from the full image backward. Each phase leads with **deterministic-first deliverables**; the *few* places an agent is genuinely warranted are named explicitly. The governing rule: **subtract and rewire before you build.**

### Phase 0 — Honesty baseline (immediate, no new capability)
- **Deterministic:** Publish the `STATE_OF_REALITY`-derived per-capability status matrix (GA / beta / mock / planned) as a checked-in data file; label the surviving mocks (3-dim vector, MockBrowserHarness, fake-WAV voice, off-chain economy) openly. Close the PRD-honesty gap flagged in the MVP QA NO-GO.
- **Agent warranted:** none. This is data discipline.

### Phase 1 — Subtraction (close the worst deviations)
- **Deterministic:** Delete the 3-dim toy vector store (refactor #3). Collapse the loopback HTTP self-calls (refactor #2). Replace the keyword router with the deterministic cost model (refactor #4). Net result: fewer lines, lower token cost, a traceable call graph, one embedding store.
- **Agent warranted:** none. Pure subtraction and rewiring.

### Phase 2 — Make the spine the spine (node hardening)
- **Deterministic:** Re-express the live RAG path as pipeline-engine stages (refactor #1); adopt the CONTEXT.md stage contract as the standard worker descriptor; enforce the **Layer-3 (stable reference, read-only, scoped) / Layer-4 (per-run working data)** split everywhere — which shrinks the secret-leak blast radius by construction. Stand up the `.stratos/objects/` content-addressed store (refactor #5).
- **Agent warranted:** the single `model` stage inside the otherwise-deterministic DAG (research synthesis / tone-matching). Nothing else.

### Phase 3 — Wire the real-but-standalone capability layer onto the live path
- **Deterministic:** Behind flags (the self-evolution pattern), put the **broker** (capability-scoped tool access) and **ACP** (signed, deny-by-default a2a envelopes) on the live request path. Formalize the PM2 fabric into **supervision trees** with known-good restart semantics.
- **Agent warranted:** none in the wiring; the broker exists precisely to let the agent touch tools *without* ambient authority.

### Phase 4 — Mesh: from isolated origin to proven two-node sovereignty
- **Deterministic:** Connect a real second node over the locked topology — **Hyperswarm DHT + hole-punch + Noise, zero open ports**. Skill discovery and agent rendezvous over the **Kademlia-style DHT**; piece-wise hash-verified transfer (BitTorrent-style) for large skill/model artifacts. Formalize cross-agent shared memory (ADR-0013) as a proper **blackboard**. Adopt delegated naming via **Agent Cards at `/.well-known/agent.json`**.
- **Agent warranted:** none. Mesh connectivity is pure deterministic plumbing.

### Phase 5 — Global skill sync at scale
- **Deterministic:** Promote `p2p-skill-sync.js` (Corestore + Autobase, seal-verified, provenance-trusted) from standalone to a live multi-node service. Run untrusted skills in **WASI/Wasm sandboxes with preopens** (zero authority by default). Make capability tokens unforgeable (signed / content-addressed).
- **Agent warranted:** none in transport; agents are *consumers* of synced skills, verified-before-execute.

### Phase 6 — Decentralized coordination + the economy
- **Deterministic:** Add **Contract Net** announce/bid/award dispatch and **speech-act-typed** performatives. Build metered settlement on top; only then evaluate on-chain (x402/Solana) broadcast vs. keeping it off-chain.
- **Agent warranted:** bid valuation under genuine uncertainty (estimating cost/quality of an ambiguous task) — a real ambiguity node. The dispatch mechanism itself stays deterministic.

### Phase 7 — Interop at the edges
- **Deterministic:** Speak **MCP** (tools) and **A2A** (agents) at the boundary so Atmosphere interoperates with the broader ecosystem — as the *thin, replaceable* layer atop the content-addressed, capability-secured, DHT-meshed substrate. Reinvent the substrate, not the envelope.
- **Agent warranted:** none in the protocol layer.

**Throughline:** in seven phases, an agent is genuinely warranted in exactly three places — the `model` stage of the pipeline DAG, bid valuation under uncertainty, and the synthesis/tone work the node already does. Everything else is deterministic plumbing.

---

## 6. Working Doctrine (the methodology we adopt)

Adapted from Van Clief & McDermott's **Interpretable Context Methodology (ICM)** / **Model Workspace Protocol (MWP)** — borrowing *the discipline, not the branding*. ICM is a published design pattern (arXiv 2603.16021), a methodology/experience report, **not a controlled study**: single model family, self-selected community, no benchmark. We treat it as a well-articulated pattern for *linear, single-agent, human-reviewed* pipelines — exactly the "thin ambiguity layer on solid plumbing" we want — and we put the real foundation (content-addressing, capabilities, deterministic scripts) *under* it. We do **not** adopt it as a load-bearing framework, and we do not oversell numbered folders as architecture.

The seven rules we operationalize:

1. **The dataflow contract is a file, not code.** Every pipeline stage carries a CONTEXT.md-style contract — **Inputs** (explicit table: which file, which layer, why) / **Process** (ordered steps) / **Outputs** (named artifacts + paths). Orchestration is diffable data.
2. **Enforce the Layer-3 / Layer-4 split everywhere.** Stable reference material (voice rules, ADRs, capability policy, design system) is internalized as read-only, scoped *constraints*; per-run working artifacts are processed as *input* and never mixed in. Scoping context = smaller blast radius — this directly attacks the secret-leak incident class.
3. **Agent only where ambiguity lives; deterministic scripts for everything mechanical.** Fetching, moving files, formatting, dispatch, signing, hashing → script/binary. Reserve the LLM for genuinely ambiguous synthesis. Track token cost per stage; a 40k→4k context reduction is both a cost *and* a quality win (lost-in-the-middle degradation).
4. **The content-addressed store is the state machine.** ICM says "system state IS the filesystem." We go one better, aligned to our content-addressing bias: stage outputs are content-addressed blobs; the pipeline is a Merkle DAG of `output→input` edges. ICM's auditability/portability *plus* tamper-evidence, dedup, and mesh-pinnability.
5. **Every intermediate output is an inspectable, signable edit surface.** Plain-text, git-diffable artifacts at every boundary; HITL gates are mandatory; *who* may advance past a gate is a **capability token, not ambient permission.**
6. **One stage, one job; plain text as the universal interface.** Compose workers as Unix-style do-one-thing units reading/writing plain artifacts — independently testable, swappable, mesh-distributable.
7. **Borrow discipline, not branding.** Implement the contracts, the layer split, the determinism boundary, and content-addressed state. Do not make ICM a framework, and do not let "agentic" redefine the plumbing.

This composes cleanly with the lab consensus that arrived at the same conclusion from the other direction — Anthropic's *don't build an agent when a workflow suffices*, Manus's filesystem-as-context, Cognition's *sub-agents isolate context, they aren't an org chart*. ICM is the small-practitioner echo; the substrate is ours.

---

## 7. Open Questions for the Operator

1. **Subtraction order vs. launch pressure.** Phase 0 (honesty matrix) and Phase 1 (subtraction) ship no new capability — they make the system *honest and cheaper*. Do we hold the public launch until Phase 0–2 land, or launch on the honest matrix *now* and refactor in the open (the changelog-as-trust pattern)?
2. **Pipeline engine as spine — how aggressive?** Re-expressing the live chat path as pipeline stages (refactor #1) is the biggest token win but touches the one path that is currently LIVE. Big-bang rewrite behind a flag, or incremental stage-by-stage with the loopback collapse first?
3. **Economy: on-chain or never?** L5 is off-chain accounting today. Is on-chain settlement (x402/Solana) actually North-Star-necessary, or is metered off-chain accounting with signed receipts sufficient for a sovereign mesh — keeping us out of the on-chain regulatory/complexity surface entirely?
4. **Second mesh node: who/where?** Phase 4 requires a real, *trusted* second node — the thing that has never existed. Is it a second VPS we control, an operator device via Taildrop-delivered ghost-node bundle, or the first external participant? The trust-establishment ceremony differs for each.
5. **Public surface timing.** Product repos currently hold OLD pre-carve source; the IP posture is A+B (BSL 1.1 on published code, learning/economic MOAT private). The honesty matrix wants to be public; the carved code is not yet re-populated. Which gates which — does the matrix go public on `docs.` before the repos do?
6. **Naming the namespace.** Delegated naming (Agent Cards at `/.well-known/`) implies a root authority and a delegation scheme. Do we anchor it to DNS (`efficientlabs.ai` zone) initially, or go DHT-native from day one, accepting the bootstrap-trust problem?
7. **WASI sandbox dependency.** Phase 5's untrusted-skill isolation assumes a WASI/Wasm host with preopens. Is that an acceptable new runtime dependency on every sovereign node, or does it raise the node's minimum footprint above the local-first bar we want to keep?

---

*The synthesis, in one line:* Atmosphere becomes "the new internet for an agentic world" not by building a better AI wrapper, but by re-founding the substrate on proven invariants — content-addressed, capability-secured, DHT-meshed, supervision-reliable, end-to-end-sovereign — and letting the agent be the thin, replaceable layer where genuine ambiguity actually lives. We already have most of the substrate. The work is to subtract the glue, wire the real layers, and never claim what we have not proven.

---

## Companion research (the layers beneath this synthesis)
- [`docs/research/cs-lineage.md`](docs/research/cs-lineage.md) — the rigorous CS / internet / AI lineage (Unix → actors → end-to-end → Merkle/content-addressing → POLA → DHT → agent protocols), architects + why each idea lasted + what Atmosphere inherits.
- [`docs/research/methodology-icm-mwp.md`](docs/research/methodology-icm-mwp.md) — Jake Van Clief's ICM / Model Workspace Protocol, the broader context-engineering movement (Anthropic / Manus / Cognition), and the 7 rules we adopt (discipline, not branding).
- [`docs/research/website-information-architecture.md`](docs/research/website-information-architecture.md) — dev-brand + subdomain IA + the file-architecture-first site stack (MD/MDX as source of truth, SSG-compiled, status-matrix public).
- [`STATE_OF_REALITY.md`](STATE_OF_REALITY.md) — the authoritative real-vs-mock status this whole document is anchored to.
