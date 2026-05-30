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
      new Field('success_rate', new Float32())
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
      new Field('vector', new FixedSizeList(VECTOR_DIM, new Field('item', new Float32())))
    ]);
    await db.createEmptyTable('intercepted_reasoning', reasoningSchema);
    console.log('✅ Created Table: intercepted_reasoning');
  }
}

// ==================== Layer 1: Ambient Memory API ====================

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

  // Hard channel isolation: when a caller supplies the channel/context tag
  // (e.g. the Slack/Discord/Telegram isolatedContextTag), restrict retrieval to
  // vectors stored under that exact tag so context cannot bleed across channels.
  if (contextTag) {
    const safeTag = String(contextTag).replace(/'/g, "''");
    search = search.where(`tags = '${safeTag}'`);
  }

  return await search.toArray();
}

// ==================== Layer 2: Cognitive Skills API ====================

export async function insertCognitiveSkill({ skillId, triggerIntent, astGraph, successRate = 1.0 }) {
  const db = await getDatabase();
  const table = await db.openTable('cognitive_skills');
  const vector = await generateEmbedding(triggerIntent);

  const record = {
    skill_id: skillId,
    trigger_intent: triggerIntent,
    vector,
    ast_graph: typeof astGraph === 'string' ? astGraph : JSON.stringify(astGraph),
    success_rate: parseFloat(successRate)
  };

  await table.add([record]);
  return record;
}

export async function queryCognitiveSkill(queryText, limit = 5) {
  const db = await getDatabase();
  const table = await db.openTable('cognitive_skills');
  const queryVector = await generateEmbedding(queryText);

  return await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray();
}

// ==================== Layer 3: Intercepted Reasoning API ====================

export async function insertInterceptedReasoning({ promptHash, modelSource, reasoningTrace }) {
  const db = await getDatabase();
  const table = await db.openTable('intercepted_reasoning');
  const vector = await generateEmbedding(reasoningTrace);

  const record = {
    prompt_hash: promptHash,
    model_source: modelSource,
    reasoning_trace: reasoningTrace,
    vector
  };

  await table.add([record]);
  return record;
}

export async function queryInterceptedReasoning(queryText, limit = 5) {
  const db = await getDatabase();
  const table = await db.openTable('intercepted_reasoning');
  const queryVector = await generateEmbedding(queryText);

  return await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray();
}
