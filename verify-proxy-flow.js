import assert from 'assert';
import net from 'node:net';

// Allocate an ephemeral free port so the suite never collides with a host port
// already bound (e.g. the docker-published :4000 on this VPS).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function runVerification() {
  console.log('🧪 Starting API Shim Proxy Flow Verification...\n');

  // server.js reads PORT at module-load time, so configure the environment BEFORE
  // importing it. Enabling local fallback makes the suite independent of the
  // (optional) StratosAgent upstream at :5001.
  const port = await getFreePort();
  process.env.PORT = String(port);
  process.env.LOCAL_FALLBACK_ENABLED = 'true';

  const { startServer } = await import('./packages/api-shim/server.js');
  const fetch = (await import('node-fetch')).default;

  const server = startServer();
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 1: health endpoint
    console.log('📡 Test 1: Checking /health status...');
    const healthRes = await fetch(`${serverUrl}/health`);
    assert.strictEqual(healthRes.status, 200, 'Health endpoint should return 200');
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'healthy', 'Status should be healthy');
    console.log('✅ Test 1 Passed: Health status is healthy.');

    // Test 2: OpenAI intercept + fallback routing. Structural assertion — the proxy
    // intercepts the request and returns a valid OpenAI-shaped completion regardless
    // of which backend (upstream agent or local fallback) ultimately served it.
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
    assert.strictEqual(openaiRes.status, 200, 'OpenAI endpoint should return 200 via interception/fallback');
    const openaiData = await openaiRes.json();
    const content = openaiData?.choices?.[0]?.message?.content;
    assert.ok(typeof content === 'string' && content.length > 0,
      'Response should be a valid OpenAI completion with non-empty content');
    console.log('✅ Test 2 Passed: OpenAI intercept and fallback routing verified.');

    // Test 3: OpenAI streaming interface
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
    let chunkCount = 0;
    await new Promise((resolve, reject) => {
      streamRes.body.on('data', () => { chunkCount++; });
      streamRes.body.on('end', resolve);
      streamRes.body.on('error', reject);
    });
    assert.ok(chunkCount > 0, 'Should have received stream chunks');
    console.log('✅ Test 3 Passed: OpenAI stream pipeline intercept verified.');
  } catch (err) {
    console.error('❌ Verification Suite Failed:', err.message || err);
    server.close(() => process.exit(1));
    return;
  }

  console.log('\n🛑 Cleaning up and shutting down mock API shim server...');
  server.close(() => {
    console.log('💤 Verification server successfully closed.\n');
    console.log('🎉 PROXY INTERCEPT AND FALLBACK PIPELINE SECURELY VERIFIED!');
    process.exit(0);
  });
}

runVerification();
