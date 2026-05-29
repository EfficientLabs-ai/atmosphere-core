import {
  initializeMemorySchema,
  insertAmbientMemory,
  queryAmbientMemory,
  insertInterceptedReasoning,
  queryInterceptedReasoning,
  insertCognitiveSkill,
  queryCognitiveSkill
} from './src/memory/vector-bank.js';

console.log('🧪 Starting StratosAgent Vector & Sensory E2E Harness (Phase 6)...');
console.log('====================================================================');

async function runTest() {
  try {
    // 1. Initialize empty tables and enforce schemas via Apache Arrow
    console.log('📦 [Step 1] Initializing local LanceDB Vector Schemas via Apache Arrow...');
    await initializeMemorySchema();
    console.log('✅ Arrow Tables & Schemas Initialized successfully!');
    console.log('--------------------------------------------------------------------');

    // 2. Insert Mock Ambient Sensory Captures (Layer 1)
    console.log('🎙️ [Step 2] Ingesting Mock Ambient Audio Transcription (Layer 1)...');
    const mockAudio = await insertAmbientMemory({
      source: 'ambient_microphone',
      content: 'Local Speech Ingested: Perfecting the Atmos 1.0 sovereign monorepo and decentralized vector bank.',
      tags: 'audio,speech,voice'
    });
    console.log('✅ Audio transcript inserted successfully.');

    console.log('\n🖥️ [Step 3] Ingesting Mock Screen Buffer Focused Context (Layer 1)...');
    const mockScreen = await insertAmbientMemory({
      source: 'ambient_screen_buffer',
      content: 'Focused Screen Context: Active Window is "OpenAtmos - Visual Studio Code".',
      tags: 'screen,visual'
    });
    console.log('✅ Screen buffer context inserted successfully.');
    console.log('--------------------------------------------------------------------');

    // 3. Insert Mock Intercepted <think> Reasoning Trace (Layer 3)
    console.log('🧠 [Step 4] Ingesting Mock Intercepted <think> Reasoning Trace (Layer 3)...');
    const mockReasoning = await insertInterceptedReasoning({
      promptHash: 'd3b07384d113edec49eaa6238ad5ff00',
      modelSource: 'deepseek-reasoner',
      reasoningTrace: '<think>\n1. Intercepted request from local api-shim proxy.\n2. Query contains P2P overlay references.\n3. Encapsulating post-quantum ML-KEM-768 shared key.\n4. Route authenticated successfully.\n</think>\nExecuting sovereign coordination sequence.'
    });
    console.log('✅ Intercepted reasoning trace inserted successfully.');
    console.log('--------------------------------------------------------------------');

    // 4. Insert Mock Cognitive Skill AST logic graph (Layer 2)
    console.log('🤖 [Step 5] Ingesting Mock Cognitive Skill AST Logic Graph (Layer 2)...');
    const mockSkill = await insertCognitiveSkill({
      skillId: 'login-flow-skill-v1',
      triggerIntent: 'Automated user portal authentication sequence',
      astGraph: {
        engine: 'StratosAgent-1.0',
        steps: [
          { type: 'goto', url: 'https://efficientlabs.ai/login' },
          { type: 'fill', target: '#user', value: 'admin' },
          { type: 'click', target: '#submit' }
        ]
      },
      successRate: 0.98
    });
    console.log('✅ Cognitive skill logic graph inserted successfully.');
    console.log('--------------------------------------------------------------------');

    // 5. Query Layer 1 (Ambient Memory) via Semantic Vector Search
    console.log('🔍 [Step 6] Searching Ambient Memory for "vector bank"...');
    const ambientResults = await queryAmbientMemory('vector bank', 2);
    console.log('✅ Query results returned successfully:');
    ambientResults.forEach((res, i) => {
      console.log(`  [Result #${i+1}] Source: ${res.source} | Content: "${res.content}"`);
    });
    console.log('--------------------------------------------------------------------');

    // 6. Query Layer 3 (Intercepted Reasoning) via Semantic Vector Search
    console.log('🔍 [Step 7] Searching Intercepted Reasoning for "post-quantum KEM"...');
    const reasoningResults = await queryInterceptedReasoning('post-quantum KEM', 1);
    console.log('✅ Query results returned successfully:');
    reasoningResults.forEach((res, i) => {
      console.log(`  [Result #${i+1}] Model: ${res.model_source} | Trace Preview: "${res.reasoning_trace.substring(0, 120)}..."`);
    });
    console.log('--------------------------------------------------------------------');

    // 7. Query Layer 2 (Cognitive Skills) via Semantic Vector Search
    console.log('🔍 [Step 8] Searching Cognitive Skills for "authentication"...');
    const skillResults = await queryCognitiveSkill('authentication', 1);
    console.log('✅ Query results returned successfully:');
    skillResults.forEach((res, i) => {
      console.log(`  [Result #${i+1}] Skill ID: ${res.skill_id} | Intent: "${res.trigger_intent}" | Success Rate: ${res.success_rate * 100}%`);
    });
    console.log('====================================================================');

    if (ambientResults.length > 0 && reasoningResults.length > 0 && skillResults.length > 0) {
      console.log('🎉 PHASE 6 TRIPLE-LAYER VECTOR MEMORY STRUCTURE SECURED!');
      process.exit(0);
    } else {
      console.error('❌ Error: Verification queries returned empty results.');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Critical Verification Error:', err);
    process.exit(1);
  }
}

runTest();
