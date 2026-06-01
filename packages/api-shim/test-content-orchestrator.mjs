/**
 * content-orchestrator tests: dry-run by default (no spend without explicit confirm), up-front cost
 * estimate, Remotion-shaped composition, shot clamping, no-fabricated-stats prompt, real-run wiring.
 */
import assert from 'node:assert';
import { createContentOrchestrator } from './src/content-orchestrator.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

let generateCalls = 0;
const generate = async ({ kind, prompt }) => { generateCalls++; return { output: { ref: `${kind}://${generateCalls}` }, costUsd: kind === 'image' ? 0.04 : kind === 'video' ? 0.5 : 0.002 }; };
const orch = createContentOrchestrator({ generate });
const BRIEF = { topic: 'The cloud is a ceiling', durationSec: 30, shots: 3, video: true };

console.log('=== plan() never spends + estimates cost up front ===');
const p = orch.plan(BRIEF);
ok(generateCalls === 0, 'plan() does NOT call the generate backend (zero spend)');
ok(p.willSpend === false && p.estimate.opCount === 5, 'plan: 1 script + 3 images + 1 video = 5 ops, willSpend false');
ok(p.estimate.totalUsd === Number((0.002 + 3 * 0.04 + 0.5).toFixed(4)), 'cost estimate is computed per kind up front');

console.log('\n=== no fabricated stats baked into the script prompt ===');
ok(/do not invent statistics/i.test(p.ops[0].prompt), 'the script op prompt forbids invented stats (honesty rule)');

console.log('\n=== run() is dry-run UNLESS confirm:true ===');
const dry = await orch.run(BRIEF);
ok(dry.executed === false && generateCalls === 0, 'run() without confirm → dry-run, still zero spend');
ok(dry.estimate.totalUsd > 0, 'dry-run surfaces the estimate so the human sees the bill first');

console.log('\n=== run({confirm:true}) executes via the injected backend + sums real cost ===');
const real = await orch.run(BRIEF, { confirm: true });
ok(real.executed === true && generateCalls === 5, 'confirm:true → generate called once per op (5)');
ok(real.actualUsd === Number((0.002 + 3 * 0.04 + 0.5).toFixed(4)), 'actual cost summed from the backend');
ok(real.results.every((r) => r.output && r.output.ref), 'each op produced an output ref');

console.log('\n=== composition is Remotion-shaped ===');
const c = real.composition;
ok(c.composition === 'AtmosphereShort' && c.fps === 30 && c.width === 1080 && c.height === 1920, 'vertical short-form composition spec');
ok(Array.isArray(c.scenes) && c.scenes.length === 5 && c.scenes[0].kind === 'text', 'scenes map to the ops with refs + kinds');

console.log('\n=== guardrails: shot clamping + a backend is required to actually spend ===');
ok(orch.plan({ topic: 'x', shots: 999 }).ops.filter((o) => o.kind === 'image').length === 12, 'shots are clamped to MAX_SHOTS (12)');
let threw = false;
try { await createContentOrchestrator({}).run({ topic: 'x' }, { confirm: true }); } catch { threw = true; }
ok(threw, 'confirm:true with no generate backend → throws (cannot silently no-op a spend request)');

console.log(`\n✅ ALL ${pass} content-orchestrator checks passed.`);
