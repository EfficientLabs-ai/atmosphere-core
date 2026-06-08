/**
 * LocalInference model-name normalization tests.
 * Pure: no Ollama/network, only verifies the tag that would be sent downstream.
 */
import assert from 'node:assert';
import { normalizeOllamaModelName } from './src/local-inference.js';

let pass = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  console.log('  - ' + message);
  pass++;
};

console.log('=== local inference concrete model selection ===');

ok(
  normalizeOllamaModelName('gemma4:e4b', 'gemma2:2b') === 'gemma4:e4b',
  'explicit installed Gemma tag is preserved'
);
ok(
  normalizeOllamaModelName('local:gemma2:9b', 'gemma2:2b') === 'gemma2:9b',
  'local: prefix is stripped without changing the concrete tag'
);
ok(
  normalizeOllamaModelName('qwen2.5:7b', 'gemma2:2b') === 'qwen2.5:7b',
  'explicit Qwen Ollama tag is preserved'
);
ok(
  normalizeOllamaModelName('qwen-2.5-vlm-telegram-local', 'gemma2:2b') === 'gemma2:2b',
  'legacy gateway alias falls back to configured default'
);
ok(
  normalizeOllamaModelName('Qwen-2.5-7B-Quantized-Local', 'gemma2:2b') === 'gemma2:2b',
  'legacy quantized alias falls back to configured default'
);
ok(
  normalizeOllamaModelName('', 'gemma4:e4b') === 'gemma4:e4b',
  'empty model uses configured fallback'
);

console.log(`\nALL ${pass} local-inference model checks passed.`);
