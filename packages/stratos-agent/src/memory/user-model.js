/**
 * user-model.js — sovereign, 100%-local DIALECTIC USER-MODELING ("the agent that grows with you").
 *
 * THE FEATURE (most-differentiating, per the hermes-agent / openclaw scan; à la plastic-labs/Honcho):
 * the agent builds a DEEPENING THEORY OF THE USER across sessions — stable preferences, goals,
 * communication style, recurring topics — and injects that theory into its own system prompt so its
 * responses personalize over time. This is NOT a growing pile of raw facts; it is a coherent,
 * revisable MODEL that is periodically re-SYNTHESIZED from accumulated observations. That synthesis
 * step IS the dialectic: each new model SUPERSEDES the prior one (thesis → new evidence → revised
 * theory), so the profile stays concise and current instead of monotonically accreting.
 *
 * COMPLEMENTARY to fts-memory.js, by design:
 *   - fts-memory = RECALL of *what was said* (full-text turns; "what did we decide about X?").
 *   - user-model = a synthesized THEORY of *who the user is* (preferences/goals/style/topics).
 * Both reuse the same better-sqlite3 backend and the same fail-open contract; neither replaces
 * the other. The local-gateway summarizer is shared in spirit (INJECTED, never cloud).
 *
 * SOVEREIGN by construction: pure local SQLite (better-sqlite3, already a dependency), zero network
 * in the storage path. Synthesis calls the LOCAL model through an INJECTED summarizer (production
 * wires it to the api-shim gateway on 127.0.0.1 — never a cloud call).
 *
 * PRIVACY / HONESTY:
 *   - The model is a DERIVED, REVISABLE THEORY, never asserted as fact about the user. The synthesis
 *     prompt instructs the model to hedge, not overclaim, and to mark uncertainty.
 *   - STRICT per-conversation isolation: a conversation's observations and synthesized model are keyed
 *     by conversationId and NEVER read for a different conversation (the context-bleed class the
 *     red-team cared about). getUserContext(A) can never surface conv B's model.
 *   - Fully FORGETTABLE: forget(conversationId) wipes that conversation's observations AND model.
 *
 * HONEST DEGRADE: if better-sqlite3 / the db can't open, every method becomes a safe no-op (observe
 * returns false, getUserContext returns '', synthesize returns a null model) with a logged, inspectable
 * reason — we never fabricate a profile. available()/unavailableReason() report which mode we're in.
 */
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_DB = () => path.join(process.cwd(), '.stratos-user-model.db');

// Default: synthesize a fresh theory of the user every N new observations since the last synthesis.
const DEFAULT_SYNTH_EVERY = Math.max(2, parseInt(process.env.STRATOS_USER_MODEL_SYNTH_EVERY || '8', 10) || 8);
// Hard cap on the injected user-context block so it can never balloon the system prompt.
const DEFAULT_MAX_CHARS = Math.max(120, parseInt(process.env.STRATOS_USER_MODEL_MAX_CHARS || '900', 10) || 900);

let _db = null;          // better-sqlite3 handle (or null)
let _ok = false;         // is the store live?
let _reason = null;      // why the store is unavailable, if so
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
 * Open (once) the user-model db. Idempotent. Never throws into the caller — on any failure it leaves
 * the module in a clearly-degraded state. Two plain tables (no FTS5 needed): an append-only
 * `observations` log and a `models` table holding the LATEST synthesized theory per conversation.
 * @param {{dbPath?: string}} [opts]
 */
export async function initUserModel(opts = {}) {
  if (_db || _loadTried) return { available: _ok, reason: _reason };
  _loadTried = true;
  const dbPath = opts.dbPath || process.env.STRATOS_USER_MODEL_DB || DEFAULT_DB();
  const Driver = await loadDriver();
  if (!Driver) return { available: false, reason: _reason };

  try {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    _db = new Driver(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role            TEXT,
        content         TEXT NOT NULL,
        ts              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_obs_conv ON observations (conversation_id, id);
      CREATE TABLE IF NOT EXISTS models (
        conversation_id TEXT PRIMARY KEY,
        summary         TEXT NOT NULL,
        synthesized_at  INTEGER NOT NULL,
        obs_at_synth    INTEGER NOT NULL   -- observation id at the moment of synthesis (dialectic watermark)
      );
    `);
    _ok = true;
    _reason = null;
  } catch (e) {
    _reason = `could not open user-model db at ${dbPath}: ${e.message}`;
    _db = null;
    _ok = false;
  }
  return { available: _ok, reason: _reason };
}

/** Is the user-model store live? */
export function available() { return _ok; }
/** If not available, the human-readable reason (for honest logging). */
export function unavailableReason() { return _reason; }

/** Only USER turns shape the theory of the user; assistant turns are the agent's own words. */
function isUserish(role) {
  const r = String(role || '').toLowerCase();
  return r === '' || r === 'user' || r === 'human';
}

/**
 * Accrue one lightweight observation (append-only). NEVER throws — a memory failure must never break
 * the chat path (mirrors the FTS5 hook + self-evolution fail-open contract). Returns true if stored.
 * Assistant turns are intentionally skipped: the user-model is a theory of the USER, not of the agent.
 * @param {string} conversationId
 * @param {{role?:string, content:string, ts?:number}} obs
 */
export function observe(conversationId, obs) {
  try {
    if (!_db || !_ok || !conversationId || !obs) return false;
    if (!isUserish(obs.role)) return false; // only the user's own words shape the model
    const content = String(obs.content ?? '').trim();
    if (!content) return false;
    const ts = Number.isFinite(obs.ts) ? obs.ts : Date.now();
    _db
      .prepare('INSERT INTO observations (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)')
      .run(String(conversationId), String(obs.role ?? 'user'), content.slice(0, 4000), ts);
    return true;
  } catch {
    return false; // fail-open: observation accrual is best-effort, never request-fatal
  }
}

/** How many observations have accrued for a conversation (diagnostics / synthesis triggering). */
export function observationCount(conversationId) {
  if (!_db || !_ok) return 0;
  try {
    return _db.prepare('SELECT count(*) AS n FROM observations WHERE conversation_id = ?')
      .get(String(conversationId)).n;
  } catch { return 0; }
}

/** The latest synthesized model row for a conversation, or null. STRICTLY scoped by conversationId. */
function latestModelRow(conversationId) {
  if (!_db || !_ok) return null;
  try {
    return _db.prepare('SELECT * FROM models WHERE conversation_id = ?').get(String(conversationId)) || null;
  } catch { return null; }
}

/**
 * Should we re-synthesize? True when enough NEW observations have accrued since the last synthesis
 * (the dialectic cadence). Used by the wired hook to fire synthesis sparingly (every N turns), not
 * on every message — synthesis costs a local-model call.
 * @param {string} conversationId
 * @param {{every?:number}} [opts]
 */
export function shouldSynthesize(conversationId, opts = {}) {
  if (!_db || !_ok) return false;
  const every = Math.max(1, parseInt(opts.every, 10) || DEFAULT_SYNTH_EVERY);
  try {
    const total = observationCount(conversationId);
    if (total === 0) return false;
    const row = latestModelRow(conversationId);
    if (!row) return total >= 1; // never synthesized → do it once we have anything
    const newest = _db.prepare('SELECT max(id) AS m FROM observations WHERE conversation_id = ?')
      .get(String(conversationId)).m || 0;
    return (newest - (row.obs_at_synth || 0)) >= every;
  } catch { return false; }
}

/**
 * THE DIALECTIC STEP. Distill the accumulated observations for ONE conversation into a CONCISE,
 * coherent theory of the user via the INJECTED local summarizer, then SUPERSEDE the prior model with
 * it (upsert — not append). The new theory replaces the old; the profile never grows into a fact-pile.
 *
 * The summarizer is INJECTED (dependency) so the storage path stays hermetic/testable and so
 * production wires it to the LOCAL gateway — never a cloud call. If no summarizer is wired, or it
 * throws, we DEGRADE HONESTLY: the prior model is kept (never fabricated) and a reason is returned.
 *
 * @param {string} conversationId
 * @param {{ summarizer?:(args:{conversationId,observations,priorModel})=>Promise<string>|string,
 *           maxObservations?:number }} [opts]
 * @returns {Promise<{model:string|null, synthesized:boolean, available:boolean, reason?:string}>}
 */
export async function synthesize(conversationId, opts = {}) {
  if (!_db || !_ok) return { model: null, synthesized: false, available: false, reason: _reason };
  if (!conversationId) return { model: null, synthesized: false, available: true, reason: 'no conversationId' };

  // Pull the recent observations for THIS conversation only (strict isolation — keyed by id).
  const limit = Math.max(4, Math.min(200, parseInt(opts.maxObservations, 10) || 60));
  let observations, newestId, prior;
  try {
    const rows = _db.prepare(
      'SELECT id, role, content, ts FROM observations WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
    ).all(String(conversationId), limit);
    observations = rows.reverse(); // chronological for the summarizer
    newestId = observations.length ? observations[observations.length - 1].id : 0;
    prior = latestModelRow(conversationId);
  } catch (e) {
    return { model: prior?.summary ?? null, synthesized: false, available: true, reason: `read failed: ${e.message}` };
  }

  if (observations.length === 0) {
    return { model: prior?.summary ?? null, synthesized: false, available: true, reason: 'no observations yet' };
  }
  if (typeof opts.summarizer !== 'function') {
    // No summarizer wired — keep the prior theory honestly rather than invent one.
    return { model: prior?.summary ?? null, synthesized: false, available: true, reason: 'no summarizer wired' };
  }

  let summary;
  try {
    summary = await opts.summarizer({
      conversationId: String(conversationId),
      observations,
      priorModel: prior?.summary ?? null,
    });
  } catch (e) {
    // Synthesis failed — keep the prior model (never blow it away with nothing).
    return { model: prior?.summary ?? null, synthesized: false, available: true, reason: `summarizer failed: ${e.message}` };
  }

  if (typeof summary !== 'string' || !summary.trim()) {
    return { model: prior?.summary ?? null, synthesized: false, available: true, reason: 'summarizer returned empty' };
  }
  const clean = summary.trim().slice(0, 4000);

  try {
    // Dialectic upsert: the new theory SUPERSEDES the prior one (one row per conversation).
    _db.prepare(`
      INSERT INTO models (conversation_id, summary, synthesized_at, obs_at_synth)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        summary = excluded.summary,
        synthesized_at = excluded.synthesized_at,
        obs_at_synth = excluded.obs_at_synth
    `).run(String(conversationId), clean, Date.now(), newestId);
  } catch (e) {
    return { model: prior?.summary ?? null, synthesized: false, available: true, reason: `write failed: ${e.message}` };
  }
  return { model: clean, synthesized: true, available: true };
}

/**
 * The current synthesized theory for ONE conversation, capped for prompt injection. Returns '' when
 * there is no model yet or the store is degraded — NEVER another conversation's model (strict
 * isolation: the SQL is keyed by conversation_id with no fallback). Pure read; no network, no synthesis.
 * @param {string} conversationId
 * @param {{maxChars?:number}} [opts]
 * @returns {string}
 */
export function getUserContext(conversationId, opts = {}) {
  if (!_db || !_ok || !conversationId) return '';
  // Respect an explicit 0 (caller disabling injection) — only fall back to the default when unspecified.
  const parsed = parseInt(opts.maxChars, 10);
  const maxChars = Math.max(0, Number.isFinite(parsed) ? parsed : DEFAULT_MAX_CHARS);
  if (maxChars === 0) return '';
  const row = latestModelRow(conversationId);
  if (!row || !row.summary) return '';
  let s = String(row.summary).trim();
  if (s.length > maxChars) s = s.slice(0, maxChars - 1).trimEnd() + '…';
  return s;
}

/** Wipe a conversation's observations AND synthesized model (the forget contract). Fail-open. */
export function forget(conversationId) {
  if (!_db || !_ok || !conversationId) return false;
  try {
    const cid = String(conversationId);
    _db.prepare('DELETE FROM observations WHERE conversation_id = ?').run(cid);
    _db.prepare('DELETE FROM models WHERE conversation_id = ?').run(cid);
    return true;
  } catch { return false; }
}

/** Diagnostics: latest-model metadata for a conversation (no cross-conversation leakage). */
export function modelInfo(conversationId) {
  const row = latestModelRow(conversationId);
  if (!row) return { exists: false, observations: observationCount(conversationId) };
  return {
    exists: true,
    summary: row.summary,
    synthesizedAt: row.synthesized_at,
    observations: observationCount(conversationId),
  };
}

/** Close the handle (tests / shutdown). Resets module state so a fresh init can re-open. */
export function closeUserModel() {
  try { _db?.close(); } catch { /* already closed */ }
  _db = null; _ok = false; _reason = null; _loadTried = false;
}

/**
 * Build a default LOCAL-gateway summarizer bound to the api-shim completions endpoint. Kept here so
 * callers get a sovereign synthesizer without re-implementing the dialectic prompt. NOT used by tests
 * (which inject a stub). The network call lives ONLY in this opt-in helper, and only ever to
 * 127.0.0.1 — never cloud. The prompt explicitly asks for a HEDGED, REVISABLE theory (no overclaiming).
 */
export function localGatewaySummarizer({ port = process.env.PORT || 4099, model } = {}) {
  return async ({ observations, priorModel }) => {
    const transcript = observations
      .map((o) => `(${o.role || 'user'}) ${o.content}`)
      .join('\n')
      .slice(0, 6000);
    const priorBlock = priorModel
      ? `\n\nYour PRIOR model of this user (revise it — supersede, don't just append):\n${priorModel}`
      : '';
    const body = {
      messages: [
        {
          role: 'system',
          content:
            'You maintain a concise, REVISABLE theory of who this user is, derived ONLY from their own messages. ' +
            'Capture: stable preferences, goals, communication style, and recurring topics. ' +
            'Rules: be brief (a few short bullet lines). Hedge — these are tentative inferences, not facts; ' +
            'use "seems to", "tends to". Do NOT overclaim, invent demographics, or include anything not supported ' +
            'by the messages. Output ONLY the updated theory, no preamble.',
        },
        {
          role: 'user',
          content: `User messages (chronological):\n${transcript}${priorBlock}\n\nWrite the updated, concise theory of this user.`,
        },
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
