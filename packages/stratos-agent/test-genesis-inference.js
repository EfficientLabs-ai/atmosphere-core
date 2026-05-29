import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fetch from 'node-fetch';
import { initializeMemorySchema, getDatabase } from './src/memory/vector-bank.js';
import { GenesisHarvester } from './src/ingestion/genesis-harvester.js';
import { LocalInferenceEngine } from '../api-shim/src/local-inference.js';

console.log('🧪 Starting Atmos Phase 10 Genesis Harvester & Local Inference E2E Test Harness...');
console.log('====================================================================================');

async function runTest() {
  const tmpDir = path.join(process.cwd(), 'tmp-genesis-test');
  let testDbPath = '';
  let serverInstance = null;

  try {
    // 1. Initialize databases and clean previous state stores
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir);
    }
    
    // Create a temporary mock SQLite database mimicking Cursor's state.vscdb
    testDbPath = path.join(tmpDir, 'state.vscdb');
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    console.log('🔑 [Step 1] Initializing mock Cursor SQLite database with developer logs...');
    const db = new Database(testDbPath);
    
    // Create VSCode workspace state tables
    db.prepare('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)').run();
    
    // Insert mock successful agent prompt-response loops representing a WASM skill execution
    const mockDeveloperLogs = {
      messages: [
        { role: 'user', content: 'Generate a sovereign web scraper skill targeting efficientlabs.ai' },
        { role: 'assistant', content: 'Here is the compiled WASM scrape script: [WASM_BINARY_HEX:a8b9c7]' }
      ]
    };

    const mockCursorChatState = {
      prompt: 'Verify P2P Node identity using hybrid ML-DSA signatures',
      response: 'Sovereign Node verification completed successfully with ML-DSA signature: [SIG_ML_DSA:90a8f7c3e1b2]'
    };

    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('workbench.panel.chat.state', JSON.stringify(mockDeveloperLogs));

    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('workbench.panel.aiHelper.state', JSON.stringify(mockCursorChatState));

    db.close();
    console.log('✅ Mock developer logs SQLite file written successfully.');
    console.log('------------------------------------------------------------------------------------');

    // 2. Initialize Vector schemas
    console.log('📦 [Step 2] Initializing local LanceDB Vector database tables...');
    await initializeMemorySchema();
    console.log('✅ LanceDB schemas active.');
    console.log('------------------------------------------------------------------------------------');

    // 3. Command Genesis Harvester to scan and ingest
    console.log('🔍 [Step 3] Booting Genesis Harvester and targeting mock workspace database...');
    const harvester = new GenesisHarvester({ verbose: true });
    
    // Create custom mock pairs by parsing our generated db directly
    const harvestedPairs = harvester.parseCursorDatabase(testDbPath);
    console.log(`✅ Harvester scanned mock database and extracted ${harvestedPairs.length} pairs:`);
    
    for (const pair of harvestedPairs) {
      console.log(`   - Prompt: "${pair.prompt.slice(0, 48)}..."`);
      console.log(`     Output: "${pair.response.slice(0, 48)}..."`);
      
      // Ingest directly into LanceDB memory bank
      await harvester.ingestPair(pair);
    }
    console.log('✅ Historical pairs ingested as semantic embeddings into LanceDB.');
    console.log('------------------------------------------------------------------------------------');

    // 4. Test Local Inference Engine with augmented RAG context directly
    console.log('🤖 [Step 4] Querying Local Inference Engine directly for semantic prompt matching...');
    const inferenceEngine = new LocalInferenceEngine({ verbose: true });
    
    const testQuery = 'How do I verify a P2P Node identity?';
    console.log(`   - Search Query: "${testQuery}"`);
    
    // Retrieve context to verify semantic embedding matching
    const context = await inferenceEngine.retrieveRagContext(testQuery);
    console.log(`   - RAG Retriever Match Count: ${context.length}`);
    
    if (context.length === 0) {
      throw new Error('❌ RAG Retriever failed to locate matching LanceDB semantic records.');
    }
    console.log(`   - Best Retrieval Match Source: ${context[0].source}`);
    console.log(`   - Extracted Context Output: "${context[0].response}"`);
    console.log('------------------------------------------------------------------------------------');

    // 5. Boot API Shim Daemon on custom port and test REST API Completions routing
    console.log('📡 [Step 5] Booting API Shim Daemon on port 4099 for E2E REST integration test...');
    process.env.PORT = '4099';
    process.env.STRATOS_AGENT_URL = 'http://127.0.0.1:9999';
    const { startServer } = await import('../api-shim/server.js');
    serverInstance = startServer();
    await new Promise(r => setTimeout(r, 1000)); // Wait for server startup
    
    console.log('📡 Sending OpenAI-compatible Completions payload...');
    const apiPayload = {
      model: 'qwen-2.5-local-rag',
      messages: [
        { role: 'user', content: 'P2P Node identity ML-DSA verification steps' }
      ],
      stream: false
    };

    const apiResponse = await fetch('http://127.0.0.1:4099/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiPayload)
    });

    if (!apiResponse.ok) {
      throw new Error(`HTTP Completions routing failed with status: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    console.log('\n🤖 [Local Inference RAG API Response]:');
    console.log('====================================================================================');
    console.log(data.choices[0].message.content);
    console.log('====================================================================================');

    console.log('\n✅ Verification checks passed:');
    console.log(`  - Completion model: ${data.model}`);
    console.log(`  - Choices length:   ${data.choices.length}`);
    console.log(`  - Usage tokens logged: ${data.usage.total_tokens}`);
    console.log('------------------------------------------------------------------------------------');

    console.log('🎉 PHASE 10 GENESIS INGESTION & DAY-1 INFERENCE BASELINE FULLY VERIFIED!');
    cleanup(tmpDir, serverInstance);
    process.exit(0);

  } catch (err) {
    console.error('❌ E2E Harness Critical Error:', err);
    cleanup(tmpDir, serverInstance);
    process.exit(1);
  }
}

function cleanup(tmpDir, serverInstance) {
  console.log('\n🛑 Shutting down mock servers and cleaning temporary files...');
  if (serverInstance) {
    try {
      serverInstance.close(() => {
        console.log('💤 API Shim Daemon successfully closed.');
      });
    } catch (e) {}
  }
  
  try {
    if (fs.existsSync(tmpDir)) {
      // Remove temp database
      const dbPath = path.join(tmpDir, 'state.vscdb');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      fs.rmdirSync(tmpDir);
      console.log('🧹 Cleaned temporary workspace folders.');
    }
  } catch (e) {
    console.warn('⚠️ Cleanup warning:', e.message);
  }
}

runTest();
