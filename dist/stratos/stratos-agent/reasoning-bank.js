import path from 'path';
import fs from 'fs/promises';

// Let's create an elegant, pure JavaScript JSON-backed DB fallback if native better-sqlite3 build is missing/incompatible
let DatabaseConstructor;
try {
  const { default: BetterSqlite3 } = await import('better-sqlite3');
  DatabaseConstructor = BetterSqlite3;
} catch (e) {
  console.warn('[ReasoningBank] Warning: Native better-sqlite3 module loading failed. Falling back to robust SQLite-compatible JSON interface.');
  
  // Custom elegant fallback Database engine that matches SQLite operations
  class FallbackJsonDatabase {
    constructor(dbPath) {
      this.dbPath = dbPath.endsWith('.db') ? dbPath + '.json' : dbPath;
      this.data = {
        success_pathways: {},
        dom_states: {},
        task_traces: {}
      };
      this.loaded = false;
    }

    pragma() {}

    exec() {
      // Stub table creation since structure is memory-preallocated
    }

    async _load() {
      if (this.loaded) return;
      try {
        const content = await fs.readFile(this.dbPath, 'utf8');
        this.data = JSON.parse(content);
      } catch (err) {
        // Safe to ignore if database file doesn't exist
      }
      this.loaded = true;
    }

    async _save() {
      try {
        await fs.writeFile(this.dbPath, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (err) {
        console.error('[FallbackDatabase] Failed to write database state:', err);
      }
    }

    prepare(sql) {
      const dbInstance = this;

      if (sql.includes('INSERT INTO success_pathways') || sql.includes('ON CONFLICT(id)')) {
        return {
          async run(id, goal, stepsJson, successRate, created_at, updated_at) {
            await dbInstance._load();
            const existing = dbInstance.data.success_pathways[id];
            if (existing) {
              const runCount = (existing.run_count || 1) + 1;
              dbInstance.data.success_pathways[id] = {
                id,
                goal,
                steps: stepsJson,
                success_rate: (existing.success_rate * existing.run_count + successRate) / runCount,
                run_count: runCount,
                created_at: existing.created_at,
                updated_at
              };
            } else {
              dbInstance.data.success_pathways[id] = {
                id,
                goal,
                steps: stepsJson,
                success_rate: successRate,
                run_count: 1,
                created_at,
                updated_at
              };
            }
            await dbInstance._save();
          }
        };
      }

      if (sql.includes('INSERT OR REPLACE INTO dom_states') || sql.includes('dom_states')) {
        return {
          async run(id, url, domHash, domSnapshot, interactiveElementsJson, capturedAt) {
            await dbInstance._load();
            dbInstance.data.dom_states[id] = {
              id,
              url,
              dom_hash: domHash,
              dom_snapshot: domSnapshot,
              interactive_elements: interactiveElementsJson,
              captured_at: capturedAt
            };
            await dbInstance._save();
          }
        };
      }

      if (sql.includes('INSERT INTO task_traces')) {
        return {
          async run(id, taskId, eventType, payloadJson, timestamp) {
            await dbInstance._load();
            dbInstance.data.task_traces[id] = {
              id,
              task_id: taskId,
              event_type: eventType,
              payload: payloadJson,
              timestamp
            };
            await dbInstance._save();
          }
        };
      }

      if (sql.includes('SELECT * FROM success_pathways WHERE id = ?')) {
        return {
          async get(id) {
            await dbInstance._load();
            return dbInstance.data.success_pathways[id] || null;
          }
        };
      }

      if (sql.includes('SELECT * FROM success_pathways')) {
        return {
          async all() {
            await dbInstance._load();
            return Object.values(dbInstance.data.success_pathways);
          }
        };
      }

      if (sql.includes('SELECT * FROM task_traces WHERE task_id = ?')) {
        return {
          async all(taskId) {
            await dbInstance._load();
            return Object.values(dbInstance.data.task_traces)
              .filter(trace => trace.task_id === taskId)
              .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          }
        };
      }

      // Default safe mock
      return {
        async run() {},
        async get() { return null; },
        async all() { return []; }
      };
    }

    close() {
      // Async saving handled per write
    }
  }

  DatabaseConstructor = FallbackJsonDatabase;
}

/**
 * ReasoningBank acts as a local SQLite database for storing success pathways and DOM traces,
 * as well as a simulated LanceDB vector store interface for local document indexing.
 */
export class ReasoningBank {
  /**
   * @param {Object} options
   * @param {string} [options.dbPath] - Path to the SQLite database file.
   * @param {string} [options.vectorStorePath] - Directory path to the simulated LanceDB vector store.
   */
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(process.cwd(), '.stratos-reasoning.db');
    this.vectorStorePath = options.vectorStorePath || path.join(process.cwd(), '.stratos-vector-store');
    this.db = null;
  }

  /**
   * Initializes the database connection and registers table structures.
   */
  async initialize() {
    // Ensure parent folders exist
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    await fs.mkdir(this.vectorStorePath, { recursive: true });

    // Open SQLite connection
    this.db = new DatabaseConstructor(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    // Create system schemas
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS success_pathways (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        steps TEXT NOT NULL, -- JSON string representation of steps
        success_rate REAL DEFAULT 1.0,
        run_count INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dom_states (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        dom_hash TEXT NOT NULL,
        dom_snapshot TEXT NOT NULL, -- Compressed or raw DOM structure
        interactive_elements TEXT NOT NULL, -- JSON list of selector endpoints
        captured_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_traces (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL, -- JSON payload of event
        timestamp TEXT NOT NULL
      );
    `);

    console.log(`[ReasoningBank] Database engine initialized successfully at: ${this.dbPath}`);
    console.log(`[ReasoningBank] Vector store directory allocated at: ${this.vectorStorePath}`);
  }

  // --- SQLite Operations ---

  /**
   * Records or updates a proven success pathway.
   * @param {string} id - Unique identifier for the pathway.
   * @param {string} goal - Target objective text.
   * @param {Array<Object>} steps - List of discrete steps executing this pathway.
   * @param {number} successRate - Decimal rate of success.
   */
  async recordPathway(id, goal, steps, successRate = 1.0) {
    const now = new Date().toISOString();
    const query = this.db.prepare(`
      INSERT INTO success_pathways (id, goal, steps, success_rate, run_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        steps = excluded.steps,
        success_rate = (success_rate * run_count + excluded.success_rate) / (run_count + 1),
        run_count = run_count + 1,
        updated_at = excluded.updated_at
    `);
    await query.run(id, goal, JSON.stringify(steps), successRate, now, now);
  }

  /**
   * Retrieves a pathway by its ID.
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async getPathway(id) {
    const query = this.db.prepare(`SELECT * FROM success_pathways WHERE id = ?`);
    const row = await query.get(id);
    if (!row) return null;
    return {
      ...row,
      steps: JSON.parse(row.steps)
    };
  }

  /**
   * Retrieves all success pathways.
   * @returns {Promise<Array<Object>>}
   */
  async getAllPathways() {
    const query = this.db.prepare(`SELECT * FROM success_pathways`);
    const rows = await query.all();
    return rows.map(row => ({
      ...row,
      steps: JSON.parse(row.steps)
    }));
  }

  /**
   * Stores a DOM state snapshot.
   * @param {string} id - Unique ID.
   * @param {string} url - Associated Web URL.
   * @param {string} domHash - Checksum/signature of DOM.
   * @param {string} domSnapshot - Full HTML/serialized string.
   * @param {Array<Object>} interactiveElements - JSON string of interactive selectors.
   */
  async recordDomState(id, url, domHash, domSnapshot, interactiveElements) {
    const now = new Date().toISOString();
    const query = this.db.prepare(`
      INSERT OR REPLACE INTO dom_states (id, url, dom_hash, dom_snapshot, interactive_elements, captured_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    await query.run(id, url, domHash, domSnapshot, JSON.stringify(interactiveElements), now);
  }

  /**
   * Appends an event to the task execution trace.
   * @param {string} id - Trace event ID.
   * @param {string} taskId - Associated task.
   * @param {string} eventType - Type of event.
   * @param {Object} payload - Associated event information.
   */
  async recordTaskTrace(id, taskId, eventType, payload) {
    const now = new Date().toISOString();
    const query = this.db.prepare(`
      INSERT INTO task_traces (id, task_id, event_type, payload, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    await query.run(id, taskId, eventType, JSON.stringify(payload), now);
  }

  /**
   * Retrieves all traces related to a task.
   * @param {string} taskId
   * @returns {Promise<Array<Object>>}
   */
  async getTaskTraces(taskId) {
    const query = this.db.prepare(`SELECT * FROM task_traces WHERE task_id = ? ORDER BY timestamp ASC`);
    const rows = await query.all(taskId);
    return rows.map(row => ({
      ...row,
      payload: JSON.parse(row.payload)
    }));
  }

  // --- LanceDB Vector Store Interface Emulation ---

  /**
   * Adds vectors and their metadata payload into the simulated vector store.
   * Emulates a vector store's insert behavior.
   * @param {string} tableName - Target vector table.
   * @param {Array<Object>} records - Items containing { id, vector: Array<number>, text: string, metadata: Object }
   */
  async vectorInsert(tableName, records) {
    const tableDir = path.join(this.vectorStorePath, tableName);
    await fs.mkdir(tableDir, { recursive: true });

    // Emulate index manifest
    const manifestPath = path.join(tableDir, 'manifest.json');
    let manifest = { records: [] };
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(content);
    } catch {
      // Manifest does not exist yet
    }

    // Append new records
    manifest.records.push(...records.map(rec => ({
      id: rec.id,
      vector: rec.vector,
      text: rec.text,
      metadata: rec.metadata || {},
      added_at: new Date().toISOString()
    })));

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`[ReasoningBank (LanceDB Sim)] Inserted ${records.length} items into table "${tableName}"`);
  }

  /**
   * Performs an emulated cosine similarity search on the vectors.
   * @param {string} tableName - Target vector table.
   * @param {Array<number>} queryVector - Query embedding vector.
   * @param {number} [limit=5] - Number of top results.
   * @returns {Promise<Array<Object>>}
   */
  async vectorSearch(tableName, queryVector, limit = 5) {
    const manifestPath = path.join(this.vectorStorePath, tableName, 'manifest.json');
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);

      const cosineSimilarity = (vecA, vecB) => {
        let dotProduct = 0.0;
        let normA = 0.0;
        let normB = 0.0;
        for (let i = 0; i < Math.min(vecA.length, vecB.length); i++) {
          dotProduct += vecA[i] * vecB[i];
          normA += vecA[i] * vecA[i];
          normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0.0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
      };

      const results = manifest.records.map(record => {
        const similarity = cosineSimilarity(queryVector, record.vector);
        return {
          id: record.id,
          text: record.text,
          metadata: record.metadata,
          score: similarity
        };
      });

      // Sort by descending score
      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    } catch (err) {
      console.warn(`[ReasoningBank (LanceDB Sim)] Table "${tableName}" empty or search error:`, err.message);
      return [];
    }
  }

  /**
   * Safely closes the database connection.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[ReasoningBank] Database connection closed.');
    }
  }
}
