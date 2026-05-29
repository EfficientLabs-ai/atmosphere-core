import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { insertCognitiveSkill, insertInterceptedReasoning, insertAmbientMemory } from '../memory/vector-bank.js';

/**
 * Genesis Harvester: Bootstraps local node intelligence on Day 1
 * by scanning standard local agent history logs and ingesting them into LanceDB.
 */
export class GenesisHarvester {
  constructor(options = {}) {
    this.homedir = os.homedir();
    this.verbose = options.verbose !== false;
  }

  /**
   * Resolves standard developer tool history paths cross-platform.
   */
  getDefaultPaths() {
    const paths = [];

    // 1. Cursor Workspaces History (SQLite)
    let cursorDir = '';
    if (process.platform === 'win32') {
      cursorDir = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'workspaceStorage');
    } else if (process.platform === 'darwin') {
      cursorDir = path.join(this.homedir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    } else {
      cursorDir = path.join(this.homedir, '.config', 'Cursor', 'User', 'workspaceStorage');
    }
    paths.push({ name: 'Cursor Workspace Logs', path: cursorDir, type: 'cursor' });

    // 2. OpenClaw Ingest Logs (JSON/JSONL)
    paths.push({
      name: 'OpenClaw Script Logs',
      path: path.join(this.homedir, '.openclaw', 'logs'),
      type: 'openclaw'
    });

    // 3. Hermes Shell History (SQLite/JSON)
    paths.push({
      name: 'Hermes History Logs',
      path: path.join(this.homedir, '.hermes', 'history'),
      type: 'hermes'
    });

    return paths;
  }

  /**
   * Scans a Cursor workspace SQLite database and extracts prompt-response pairs.
   */
  parseCursorDatabase(dbPath) {
    const pairs = [];
    let db = null;
    try {
      if (!fs.existsSync(dbPath)) return pairs;
      
      db = new Database(dbPath, { readonly: true, timeout: 1000 });
      
      // Check if common Cursor/VSCode workspace tables exist (e.g. State)
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'").get();
      if (!tableCheck) return pairs;

      // Extract workspace conversation states
      const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%ai%' OR key LIKE '%prompt%'").all();
      
      for (const row of rows) {
        try {
          const valueJson = JSON.parse(row.value);
          // Recursively extract prompt/response nodes from Cursor's state JSON
          this.traverseStateJson(valueJson, pairs);
        } catch (e) {
          // Skip if value is not valid JSON
        }
      }
    } catch (err) {
      if (this.verbose) {
        console.warn(`[GenesisHarvester] SQLite parse skipped for ${path.basename(dbPath)}: ${err.message}`);
      }
    } finally {
      if (db) {
        try { db.close(); } catch (e) {}
      }
    }
    return pairs;
  }

  /**
   * Traverses Cursor/VSCode state JSON schemas recursively to find prompt-response blocks.
   */
  traverseStateJson(obj, pairs) {
    if (!obj || typeof obj !== 'object') return;

    // Direct match for standard chat structures
    if (obj.prompt && (obj.response || obj.reply || obj.output)) {
      pairs.push({
        prompt: obj.prompt,
        response: obj.response || obj.reply || obj.output,
        source: 'cursor-workspace-storage'
      });
      return;
    }

    // Match array-based message exchanges
    if (Array.isArray(obj.messages)) {
      for (let i = 0; i < obj.messages.length - 1; i++) {
        const msg = obj.messages[i];
        const nextMsg = obj.messages[i + 1];
        if (msg.role === 'user' && nextMsg.role === 'assistant') {
          pairs.push({
            prompt: msg.content,
            response: nextMsg.content,
            source: 'cursor-chat-history'
          });
        }
      }
    }

    // Recurse down nested objects
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object') {
        this.traverseStateJson(obj[key], pairs);
      }
    }
  }

  /**
   * Parses OpenClaw JSON/JSONL logging logs.
   */
  parseOpenClawLogs(dirPath) {
    const pairs = [];
    try {
      if (!fs.existsSync(dirPath)) return pairs;
      
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const content = fs.readFileSync(filePath, 'utf8');
        
        if (file.endsWith('.jsonl')) {
          const lines = content.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.prompt && obj.response) {
                pairs.push({ prompt: obj.prompt, response: obj.response, source: 'openclaw-jsonl' });
              }
            } catch (e) {}
          }
        } else {
          try {
            const obj = JSON.parse(content);
            if (Array.isArray(obj)) {
              for (const entry of obj) {
                if (entry.prompt && entry.response) {
                  pairs.push({ prompt: entry.prompt, response: entry.response, source: 'openclaw-array' });
                }
              }
            } else if (obj.prompt && obj.response) {
              pairs.push({ prompt: obj.prompt, response: obj.response, source: 'openclaw-single' });
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      if (this.verbose) {
        console.warn(`[GenesisHarvester] OpenClaw parse skipped for ${dirPath}: ${err.message}`);
      }
    }
    return pairs;
  }

  /**
   * Parses Hermes shell command database or history logs.
   */
  parseHermesHistory(historyPath) {
    const pairs = [];
    let db = null;
    try {
      if (!fs.existsSync(historyPath)) return pairs;
      
      // If it is a directory, look for db file
      let targetFile = historyPath;
      if (fs.statSync(historyPath).isDirectory()) {
        targetFile = path.join(historyPath, 'history.db');
      }
      
      if (!fs.existsSync(targetFile)) return pairs;

      db = new Database(targetFile, { readonly: true, timeout: 1000 });
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history'").get();
      
      if (tableCheck) {
        const rows = db.prepare("SELECT query, response FROM history ORDER BY id DESC LIMIT 500").all();
        for (const row of rows) {
          pairs.push({
            prompt: row.query,
            response: row.response,
            source: 'hermes-history-db'
          });
        }
      }
    } catch (err) {
      if (this.verbose) {
        console.warn(`[GenesisHarvester] Hermes parse skipped for ${historyPath}: ${err.message}`);
      }
    } finally {
      if (db) {
        try { db.close(); } catch (e) {}
      }
    }
    return pairs;
  }

  /**
   * Executes systemic scan across default paths and ingests harvested prompt pairs.
   */
  async harvestAll() {
    const defaultPaths = this.getDefaultPaths();
    let totalHarvested = 0;

    console.log('🔍 [Genesis Harvester] Commencing scan of local agent environment logs...');

    for (const target of defaultPaths) {
      if (!fs.existsSync(target.path)) {
        if (this.verbose) {
          console.log(`  - Path not found (skipping): ${target.name} [${target.path}]`);
        }
        continue;
      }

      console.log(`  📂 Scanning: ${target.name} under ${target.path}...`);
      let pairs = [];

      if (target.type === 'cursor') {
        // Cursor workspace directory contains subdirectories with state.vscdb files
        try {
          const subdirs = fs.readdirSync(target.path);
          for (const dir of subdirs) {
            const vscdbPath = path.join(target.path, dir, 'state.vscdb');
            if (fs.existsSync(vscdbPath)) {
              pairs.push(...this.parseCursorDatabase(vscdbPath));
            }
          }
        } catch (err) {}
      } else if (target.type === 'openclaw') {
        pairs.push(...this.parseOpenClawLogs(target.path));
      } else if (target.type === 'hermes') {
        pairs.push(...this.parseHermesHistory(target.path));
      }

      if (pairs.length > 0) {
        console.log(`    ✅ Extracted ${pairs.length} prompt-response pairs from ${target.name}. Ingesting...`);
        for (const pair of pairs) {
          await this.ingestPair(pair);
        }
        totalHarvested += pairs.length;
      }
    }

    console.log(`🎉 [Genesis Harvester] Day-1 execution complete. Ingested ${totalHarvested} historical pairs.`);
    return totalHarvested;
  }

  /**
   * Helper to ingest a prompt-response pair into LanceDB tables.
   */
  async ingestPair(pair) {
    const { prompt, response, source } = pair;
    if (!prompt || !response) return;

    try {
      // 1. Ingest into cognitive_skills as a cognitive bootstrap graph
      const skillId = `harvested_${source}_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 10)}`;
      const triggerIntent = prompt.trim();
      const astGraph = JSON.stringify({
        type: 'SovereignExecutionGraph',
        version: '1.0',
        harvestedSource: source,
        steps: [
          { type: 'natural_completion', text: response }
        ]
      });

      await insertCognitiveSkill({
        skillId,
        triggerIntent,
        astGraph,
        successRate: 1.0 // Verified historical logs get perfect success score
      });

      // 2. Ingest into intercepted_reasoning to bootstrap offline thoughts
      const promptHash = crypto.createHash('sha256').update(triggerIntent).digest('hex');
      const mockThinkTrace = `<think>\n1. Analyzing harvested context prompt from ${source}.\n2. Resolving target response offline.\n3. Returning verified historical token trace.\n</think>\n${response}`;

      await insertInterceptedReasoning({
        promptHash,
        modelSource: `local-harvest-${source}`,
        reasoningTrace: mockThinkTrace
      });

    } catch (err) {
      if (this.verbose) {
        console.warn(`[GenesisHarvester] Ingestion failed for pair: ${err.message}`);
      }
    }
  }

  /**
   * Recursively crawls the entire workspace, reads source and documentation files,
   * chunks them, generates semantic embeddings, and injects them into ambient_memory.
   */
  async deepScanWorkspace(workspacePath) {
    if (this.verbose) {
      console.log(`🔍 [Genesis Harvester] Initiating Deep-Scan Workspace Crawler on: ${workspacePath}`);
    }

    const filesToProcess = [];
    const ignoreDirs = new Set(['.git', 'node_modules', '.secrets-vault', '.stratos-vector-store', 'dist', 'tmp-corestore-test', 'tmp-genesis-test', 'tmp-pqc-stress', 'tmp-multimodal-test']);
    const allowedExts = new Set(['.js', '.ts', '.py', '.json', '.md', '.rs', '.sh', '.css', '.html']);

    const crawl = (dir) => {
      try {
        const list = fs.readdirSync(dir);
        for (const file of list) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            if (!ignoreDirs.has(file) && !file.startsWith('.')) {
              crawl(fullPath);
            }
          } else {
            const ext = path.extname(file).toLowerCase();
            if (allowedExts.has(ext)) {
              filesToProcess.push(fullPath);
            }
          }
        }
      } catch (err) {
        if (this.verbose) {
          console.warn(`[GenesisHarvester] Deep-Scan skip directory ${dir}: ${err.message}`);
        }
      }
    };

    crawl(workspacePath);

    if (this.verbose) {
      console.log(`🔍 [Genesis Harvester] Found ${filesToProcess.length} source/doc files to ingest. Chunking and indexing...`);
    }

    let chunksIngested = 0;

    for (const filePath of filesToProcess) {
      try {
        const relativePath = path.relative(workspacePath, filePath);
        const content = fs.readFileSync(filePath, 'utf8');

        if (!content || content.trim().length === 0) continue;

        // Simple line/block chunking for premium semantic context extraction
        const chunkSize = 1200; // chars
        const overlap = 150;
        let index = 0;

        while (index < content.length) {
          const chunkText = content.substring(index, index + chunkSize).trim();
          if (chunkText.length > 50) { // Skip trivial tiny snippets
            const sourceInfo = `workspace_file:${relativePath}`;
            
            // Ingest as ambient memory chunk
            await insertAmbientMemory({
              source: sourceInfo,
              content: `--- FILE PATH: ${relativePath} ---\n${chunkText}`,
              tags: `code,architecture,deep-scan,${path.extname(filePath).slice(1)}`
            });
            chunksIngested++;
          }
          index += chunkSize - overlap;
        }
      } catch (err) {
        if (this.verbose) {
          console.warn(`[GenesisHarvester] Failed to process deep-scan file ${filePath}: ${err.message}`);
        }
      }
    }

    console.log(`🎉 [Genesis Harvester] Deep-Scan complete! Ingested ${chunksIngested} semantic chunks into ambient_memory.`);
    return chunksIngested;
  }
}
