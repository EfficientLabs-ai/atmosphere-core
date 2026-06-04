import assert from 'node:assert';
import { TaskClassifierRouter } from './src/task-router.js';

/**
 * Task-router spec — SOVEREIGN routing (updated 2026-06-05 when classify() was consolidated onto the
 * one sovereign model router). The philosophy changed deliberately and with approval:
 *
 *   OLD: complexity auto-escalated to cloud (and did so even with NO API key configured — a call that
 *        would then fail), and a general prompt "defaulted to cloud for maximum intelligence".
 *   NEW: LOCAL is the default. Cloud is OPT-IN only — via a `/force-cloud` directive, or a configured
 *        BYOK key (the standing opt-in) on a genuinely hard prompt. With no key, everything stays
 *        local (which is also the only honest option — without a key a cloud call can't succeed).
 *
 * A *named* model from an OpenAI-compatible client (e.g. "gpt-4o") is NOT a force-cloud — clients
 * send a model on every call. Only an explicit LOCAL model name pins local.
 */
async function runTaskRouterTests() {
  console.log('========================================================================');
  console.log('🌌 EFFICIENT LABS — THE ATMOSPHERE TASK CLASSIFIER & ROUTER (sovereign)');
  console.log('========================================================================\n');

  const router = new TaskClassifierRouter({ verbose: true });
  const ask = (content, model) => router.classify([{ role: 'user', content }], model);
  const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY'];
  const clearKeys = () => KEYS.forEach((k) => delete process.env[k]);
  clearKeys();

  // --- TEST 1: SIMPLE GREETINGS & SYNTAX (EXPECT: LOCAL — even when a cloud model is named) ---
  console.log('🔄 [Test 1] Simple greetings + syntax (a named cloud model must NOT force cloud)...');
  for (const p of ['Hello! Good morning.', 'How do I write a simple Array.map in JS?']) {
    const r = await ask(p, 'gpt-4o');
    console.log(`   "${p}" -> [${r.decision.toUpperCase()}] ${r.reason}`);
    assert.strictEqual(r.decision, 'local');
  }
  console.log('✅ [Test 1] Simple prompts route local even with model="gpt-4o".\n');

  // --- TEST 2: SOVEREIGN SYSTEM / LEDGER (EXPECT: LOCAL) ---
  console.log('🔄 [Test 2] Sovereign system + ledger prompts...');
  for (const p of ['Display my current P2P mesh network status', 'Check my off-chain state channel Solana balances']) {
    const r = await ask(p, 'claude-3-5-sonnet');
    console.log(`   "${p}" -> [${r.decision.toUpperCase()}] ${r.reason}`);
    assert.strictEqual(r.decision, 'local');
  }
  console.log('✅ [Test 2] Sovereign system prompts route local.\n');

  // --- TEST 3: HIGH COMPLEXITY (EXPECT: LOCAL by default; CLOUD only on opt-in) ---
  console.log('🔄 [Test 3] High-complexity prompts — sovereign default is LOCAL, cloud is opt-in...');
  const complex = 'Design a multi-threaded parallel sorting algorithm in Rust. Handle concurrency, prevent deadlocks and race conditions, and export performance metrics.';

  const noKey = await ask(complex, 'gpt-4o');
  console.log(`   complex, no key      -> [${noKey.decision.toUpperCase()}] ${noKey.reason}`);
  assert.strictEqual(noKey.decision, 'local'); // was auto-cloud before; now sovereign-local (and a keyless cloud call couldn't succeed anyway)

  const forced = await ask(complex + ' /force-cloud', 'gpt-4o');
  console.log(`   complex, /force-cloud -> [${forced.decision.toUpperCase()}] ${forced.reason}`);
  assert.strictEqual(forced.decision, 'cloud'); // explicit opt-in honored

  // genuinely hard (difficulty >=4) + a configured key (standing opt-in) -> cloud
  const hard = 'Architect, refactor and prove the optimal multi-threaded distributed sorting algorithm; optimize it and reason through every step in detail. '.repeat(10) + ' ```rust\nfn main(){}\n``` ';
  process.env.OPENAI_API_KEY = 'sk-test';
  const keyed = await ask(hard, 'gpt-4o');
  console.log(`   hard, key configured  -> [${keyed.decision.toUpperCase()}] ${keyed.reason}`);
  assert.strictEqual(keyed.decision, 'cloud'); // opt-in via configured BYOK key on a hard prompt
  clearKeys();
  console.log('✅ [Test 3] Complex stays local by default; cloud only on explicit/key opt-in.\n');

  // --- TEST 4: MANUAL DIRECTIVES (EXPECT: EXACT OVERRIDE) ---
  console.log('🔄 [Test 4] Manual override directives...');
  const fc = await ask('What is Array.map /force-cloud', 'gpt-4o');
  console.log(`   "...//force-cloud" -> [${fc.decision.toUpperCase()}] ${fc.reason}`);
  assert.strictEqual(fc.decision, 'cloud');
  const fl = await ask('Compile a multi-threaded Rust kernel /force-local', 'gpt-4o');
  console.log(`   "...//force-local" -> [${fl.decision.toUpperCase()}] ${fl.reason}`);
  assert.strictEqual(fl.decision, 'local');
  console.log('✅ [Test 4] Force directives override automated routing.\n');

  console.log('========================================================================');
  console.log('🎉 ALL SOVEREIGN ROUTING TESTS PASSED — local by default, cloud opt-in only');
  console.log('========================================================================');
}

runTaskRouterTests().catch((err) => {
  console.error('\n❌ TASK ROUTER HARNESS ERROR:', err.message);
  process.exit(1);
});
