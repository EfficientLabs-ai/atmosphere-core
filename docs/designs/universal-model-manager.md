# Design: Universal Model Manager (BYOK + local open-weights) — P1

**Status:** DRAFT for Codex Pattern-C review before implementation.
**Scope:** the CLEAN path only — per `feedback_clean_path_no_scraping`: BYOK (user's own keys →
official endpoints), local open-weights (Ollama, hardware-aware), and rerouting the user's OWN
local traffic. **Explicitly NOT**: headless automation of paid ChatGPT/Claude subscriptions,
training on frontier outputs. No fabricated metrics.
**Authority:** subordinate to STATE_OF_REALITY.md.

## Problem (verified)
`server.js /v1/chat/completions` today: `taskRouter.classify()` → local Ollama (`executeChatCompletion`)
OR a `:5001` "cloud" stand-in that is itself local-Ollama-backed. There is **no real pass-through**
to OpenAI/Anthropic/Google, and local model selection is hard-coded to `qwen2.5:7b`. The Manager
adds one resolution layer in front.

## Resolution (one function, ordered)
`resolveRoute(model, env)` → `{ kind: 'byok'|'local'|'mesh', provider?, endpoint?, model, format }`
1. **BYOK** — if `model` matches a cloud family AND that provider's key is configured:
   - `^(gpt-|o1|o3|o4|chatgpt)` → OpenAI (`OPENAI_API_KEY`) → `https://api.openai.com/v1/chat/completions`
   - `^gemini` → Google (`GEMINI_API_KEY`) → `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` (OpenAI-compatible)
   - `^claude` → Anthropic (`ANTHROPIC_API_KEY`) → `https://api.anthropic.com/v1/messages` (**different shape — needs translation; see open Q1**)
   A cloud-family model with **no** matching key → fall through to local (with a one-line notice), never error.
2. **Local open-weights** (default / `^(qwen|gemma|llama|local)` / anything else): Ollama via the
   existing local-inference path, with `selectLocalModel()`.
3. **Mesh** — deferred (flag `MODEL_MESH_ENABLED`, off): route to a mesh node. Not built in v1.

## BYOK pass-through (`routers/cloud-byok.js`)
- OpenAI + Gemini are OpenAI-compatible → forward the request body mostly as-is with
  `Authorization: Bearer <userKey>`; stream and non-stream both supported (pipe SSE through).
- The key is the USER's, read from env/vault, **never logged**; sent only to the official HTTPS
  endpoint. This is the user rerouting their own traffic with their own credentials = the clean path.
- On provider error/timeout: return the provider's error (do NOT silently fall to local for an
  explicit BYOK request — the user chose that provider; surfacing the error is honest). Optional
  `BYOK_FALLBACK_LOCAL=1` to fall back.

## Hardware-aware local selection (`selectLocalModel`)
- Detect capacity: `nvidia-smi` VRAM if present, else system RAM (`os.totalmem`).
- Preference tiers (configurable): `<8GB` → `qwen2.5:7b`; `≥8GB` → `gemma2:9b`; `≥18GB` → `gemma2:27b`.
- **Gate on what's actually installed:** query Ollama `/api/tags`; if the preferred tier model isn't
  pulled, fall back to the largest installed model ≤ capacity, else the configured default. On this
  CPU-only VPS this resolves to `qwen2.5:7b` (installed) — honest, no pretending gemma is there.

## Honesty / security
- Only uses keys the USER configured; forwards over HTTPS; never logs keys or prompt bodies.
- No subscription scraping, no frontier-output training (frozen — GROUNDED_STRATEGY §6).
- Local selection never claims a model that isn't pulled.

## Files
- NEW `packages/api-shim/src/model-manager.js` — `resolveRoute`, `selectLocalModel`, hardware detect (pure where possible; Ollama/`nvidia-smi` calls injected for tests).
- NEW `packages/api-shim/src/routers/cloud-byok.js` — provider pass-through (+ Anthropic adapter per Q1).
- `packages/api-shim/server.js` — call `resolveRoute` first; BYOK → passthrough; else existing local path with `selectLocalModel`.
- NEW `packages/api-shim/test-model-manager.mjs` — unit tests (resolution, key-gating, install-gating with injected probes; mocked BYOK passthrough). Live local round-trip unaffected.

## ✅ REVISED per Codex Pattern-C review (verdict: BUILD WITH CHANGES) — this section governs

**Biggest fix — the trust boundary (CRITICAL):** route resolution happens on the **RAW inbound
request body, BEFORE any local mutation** (RAG retrieval, identity injection, Tier-0 windowing).
A BYOK request forwards the **raw body only** — never the locally-mutated copy — so the user's
internal prompts/RAG context are never leaked to a third-party provider. Local routes keep doing
their mutation as today. Two separate bodies; never crossed.

**No silent substitution:** a recognized **cloud model with no configured key returns an explicit
error** (501/"provider not configured"), NOT a local qwen substitution. Opt-in `BYOK_AUTO_LOCAL=1`
allows fallback, off by default. Returning qwen for `gpt-4.1` is dishonest model substitution.

**Capability map, not regex:** an explicit `PROVIDERS` map (provider → { matches, endpoint, envKey,
streaming }) + a forced-local escape hatch (`local:` prefix or `STRATOS_FORCE_LOCAL=1`). Unknown
models default to local. v1 supports **OpenAI + Gemini only** (both OpenAI-compatible). Anthropic
deferred (its `/v1/messages` shape needs a translation adapter — separate, later).

**SSE-safe pass-through:** `fetch` the provider, read its **status + headers FIRST**; only on a 2xx
do we send `200` and pipe the body through (SSE or JSON); on a 4xx/5xx we relay the provider's
status + error body (no fake success stream). Propagate client aborts.

**Security/ops:**
- Key routes require **localhost** (the shim already binds `127.0.0.1` — assert it).
- Explicit **redaction**: scrub `Authorization`/`x-api-key`/prompt bodies/provider errors from logs.
- **Cache** the hardware probe + Ollama `/api/tags` (TTL, e.g. 60s) — never shell/HTTP-probe per request.
- One **secret resolver** (env first; `.secrets-vault` only if already trusted). No process-fail for
  optional providers; reject obviously-malformed keys at request time, not startup.
- Local auto-selected replies report the **actual concrete model** used, not the requested alias.

**Cut from v1:** the `mesh` route kind (it's off + out of scope), Anthropic translation, free-VRAM/
quantization heuristics.

### 7 required changes (all adopted)
1. Resolve from raw inbound body before any local mutation; separate raw-BYOK vs local-mutated bodies.
2. No silent cloud→local fallback; explicit error unless `BYOK_AUTO_LOCAL`. 3. Capability map +
forced-local escape hatch (not regex-only). 4. Cut `mesh` from the contract. 5. OpenAI + Gemini
raw pass-through only; defer Anthropic. 6. Enforce localhost for key routes. 7. Header/body
redaction + probe caching.

---
## Open questions for Codex (resolved above)
1. **Anthropic** in v1: include the OpenAI↔Anthropic `/v1/messages` translation (system extraction,
   `max_tokens` required, content-block mapping, response shape), or ship OpenAI+Gemini clean and add
   Anthropic next? (Risk vs. completeness — Claude is the operator's stated provider.)
2. Hardware detection: `nvidia-smi` + RAM heuristic enough, or also consider quantization/free VRAM
   (not just total)? Keep it a *preference* gated by installed models regardless?
3. Streaming pass-through for BYOK: pipe the provider SSE straight through, or parse/re-emit? (Latency
   + correctness.)
4. BYOK error behavior: surface provider errors (chosen here) vs. auto-fallback to local? Default off?
5. Where do keys come from — env only, or also the `.secrets-vault`? And should the Manager refuse to
   start a BYOK route if the key looks malformed (fail-fast vs. let the provider 401)?
