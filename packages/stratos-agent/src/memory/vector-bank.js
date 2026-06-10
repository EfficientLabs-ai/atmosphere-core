import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, FixedSizeList, Float32, Utf8 } from 'apache-arrow';

// nomic-embed-text produces 768-dim embeddings with an 8k context (handles full
// code/doc chunks without truncation, unlike all-minilm's 256-token limit).
export const VECTOR_DIM = 768;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';

/**
 * Real semantic embedding via the local Ollama embedding model (all-minilm, 384-dim).
 * This makes vector search genuinely semantic. If the embedding model is unreachable
 * it falls back to a deterministic (non-semantic) char-hash so the pipeline never
 * crashes — but a warning is logged because retrieval quality degrades in that mode.
 */
export async function generateEmbedding(text) {
  const input = (text || '').toString().slice(0, 8000);
  if (!input.trim()) return new Array(VECTOR_DIM).fill(0);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: input })
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.embedding) && data.embedding.length === VECTOR_DIM) {
        return normalizeVec(data.embedding); // unit-length → L2 distance lands in [0,2], makes thresholds meaningful
      }
    }
    console.warn(`⚠️ [Embeddings] Unexpected response from ${EMBED_MODEL}; using non-semantic fallback.`);
  } catch (err) {
    console.warn(`⚠️ [Embeddings] Local embed model unreachable (${err.message}); using non-semantic fallback.`);
  }
  return fallbackEmbedding(input);
}

/** Normalize a vector to unit length so cosine/L2 distances are comparable. */
function normalizeVec(v) {
  let s = 0; for (const x of v) s += x * x;
  const m = Math.sqrt(s) || 1;
  return v.map(x => x / m);
}

/** Deterministic, NON-semantic char-hash projection. Legacy fallback only. */
function fallbackEmbedding(text) {
  const vector = new Float32Array(VECTOR_DIM);
  for (let idx = 0; idx < text.length; idx++) {
    const charCode = text.charCodeAt(idx);
    const hashIdx = (charCode * (idx + 13)) % VECTOR_DIM;
    vector[hashIdx] += Math.sin(charCode + idx) * 0.55;
  }
  let sumSq = 0;
  for (let idx = 0; idx < VECTOR_DIM; idx++) sumSq += vector[idx] * vector[idx];
  const magnitude = Math.sqrt(sumSq) || 1;
  for (let idx = 0; idx < VECTOR_DIM; idx++) vector[idx] /= magnitude;
  return Array.from(vector);
}

let dbInstance = null;

/**
 * Returns a connected LanceDB database handle.
 */
export async function getDatabase() {
  if (dbInstance) return dbInstance;
  
  // Connect to the verified sovereign workspace vector directory
  dbInstance = await lancedb.connect('./.stratos-vector-store');
  return dbInstance;
}

/**
 * Initializes the three core triple-layer schema tables if they do not exist.
 */
export async function initializeMemorySchema() {
  const db = await getDatabase();
  const tableNames = await db.tableNames();

  // 1. Ambient Memory Schema definition
  if (!tableNames.includes('ambient_memory')) {
    const ambientSchema = new Schema([
      new Field('timestamp', new Utf8()),
      new Field('source', new Utf8()),
      new Field('content', new Utf8()),
      new Field('vector', new FixedSizeList(VECTOR_DIM, new Field('item', new Float32()))),
      new Field('tags', new Utf8())
    ]);
    await db.createEmptyTable('ambient_memory', ambientSchema);
    console.log('✅ Created Table: ambient_memory');
  }

  // 2. Cognitive Skills Schema definition
  if (!tableNames.includes('cognitive_skills')) {
    const skillsSchema = new Schema([
      new Field('skill_id', new Utf8()),
      new Field('trigger_intent', new Utf8()),
      new Field('vector', new FixedSizeList(VECTOR_DIM, new Field('item', new Float32()))),
      new Field('ast_graph', new Utf8()),
      new Field('success_rate', new Float32()),
      new Field('context_tag', new Utf8())
    ]);
    await db.createEmptyTable('cognitive_skills', skillsSchema);
    console.log('✅ Created Table: cognitive_skills');
  }

  // 3. Intercepted Reasoning Schema definition
  if (!tableNames.includes('intercepted_reasoning')) {
    const reasoningSchema = new Schema([
      new Field('prompt_hash', new Utf8()),
      new Field('model_source', new Utf8()),
      new Field('reasoning_trace', new Utf8()),
      new Field('vector', new FixedSizeList(VECTOR_DIM, new Field('item', new Float32()))),
      new Field('context_tag', new Utf8())
    ]);
    await db.createEmptyTable('intercepted_reasoning', reasoningSchema);
    console.log('✅ Created Table: intercepted_reasoning');
  }

  // EFL-003 migration: tables created before the channel-isolation fix lack the `context_tag`
  // column. Add it (default '' = global) so the live daemon's store self-migrates on boot —
  // channel-tagged inserts/queries then work without losing any learned skills or traces.
  for (const t of ['cognitive_skills', 'intercepted_reasoning']) {
    if (!tableNames.includes(t)) continue; // a table freshly created above already has the column
    try {
      const table = await db.openTable(t);
      const fields = (await table.schema()).fields.map((f) => f.name);
      if (!fields.includes('context_tag')) {
        await table.addColumns([{ name: 'context_tag', valueSql: "''" }]);
        console.log(`✅ Migrated ${t}: added context_tag (EFL-003 channel isolation)`);
      }
    } catch (e) {
      console.warn(`⚠️ context_tag migration on ${t} skipped: ${e.message}`);
    }
  }
}

// ==================== Layer 1: Ambient Memory API ====================

// Cross-channel isolation (EFL-003): when a caller passes a channel/context tag (the per-channel
// isolatedContextTag / conversationId from the chat path), restrict retrieval to rows stored under
// THAT tag OR untagged/global rows ('') — so one channel/user's data can never bleed into another's.
// A null/empty tag (internal callers like self-evolution) means "no filter" → global access preserved.
function channelClause(col, contextTag) {
  if (contextTag == null || contextTag === '') return null;
  const safe = String(contextTag).replace(/'/g, "''");
  return `${col} = '${safe}' OR ${col} = ''`;
}

export async function insertAmbientMemory({ source, content, tags = '' }) {
  const db = await getDatabase();
  const table = await db.openTable('ambient_memory');
  const vector = await generateEmbedding(content);

  const record = {
    timestamp: new Date().toISOString(),
    source,
    content,
    vector,
    tags
  };

  await table.add([record]);
  return record;
}

export async function queryAmbientMemory(queryText, limit = 5, contextTag = null) {
  const db = await getDatabase();
  const table = await db.openTable('ambient_memory');
  const queryVector = await generateEmbedding(queryText);

  let search = table.vectorSearch(queryVector).limit(limit);
  const clause = channelClause('tags', contextTag);
  if (clause) search = search.where(clause);
  return await search.toArray();
}

// ==================== Layer 2: Cognitive Skills API ====================

export async function insertCognitiveSkill({ skillId, triggerIntent, astGraph, successRate = 1.0, contextTag = '' }) {
  const db = await getDatabase();
  const table = await db.openTable('cognitive_skills');
  const vector = await generateEmbedding(triggerIntent);

  const record = {
    skill_id: skillId,
    trigger_intent: triggerIntent,
    vector,
    ast_graph: typeof astGraph === 'string' ? astGraph : JSON.stringify(astGraph),
    success_rate: parseFloat(successRate),
    context_tag: contextTag || ''
  };

  // Upsert by skill_id: a skill is identified by its id, not by row count. Without this,
  // repeated captures of the same intent (e.g. accumulating training examples) would pile
  // up duplicate rows that the night shift would each distill into conflicting skills.
  try {
    const safeId = String(skillId).replace(/'/g, "''");
    await table.delete(`skill_id = '${safeId}'`);
  } catch { /* table may have no prior row; add is still correct */ }

  await table.add([record]);
  return record;
}

/** Exact-id lookup of a single cognitive skill row (null if absent). Used to accumulate
 *  observed examples into one growing row rather than appending one-example duplicates. */
export async function getCognitiveSkillById(skillId) {
  const db = await getDatabase();
  const table = await db.openTable('cognitive_skills');
  const safeId = String(skillId).replace(/'/g, "''");
  const rows = await table.query().where(`skill_id = '${safeId}'`).limit(1).toArray();
  return rows && rows.length ? rows[0] : null;
}

export async function queryCognitiveSkill(queryText, limit = 5, contextTag = null) {
  const db = await getDatabase();
  const table = await db.openTable('cognitive_skills');
  const queryVector = await generateEmbedding(queryText);

  let search = table.vectorSearch(queryVector).limit(limit);
  const clause = channelClause('context_tag', contextTag);
  if (clause) search = search.where(clause);
  return await search.toArray();
}

// ==================== Layer 3: Intercepted Reasoning API ====================

export async function insertInterceptedReasoning({ promptHash, modelSource, reasoningTrace, contextTag = '' }) {
  const db = await getDatabase();
  const table = await db.openTable('intercepted_reasoning');
  const vector = await generateEmbedding(reasoningTrace);

  const record = {
    prompt_hash: promptHash,
    model_source: modelSource,
    reasoning_trace: reasoningTrace,
    vector,
    context_tag: contextTag || ''
  };

  await table.add([record]);
  return record;
}

export async function queryInterceptedReasoning(queryText, limit = 5, contextTag = null) {
  const db = await getDatabase();
  const table = await db.openTable('intercepted_reasoning');
  const queryVector = await generateEmbedding(queryText);

  let search = table.vectorSearch(queryVector).limit(limit);
  const clause = channelClause('context_tag', contextTag);
  if (clause) search = search.where(clause);
  return await search.toArray();
}
