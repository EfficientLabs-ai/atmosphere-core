/**
 * test-active-vision-honesty.mjs — regression guard for atmosphere-core#62 / EFL-002.
 *
 * The live gateway (local-inference.js isVisualQuery branch) calls ActiveVisionEngine
 * .parseActiveVisualContext(). It must:
 *   1) return '' by default (no real VLM wired → no fabricated/invented screen context), AND
 *   2) be null-safe — callable with NO screenshot path (Codex caught a path.basename(undefined) crash).
 *   3) emit synthetic output ONLY behind STRATOS_SYNTHETIC_VISION, clearly labeled, never as a real VLM.
 *
 * Hermetic: no network, no Ollama, no live services (on non-win32 the window lookup is a static fallback).
 */
import assert from 'node:assert';
import { ActiveVisionEngine } from '../atmos-desktop/src/sensory/active-vision.js';

const v = new ActiveVisionEngine({ verbose: false });

// 1 + 2: no-arg default must be '' and must NOT throw (the regression Codex found).
const def = await v.parseActiveVisualContext();
assert.strictEqual(def, '', `default parseActiveVisualContext() must be '' (got: ${JSON.stringify(def)})`);

// default stays '' even with a path, while no synthetic flag is set
const withPath = await v.parseActiveVisualContext('/tmp/none.png');
assert.strictEqual(withPath, '', 'default must be empty even when a screenshot path is supplied');

// 3: opt-in synthetic output is labeled, never presented as a real VLM analysis
process.env.STRATOS_SYNTHETIC_VISION = '1';
const syn = await v.parseActiveVisualContext();
assert.ok(/SYNTHETIC DEMO/.test(syn), 'synthetic output must be labeled "[SYNTHETIC DEMO …]"');
assert.ok(!/\[Local Vision-Language Model Analysis\]/.test(syn), 'must never present synthetic output as a real VLM analysis');
delete process.env.STRATOS_SYNTHETIC_VISION;

console.log('  ✓ active-vision: default empty + null-safe, synthetic labeled — no fabrication on the live path');
