# Design: MemGPT-lite layered-context memory (P1)

**Status:** DRAFT for review (Codex Pattern-C before implementation)
**Scope:** `packages/api-shim` — bounded working-set + evict-to-LanceDB + relevance page-back.
**Authority:** subordinate to STATE_OF_REALITY.md. No "infinite context" / "100% recall" claims.

## Verified problem (runtime-checked 2026-05-31)
1. **Acute bug:** the Ollama call in `local-inference.js` sends `{model, messages, stream}` with **no `num_ctx`** → Ollama defaults to **2048 tokens** even though `qwen2.5:7b` reports `context_length: 32768`. Long inputs are silently truncated *today*.
2. **No context management:** long `messages[]` (HTTP clients send full history) are passed wholesale; nothing evicts, summarizes, or recalls.
3. **Telegram is stateless:** the bridge sends `messages: [{role:'user', content: text}]` — no per-chat history, so the agent has no memory across turns. (Companion change; MemGPT-lite needs a conversation to manage.)

## Design (lean v1)

### A. Fix `num_ctx` (separate, trivial)
Set `options.num_ctx = MODEL_NUM_CTX` (env, default **8192** — well within 32k, bounded for CPU latency) on the Ollama call. This alone is a large correctness win.

### B. `memory-manager.js` — the working set
Pure function `compactConversation({ conversationId, messages, identityPrompt, ragBlocks, budgetTokens })` → `{ compiledMessages, stats }`.

1. **Token estimate:** `ceil(chars/4)` heuristic (cheap, deterministic; no tokenizer dep in v1 — flagged as approximate).
2. **Budget split** (of `budgetTokens`, default = num_ctx − response reserve): identity + RAG fixed; **recent working-set** gets ~55%; **recalled** ~20%; **summary** ~10%; headroom rest.
3. **Keep recent:** walk `messages` newest→oldest, keep until the working-set budget is hit. The rest are "overflow".
4. **Evict overflow → LanceDB** table `conversation_memory` (conversationId, turnIndex, role, content, vector, ts). Idempotent by (conversationId, turnIndex). Only evict turns not already stored.
5. **Recall (relevance page-fault):** embed the latest user message, vector-search `conversation_memory` WHERE conversationId, top-k (default 3) with a distance gate; inject as a `[Recalled from earlier in this conversation]` block. This is the "page fault → pin back" — relevance-gated, not guaranteed.
6. **Summary:** maintain a rolling plain-text summary of evicted turns in a `conversation_summaries` row (conversationId, summary, coveredThroughTurn). v1 update = **truncating concat** of `summary + newly-evicted role:content`, capped at the summary budget (honest: naive; a real LLM-summarize pass is a v2 flag — note it). Inject as `[Summary of earlier conversation]`.
7. **Assemble:** `[identity] + [summary?] + [recalled?] + [RAG?] + recentWorkingSet`. Strip inbound system msgs (existing anti-injection behavior preserved).

### C. Conversation identity
- HTTP: `conversationId` from an `x-stratos-conversation` header if present, else a stable hash of `(systemPrompt + first user message)`.
- Telegram: `chatId` — **requires** the bridge to (a) accumulate per-chat history and (b) pass a conversation id. Companion change `B'` (small, in telegram-bridge.js): keep a bounded in-memory ring per chatId, send it as `messages[]`, tag conversationId=chatId.

### D. Honest recall eval (`test-memory-recall.mjs`)
Build a synthetic 40–50-turn thread with a planted fact early (e.g. turn 3: "my project codename is BLUEJAY"); at the end ask "what's my project codename?". Run WITH and WITHOUT the manager. Report **recall@k** and whether the planted fact survived. Print the real number; assert improvement over the truncate-baseline, never "100%".

## Non-goals / honesty
- Not infinite context — bounded by `num_ctx` + retrieval quality (cf. "Lost in the Middle").
- v1 summary is naive (truncating concat); LLM-summarize is a flagged v2.
- Token counting is a char/4 estimate; a real tokenizer is a v2 option.
- Recall is top-k relevance-gated; misses are possible — the eval must show real numbers.

## Files
- NEW `packages/api-shim/src/memory-manager.js` (pure, testable).
- `packages/stratos-agent/src/memory/vector-bank.js`: add `conversation_memory` + `conversation_summaries` tables + insert/query/get helpers (mirror existing patterns).
- `packages/api-shim/src/local-inference.js`: set `num_ctx`; call `compactConversation` before the Ollama request.
- (companion) `packages/api-shim/src/telegram-bridge.js`: per-chat history ring + conversationId.
- NEW `packages/api-shim/test-memory-recall.mjs`.

## ✅ REVISED per Codex Pattern-C review (2026-05-31) — verdict: BUILD WITH CHANGES

The draft above is superseded by a **two-tier** architecture. Codex flagged that persistent
memory without a stable identity + append-only ordering corrupts behavior silently. So:

### Tier 0 — safe recent-window compaction (ALWAYS, any caller) + the num_ctx fix
- Set `num_ctx = MODEL_NUM_CTX` (env, default 8192), and **plan against ~72% of it** with a fixed
  response reserve (no tokenizer dep; char/4 estimate, derated).
- **Pure** `planWindow({ messages, identityPrompt, ragBlocks, budgetTokens })` → compiledMessages.
  No side effects (testable in isolation). Hard invariants: ALWAYS keep the latest user message;
  keep **whole user/assistant exchange blocks** newest-first until budget; drop recalled-memory
  blocks before dropping recent context; never plan against 100% of num_ctx.
- This alone fixes the acute 2048-token truncation for every caller. No persistence.

### Tier 1 — persistent memory + relevance recall (ONLY with a stable conversation identity)
Gated: a caller must supply an explicit `conversationId` AND guarantee append-only ordering
(monotonic exchange seq). The **Telegram bridge** provides this (chatId + a per-chat append-only
ring); arbitrary stateless HTTP clients do NOT, so they stay Tier-0-only.
- **Async** (off the hot path) persistence: on overflow, evict the overflowed **exchange blocks**
  to LanceDB `conversation_memory`, keyed by `(conversationId, exchangeSeq)` append-only.
- **Recall:** embed the latest USER message; search ONLY this conversation's evicted, **user-authored**
  content; top-k with a distance gate **and recency bias**; **dedupe** against what's already in the
  window/RAG. Inject as `[Recalled from earlier in this conversation]`.
- **No summary in v1** (Codex: a truncating concat is "actively misleading"). If needed later, an
  LLM-summarize pass is a flagged v2.

### 8 required changes (all adopted)
1. Ship the num_ctx fix immediately.  2. Require explicit conversationId for persistence; no hash
fallback.  3. Stable exchange ids / append-only contract.  4. Split pure compaction from async
persistence/recall.  5. Evict/recall exchange blocks, user-authored first, recency bias.  6. Drop
v1 summary.  7. Hard budget invariants + dedupe.  8. Eval with distractors + "fact corrected later".

### Eval (`test-memory-recall.mjs`)
Synthetic long thread with a planted fact AND a later correction (BLUEJAY → FALCON) AND distractors.
Assert: (a) Tier-0 keeps the latest exchange + never exceeds budget; (b) Tier-1 recall surfaces the
CURRENT fact (FALCON), not the stale one; (c) report real recall@k — never claim 100%.

---
## Open questions for review (resolved above by Codex)
1. Char/4 token estimate vs. a small real tokenizer — worth the dep for v1?
2. Evict-by-turn granularity vs. evict-by-block (summarize N turns at once)?
3. Should recall search ALL of a conversation's evicted turns, or also the global RAG? (Risk of cross-conversation bleed — must filter by conversationId.)
4. Naive truncating-concat summary: acceptable for v1, or is it so weak it misleads (better to omit summary than ship a bad one)?
