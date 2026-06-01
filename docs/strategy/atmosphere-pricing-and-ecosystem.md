# The Atmosphere — Pricing (atmospheric layers) + Open-Source Ecosystem

**Status:** STRATEGY / PROPOSAL. Pricing is benchmarked to real 2026 competitor prices (cited in the
PR/chat), themed to the brand. Ecosystem projects are real with verified licenses; **integrations are
PROPOSED, not built.** No fabricated partnerships.

## Part 1 — Pricing: "We didn't fix the cloud. We rose above it."

The brand metaphor: clouds form in the **Troposphere**; you ascend through the atmosphere to the edge
of space. The product literally lives there — **Strato**sAgent flies in the **Stratosphere**. So the
tiers ARE the atmospheric layers. We mirror the majors' *structure* ($0 / $20 / $100 / team / custom —
the proven shape) but invert the *meaning*: the money buys **convenience + compute (Lift)**, never the
right to be sovereign (that's always free and self-hostable).

| Layer | Tier | Price | Mirrors | The offer |
|---|---|---|---|---|
| 🌍 **Troposphere** | Free, forever | **$0** | ChatGPT/Claude Free | Ground level. StratosAgent local **or** BYOK (unlimited — your compute/keys). Self-host the connector layer. Join the mesh, **earn Lift**. Community skills + support. The whole product, sovereign, DIY. |
| 🛩️ **Stratosphere** | Pro | **$20/mo** | ChatGPT Plus / Claude Pro ($20) | Above the clouds — where StratosAgent flies. Turnkey connectors (managed local vault), **monthly Lift** (run bigger models on the mesh, no GPU needed), hosted skill sync, multi-device, email support. |
| 🌠 **Mesosphere** | Pro Max | **$100/mo** | ChatGPT Pro / Claude Max ($100) | Power tier. Large Lift allotment, priority scheduling, biggest models, the full federated skill library. |
| 🛰️ **Thermosphere** | Team | **$30/seat** (min 5) | Claude/OpenAI Team (~$25–30) | Shared workspace, seats, shared skills + connectors, pooled Lift, role basics. |
| 🌌 **Exosphere** | Enterprise | **Contact us** | Enterprise (custom) | The edge of space — limitless, beyond boundaries. On-prem/air-gapped, private mesh, SSO/RBAC, audit logs, **commercial license**, compliance posture (SOC 2/GDPR/HIPAA), SLA, white-label. |

- **"Lift" ⬆️ = the compute currency** — what carries your workloads higher. Free users *earn* Lift by
  contributing node capacity; paid tiers *include* a monthly Lift allotment. (Lift = mesh compute
  credits; depends on the economic layer, currently devnet-only / not real.)
- **The inversion that wins:** OpenAI/Anthropic charge you to *access* the model on *their* compute.
  We charge for *convenience + borrowed mesh compute* — you can always run free on your own hardware.
  Sovereignty is never behind the paywall. That's the moat the $20 anchor can't copy.
- **Taglines:** *"You've been living in the cloud. Come up for air."* · *"The cloud is a ceiling. The
  Atmosphere is the sky."* · *"We left the cloud. We built the Atmosphere."*

## Part 2 — The open-source ecosystem that plugs into the Atmosphere
Everything below is real + license-verified. The thesis: **the Atmosphere becomes the sovereign fabric
that orchestrates the best open-source AI infra** — value for users, devs, AND data centers / clouds /
frontier labs (they monetize idle compute by joining; everyone benefits from a shared, verified mesh).

### A. Connect everything (the "one place for all your tools")
- **Composio** (MIT) — 1,000+ toolkits, OAuth vault. ✅ green-lit: embed self-hosted → keys on user HW.
- **LiteLLM** (MIT) — AI gateway to 100+ LLM providers in OpenAI format, cost tracking, load-balancing.
  Supercharges our shim: true BYOK to *everything* (OpenAI/Anthropic/Gemini/Bedrock/vLLM/local) behind
  one sovereign endpoint. **Highest-leverage add after Composio.**

### B. Build / engineer / terminal (dev + vibe-coder value)
- **OpenHands** (MIT) — AI software-engineering agent, BYO-model, already uses LiteLLM. Plug in as the
  coding/engineering brain inside StratosAgent.
- **E2B** (OSS) — sandboxed code execution for agents. Pairs with our WASI sandbox for the **sovereign
  dev environment** (run code safely on your/mesh hardware instead of a $150/mo cloud sandbox).

### C. Orchestrate compute at scale (where data centers + clouds + frontier labs benefit)
- **Ray** (Apache-2.0) — distributed compute (the engine behind io.net; used at OpenAI/Uber). The
  Atmosphere can speak Ray so a **data center's idle GPUs** or a **cloud instance** join as high-
  capacity provider nodes and monetize spare capacity.
- **SkyPilot** (Apache-2.0) — run/scale AI workloads on *any* infra (K8s, Slurm, 20+ clouds, on-prem),
  data never leaves your environment. The bridge that lets **existing infra opt into the mesh** without
  re-platforming — the partnership on-ramp for enterprises and providers.

### D. Trust + identity (the enterprise/compliance moat)
- **Sigstore** (OSS) — signing/transparency; complements our PQC skill seals.
- **SPIFFE/SPIRE** (OSS) — workload identity for zero-trust enterprise deployments.

### E. The model itself (the private moat path — keep private)
- **mergekit / unsloth / axolotl / PEFT-LoRA** (OSS) — fork+merge top open weights and fine-tune on
  the federated (opted-in, anonymized) skill corpus. This is the "our own model that gets better from
  the network" path — built **privately**, never published.

### F. Peer DePIN networks (interop / partnership candidates, NOT integrations)
Akash, io.net, Render, Bittensor — decentralized compute markets. The Atmosphere could **bridge/
federate** with these for compute liquidity. Aspirational; no partnership exists. (Several are
token/crypto-native — fits "devnet-only economic layer" caution.)

## Honest dependencies
- "Lift" / paid mesh compute needs the **economic layer** (devnet-only, not real yet).
- Every integration here is **proposed** — each is its own design → review → build.
- DePIN federation is aspirational; don't claim partnerships until they're signed.
- Pricing numbers are benchmarked proposals; validate with real prospects before locking.
