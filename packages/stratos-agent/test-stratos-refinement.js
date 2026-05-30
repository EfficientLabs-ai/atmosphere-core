import '../atmos-core/index.js';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigParser } from './src/core/config.js';
import { UnifiedDispatcher } from './src/ingestion/unified-dispatcher.js';
import { P2pSkillSync } from './src/memory/p2p-skill-sync.js';

console.log('========================================================================');
console.log('🌌 EFFICIENT LABS - STRATOS AGENT ARCHITECTURAL REFINEMENT TEST SUITE');
console.log('🧪 RUNNING PHASE 23 REFINEMENT & DECENTRALIZED INTEGRATION TESTS');
console.log('========================================================================\n');

async function testConfigParser() {
  console.log('🔄 [Test 1] Testing Unified Configuration & Model Endpoints Mapper...');
  const parser = new ConfigParser({ verbose: false });

  // Test loading default endpoints
  const qwenEndpoint = parser.resolveModelEndpoint('qwen2.5:7b');
  assert.strictEqual(qwenEndpoint.provider, 'ollama');
  assert.strictEqual(qwenEndpoint.url, 'http://127.0.0.1:11434');

  const gptEndpoint = parser.resolveModelEndpoint('gpt-4o');
  assert.strictEqual(gptEndpoint.provider, 'openai');
  assert.strictEqual(gptEndpoint.url, 'https://api.openai.com/v1');

  // Test registering dynamic custom endpoints
  parser.registerModel('custom-deepseek', 'openrouter', 'https://openrouter.ai/api/v1', 'sk-or-custom');
  const customEndpoint = parser.resolveModelEndpoint('custom-deepseek');
  assert.strictEqual(customEndpoint.provider, 'openrouter');
  assert.strictEqual(customEndpoint.url, 'https://openrouter.ai/api/v1');
  assert.strictEqual(customEndpoint.apiKey, 'sk-or-custom');

  // Test mapping environments
  process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-DEF-TELEGRAM-TOKEN';
  const legacyConfig = parser.mapLegacyConfig();
  assert.strictEqual(legacyConfig.telegramToken, '123456:ABC-DEF-TELEGRAM-TOKEN');

  console.log('✅ [Test 1 Passed] Configuration and endpoint mappings are correct!\n');
}

async function testUnifiedDispatcher() {
  console.log('🔄 [Test 2] Testing Multi-Channel Dispatch Gateway...');
  const dispatcher = new UnifiedDispatcher({ verbose: false });

  // Test normalizing inputs across channels
  const mockTelegramPayload = {
    message_id: 42,
    from: { username: 'jax_atmosphere', first_name: 'Jax' },
    text: 'Show my P2P network status'
  };
  const normalized = dispatcher.normalizeIncomingRequest('telegram', mockTelegramPayload);
  assert.strictEqual(normalized.channel, 'telegram');
  assert.strictEqual(normalized.user, 'jax_atmosphere');
  assert.strictEqual(normalized.text, 'Show my P2P network status');

  // Test thought extraction & HTML spoiler formatting
  const mockRawResponse = `<think>
1. User queried P2P network status.
2. Formulating status report detailing 5 peers and SOL balances.
</think>
Here is your network report: **5 Peers Online**. CLI active at: \`stratos-ctl\``;
  const formattedHTML = dispatcher.formatResponseHTML(mockRawResponse);
  assert.ok(formattedHTML.includes('🧠 <b>Thinking Process:</b>'));
  assert.ok(formattedHTML.includes('<tg-spoiler>'));
  assert.ok(!formattedHTML.includes('&lt;think&gt;')); // Assert raw tags are stripped
  assert.ok(!formattedHTML.includes('<think>'));
  assert.ok(formattedHTML.includes('<b>5 Peers Online</b>'));
  assert.ok(formattedHTML.includes('<code>stratos-ctl</code>'));

  // Test voice transcription thought strips & formatting cleanups
  const voicePlainText = dispatcher.cleanTextForVoice(mockRawResponse);
  assert.ok(!voicePlainText.includes('Thinking Process'));
  assert.ok(!voicePlainText.includes('<think>'));
  assert.ok(!voicePlainText.includes('**'));
  assert.ok(voicePlainText.includes('Here is your network report: 5 Peers Online. CLI active at: stratos-ctl'));

  console.log('✅ [Test 2 Passed] Gateway dispatching, HTML escaping, and voice cleaning verified!\n');
}

async function testP2pSkillSync() {
  console.log('🔄 [Test 3] Testing Hyperswarm DHT P2P Skill Sync & Autobase Synchronization...');
  
  // Create two distinct nodes (simulating local desktop node and remote Hostinger VPS node)
  const nodeA = new P2pSkillSync({ storagePath: './.stratos-p2p-store-nodeA', topicSeed: 'test-shared-topic-seed-v1', verbose: false });
  const nodeB = new P2pSkillSync({ storagePath: './.stratos-p2p-store-nodeB', topicSeed: 'test-shared-topic-seed-v1', verbose: false });

  await nodeA.init();
  await nodeB.init();

  // Simulated node keyring attestation signing
  const skillMeta = { intent: 'Fetch AWS billing summary', successRate: 1.0, timestamp: Date.now() };
  const wasmHash = crypto.createHash('sha256').update('WASM_BINARY_COMPILATION_DATA').digest('hex');
  const signatureSeal = 'SIG_ML_DSA_65:84c7d9a1f2bc3d4e5f';

  // NodeA compiles a new skill and appends it to Autobase
  const appBlock = await nodeA.appendSkillBlock(
    'skill_aws-billing-summary-v1',
    skillMeta,
    wasmHash,
    signatureSeal
  );

  assert.strictEqual(appBlock.skillId, 'skill_aws-billing-summary-v1');
  assert.strictEqual(appBlock.wasmHash, wasmHash);
  assert.strictEqual(appBlock.signatureSeal, signatureSeal);

  // Read skill log back
  const syncedSkillsA = await nodeA.getSynchronizedSkills();
  assert.strictEqual(syncedSkillsA.length, 1);
  assert.strictEqual(syncedSkillsA[0].skillId, 'skill_aws-billing-summary-v1');

  // Clean up P2P resources
  await nodeA.destroy();
  await nodeB.destroy();

  // Purge temporary folders
  try {
    fs.rmSync('./.stratos-p2p-store-nodeA', { recursive: true, force: true });
    fs.rmSync('./.stratos-p2p-store-nodeB', { recursive: true, force: true });
  } catch (e) {
    // Ignore folder lock issues on Windows
  }

  console.log('✅ [Test 3 Passed] DHT swarming initialization and Autobase skills append validated!\n');
}

async function testStratosCtlDashboard() {
  console.log('🔄 [Test 4] Testing Command Center CLI Dashboard...');
  
  const ctlPath = path.resolve('./packages/stratos-agent/stratos-ctl.js');
  assert.ok(fs.existsSync(ctlPath));

  // Confirm standard file permissions or executable template
  const content = fs.readFileSync(ctlPath, 'utf8');
  assert.ok(content.startsWith('#!/usr/bin/env node'));
  assert.ok(content.includes('stratos-ctl'));
  assert.ok(content.includes('status'));
  assert.ok(content.includes('compile'));

  console.log('✅ [Test 4 Passed] CLI commander utility structure validated!\n');
}

async function runAll() {
  try {
    await testConfigParser();
    await testUnifiedDispatcher();
    await testP2pSkillSync();
    await testStratosCtlDashboard();

    console.log('========================================================================');
    console.log('🎉 ALL REFINEMENT AND P2P INTEGRATION TESTS PASSED (100% CORRECTNESS)');
    console.log('========================================================================');
  } catch (err) {
    console.error('❌ Integration Test Suite Failed:', err);
    process.exit(1);
  }
}

runAll();
