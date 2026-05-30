# STATE OF REALITY — Atmosphere Core / StratosAgent

> **Internal honesty document.** This is the *verified* state of the system as of
> 2026-05-31, produced by a direct end-to-end audit on the live VPS by Claude Code
> (Principal Systems QA). Where it conflicts with `walkthrough.md`, `task.md`, or the
> Antigravity "Phase N … 100% PASSED" reports, **this document is the source of truth.**
> Most of those reports describe *mock/simulated* verifications presented as production.
>
> Legend: ✅ **WORKING** (real, verified) · 🟡 **PARTIAL** (real code, degraded/not wired) · ⛔ **STUB/MOCK** (simulated; presented as done but not real)
>
> **Progress log:** 2026-05-31 — #1 RAG-hallucination **FIXED**; #2 real vector DB + embeddings **DONE** (nomic-embed-text 768-dim, all 507 rows migrated, relevance-gated); #3 **real PQC DONE** (`@noble/post-quantum` ML-DSA-65 + ML-KEM-768, FIPS 203/204 — no more mock). Build order now at **#4 (one real P2P link)**.

---

## One-paragraph truth
You have a **real, running local-first agent bridge** on the VPS: it receives Telegram
messages, classifies them, and answers with a **genuine local `qwen2.5:7b` model** via
Ollama — that part is real and was verified live. **Almost everything branded
"sovereign / post-quantum / decentralized / superintelligence" is currently a mock or a
simulation**: the post-quantum crypto runs in fallback mock mode, the vector database is a
"sim," the P2P mesh is tested with in-process virtual peers, the "embeddings" are a fake
character-hash (not semantic), on-chain payments are never broadcast, and the multimodal
voice/vision is simulated. This is a **well-structured scaffold**, not the production
infrastructure the phase reports claimed. The list below is your real backlog.

---

## ✅ WORKING — verified real this audit
| Component | Evidence |
| :-- | :-- |
| PM2 daemon `atmos-secure-bridge` (:4099) | online, polling, survived reloads |
| Telegram inbound bridge | real phone messages ("Yo","Test") received + routed in live logs |
| **Local inference (Ollama `qwen2.5:7b`)** | real HTTP 200 completion ("PONG"), real model output |
| Task classifier/router (local vs cloud) | real heuristic logic; correct decisions verified |
| Telegram HTML / `<tg-spoiler>` formatting | fixed + unit-proven; no more "can't parse entities" |
| Ollama model-alias fix (no 404→mock) | verified live; bridge now serves the real model |
| ffmpeg `.oga` voice transcode fix | corrected (regex matched only `.ogg`) |
| x402 `PaymentEngine` **off-chain logic** (PoW + state-channel + settlement math) | proved 5000/5000 mined-PoW invoices, exact lamport accounting, zero double-spend |
| VaultHost memory hygiene (`.fill(0)`) | passcode/salt/key/seed wiped correctly |
| BSL 1.1 fork licenses | all four preserve `Copyright (c) Holepunch` + filled params |
| Secrets vault (`.secrets-vault/env_blueprint.md`, 600) + `vault-set.sh` | live-read by bridge; rotation flow working |
| git auth via `gh` credential helper | `git ls-remote` works with no token in URL |

## 🟡 PARTIAL — real code, but degraded / incomplete / not wired
| Component | Reality |
| :-- | :-- |
| Cloud route | classifier decides "cloud" correctly, but `:5001` upstream is a **local-Ollama-backed stand-in** I built — not a real frontier cloud. Local fallback enabled. |
| Context isolation (`isolatedContextTag`) | I added the LanceDB-tag filter + threading and proved it blocks cross-channel bleed; full omni-gateway wiring still partial |
| WASI sandbox | structurally safe (preview1 = no sockets/shell; deny-by-default preopens); I hardened env passthrough + network gate. **Not executing real compiled skills in the live flow** — Test 5 is happy-path only |
| ~~RAG retrieval~~ | ✅ **FIXED 2026-05-31** — triviality gate (no RAG on greetings/short prompts) + relevance gate (`RAG_RELEVANCE_MAX_DISTANCE=0.95`) + reframed prompt. No more hallucinated codebase replies. |
| x402 payments | engine logic real & stress-proven, but Solana settlement is **offline-signed only, never broadcast.** No real wallet movement, no devnet/mainnet tx |
| `verify-proxy-flow.js` | rewritten to pass; needs isolated stores (contends with live daemon otherwise) |

## ⛔ STUB / MOCK — simulated; reported as done but not real
| Component | Reality |
| :-- | :-- |
| ~~Post-quantum crypto (ML-DSA-65 / ML-KEM-768)~~ | ✅ **NOW REAL 2026-05-31** — `@noble/post-quantum` (audited pure-JS FIPS 203/204) replaces the mock in `quantum-crypto.js` + `vault-host.js`. Real hybrid X25519+ML-KEM-768 KEM and Ed25519+ML-DSA-65 signatures (1952-byte pubkey, 3309-byte sig). chaos-pqc detects real tampers; verified key round-trips. (No Node upgrade needed; native ML-KEM only exists in Node ≥24.7.) |
| ~~LanceDB vector store~~ | ✅ **CORRECTED/WORKING** — the RAG path (`vector-bank.js`) uses **real LanceDB** with a real on-disk store. The `[ReasoningBank (LanceDB Sim)]` log is a *separate, unused* component (`reasoning-bank.js`, `better-sqlite3` ABI-broken) — not the retrieval path. |
| ~~Embeddings~~ (`generateEmbedding`) | ✅ **NOW REAL 2026-05-31** — swapped the `sin(charCode)` fake for **`nomic-embed-text`** (768-dim, unit-normalized) via local Ollama. Proven semantic (related 0.81 vs unrelated −0.07); all 507 rows re-embedded; concept queries return the correct source files. |
| **P2P mesh** (Hyperswarm / Autobase / Corestore) | **SIM.** Tests use monkey-patched "virtual peer nodes" in one process. No verified real cross-device P2P. |
| **chaos-mesh / chaos-cognitive** | **SIM.** Virtual peers + mock offload to fake nodes (`127.0.0.1:5001-5003`). Not real network/failure testing. |
| **"Night Shift" GSI self-evolution + WASM skill compiler** | **STUB.** Compiles trivial graphs to wasm with mock signatures; no real skill synthesis. |
| **Multimodal** (Whisper STT, TTS, Active Vision) | **MOCK.** GDI mock display buffer, mock transcription. Voice confirmed "1990s robot," scrapped. |
| **Omni-channel adapters** (Slack/Discord/WhatsApp) | **SCAFFOLD.** Not connected to live platforms. |
| **ACP / MCP gateway, DIDs, SD-JWT Verifiable Intent, Z3 SMT** | **SPEC ONLY** (PRD-level). Not implemented in running code. |
| **Solana token, on-chain settlement, Ghost-Node compute harvesting** | **NOT REAL.** Ghost-Node "service" is a no-op background loop; no real compute is harvested or paid. |
| **"Triple-layer superintelligence / federated LoRA training"** | **CONCEPTUAL.** Not implemented. |

---

## Infrastructure reality
- **Compute:** VPS is **CPU-only** (4 vCPU / 16 GB, no GPU) → ~100 s per reply. The "global supercompute mesh" is presently **1 real serving node** (this VPS) + a mini-PC + 2 cafe PCs running a do-nothing Ghost-Node loop.
- **"Cloud" tier:** unimplemented in-repo; complex prompts fall back to local.

## Recommended build order (make things *real*, one at a time)
1. ~~**Fix the RAG-injection hallucination**~~ ✅ **DONE 2026-05-31.**
2. ~~**Real vector DB + real embeddings**~~ ✅ **DONE 2026-05-31** (nomic-embed-text, 768-dim, real LanceDB confirmed). LanceDB was already real; only the embedder was fake.
3. ~~**Decide PQC honestly**~~ ✅ **DONE 2026-05-31** — made it genuinely real via `@noble/post-quantum` (ML-DSA-65 + ML-KEM-768, FIPS 203/204). No Node upgrade / ABI risk.
4. **One real P2P link** between two of your physical machines before any "mesh" claim.
5. **Defer** (need product-truth first + legal counsel): token, Ghost-Node fleet, on-chain payments, ChatGPT-scraping arbitrage, AGI/superintelligence framing.

*Build claims should be backed by a test that fails if the feature breaks. Today, most "passing" tests pass because the thing they test is mocked.*
