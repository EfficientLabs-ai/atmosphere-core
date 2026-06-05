/**
 * chat-history.js — per-chat append-only conversation memory for the Telegram bridge (Tier 1, Part 1).
 *
 * Today the bridge sends a single message per turn, so the agent is amnesiac across turns. This
 * gives each chat a durable, bounded, APPEND-ONLY history ring keyed by chatId — which is exactly
 * the stable identity + monotonic ordering the Codex review said persistent memory requires before
 * it's safe. Tier 1 Part 2 (evict overflow → LanceDB + relevance recall) builds on this contract.
 *
 * Disk-backed (survives bridge restarts) under .stratos-profile/chat-memory/<chatId>.json,
 * gitignored. In-memory cache avoids re-reading every turn.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as fts from '../../stratos-agent/src/memory/fts-memory.js';
import * as userModel from '../../stratos-agent/src/memory/user-model.js';

const DIR = path.join(process.cwd(), '.stratos-profile', 'chat-memory');

// Cross-session FTS5 recall is COMPLEMENTARY to the bounded in-memory ring above: the ring is the
// working set the model sees each turn; the FTS5 index is the durable, full-text-searchable record
// of EVERY turn ("what did we decide about X last week?"). Best-effort + fail-open: initialization
// is fired once, lazily, and never blocks or breaks the chat path.
let _ftsInit = null; // memoized init promise (resolves once, used to order indexing after open)
function ensureFtsInit() {
  if (!_ftsInit) {
    // Memoize; never throws into the chat path. indexTurn() is a no-op until this resolves, and a
    // no-op forever if FTS5 is unavailable in this SQLite build (honest degrade).
    _ftsInit = fts.initFtsMemory().catch(() => ({ available: false }));
  }
  return _ftsInit;
}

// DIALECTIC USER-MODEL accrual — COMPLEMENTARY to the FTS5 recall above: FTS5 indexes *what was said*;
// the user-model accrues lightweight observations and periodically SYNTHESIZES a coherent theory of
// *who the user is* (preferences/goals/style/topics), injected into the system prompt to personalize.
// Flag-gated (STRATOS_USER_MODEL; default ON) + fail-open + never awaited in the chat path — a memory
// hiccup or a slow local-model synthesis can never block or break serving. Synthesis runs only every
// N user turns (shouldSynthesize) so it costs at most one local-model call per cadence, off the hot path.
const USER_MODEL_ENABLED = process.env.STRATOS_USER_MODEL !== '0' && process.env.STRATOS_USER_MODEL !== 'false';
let _umInit = null; // memoized init promise
function ensureUserModelInit() {
  if (!_umInit) _umInit = userModel.initUserModel().catch(() => ({ available: false }));
  return _umInit;
}

const MAX_RING = Math.max(8, parseInt(process.env.CHAT_RING_MAX || '60', 10) || 60); // bounded working set
const cache = new Map(); // chatId -> { seq, messages, nextSeq }

function safeId(chatId) { return String(chatId).replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 64); }
function file(chatId) { return path.join(DIR, safeId(chatId) + '.json'); }

function load(chatId) {
  const key = String(chatId);
  if (cache.has(key)) return cache.get(key);
  let state = { seq: 0, messages: [] };
  try { state = JSON.parse(fs.readFileSync(file(chatId), 'utf8')); } catch { /* new chat */ }
  if (!Array.isArray(state.messages)) state.messages = [];
  if (typeof state.seq !== 'number') state.seq = state.messages.length;
  cache.set(key, state);
  return state;
}

function persist(chatId, state) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file(chatId), JSON.stringify(state), { mode: 0o600 });
  } catch (e) { /* memory still works in-cache if disk write fails */ }
}

/** Append a turn (append-only: seq is monotonic and never reused, even after the ring trims). */
function append(chatId, role, content) {
  const state = load(chatId);
  const text = String(content ?? '');
  state.messages.push({ role, content: text, seq: state.seq++, ts: Date.now() });
  // Bound the ring. (Tier 1 Part 2 will evict the trimmed overflow to LanceDB BEFORE dropping it.)
  if (state.messages.length > MAX_RING) state.messages = state.messages.slice(-MAX_RING);
  persist(chatId, state);
  // Accrue durable cross-session full-text memory. Fail-open + non-blocking: we index AFTER init
  // resolves (so the very first turns aren't dropped before the table exists), but we do NOT await
  // here — the chat path returns immediately. indexTurn() catches internally; the .catch covers any
  // init/import edge case. A memory hiccup can never break or slow serving.
  try {
    const cid = conversationId(chatId);
    const ts = Date.now();
    ensureFtsInit()
      .then(() => fts.indexTurn({ conversationId: cid, role, content: text, ts }))
      .catch(() => { /* best-effort: memory accrual never blocks serving */ });
  } catch { /* best-effort */ }
  // DIALECTIC user-model: accrue this turn as an observation, then (sparingly, per cadence) re-synthesize
  // the theory of the user via the LOCAL gateway. Strictly per-conversation (keyed by cid). Fail-open +
  // non-awaited: never blocks or breaks serving. Only the user's own turns shape the model (observe()
  // skips assistant turns internally). Synthesis fires at most once every N user turns.
  if (USER_MODEL_ENABLED) {
    try {
      const cid = conversationId(chatId);
      const ts = Date.now();
      ensureUserModelInit()
        .then(() => {
          userModel.observe(cid, { role, content: text, ts });
          if (userModel.shouldSynthesize(cid)) {
            return userModel.synthesize(cid, { summarizer: userModel.localGatewaySummarizer() });
          }
        })
        .catch(() => { /* best-effort: the theory of the user never blocks serving */ });
    } catch { /* best-effort */ }
  }
  return state;
}

export function appendUser(chatId, content) { return append(chatId, 'user', content); }
export function appendAssistant(chatId, content) { return append(chatId, 'assistant', content); }

/** Messages to send to the completion endpoint (role/content only; Tier 0 will window them). */
export function getMessages(chatId) {
  return load(chatId).messages.map((m) => ({ role: m.role, content: m.content }));
}

/** Stable conversation id for this chat (the persistence/recall key). */
export function conversationId(chatId) { return 'tg:' + safeId(chatId); }

/** Wipe a chat's memory (the /forget command). */
export function clear(chatId) {
  cache.delete(String(chatId));
  try { fs.unlinkSync(file(chatId)); } catch { /* already gone */ }
  // Forget the synthesized theory of the user too — /forget must leave nothing behind. Fail-open.
  try {
    const cid = conversationId(chatId);
    ensureUserModelInit().then(() => userModel.forget(cid)).catch(() => {});
  } catch { /* best-effort */ }
}

export function ringStats(chatId) {
  const s = load(chatId);
  return { turns: s.messages.length, seq: s.seq, max: MAX_RING };
}
