/**
 * memory-manager.js — MemGPT-lite layered context (P1), Tier 0.
 *
 * Tier 0 is a PURE, side-effect-free window planner (this file). It fixes the acute bug where the
 * Ollama call used the 2048 default context, and it bounds long histories WITHOUT ever truncating
 * the latest user message — keeping whole user/assistant exchange blocks newest-first within a
 * derated token budget. No persistence, no embedding, no I/O — safe for ANY caller.
 *
 * Tier 1 (persistent evict→LanceDB + relevance recall) lives separately and is gated on a stable
 * conversationId + append-only ordering (see docs/designs/memgpt-lite-memory.md). Per the Codex
 * Pattern-C review: persistent memory without a stable identity corrupts behavior silently, so it
 * is intentionally NOT done here.
 */

// Default model context budget. qwen2.5:7b supports 32768; we cap at 8192 for CPU latency.
// Overridable via env. Tier 0 plans against a DERATE of this (never 100%) + a response reserve.
export const MODEL_NUM_CTX = Math.max(2048, parseInt(process.env.MODEL_NUM_CTX || '8192', 10) || 8192);
const DEFAULT_DERATE = 0.72;          // never plan against the full window
const DEFAULT_RESPONSE_RESERVE = 512; // tokens kept free for the model's reply

/** Cheap, deterministic token estimate (no tokenizer dependency in v1). Intentionally approximate. */
export function estimateTokens(text) {
  return Math.ceil((typeof text === 'string' ? text.length : 0) / 4);
}

/**
 * Plan the message window that fits the budget. PURE.
 * Invariants (Codex review): always keep the latest user message; keep WHOLE exchange blocks
 * (a user message + its following assistant/tool turns) newest-first; never exceed the derated
 * budget except to honor "keep the latest block".
 *
 * @returns {{ compiledMessages: Array, stats: Object }}
 */
export function planWindow({ systemPrompt, messages = [], numCtx = MODEL_NUM_CTX, responseReserve = DEFAULT_RESPONSE_RESERVE, derate = DEFAULT_DERATE }) {
  const budget = Math.max(256, Math.floor(numCtx * derate) - responseReserve);
  const sysTokens = estimateTokens(systemPrompt);
  const available = Math.max(0, budget - sysTokens);

  // Group non-system messages into exchange blocks: each user message starts a block; following
  // assistant/tool messages attach to it. Preserves chronological adjacency.
  const convo = messages.filter((m) => m && m.role !== 'system');
  const blocks = [];
  for (const m of convo) {
    if (m.role === 'user' || blocks.length === 0) blocks.push([m]);
    else blocks[blocks.length - 1].push(m);
  }

  // Keep newest blocks within `available`; ALWAYS keep the last (most recent) block.
  const kept = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const blk = blocks[i];
    const cost = blk.reduce((a, m) => a + estimateTokens(m.content), 0);
    const isLast = i === blocks.length - 1;
    if (isLast || used + cost <= available) {
      kept.unshift(blk);
      used += cost;
    } else {
      break; // older blocks don't fit — stop (keep the most-recent contiguous window)
    }
  }

  const keptMsgs = kept.flat();
  const compiledMessages = [{ role: 'system', content: systemPrompt }, ...keptMsgs];
  return {
    compiledMessages,
    stats: {
      numCtx, budget, sysTokens, historyTokens: used,
      blocksTotal: blocks.length, blocksKept: kept.length, blocksEvicted: blocks.length - kept.length,
      evictedBlocks: blocks.slice(0, blocks.length - kept.length), // Tier 1 would persist these
    },
  };
}
