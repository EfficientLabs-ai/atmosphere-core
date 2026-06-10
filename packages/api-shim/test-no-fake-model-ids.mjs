/**
 * test-no-fake-model-ids.mjs — source guard (EFL-007 / atmosphere-core#60).
 *
 * The box runs gemma2:2b + gemma4:e4b; qwen2.5:7b was removed (task #43). The Telegram bridge and the
 * local-inference engine must NEVER hardcode a fake "qwen" model id, because those ids flow into
 * responseModel / capability receipts — a tamper-evident provenance rail must not record a model that
 * never ran. This test fails if a qwen alias is reintroduced into the source.
 */
import fs from 'node:fs';
import assert from 'node:assert';

const src =
  fs.readFileSync(new URL('./src/telegram-bridge.js', import.meta.url), 'utf8') +
  fs.readFileSync(new URL('./src/local-inference.js', import.meta.url), 'utf8');

// Guard the exact fake model IDs that were hardcoded (these flowed into responseModel/receipts).
// We match the id *values*, not the word "qwen" in a comment — those are different things.
assert.ok(!/['"]qwen-2\.5-vlm-telegram-local['"]/.test(src), 'no hardcoded qwen telegram alias value in bridge/inference source');
assert.ok(!/['"]Qwen-2\.5-7B-Quantized-Local['"]/.test(src), 'no hardcoded qwen quantized alias value in bridge/inference source');

console.log('  ✓ no fake qwen model-id values in telegram-bridge.js / local-inference.js');
