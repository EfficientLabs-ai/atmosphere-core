/**
 * fts-memory.js — sovereign, 100%-local FULL-TEXT cross-session recall (SQLite FTS5).
 *
 * PATTERN (extracted from NousResearch/hermes-agent's "FTS5 session search with LLM summarization
 * for cross-session recall"): index every conversation turn into an FTS5 virtual table, expose a
 * keyword search ranked by bm25() with snippet() highlights, and a recall() that searches then asks
 * the LOCAL model to summarize the top hits ("what did we decide about X last week?").
 *
 * COMPLEMENTARY to vector-bank.js (LanceDB semantic RAG): FTS5 is keyword/exact recall (names, ids,
 * error strings, literal phrases) — the half-of-search that embeddings are bad at. We add it ALONGSIDE
 * the vector store, never replacing it.
 *
 * Sovereign by construction: pure local SQLite (better-sqlite3, already a dependency), zero network,
 * zero external service for the search path. The optional recall() summarizer is the local gateway.
 *
 * HONEST DEGRADE: if the linked SQLite build has no FTS5 compiled in, we do NOT fabricate results —
 * indexing becomes a no-op and search() returns [] with a logged, inspectable reason. Callers can
 * read `available()` / `unavailableReason()` to know which mode they're in.
 */
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_DB = () => path.join(process.cwd(), '.stratos-fts-memory.db');

let _db = null;            // better-sqlite3 handle (or null)
let _fts = false;          // is the FTS5 virtual table live?
let _reason = null;        // why FTS5 is unavailable, if so
let _loadTried = false;

/** Lazily load better-sqlite3. Never throws — records the reason and degrades. */
async function loadDriver() {
  try {
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    return BetterSqlite3;
  } catch (e) {
    _reason = `better-sqlite3 unavailable: ${e.message}`;
    return null;
  }
}

/**
 * Open (once) the FTS5 memory db. Idempotent. Never throws into the caller —
 * on any failure it leaves the module in a clearly-degraded state.
 * @param {{dbPath?: string}} [opts]
 */
export async function initFtsMemory(opts = {}) {
  if (_db || _loadTried) return { available: _fts, reason: _reason };
  _loadTried = true;
  const dbPath = opts.dbPath || process.env.STRATOS_FTS_DB || DEFAULT_DB();
  const Driver = await loadDriver();
  if (!Driver) return { available: false, reason: _reason };

  try {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    _db = new Driver(dbPath);
    _db.pragma('journal_mode = WAL');
  } catch (e) {
    _reason = `could not open db at ${dbPath}: ${e.message}`;
    _db = null;
    return { available: false, reason: _reason };
  }

  // Probe for FTS5 by attempting to create the virtual table. If the SQLite build lacks the
  // fts5 module this throws — we catch it and degrade honestly rather than pretending.
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        conversation_id,
        role,
        ts UNINDEXED,
        content,
        tokenize = 'unicode61'
      );
    `);
    _fts = true;
    _reason = null;
  } catch (e) {
    _fts = false;
    _reason = `FTS5 not available in this SQLite build: ${e.message}`;
  }
  return { available: _fts, reason: _reason };
}

/** Is full-text recall live? */
export function available() { return _fts; }
/** If not available, the human-readable reason (for honest logging). */
export function unavailableReason() { return _reason; }

/**
 * Sanitize a raw user query into a SAFE FTS5 MATCH expression. FTS5's query grammar treats
 * `" * : ( ) AND OR NOT NEAR ^` as operators; an unsanitized user string ("what about C:\\?" or a
 * lone double-quote) raises a syntax error or over-matches. We defuse this by tokenizing on
 * non-word characters and re-quoting each token as a literal phrase, OR-joined. Result: a query
 * that can never be a syntax error and never injects operators, while still matching the words.
 * Returns '' when nothing searchable remains (caller should treat as "no results").
 */
export function sanitizeQuery(raw) {
  if (typeof raw !== 'string') return '';
  // Split on anything that isn't a unicode letter/number/underscore. This drops every FTS5
  // operator character. Each surviving token becomes a quoted literal (double-quotes escaped).
  const tokens = raw
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 32); // bound pathological inputs
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Index one conversation turn. Append-only. NEVER throws — a memory failure must never break the
 * chat path (mirrors the self-evolution hooks' fail-open contract). Returns true if indexed.
 * @param {{conversationId:string, role:string, content:string, ts?:number}} turn
 */
export function indexTurn(turn) {
  try {
    if (!_db || !_fts || !turn) return false;
    const content = String(turn.content ?? '');
    if (!content.trim()) return false;
    const ts = Number.isFinite(turn.ts) ? turn.ts : Date.now();
    _db
      .prepare('INSERT INTO turns_fts (conversation_id, role, ts, content) VALUES (?, ?, ?, ?)')
      .run(String(turn.conversationId ?? ''), String(turn.role ?? ''), String(ts), content);
    return true;
  } catch {
    return false; // fail-open: memory accrual is best-effort, never request-fatal
  }
}

/**
 * Keyword search over indexed turns, ranked by FTS5 bm25() (lower rank = better; we return ascending).
 * @param {string} query           raw user query (sanitized internally — injection-safe)
 * @param {{limit?:number, conversationId?:string}} [opts]
 * @returns {Array<{conversationId,role,ts,content,snippet,score}>}
 */
export function search(query, opts = {}) {
  if (!_db || !_fts) return [];
  const match = sanitizeQuery(query);
  if (!match) return [];
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 8));
  try {
    // snippet(): highlights matched terms with a 12-token window. bm25(): relevance score.
    let sql = `
      SELECT conversation_id AS conversationId, role, ts, content,
             snippet(turns_fts, 3, '[', ']', ' … ', 12) AS snippet,
             bm25(turns_fts) AS score
      FROM turns_fts
      WHERE turns_fts MATCH ?`;
    const params = [match];
    if (opts.conversationId) {
      // Filter by exact conversation. Bound as a parameter — never string-concatenated.
      sql += ' AND conversation_id = ?';
      params.push(String(opts.conversationId));
    }
    sql += ' ORDER BY score ASC LIMIT ?';
    params.push(limit);
    const rows = _db.prepare(sql).all(...params);
    // ts was stored as text; surface a number for callers.
    return rows.map((r) => ({ ...r, ts: Number(r.ts) || null }));
  } catch (e) {
    // Defensive: a sanitized query should never error, but degrade rather than throw.
    _reason = `search failed: ${e.message}`;
    return [];
  }
}

/**
 * Cross-session RECALL: search the top hits, then ask the LOCAL model to summarize them into a
 * short answer. The summarizer is INJECTED (dependency) so the search path stays hermetic/testable
 * and so production wires it to the local gateway — never a cloud call.
 *
 * @param {string} query
 * @param {{ limit?:number, conversationId?:string, summarize?:(args:{query,hits})=>Promise<string>|string }} [opts]
 * @returns {Promise<{answer:string|null, hits:Array, available:boolean, reason?:string}>}
 */
export async function recall(query, opts = {}) {
  if (!_fts) return { answer: null, hits: [], available: false, reason: _reason };
  const hits = search(query, { limit: opts.limit || 6, conversationId: opts.conversationId });
  if (hits.length === 0) return { answer: null, hits: [], available: true };
  if (typeof opts.summarize !== 'function') {
    // No summarizer wired — return the raw hits honestly rather than fabricate an answer.
    return { answer: null, hits, available: true };
  }
  try {
    const answer = await opts.summarize({ query, hits });
    return { answer: typeof answer === 'string' ? answer : null, hits, available: true };
  } catch (e) {
    return { answer: null, hits, available: true, reason: `summarizer failed: ${e.message}` };
  }
}

/** Count indexed turns (optionally for one conversation) — used by status/diagnostics. */
export function count(conversationId) {
  if (!_db || !_fts) return 0;
  try {
    if (conversationId) {
      return _db.prepare('SELECT count(*) AS n FROM turns_fts WHERE conversation_id = ?').get(String(conversationId)).n;
    }
    return _db.prepare('SELECT count(*) AS n FROM turns_fts').get().n;
  } catch { return 0; }
}

/** Close the handle (tests / shutdown). Resets module state so a fresh init can re-open. */
export function closeFtsMemory() {
  try { _db?.close(); } catch { /* already closed */ }
  _db = null; _fts = false; _reason = null; _loadTried = false;
}

/** Build a default LOCAL-gateway summarizer bound to the api-shim completions endpoint.
 *  Kept here so callers get a sovereign summarizer without re-implementing the prompt. NOT used by
 *  tests (which inject a stub). Network call lives ONLY in this opt-in helper. */
export function localGatewaySummarizer({ port = process.env.PORT || 4099, model } = {}) {
  return async ({ query, hits }) => {
    const context = hits
      .map((h, i) => `[${i + 1}] (${h.role}) ${h.content}`)
      .join('\n');
    const body = {
      messages: [
        { role: 'system', content: 'You recall facts from past local conversations. Answer ONLY from the provided excerpts. If they do not contain the answer, say so plainly. Be concise.' },
        { role: 'user', content: `Question: ${query}\n\nPast conversation excerpts:\n${context}\n\nAnswer the question from these excerpts.` },
      ],
    };
    if (model) body.model = model;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  };
}
