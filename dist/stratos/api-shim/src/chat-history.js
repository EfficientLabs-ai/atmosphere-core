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

const DIR = path.join(process.cwd(), '.stratos-profile', 'chat-memory');
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
  state.messages.push({ role, content: String(content ?? ''), seq: state.seq++, ts: Date.now() });
  // Bound the ring. (Tier 1 Part 2 will evict the trimmed overflow to LanceDB BEFORE dropping it.)
  if (state.messages.length > MAX_RING) state.messages = state.messages.slice(-MAX_RING);
  persist(chatId, state);
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
}

export function ringStats(chatId) {
  const s = load(chatId);
  return { turns: s.messages.length, seq: s.seq, max: MAX_RING };
}
