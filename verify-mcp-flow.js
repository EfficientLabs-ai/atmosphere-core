import { startServer } from './packages/api-shim/server.js';
import fetch from 'node-fetch';
import assert from 'assert';

const PORT = process.env.PORT || '4000';
const serverUrl = `http://127.0.0.1:${PORT}`;

async function runMcpVerification() {
  console.log(`🧪 Starting API Shim MCP & JSON-RPC 2.0 Flow Verification on port ${PORT}...\n`);

  // Boot up Express server bound to 127.0.0.1
  const server = startServer();

  try {
    // Wait briefly for server startup
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 1. Test 1: Verify health endpoint
    console.log('📡 Test 1: Checking /health status...');
    const healthRes = await fetch(`${serverUrl}/health`);
    assert.strictEqual(healthRes.status, 200, 'Health endpoint should return 200');
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'healthy', 'Status should be healthy');
    console.log('✅ Test 1 Passed: Health status is healthy.');

    // 2. Test 2: Check tools/list method on /mcp
    console.log('\n📡 Test 2: Listing native MCP tools...');
    const listRes = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 1
      })
    });

    assert.strictEqual(listRes.status, 200, 'List tools endpoint should return 200');
    const listData = await listRes.json();
    console.log('🤖 Received MCP Tools List:', JSON.stringify(listData, null, 2));
    assert.strictEqual(listData.jsonrpc, '2.0', 'JSON-RPC version must be 2.0');
    assert.ok(listData.result.tools, 'Response must contain tools list');
    
    const toolNames = listData.result.tools.map(t => t.name);
    assert.ok(toolNames.includes('stratos_browser_execute'), 'Should register stratos_browser_execute');
    assert.ok(toolNames.includes('atmos_vector_search'), 'Should register atmos_vector_search');
    console.log('✅ Test 2 Passed: MCP tools list returned successfully.');

    // 3. Test 3: Call atmos_vector_search on /mcp
    console.log('\n📡 Test 3: Calling atmos_vector_search...');
    const searchRes = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'atmos_vector_search',
          arguments: {
            query: 'Atmos sovereign compute layer spec',
            limit: 2
          }
        },
        id: 2
      })
    });

    assert.strictEqual(searchRes.status, 200, 'Call vector search endpoint should return 200');
    const searchData = await searchRes.json();
    console.log('🤖 Received Vector Search Result:', JSON.stringify(searchData, null, 2));
    assert.strictEqual(searchData.jsonrpc, '2.0', 'JSON-RPC version must be 2.0');
    assert.ok(searchData.result.content, 'Response must contain content');
    
    const results = JSON.parse(searchData.result.content[0].text);
    assert.ok(results.length > 0, 'Vector search should return bootstrapped documents');
    assert.ok(results.some(r => r.text.includes('Atmos')), 'At least one search result should match Atmos query');
    console.log('✅ Test 3 Passed: atmos_vector_search completed successfully.');

    // 4. Test 4: Call stratos_browser_execute with mock execution
    console.log('\n📡 Test 4: Calling stratos_browser_execute...');
    const browserRes = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'stratos_browser_execute',
          arguments: {
            prompt: 'navigate to https://example.com'
          }
        },
        id: 3
      })
    });

    assert.strictEqual(browserRes.status, 200, 'Call browser execute endpoint should return 200');
    const browserData = await browserRes.json();
    console.log('🤖 Received Browser Execute Result:', JSON.stringify(browserData, null, 2));
    assert.strictEqual(browserData.jsonrpc, '2.0', 'JSON-RPC version must be 2.0');
    assert.ok(browserData.result.content, 'Response must contain content');
    console.log('✅ Test 4 Passed: stratos_browser_execute completed successfully.');

  } catch (err) {
    console.error('❌ MCP Verification Suite Failed:', err);
    process.exit(1);
  } finally {
    // Shut down the server gracefully
    console.log('\n🛑 Cleaning up and shutting down API shim server...');
    server.close(() => {
      console.log('💤 Verification server successfully closed.\n');
      console.log('🎉 ALL INTEGRATION DAEMON & MCP TEST CASES SUCCESSFULLY PASSED!');
      process.exit(0);
    });
  }
}

runMcpVerification();
