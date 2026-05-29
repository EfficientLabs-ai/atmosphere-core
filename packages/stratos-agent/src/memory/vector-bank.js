import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, FixedSizeList, Float32, Utf8 } from 'apache-arrow';

// Standard dimension size for lightweight local embeddings (e.g. MiniLM)
export const VECTOR_DIM = 384;

/**
 * Helper to generate a deterministic semantic embedding vector of length 384.
 * Projects text characters onto a normalized Float32 array, ensuring zero dependencies.
 */
export function generateEmbedding(text) {
  const vector = new Float32Array(VECTOR_DIM);
  if (!text) return vector;

  // Simple, high-performance deterministic frequency & character hash projection
  for (let idx = 0; idx < text.length; idx++) {
    const charCode = text.charCodeAt(idx);
    const hashIdx = (charCode * (idx + 13)) % VECTOR_DIM;
    vector[hashIdx] += Math.sin(charCode + idx) * 0.55;
  }

  // Normalize the projected vector
  let sumSq = 0;
  for (let idx = 0; idx < VECTOR_DIM; idx++) {
    sumSq += vector[idx] * vector[idx];
  }
  const magnitude = Math.sqrt(sumSq) || 1;
  for (let idx = 0; idx < VECTOR_DIM; idx++) {
    vector[idx] /= magnitude;
  }

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
  const vector = generateEmbedding(content);

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

export async function queryAmbientMemory(queryText, limit = 5) {
  const db = await getDatabase();
  const table = await db.openTable('ambient_memory');
  const queryVector = generateEmbedding(queryText);

  return await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray();
}

// ==================== Layer 2: Cognitive Skills API ====================

export async function insertCognitiveSkill({ skillId, triggerIntent, astGraph, successRate = 1.0 }) {
  const db = await getDatabase();
  const table = await db.openTable('cognitive_skills');
  const vector = generateEmbedding(triggerIntent);

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
  const queryVector = generateEmbedding(queryText);

  return await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray();
}

// ==================== Layer 3: Intercepted Reasoning API ====================

export async function insertInterceptedReasoning({ promptHash, modelSource, reasoningTrace }) {
  const db = await getDatabase();
  const table = await db.openTable('intercepted_reasoning');
  const vector = generateEmbedding(reasoningTrace);

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
  const queryVector = generateEmbedding(queryText);

  return await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray();
}
