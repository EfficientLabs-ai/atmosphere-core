# Atmosphere Core / StratosAgent — Grounded Strategy

**Author:** Lead architect synthesis of six research outputs
**Date:** 2026-05-31
**Authority:** Subordinate to `docs/STATE_OF_REALITY.md` (the honest internal audit). Where this doc and a "Phase N 100% PASSED" report disagree, STATE_OF_REALITY wins.
**Verification basis:** Claims below were spot-checked against disk on 2026-05-31 — three PM2 processes online (`atmos-secure-bridge`, `stratos-agent-upstream`, `atmos-mesh-origin`); divergent PaymentEngine confirmed (70 LOC `x402-payment.js` vs 239 LOC `src/billing/payment-engine.js`); 4 license-only fork stubs in `packages/forks/`; 414 LOC `reasoning-bank.js` present; no pre-existing `docs/` dir; 5 root `.md` files.

> **A note on tone.** This document deliberately separates *what exists and runs today* from *what is aspirational or mock*. The genuine vision — local-first, sovereign, anti-surveillance P2P compute — is real and worth building toward. But several inputs that shaped earlier planning were hype-padded with fabricated-sounding metrics ("infinite context," "100% recall," "93% reduction," "legally untouchable"). Those are flagged here, not repeated. **Not legal advice anywhere in this document — see Section 6.**

---

## 1. Executive reality-check — what this actually IS today

StratosAgent / Atmosphere Core is an **early-stage, single-host sovereign AI agent** with one genuinely working path and a large amount of scaffolding around it. What actually runs: an Express interceptor (`packages/api-shim`, the renamed-worthy "bridge") that routes prompts between a **real local `qwen2.5:7b` via Ollama** and a local "frontier" stand-in (`:5001`, which serves the *same* local model), with **real LanceDB RAG** (768-dim embeddings, top-k=2 over three tables), a **working Telegram bridge** (text + voice), **real post-quantum crypto** (`@noble/post-quantum`, ML-DSA-65 + ML-KEM-768, FIPS 203/204 — no longer mock), a **WASI sandbox** with verify-before-execute skill signing, and **proven P2P transport** (Hyperswarm/hyperdht Noise connect, bidirectional data via `test-real-p2p.mjs`). What is NOT real despite appearing in the tree or in older docs: the "global supercompute mesh" (it is **one serving node** plus Ghost-Nodes running a no-op loop — the VPS is firewalled with zero public UDP, so it cannot currently be a reachable peer), the entire **economic layer** (Solana token, on-chain x402 settlement, DePIN reward harvesting, federated LoRA, "superintelligence"), the **multi-channel UX** (Slack/Discord/WhatsApp adapters are scaffold-only), and the **self-evolution generality** (the live loop learns exactly *one* skill class: deterministic integer-in/integer-out numeric transforms). In one honest sentence: **it is a secure, sovereign, local single-agent that works, wrapped in a monorepo whose structure and older docs overclaim a mesh, an economy, and a generality that do not yet exist.**

---

## 2. Real differentiators worth pressing

These are verified-in-repo and genuinely defensible. Press on these; drop everything else from the pitch.

1. **Secure-by-construction local agent.** This is the single strongest, most counterintuitive asset. The defining 2026 story for the category leader **OpenClaw** (~247K★ claimed; CVE-2026-25253 / CVSS 8.8; ~42,000 exposed unauthenticated control panels; "ClawJacked" browser-hijack; malicious-skill distribution via ClawHub) is that local-first agents shipped with **no security model and got mass-exploited**. StratosAgent already has the technical answer: real PQC, a deny-by-default WASI sandbox (no sockets/shell), and signed skills (code bytes + manifest both signed; tampered skills refused). Positioning: *"Everything OpenClaw does, minus the 42,000 exposed control panels."* Backed by real code, not marketing.
   - *Sourcing caveat:* OpenClaw star counts and CVE specifics come largely from secondary blogs with inflation incentives — treat as directionally true, not independently audited. The arXiv safety paper (2604.04759) and IBM X-Force writeups are the most credible signals the security problems are real.

2. **Real local inference, working today.** `qwen2.5:7b` via Ollama, live HTTP 200 round-trips, real Telegram bridge. Same category as Goose/OpenClaw's local story — and it actually runs. Constraint to state honestly: **CPU-only, ~100s/reply.**

3. **Real P2P transport on the Holepunch stack.** Hyperswarm/hyperdht is a credible, differentiated foundation others are only now prototyping AI sidecars against. Say *"P2P transport proven, mesh in progress"* — never "global mesh."

4. **Intellectual honesty as a moat.** `STATE_OF_REALITY.md` exists to override the codebase's own hype reports. In a field drowning in fabricated benchmarks, a vendor whose internal doc says "this is mock" is differentiated. Don't squander it by shipping inflated claims.

**True comparison set:** OpenClaw, Goose (Block → Linux Foundation AAIF, ~29K★, Apache-2.0), and Hermes Agent (Nous Research, Feb 2026, MIT — its "autonomous skill creation" directly overlaps the Night-Shift GSI idea). **Not** Devin, OpenHands (72% SWE-bench Verified — a coding-lane bar that doesn't apply here), or LangGraph/CrewAI (libraries, not products).

---

## 3. Proposed upgrades — BUILD / PARTIAL / SKIP

| Proposed upgrade | Real research basis | Hype to strip | Verdict | Reason |
|---|---|---|---|---|
| **"Pichay Protocol" — demand-paging MMU for context** | MemGPT/Letta ([arXiv:2310.08560](https://arxiv.org/abs/2310.08560)), H2O KV-eviction ([arXiv:2306.14048](https://arxiv.org/abs/2306.14048)) — both real and shipping | "infinite context", "100% recall", unsourced "93% reduction" | **PARTIAL → BUILD the MemGPT-lite core** | The shim has a **real gap today**: no conversation-history truncation/eviction. Long Telegram threads blow past qwen2.5:7b's small `num_ctx` (~8k) with no graceful degradation. Build bounded working-set + evict-to-LanceDB + page-back-on-miss (~1–2 days, inside `local-inference.js`). The "infinite/100%/93%" framing is fabricated/unreproducible — recall is bounded by retrieval quality (see "Lost in the Middle," [arXiv:2510.10276](https://arxiv.org/html/2510.10276v1)), not storage. |
| **"RANGER" — neuro-symbolic GraphRAG (AST graph + MCTS traversal)** | GraphRAG (real, mixed efficacy — [arXiv:2506.02404](https://arxiv.org/pdf/2506.02404)), AST indexing (tree-sitter, real), MCTS-over-KG ([arXiv:2503.20757](https://arxiv.org/pdf/2503.20757) — research-grade) | MCTS-as-production-retriever; "GraphRAG is a free upgrade" | **PARTIAL → BUILD lightweight AST entity index + 1-hop expansion; SKIP MCTS** | The AST-entity half is buildable and useful for a code-aware sovereign agent. But full GraphRAG is **13.4% *worse* than vanilla RAG on simple Q&A**, ~2.3× latency, ~6,000× token cost, no incremental updates. MCTS multiplies that cost with many LLM rollouts per query — fatal on a single CPU-bound 7B. Use a LightRAG-style bounded 1-hop expansion ([LightRAG](https://github.com/HKUDS/LightRAG)), gate it in `task-router.js` for code queries only, defer MCTS behind a flag like the existing `STRATOS_EVOLUTION=1`. |
| **Identity / onboarding layer** | N/A — pure product gap | none | **BUILD (P0)** | Agent currently answers "I am a personal assistant" because the configured `STRATOS_AGENT_NAME` is collected by onboarding and then **never read into the prompt**. Concrete, low-risk, high-impact. See Section 5. |
| **Verified ("anti-ClawHub") skill registry** | Existing signed-skill pipeline | none | **BUILD (P1)** | Directly counters the ClawHub malware vector that is sinking the category leader. Uniquely ours; the technical primitives already exist. |
| **Real 2-node mesh** | Proven transport; discovery unverified | "global supercompute mesh" | **BUILD (P1)** | Open DHT UDP or use Tailscale/private bootstrap, prove cross-machine discovery on a 2nd device, then PQC-sealed skill gossip. A working 2-node demo is a genuine industry-first. Until then: "mesh in progress." |
| **Headless-browser automation of paid ChatGPT/Claude subscriptions** | — | "legally untouchable" | **SKIP** | Contract breach with **active enforcement this quarter** (Anthropic banned OpenClaw harnesses April 2026). See Section 6. |
| **Scraping frontier models to train a "superintelligence"** | — | "untouchable" | **SKIP** | Highest risk on multiple independent axes; brand-destroying. See Section 6. |
| **Economic / token / DePIN / AGI narrative** | — | entire layer is mock | **SKIP (freeze)** | Legal + credibility liability while everything above it is mock. STATE_OF_REALITY already defers it. Lead with sovereignty + security, not a token. |

---

## 4. Tailscale Aperture verdict

**NOT RELEVANT — do not adopt for the mesh, and treat as counter-thesis even for the agent layer.**

Aperture is **Tailscale's AI gateway / governance product**, not a networking or relay feature. It is an egress proxy that sits *in front of LLM API calls*: centralized routing to OpenAI/Anthropic/Google without distributing keys, per-user/agent cost quotas, and pre-call PII/DLP hooks. It rides Tailscale identity but has **zero overlap** with the three things that matter to Atmosphere's transport:

- **Relay / availability HA** → stays on Hyperswarm + Tailscale **DERP**, not Aperture.
- **Public reachability without opening ports** → that's Tailscale **core** (DERP + NAT traversal) and Hyperswarm hole-punching, not Aperture.
- **Service exposure** → that's **Funnel** + **Serve**, not Aperture.

The name reads like an ingress/networking feature; it is not. Do not let it pull a relay/NAT re-architecture. The only place it's even adjacent is governing *centralized cloud-LLM* spend — which **runs directly against the local-first, anti-surveillance thesis** (routing your agent's calls through a Tailscale-hosted gateway that logs request/response and brokers provider keys is the opposite of sovereignty). File as **not relevant**, deferred-at-best. If you want reachability/HA on Tailscale, research **DERP, Funnel, Serve** — not Aperture.
Sources: [Aperture beta](https://tailscale.com/blog/aperture-public-beta), [What is Aperture](https://tailscale.com/docs/aperture/what-is-aperture).

---

## 5. Identity layer — concrete plan

**Root cause (verified on disk):** the persona is overwritten at inference time by two system prompts, **neither containing a name**: `local-inference.js:123` (`compileAugmentedPrompt`, "You are a highly intelligent, quantized open-weights assistant…", and it *strips* inbound system messages at line 142 — good anti-injection, but means identity must be server-injected) and `stratos-upstream.js:~35` ("You are the StratosAgent frontier reasoning tier…"). The onboarding wizard (`stratos-ctl.js runOnboarding`) writes `STRATOS_AGENT_NAME` to `.env.local`, but **nothing reads it**. So the name is collected and discarded.

**Plan (5 surgical edits):**

| # | File | Change |
|---|------|--------|
| New | `packages/stratos-agent/src/core/identity.js` | Single source of persona truth: `getAgentName()` (reads `STRATOS_AGENT_NAME` from env, falls back to direct `.env.local` read, default `StratosAgent`), `buildIdentityPrompt()` (honest capabilities + a **"WHAT YOU MUST NOT CLAIM AS LIVE"** block), `capabilitiesSummary()`. |
| 1 | `api-shim/src/local-inference.js` | Import identity; prepend `buildIdentityPrompt()` to the system prompt at line 123, keeping RAG/visual blocks beneath. **Primary fix.** |
| 2 | `stratos-agent/stratos-upstream.js` | Replace the "frontier reasoning tier" message (~line 35) with the identity prompt + one reasoning-depth line, so both routes answer consistently. |
| 3 | `api-shim/src/telegram-bridge.js` | Rewrite honest `/start` (line 80) using `capabilitiesSummary()`; add `/whoami` (deterministic, LLM-independent identity); add first-run auto-intro guarded by a per-chat flag in `.stratos-profile/`. **Critically: relabel the mock `/status` `/balance` `/compile` strings** (e.g. "5 Nodes Online", "0.0084 SOL") as "(sample readout)" or wire to real `os`/`pm2 jlist` data. |
| 4 | `stratos-agent/stratos-ctl.js` | After naming, print capabilities; add an honest "connecting skills/MCPs/repos/models + permission model (all opt-in, off by default)" section; default name `Stratos` → `StratosAgent`. |

**Load-bearing honesty guardrail:** without the Edit-3 relabel, the agent introduces itself honestly and then, on `/balance`, emits a fabricated "0.0084 SOL" — contradicting its own new persona. The `MUST NOT CLAIM AS LIVE` block + relabeling the mock readouts are what keep identity grounded.

---

## 6. Risk flags + de-risked path

> **THIS IS NOT LEGAL ADVICE.** This is an engineering reality-check on public ToS language and case law. Nothing here is privileged. Anyone calling a strategy "legally untouchable" is selling something — that phrase is a red flag, not a conclusion. **Before building anything in the "risky" tier below into a product, retain a real attorney practicing tech/IP litigation (CFAA, breach of contract, Lanham Act).**

| Strategy | Risk | Why |
|---|---|---|
| **(1) Reroute your OWN traffic to local models (BYOK / 127.0.0.1 proxy)** | **LOW — clearly fine** | Your software talking to your infrastructure. No third-party servers, no ToS-gated account automated. This is the sovereign core; keep building. Only caveat: honor open-weights licenses (Qwen/Llama terms) and don't misrepresent which model produced an output. |
| **(2) Headless-browser automation of a paid ChatGPT/Claude subscription to bypass API limits** | **GENUINELY RISKY — "untouchable" is wrong** | Breach of contract is near slam-dunk: hiQ/Bright Data protect *logged-OUT public* scraping; driving a paid subscription is *logged-IN*, the wrong side of that line. OpenAI ToS names "circumventing rate limits" as prohibited. **Anthropic began actively enforcing against exactly this (OpenClaw harnesses on Claude Max) in April 2026 — accounts banned right now.** Plus contributory/inducement + tortious-interference exposure, made worse by marketing copy that advertises the violating use. |
| **(3) Scrape frontier models to train a "superintelligence"** | **HIGHEST — do not build** | Named, express ToS prohibition (both OpenAI and Anthropic ban training competing models on their output) + breach of contract + IP/misappropriation exposure (NYT-v-OpenAI terrain, wrong side) + brand-destroying for an anti-surveillance firm. |

*Verification note:* "Jake Van Clief" is a real, traceable person (USMC veteran, AI educator, "Model Workspace Protocol" / folder-architecture content). **No verified connection between him and the bypass/superintelligence strategy** — his public material is about prompt/folder architecture. If that strategy was attributed to him, the attribution is unconfirmed. His claimed scale (16K members, Fortune 500 roster) and arXiv ID 2603.16021 are self-reported and unverified.

**De-risked path (what to actually ship):** (a) BYOK + own-traffic only; (b) local open-weights as default tier; (c) **no** headless automation of subscription UIs, **no** training on frontier outputs; (d) if more frontier capacity is ever needed, use the sanctioned API with the user's own key/billing — never puppet the consumer web app. This keeps the entire genuine vision intact while removing the contract-breach/inducement/IP exposure.

---

## 7. File-architecture recommendations

The monorepo (~11.5k LOC first-party JS, npm workspaces, ESM, 3 live PM2 processes) has real structural debt. **Validation rule for every step: `pm2 restart atmos-secure-bridge stratos-agent-upstream atmos-mesh-origin && pm2 logs --lines 30` — the bridge must still serve a real qwen round-trip.** Do not refactor the *logic* of anything STATE marks real (`vector-bank.js`, `quantum-crypto.js`, `self-evolution.js`, the bridge path) — only its *location*.

**Top concrete problems (verified):**
- **P1 — Divergent duplicate `PaymentEngine`.** The barrel `atmos-core/index.js:95` exports the *70-LOC* `x402-payment.js`; tests import the *239-LOC* `src/billing/payment-engine.js`. Anyone importing from the package gets untested behavior. **Single clearest must-fix.**
- **P2 — `reasoning-bank.js` doc/code disagreement.** STATE says it's "unused" but `server.js:48`, `stratos-agent/index.js:2`, `gsi-scheduler.js:3` import it. **Requires a runtime check** (does `server.js` actually use it or always fall to the mock?) before deleting. *Honestly flagged as unverified — do not delete blind.*
- **P5 — Cross-package reach-arounds.** `api-shim` deep-imports `../../../packages/stratos-agent/src/...`, bypassing barrels; brittle.
- **P7 — `brain/` (untracked, 220KB)** is the discredited "Phase N 100% PASSED" hype that STATE exists to override. Quarantine to `docs/archive/brain/` with a SUPERSEDED header; do not delete (provenance).
- **P8/P9 — Scaffold-as-component + doc sprawl.** 4 license-only `forks/` stubs, scaffold `omni-gateway/`, MOCK `sensory/`; 5 competing root `.md`s where only STATE (640 perms) is authoritative.

**Target shape:** rename `api-shim`→`bridge` (the working product), `atmos-core`→`core`, `stratos-agent`→`agent`; one concern → one home, dependency arrows inward, cross-package imports only via barrels (`@atmos/agent`, `@atmos/core`). Consolidate docs into `docs/` (this file lands there) with `docs/archive/` for superseded specs + brain. Move tests out of source into `tests/`, `forks/` out of the workspace glob, promote `ghost-node` to its own package, label every stub with a MOCK/SCAFFOLD banner.

---

## 8. Prioritized, buildable roadmap

Only real, shippable work. No mesh-economy, no token, no AGI.

### P0 — This week (correctness + identity; low risk, high value)
1. **Fix the divergent PaymentEngine (P1).** Delete `x402-payment.js`, repoint `atmos-core/index.js:95` to `src/billing/payment-engine.js`, run `test-chaos-ledger.js`. ~1 commit.
2. **Ship the identity layer (Section 5).** New `identity.js` + the 4 edits. Fixes "I am a personal assistant." Includes the honesty guardrail + relabeling mock Telegram readouts. ~1–2 days.
3. **Quarantine `brain/` + consolidate docs.** Move to `docs/archive/`, slim README pointing to `STATE_OF_REALITY.md` as source of truth. Keep 640 perm. ~1 commit.
4. **Runtime-check `reasoning-bank.js` (P2)** and reconcile doc vs code (delete-and-correct-doc, or keep-and-correct-doc). Do the check first.

### P1 — Next 2–4 weeks (real differentiators)
5. **MemGPT-lite working-set + evict-to-LanceDB** in `local-inference.js` (the real, non-hype core of "Pichay"). Build a 20-question recall eval on a long synthetic thread; **report real recall@k, claim no "100%".** ~1–2 days + eval.
6. **Verified ("anti-ClawHub") skill registry.** Productize the existing signed-skill pipeline with mandatory signing + refuse-on-tamper. The direct counter to the category leader's malware vector.
7. **Real 2-node mesh.** Tailscale/private bootstrap or open DHT UDP on a 2nd device; prove cross-machine discovery, then PQC-sealed skill gossip. Industry-first demo. Drop "global mesh" language until done.
8. **Architecture flatten (P3/P5/P7/P8/P9),** one package at a time, each gated by the PM2 round-trip check.

### P2 — Later (gated, deferred, or science projects)
9. **AST entity index + bounded 1-hop expansion** (the real core of "RANGER"), gated in `task-router.js` for code queries. **MCTS deferred behind a flag** — revisit only with a real eval showing 1-hop is insufficient *and* GPU headroom.
10. **One non-numeric skill class made fully real** (e.g. a verifiable Playwright browser-automation manifest) to demo OBSERVE→LEARN→EXECUTE beyond the integer-transform class.
11. **Frozen indefinitely:** token/DePIN/on-chain settlement/federated-LoRA/"superintelligence" (legal + credibility liability); headless subscription automation and frontier-output scraping (Section 6 — do not build).

---

*End. Source of truth for current capability remains `docs/STATE_OF_REALITY.md`. This strategy is subordinate to it.*
