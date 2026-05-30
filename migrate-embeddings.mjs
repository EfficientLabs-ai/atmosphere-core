// One-off migration: re-embed ambient_memory with the real model (nomic-embed-text, 768-dim).
// Reads existing content (intact), embeds with a small concurrency pool, then drops &
// recreates the 3 tables at the new dimension and re-inserts. Idempotent to re-run.
import { getDatabase, initializeMemorySchema, generateEmbedding } from './packages/stratos-agent/src/memory/vector-bank.js';

const CONCURRENCY = 4;
const db = await getDatabase();
const rows = await (await db.openTable('ambient_memory')).query().limit(100000).toArray();
console.log(`read ${rows.length} rows; embedding (concurrency ${CONCURRENCY})...`);

const out = new Array(rows.length);
let done = 0, fb = 0;
async function worker(start) {
  for (let i = start; i < rows.length; i += CONCURRENCY) {
    const r = rows[i];
    const v = await generateEmbedding(r.content);
    if (v.length !== 768) fb++;
    out[i] = { timestamp: r.timestamp, source: r.source, content: r.content, vector: v, tags: r.tags || '' };
    if (++done % 100 === 0) console.log(`  embedded ${done}/${rows.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, k) => worker(k)));
console.log('embeds done; recreating tables at 768-dim...');
for (const t of ['ambient_memory', 'cognitive_skills', 'intercepted_reasoning']) { try { await db.dropTable(t); } catch (e) {} }
await initializeMemorySchema();
const fresh = await db.openTable('ambient_memory');
for (let j = 0; j < out.length; j += 200) await fresh.add(out.slice(j, j + 200));
console.log(`DONE. ambient_memory rows: ${await fresh.countRows()} | non-semantic fallbacks: ${fb}`);
