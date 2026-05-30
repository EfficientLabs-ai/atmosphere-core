import assert from 'node:assert';
import { TaskClassifierRouter } from './src/task-router.js';

async function runTaskRouterTests() {
  console.log('========================================================================');
  console.log('🌌 EFFICIENT LABS - THE ATMOSPHERE TASK CLASSIFIER & ROUTER');
  console.log('🧪 RUNNING SYSTEMATIC ROUTING AND COMPLEXITY DECISION HARNESS');
  console.log('========================================================================\n');

  const router = new TaskClassifierRouter({ verbose: true });

  // --- TEST CASE 1: SIMPLE GREETINGS & SYNTAX QUESTIONS (EXPECT: LOCAL) ---
  console.log('🔄 [Test 1] Simulating simple greetings and syntax references...');
  
  const greetRes = await router.classify([
    { role: 'user', content: 'Hello! Good morning.' }
  ], 'gpt-4o');
  console.log(`   Prompt: "Hello! Good morning." -> Decision: [${greetRes.decision.toUpperCase()}] | Reason: "${greetRes.reason}"`);
  assert.strictEqual(greetRes.decision, 'local');

  const syntaxRes = await router.classify([
    { role: 'user', content: 'How do I write a simple Array.map in JS?' }
  ], 'gpt-4o');
  console.log(`   Prompt: "How do I write a simple Array.map in JS?" -> Decision: [${syntaxRes.decision.toUpperCase()}] | Reason: "${syntaxRes.reason}"`);
  assert.strictEqual(syntaxRes.decision, 'local');

  console.log('✅ [Test 1 Passed] Simple prompts successfully route to local open-weights!\n');


  // --- TEST CASE 2: SOVEREIGN SYSTEM & LEDGER AUDITS (EXPECT: LOCAL) ---
  console.log('🔄 [Test 2] Simulating sovereign DePIN network and payment triggers...');

  const systemRes = await router.classify([
    { role: 'user', content: 'Display my current P2P mesh network status' }
  ], 'claude-3-5-sonnet');
  console.log(`   Prompt: "Display my current P2P mesh network status" -> Decision: [${systemRes.decision.toUpperCase()}] | Reason: "${systemRes.reason}"`);
  assert.strictEqual(systemRes.decision, 'local');

  const paymentRes = await router.classify([
    { role: 'user', content: 'Check my off-chain state channel Solana balances' }
  ], 'claude-3-5-sonnet');
  console.log(`   Prompt: "Check my off-chain state channel Solana balances" -> Decision: [${paymentRes.decision.toUpperCase()}] | Reason: "${paymentRes.reason}"`);
  assert.strictEqual(paymentRes.decision, 'local');

  console.log('✅ [Test 2 Passed] Sovereign system and ledger prompts successfully route locally!\n');


  // --- TEST CASE 3: HIGH COMPLEXITY LOGICAL REASONING (EXPECT: CLOUD) ---
  console.log('🔄 [Test 3] Simulating high-complexity algorithmic coding queries...');

  const complexRes = await router.classify([
    { role: 'user', content: 'Design a multi-threaded parallel sorting algorithm in Rust. Handle concurrency, prevent deadlocks and race conditions, and export performance metrics.' }
  ], 'gpt-4o');
  console.log(`   Prompt: "Design a multi-threaded..." -> Decision: [${complexRes.decision.toUpperCase()}] | Reason: "${complexRes.reason}"`);
  assert.strictEqual(complexRes.decision, 'cloud');

  const cryptRes = await router.classify([
    { role: 'user', content: 'Write a FIPS-compliant script that implements ML-KEM-768 post-quantum key encapsulation and ML-DSA-65 signatures.' }
  ], 'claude-3-5-sonnet');
  console.log(`   Prompt: "Write a FIPS-compliant script..." -> Decision: [${cryptRes.decision.toUpperCase()}] | Reason: "${cryptRes.reason}"`);
  assert.strictEqual(cryptRes.decision, 'cloud');

  console.log('✅ [Test 3 Passed] High-complexity tasks correctly require frontier cloud models!\n');


  // --- TEST CASE 4: MANUAL DIRECTIVE ROUTE OVERRIDES (EXPECT: EXACT OVERRIDE) ---
  console.log('🔄 [Test 4] Simulating manual override keywords...');

  const forceCloudRes = await router.classify([
    { role: 'user', content: 'What is Array.map /force-cloud' }
  ], 'gpt-4o');
  console.log(`   Prompt: "What is Array.map /force-cloud" -> Decision: [${forceCloudRes.decision.toUpperCase()}] | Reason: "${forceCloudRes.reason}"`);
  assert.strictEqual(forceCloudRes.decision, 'cloud');

  const forceLocalRes = await router.classify([
    { role: 'user', content: 'Compile a multi-threaded Rust kernel /force-local' }
  ], 'gpt-4o');
  console.log(`   Prompt: "Compile a multi-threaded Rust... /force-local" -> Decision: [${forceLocalRes.decision.toUpperCase()}] | Reason: "${forceLocalRes.reason}"`);
  assert.strictEqual(forceLocalRes.decision, 'local');

  console.log('✅ [Test 4 Passed] Manual force directives successfully override automated routing!\n');


  console.log('========================================================================');
  console.log('🎉 ALL TCR ROUTING & COMPLEXITY CLASSIFICATION TESTS PASSED (100% SUCCESS)');
  console.log('========================================================================');
}

runTaskRouterTests().catch(err => {
  console.error('\n❌ TASK ROUTER HARNESS ENCOUNTERED CRITICAL ERROR:', err);
  process.exit(1);
});
