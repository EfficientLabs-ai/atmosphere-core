# 🌌 The Atmosphere (Atmos) — Sovereign, Local-First AI + a Real P2P Compute Mesh

> *A sovereign AI agent that runs on **your** hardware with no external API by default, post-quantum
> cryptography, and a genuinely real peer-to-peer compute mesh — plus an honest, clearly-marked roadmap
> for everything that isn't built yet.*

**StratosAgent** is a local-first AI agent. **The Atmosphere** is the P2P compute mesh it runs on. The
guiding principle of this project — and of Efficient Labs — is **honesty about what is and isn't real.**
This README leads with what is verified and working today, and marks everything aspirational as
**ROADMAP**. The authoritative, audited status of every component lives in
[`STATE_OF_REALITY.md`](./STATE_OF_REALITY.md); where any doc disagrees with it, that file wins.

---

## ✅ What's real today (verified)

- **Local sovereign agent.** StratosAgent answers from a **real local `qwen2.5:7b`** (via Ollama) — zero
  external API calls by default. It knows it is StratosAgent, runs a zero-ambient-authority permission
  model, and **remembers each conversation across turns** (durable per-chat memory, `/forget`).
- **Messaging where you are.** A real two-way **Telegram** bridge, plus **Discord, Slack, Matrix, and
  Signal** adapters — all owner-gated (deny-by-default) and secret-guarded (a pasted API key is refused,
  never forwarded to the model/logs). All connect *outward* (no inbound ports). You supply the bot
  token/number; the adapter does the rest.
- **Real hybrid post-quantum crypto.** `@noble/post-quantum` (audited, FIPS 203/204): X25519 + **ML-KEM-768**
  key agreement and Ed25519 + **ML-DSA-65** signatures. Used for the skill-execution seal and P2P identity.
- **A real cross-machine P2P mesh.** Public **Hyperswarm DHT + NAT hole-punch** (no firewall change, no open
  ports), **PQC-signed skill gossip**, **proof-of-capacity** (a node can't inflate its claimed compute), a
  **parallel job scheduler** (fan-out + aggregate), and **multi-machine HA failover** (kill the key-holder
  origin → a keyless relay takes over and work continues). Proven live across the maintainer's own three
  machines. *Honest limit: it's a real verified fleet of the operator's own hardware, not yet a large
  public fleet.*
- **Real semantic memory.** LanceDB + **`nomic-embed-text`** (768-dim) embeddings — real semantic retrieval,
  relevance-gated (no hallucinated codebase replies).
- **A local model gateway (BYOK + local).** `127.0.0.1` OpenAI/Anthropic-compatible endpoint that routes
  each request between **local open-weight models** and **your own provider key (BYOK)** — with a
  **cost/ToS approval gate** (it asks before incurring paid spend) and built-in **language auto-switch**.
- **A self-evolution loop (narrow, flag-gated).** The agent can learn a verified WASM skill for the
  **deterministic numeric-transform class** (e.g. "double 8 → 16") and serve it instead of a slow LLM
  call. Off by default; a reload changes nothing until a flag is flipped.
- **A folder-stage pipeline engine** and an **off-chain** x402 payment engine (PoW + state-channel +
  settlement *math*, stress-proven) — see the honest scope on settlement below.

Run the hermetic test suite (CI runs it on every PR, Node 20 + 22):

```bash
npm ci
npm run test:ci
```

---

## 🧭 ROADMAP — not real yet (clearly marked, so you're never misled)

These appear in the vision and in the PRD, but are **not implemented / not real** in running code today.
They are deferred deliberately (several need legal/product groundwork — see
[`docs/GROUNDED_STRATEGY.md`](./docs/GROUNDED_STRATEGY.md)):

| Area | Honest status |
| :-- | :-- |
| **On-chain settlement / Solana token / DePIN reward harvesting** | **Not real.** The payment engine's off-chain logic is real and stress-proven, but settlement is **offline-signed only, never broadcast** — no wallet movement, no devnet/mainnet tx. The "Ghost-Node" compute-harvesting service is a no-op loop. |
| **Multimodal (Whisper STT, TTS, Active Vision)** | **Mock.** No real offline speech-to-text, text-to-speech, or vision today. |
| **WhatsApp / Viber** | **Roadmap.** Needs a sovereign blind-relay (design in [`docs/roadmap/whatsapp-sovereign-relay.md`](./docs/roadmap/whatsapp-sovereign-relay.md)) — we won't fake sovereignty for a checkmark. |
| **ACP / DIDs / SD-JWT Verifiable Intent / Z3 SMT** | **Spec only** (PRD-level), not implemented in running code. |
| **"Superintelligence" / federated LoRA training** | **Conceptual** framing, not implemented. |
| **Public global compute fleet** | **Roadmap.** The mesh is real but currently spans the operator's own machines; a large public fleet (and a public proof-of-capacity gate for strangers) is future work. |

If a feature isn't in the "real today" list above, treat it as roadmap until `STATE_OF_REALITY.md` says
otherwise.

---

## 🏛️ Architecture (today's reality)

```mermaid
graph TD
    subgraph Your Node (sovereign, local-first)
        CH[Telegram / Discord / Slack / Matrix / Signal] -->|owner-gated, secret-guarded| GW[Local API Gateway :4099]
        GW -->|simple/automatable work| LI[Local open-weight model (Ollama qwen2.5:7b)]
        GW -->|heavier work, with cost-approval| BYOK[Your OWN provider key (BYOK)]
        GW --> MEM[(LanceDB semantic memory)]
    end
    subgraph The Atmosphere (real P2P mesh — operator fleet today)
        NODE[Your node] <-->|public DHT + hole-punch, PQC-signed gossip| PEERS[(Peer nodes)]
        NODE -->|proof-of-capacity + parallel scheduler + HA failover| PEERS
    end
```

The gateway is a **local** router for **your own** outbound model traffic. It does **not** intercept,
scrape, or automate any third-party subscription — that path is explicitly out of scope.

---

## 📂 Monorepo layout

```
packages/
├── atmos-core/        # P2P keyring, Hyperswarm mesh, Corestore, off-chain x402 payment engine
├── stratos-agent/     # the agent: config, memory, connectors/broker, PQC, self-evolution, pipeline
├── api-shim/          # local model gateway + channel adapters (Telegram/Discord/Slack/Matrix/Signal)
├── atmos-desktop/     # Tauri tray launcher (multimodal sensory interfaces are ROADMAP — see above)
└── maximus-telemetry/ # telemetry compose configs
scripts/
└── ci-test.mjs        # the hermetic test runner used by CI + `npm run test:ci`
```

---

## 🛡️ License

Copyright © 2026 **Efficient Labs**. See the repository's license files; the `packages/forks/*` retain
their upstream `Copyright (c) Holepunch` notices under BSL 1.1.
