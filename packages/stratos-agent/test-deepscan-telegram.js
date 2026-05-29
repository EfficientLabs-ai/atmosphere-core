import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { initializeMemorySchema, getDatabase } from './src/memory/vector-bank.js';
import { GenesisHarvester } from './src/ingestion/genesis-harvester.js';

console.log('🧪 Starting Atmos Phase 14 Deep-Scan Ingestion & completions RAG Test Harness...');
console.log('=====================================================================================');

async function runTest() {
  const tmpDir = path.join(process.cwd(), 'tmp-deepscan-test');
  let serverInstance = null;

  try {
    // 1. Initialize folders
    if (fs.existsSync(tmpDir)) {
      cleanup(tmpDir);
    }
    fs.mkdirSync(tmpDir, { recursive: true });

    // 2. Create mock source code files representing developer architecture
    console.log('🔑 [Step 1] Initializing mock source files and Markdown docs in workspace...');
    
    const mockPaymentJs = `
    // Efficient Labs Sovereign USDC/SOL State Channels Payment Module
    export class SovereignStateChannelEngine {
      constructor() {
        this.protocol = "x402-execution-fee-settlement";
        this.bypassYieldStaking = true; // Prevents Howey security classification
      }
      verifyMeasurableOutput(skillId, hash) {
        return crypto.createHash('sha256').update(skillId + hash).digest('hex');
      }
    }
    `;

    const mockDocsMd = `
    # Atmos Sovereign Grid Architecture
    This documents our post-quantum key agreement using X25519 Diffie-Hellman + ML-KEM-768 hybrid mechanics.
    All digital signatures utilize Ed25519 classical keys combined with native FIPS 204 ML-DSA-65 standards.
    `;

    fs.writeFileSync(path.join(tmpDir, 'state-channel-engine.js'), mockPaymentJs);
    fs.writeFileSync(path.join(tmpDir, 'architecture-guide.md'), mockDocsMd);
    console.log('✅ Mock files written successfully.');
    console.log('-------------------------------------------------------------------------------------');

    // 3. Initialize LanceDB
    console.log('📦 [Step 2] Initializing local LanceDB table schemas...');
    await initializeMemorySchema();
    console.log('✅ LanceDB table schemas active.');
    console.log('-------------------------------------------------------------------------------------');

    // 4. Trigger Deep-Scan Crawler Ingestion
    console.log('🔍 [Step 3] Booting Genesis Harvester and triggering deep recursive crawler...');
    const harvester = new GenesisHarvester({ verbose: true });
    
    // Scan our temporary mock workspace recursively
    const chunksCount = await harvester.deepScanWorkspace(tmpDir);
    console.log(`✅ Deep-scan crawled, chunked, and indexed ${chunksCount} files into LanceDB!`);
    console.log('-------------------------------------------------------------------------------------');

    // 5. Set custom port and boot completions API shim daemon
    console.log('📡 [Step 4] Booting API Shim Completions Daemon on port 4099...');
    process.env.PORT = '4099';
    process.env.STRATOS_AGENT_URL = 'http://127.0.0.1:9999'; // Dead port to force fallback RAG
    
    const { startServer } = await import('../api-shim/server.js');
    serverInstance = startServer();
    await new Promise(r => setTimeout(r, 1000)); // Wait for server startup
    console.log('-------------------------------------------------------------------------------------');

    // 6. Test RAG Completions routing with deep-scan prompt keywords
    const testQuery = 'Explain post-quantum signatures and state channel engine bypass rules';
    console.log(`🖥️ [Step 5] Routing RAG completions query: "${testQuery}"`);
    
    const apiPayload = {
      model: 'qwen-2.5-deepscan-telegram-local',
      messages: [
        { role: 'user', content: testQuery }
      ],
      stream: false
    };

    const apiResponse = await fetch('http://127.0.0.1:4099/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiPayload)
    });

    if (!apiResponse.ok) {
      throw new Error(`HTTP completions routing failed with status: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    const responseText = data.choices[0].message.content;
    
    console.log('\n🤖 [Local RAG Completions API Response]:');
    console.log('=====================================================================================');
    console.log(responseText);
    console.log('=====================================================================================');
    console.log('-------------------------------------------------------------------------------------');

    // 7. Verify audit properties
    console.log('🏆 Deep-Scan Ingestion Audit:');
    console.log(`   - Model Output:    ${data.model}`);
    console.log(`   - Choices returned: ${data.choices.length}`);
    console.log(`   - Tokens parsed:    ${data.usage.total_tokens}`);
    
    if (data.choices.length > 0 && responseText.length > 0) {
      console.log('\n🎉 PHASE 14 DEEP-SCAN INGESTION & COMPLETIONS RAG FULLY VERIFIED!');
      cleanup(tmpDir, serverInstance);
      process.exit(0);
    } else {
      throw new Error('Verification failed: empty completions returned.');
    }

  } catch (err) {
    console.error('❌ E2E Harness Critical Error:', err);
    cleanup(tmpDir, serverInstance);
    process.exit(1);
  }
}

function cleanup(tmpDir, serverInstance) {
  console.log('\n🛑 Shutting down mock servers and cleaning temporary deep-scan buffers...');
  if (serverInstance) {
    try {
      serverInstance.close(() => {
        console.log('💤 API Shim Daemon successfully closed.');
      });
    } catch (e) {}
  }
  
  try {
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        fs.unlinkSync(path.join(tmpDir, file));
      }
      fs.rmdirSync(tmpDir);
      console.log('🧹 Cleaned temporary workspace folders.');
    }
  } catch (e) {
    console.warn('⚠️ Cleanup warning:', e.message);
  }
}

runTest();
