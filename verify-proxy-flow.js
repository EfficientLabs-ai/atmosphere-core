import { startServer } from './packages/api-shim/server.js';
import fetch from 'node-fetch';
import assert from 'assert';

async function runVerification() {
  console.log('🧪 Starting API Shim Proxy Flow Verification...\n');

  // 1. Boot up Express server bound to 127.0.0.1
  const server = startServer();
  const serverUrl = 'http://127.0.0.1:4000';

  try {
    // Wait briefly for server startup
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. Test 1: Verify health endpoint
    console.log('📡 Test 1: Checking /health status...');
    const healthRes = await fetch(`${serverUrl}/health`);
    assert.strictEqual(healthRes.status, 200, 'Health endpoint should return 200');
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'healthy', 'Status should be healthy');
    console.log('✅ Test 1 Passed: Health status is healthy.');

    // 3. Test 2: Verify OpenAI chat completions fallback endpoint
    console.log('\n📡 Test 2: Sending mock OpenAI payload (streaming=false)...');
    const openaiRes = await fetch(`${serverUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'What is Atmos P2P?' }],
        stream: false
      })
    });
    
    assert.strictEqual(openaiRes.status, 200, 'OpenAI endpoint should return 200');
    const openaiData = await openaiRes.json();
    console.log('🤖 Received mock response structure:', JSON.stringify(openaiData, null, 2));
    assert.ok(openaiData.choices[0].message.content.includes('<think>'), 'Response should contain <think> tags from local fallback');
    assert.ok(openaiData.choices[0].message.content.includes('Atmos P2P') || openaiData.choices[0].message.content.includes('Sovereign'), 'Response should contain context-aware fallback completion');
    console.log('✅ Test 2 Passed: OpenAI intercept and fallback routing verified.');

    // 4. Test 3: Verify OpenAI streaming interface
    console.log('\n📡 Test 3: Sending mock OpenAI payload (streaming=true)...');
    const streamRes = await fetch(`${serverUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello assistant' }],
        stream: true
      })
    });
    
    assert.strictEqual(streamRes.status, 200, 'Streaming endpoint should return 200');
    console.log('🤖 Received stream segments:');
    let chunkCount = 0;
    
    // Read the stream
    await new Promise((resolve, reject) => {
      streamRes.body.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        console.log(text.trim());
        chunkCount++;
      });
      streamRes.body.on('end', () => {
        resolve();
      });
      streamRes.body.on('error', (err) => {
        reject(err);
      });
    });
    
    assert.ok(chunkCount > 0, 'Should have received multiple stream chunks');
    console.log('✅ Test 3 Passed: OpenAI stream pipeline intercept verified.');

  } catch (err) {
    console.error('❌ Verification Suite Failed:', err);
    process.exit(1);
  } finally {
    // Shut down the server gracefully
    console.log('\n🛑 Cleaning up and shutting down mock API shim server...');
    server.close(() => {
      console.log('💤 Verification server successfully closed.\n');
      console.log('🎉 PROXY INTERCEPT AND FALLBACK PIPELINE SECURELY VERIFIED!');
      process.exit(0);
    });
  }
}

runVerification();
