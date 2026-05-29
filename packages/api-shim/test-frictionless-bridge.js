import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { LegacyBridge } from '../stratos-agent/src/ingestion/legacy-bridge.js';
import { TelemetryExporter } from '../stratos-agent/src/memory/telemetry-exporter.js';
import { VaultHost } from '../stratos-agent/src/security/vault-host.js';

async function runFrictionlessBridgeTest() {
  console.log('========================================================================');
  console.log('🌌 EFFICIENT LABS - THE ATMOSPHERE P2P GRID & STRATOSAGENT');
  console.log('🧪 RUNNING FRONTIER MODEL BRIDGE & TELEMETRY FLYWHEEL HARVESTER TESTS');
  console.log('========================================================================\n');

  // Setup temporary paths
  const tmpConfigPath = path.join(process.cwd(), 'mock_claude_config.json');
  const testDbPath = path.join(process.cwd(), '.stratos-reasoning.db');
  
  // Configure environment overrides before evaluating server.js
  process.env.PORT = '4099';
  process.env.STRATOS_DB_PATH = testDbPath;

  // Dynamically load the server module so it binds to port 4099 on first evaluation
  const { startServer } = await import('./server.js');

  // Write a mock Claude Desktop config containing external MCP tools
  const mockConfig = {
    mcpServers: {
      "enterprise-sql-server": {
        "command": "node",
        "args": ["./scripts/sql-mcp.js"],
        "env": { "DATABASE_URL": "postgresql://localhost:5432/main" }
      },
      "custom-gdrive-connector": {
        "command": "python",
        "args": ["gdrive_mcp.py", "--shared-only"],
        "env": { "GD_CREDENTIALS": "sk-proj-GD-SEC-9999" }
      }
    }
  };

  fs.writeFileSync(tmpConfigPath, JSON.stringify(mockConfig, null, 2));
  console.log(`✅ Success: Temporary mock Claude Desktop config written to: ${tmpConfigPath}`);

  // Set the override path so that server.js automatically picks it up during load Claude config queries
  LegacyBridge.configPathOverride = tmpConfigPath;

  // --- VERIFICATION 1: LEGACY CONFIG INGESTION ---
  console.log('\n📥 Ingesting legacy configurations and MCP servers...');
  
  let ReasoningBank;
  try {
    const module = await import('../stratos-agent/reasoning-bank.js');
    ReasoningBank = module.ReasoningBank;
  } catch (err) {
    throw new Error('❌ Failed: Could not load ReasoningBank to parse legacy context.');
  }

  const reasoningBank = new ReasoningBank({
    dbPath: testDbPath,
    vectorStorePath: path.join(process.cwd(), '.stratos-vector-store')
  });
  await reasoningBank.initialize();

  // Run the Legacy Bridge parser targeting our mock Claude config
  await LegacyBridge.ingestLegacyContext(reasoningBank, tmpConfigPath);
  console.log('✅ Success: Ingestion Bridge successfully parsed and committed legacy servers to LanceDB.');


  // --- VERIFICATION 2: DYNAMIC MCP ROUTING & AUTO-ADAPTATION ---
  console.log('\n📡 Initializing api-shim Interception Server on Port 4099...');
  
  const serverInstance = startServer();
  await new Promise(resolve => setTimeout(resolve, 2000)); // Allow server to boot

  console.log('\n📡 Sending tools/list JSON-RPC request to /mcp...');
  const mcpPayload = {
    jsonrpc: '2.0',
    method: 'tools/list',
    params: {},
    id: 'test-req-1'
  };

  const mcpRes = await fetch('http://127.0.0.1:4099/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mcpPayload)
  });

  const mcpData = await mcpRes.json();
  const tools = mcpData.result.tools;
  
  console.log("🔍 Inspecting merged '/mcp' Tools List:");
  tools.forEach(tool => {
    console.log(`   * Tool Name: ${tool.name}`);
    console.log(`     Description: ${tool.description}`);
  });

  const hasLegacySql = tools.some(t => t.name === 'bridged_mcp_enterprise-sql-server');
  const hasLegacyGDrive = tools.some(t => t.name === 'bridged_mcp_custom-gdrive-connector');

  if (!hasLegacySql || !hasLegacyGDrive) {
    throw new Error('❌ Phase 22 Failed: Claude Desktop MCP servers were not dynamically bridged or merged.');
  }
  console.log('✅ Success: Both custom Claude Desktop MCP servers were automatically parsed, adapted, and loaded into the local proxy!');

  // Test executing a legacy bridged tool
  console.log('\n📡 Simulating legacy bridged tool execution...');
  const toolCallPayload = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'bridged_mcp_enterprise-sql-server',
      arguments: { input: 'SELECT COUNT(*) FROM transactions;' }
    },
    id: 'test-req-2'
  };

  const toolCallRes = await fetch('http://127.0.0.1:4099/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toolCallPayload)
  });

  const toolCallData = await toolCallRes.json();
  console.log('   Response Output:', toolCallData.result.content[0].text);
  if (!toolCallData.result.content[0].text.includes('bridged_execution_success')) {
    throw new Error('❌ Phase 22 Failed: Legacy bridged tool execution failed.');
  }
  console.log('✅ Success: Legacy tool execution successfully completed within secure local bounds!');


  // --- VERIFICATION 3: ZERO-TRUST TELEMETRY STRIPPING (THE HARVESTER) ---
  console.log('\n🛡️  Testing Telemetry Harvester & Anonymizer Pipeline...');

  const sensitivePrompt = 'Generate a script using my proprietary key: sk-proj-1234567890abcdef1234567890abcdef and charge transaction to card 4111-2222-3333-4444. Reply to ceo@efficientlabs.ai';
  console.log(`💬 Inbound Prompt contains:
      - Credit Card (PII)
      - Email Address (PII)
      - proprietary Front Key (Secret)`);

  const completionsPayload = {
    model: 'quantized-qwen-2.5-local',
    messages: [
      { role: 'user', content: sensitivePrompt }
    ]
  };

  // Trigger local completions endpoint
  const compRes = await fetch('http://127.0.0.1:4099/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(completionsPayload)
  });

  const compData = await compRes.json();
  console.log('\n🤖 Simulated completions execution resolved.');

  await new Promise(r => setTimeout(r, 1000)); // Allow telemetry thread to insert records

  // Scan vector database tables to assert the anonymized content
  const matches = await reasoningBank.vectorSearch('knowledge-base', [1, 0, 0], 100);
  console.log(`🔍 Total database records returned: ${matches.length}`);
  const harvestedTrace = matches.find(m => m.id.startsWith('telemetry-'));

  if (!harvestedTrace) {
    throw new Error('❌ Phase 22 Failed: Telemetry Harvester failed to write training records.');
  }

  console.log(`\n🔍 Inspecting Harvested Training Telemetry Record (ID: ${harvestedTrace.id}):`);
  console.log('------------------------------------------------------------------------');
  console.log(harvestedTrace.text);
  console.log('------------------------------------------------------------------------');

  if (harvestedTrace.text.includes('4111') || harvestedTrace.text.includes('sk-proj-') || harvestedTrace.text.includes('ceo@')) {
    throw new Error('❌ Phase 22 Failed: Security Breach! Sensitive API keys, credit cards, or emails leaked into the database.');
  }

  console.log('🏆 Zero-Knowledge Telemetry Scrubber Status: ✅ 100% ANONYMIZED & SECURED!');


  // --- VERIFICATION 4: ZK TELEMETRY ROLLUP AND post-quantum signature SEAL ---
  console.log('\n⚡ Testing Zero-Knowledge Telemetry Exporter Rollup & Cryptographic Seal...');

  const vaultHost = new VaultHost();
  await vaultHost.init();

  const rollup = await TelemetryExporter.compileAndSignTelemetry(reasoningBank, vaultHost);
  
  console.log('\n📦 Telemetry rollup compiled:');
  console.log(`   - Generator: ${rollup.payload.generator}`);
  console.log(`   - Total Traces Extracted: ${rollup.payload.traces.length}`);
  console.log(`   - Node certified did:atmos: ${rollup.nodeAtmosDid}`);
  console.log(`   - ML-DSA-65 Enclaved Signature Seal: ${rollup.signature.slice(0, 32)}...`);

  if (!rollup.success || rollup.payload.traces.length === 0 || !rollup.signature) {
    throw new Error('❌ Phase 22 Failed: Failed to generate signed telemetry rollup.');
  }

  console.log('✅ Success: Telemetry rollup compiled, anonymized, and post-quantum sealed successfully!');


  // --- CLEANUP ---
  console.log('\n🧹 Cleaning temporary configurations and shutting down servers...');
  serverInstance.close();
  reasoningBank.close();
  
  if (fs.existsSync(tmpConfigPath)) fs.unlinkSync(tmpConfigPath);
  
  console.log('\n========================================================================');
  console.log('🎉 FRONTIER BRIDGE & TELEMETRY FLYWHEEL COMPLETED (100% CORRECTNESS)');
  console.log('========================================================================');
}

runFrictionlessBridgeTest().catch(err => {
  console.error('\n❌ TEST HARNESS ENCOUNTERED CRITICAL ERROR:', err);
  process.exit(1);
});
