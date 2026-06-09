# Efficient Labs — State of the Company

> **The board.** Single source of truth for what exists, what's in flight, and what's next.
> Updated every session by the orchestrator. If you ever wonder "what's built / what's Claude doing,"
> the answer is here. Process that governs this board: [`OPERATING-MODEL.md`](OPERATING-MODEL.md).

**Last verified against disk:** 2026-06-09 (full parallel audit of all 4 repos + running services).

---

## NOW — in flight

| # | Item | Stage | Owner |
|---|---|---|---|
| 1 | Operating system stood up (OPERATING-MODEL + this board + PARALLEL runbook) | DONE | Orchestrator |
| 2 | **Comprehensive audit → [`ISSUES.md`](ISSUES.md)** — 18 issues (0 crit / 6 high / 5 med / 7 low) | DONE | Audit team |
| 3 | Codex independent full-VPS audit → issue list | RUNNING (external, Codex) | Codex |

**On deck (chosen):** merge [`ISSUES.md`](ISSUES.md) with Codex's list into one master backlog
(two-agent agreement = promote to sprint) → then **Discord/Slack integration** sprint.

**Verified-urgent from the audit (checked live against disk):** EFL-001 — `qwen2.5:7b` is **not
on the box**; agent runs `gemma2:2b` + `gemma4:e4b`. Flagship "local qwen" claim is false across
docs/doctrine/site. EFL-002 — `/vision` fabricates fake analysis on the live path. EFL-003 —
cross-channel context bleed (multi-tenant memory leak).

---

## NEXT — sequenced backlog (proposed, awaiting your pick)

Ordered by leverage. Each is one full pipeline run with a gate at the end.

1. **Wire the skill-executor into the live daemon.** Biggest "real vs claimed" gap: skills are
   built, signed, and test-verified, but the live Telegram path still LLM-calls everything instead of
   running a verified skill. Closing this makes the agent visibly *learn and execute*, not just chat.
2. **Capability-label re-audit of `status.json`.** Make the public `/status` matrix exactly match
   ground truth so the "% done" figure is defensible. (You doubted "65%" — this settles it with evidence.)
3. **Turn on one real channel end-to-end** (Discord *or* Slack), token-gated, past the dry-run
   scaffold — so "omni-channel" has one true leg, honestly labeled.
4. **Mesh: second real node serving work.** Move from "single operator, 3 machines, gossip off" to
   one node actually scheduling/serving a job, so the mesh claim has a live demonstration.
5. **Deploy gate for efficientlabs-web.** Resolve the Vercel hold; get `/status`, `/install`,
   Stripe checkout live on `efficientlabs.ai` so the public can watch the real activity feed.

---

## DONE — verified capability map (ground truth, 2026-06-09)

### atmosphere-core (private monorepo, ~17K LOC real product code)
- ✅ **Local sovereign agent** — `gemma2:2b` (fast default) + `gemma4:e4b` (chat/vision) via Ollama, answers over Telegram, remembers across turns. *Limit: CPU-only.* *(qwen2.5:7b was intentionally removed per task #43 — Gemma migration; docs still need reconciling → EFL-001.)*
- ✅ **Post-quantum crypto** — ML-DSA-65 + Ed25519 signing, ML-KEM-768 KEM (FIPS 203/204 via `@noble/post-quantum`). Skill seals + P2P identity.
- ✅ **P2P transport** — Hyperswarm + hyperdht Noise, proven across your 3 machines. *Limit: your own hardware; no public mesh yet.*
- ✅ **Semantic memory** — LanceDB + nomic-embed-text 768-dim, relevance-gated.
- ✅ **Secret-guard + cost-approval gates** — blocks key-shaped tokens; asks before cloud spend.
- ✅ **Self-evolution (narrow)** — deterministic numeric transforms learned→compiled→signed→executed. Flag-gated, off by default.
- ✅ **Folder-stage pipeline engine** — 12/12 tests, human-editable `.md` stages.
- 🟡 **x402 payment engine** — PoW + state-channel math stress-proven on 5K invoices; **no on-chain broadcast** (offline-signed only).
- 🟡 **Channel adapters** (Slack/Discord/Matrix/Signal) — instantiate, dry-run; no live tokens wired.
- 🟡 **Skill execution** — executor real + test-verified; **not wired into live daemon path.**
- ⛔ **Multimodal** (Whisper/TTS/vision) — mock buffers in `atmos-desktop/src/sensory/`.
- ⛔ **Economy** (token, on-chain settlement, DePIN rewards) — designed, intentionally deferred by legal gate.
- Tests: `npm run test:ci` → 88 hermetic test files run green locally; honest (mocked paths are labeled). Working tree `main` clean — **BUT GitHub Actions CI is RED** on the last 3 commits (Node-20 vs deps requiring Node ≥22 — Codex atmosphere-core#59, a P0). `efficientlabs-web` `honesty.yml` CI also RED (web#5). *Local-green ≠ CI-green; both must go green before "production-ready."*

### StratosAgent (PUBLIC, BSL 1.1)
- ✅ `@efficientlabs/stratos@1.1.0` on npm. README, 145 hermetic assertions, Node ≥20.19 floor. `stratos init` / `stratos complete` CLI. Capability receipts, signed skills, local-default router.

### TheAtmosphere (PUBLIC, BSL 1.1)
- ⛔ **`@efficientlabs/atmosphere-mesh-node` is NOT published** — `npm view` → 404. (My earlier audit wrongly claimed `@1.0.0`; Codex caught it, verified live.) README/docs imply availability → must publish or remove the claim (Codex TheAtmosphere#5 / web#8).
- ✅ Joins public Hyperswarm DHT (run from source via `node-runner`). Lazy-load Hyperswarm fix shipped (cross-platform). Offline PQC verify proof passes 5/5.

### efficientlabs-web (private, Vercel-linked `efficient-labs`)
- ✅ 11 substantive pages: `/`, `/pricing`, `/status`, `/install`, `/stratos`, `/architecture`, `/atmosphere`, `/docs`, `/updates`, `/login`, `/signup`, `/app`, `/ops`.
- ✅ **`/status` is genuinely live** — GitHub API, ISR `revalidate=300`, tracks all 4 repos, merges committed baseline, scrubs PII. Public repos surface within 5 min of a push.
- ✅ Supabase auth wired + env-gated (`authReady`); renders only enabled OAuth providers. Founder `/ops` HMAC-cookie gate.
- ✅ Live Stripe checkout + public install flow (`efficientlabs.ai/install.sh`).
- ✅ `/app/*` are **10 fully-built, honesty-gated preview modules** that degrade safely when signed-out (audit corrected my earlier "stubs" call — `npm run build` is green across 49 routes, honesty-guard passes 55 surfaces).
- 🟡 Not deployed with live env keys; **deploy blocker is external** — a Vercel account/email-verification hold needing Vercel support, not an engineering fix (EFL-010 / web-deploy).

### Running services (PM2)
- ✅ `atmos-secure-bridge` (:4099), `stratos-agent-upstream` (:5001, backing `gemma2:2b`), `atmos-mesh-origin` — all online. *(bridge heap ~94%, p95 ~71s under load → EFL-014, infra-hardening.)*

---

## Honesty caveats binding this board
- Mocked/dry-run/deferred items are labeled 🟡/⛔, never counted as ✅.
- No "% complete" number appears here until the `status.json` re-audit (NEXT #2) backs it with evidence.
- This board is re-verified against disk, not copied from older docs (which historically overclaimed).
