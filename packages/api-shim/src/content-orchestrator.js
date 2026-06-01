/**
 * content-orchestrator.js — the sovereign content pipeline (Task #17): brief → script → shotlist →
 * image/video → a Remotion-ready composition spec, routed through the model gateway.
 *
 * SAFETY POSTURE (the whole point of this module):
 *   - DRY-RUN BY DEFAULT. `plan()` and `run()` never spend a cent unless `run(brief, {confirm:true})`
 *     is called explicitly. The model/agent cannot trigger paid image/video generation by accident.
 *   - COST IS ALWAYS ESTIMATED UP FRONT, per kind, before any spend, so the human sees the bill first.
 *   - NO FABRICATED METRICS: the script prompt explicitly forbids invented stats (the standing honesty
 *     rule); generated copy is the model's, but we never seed it with fake numbers.
 *
 * `generate({kind, prompt, model}) → {output, costUsd}` is injected (prod = the universal gateway /
 * passthroughCloud; image/video via BYOK providers). Tests inject a stub so nothing external is called.
 */

// rough per-operation USD ESTIMATES (clearly estimates — real cost comes back from generate()).
const DEFAULT_COSTS = { text: 0.002, image: 0.04, video: 0.5 };
const MAX_SHOTS = 12;

export function createContentOrchestrator({ generate, costs = DEFAULT_COSTS } = {}) {
  function buildPlan(brief = {}) {
    const topic = String(brief.topic || 'untitled').slice(0, 200);
    const durationSec = Math.max(5, Math.min(Number(brief.durationSec) || 30, 180));
    const shots = Math.max(1, Math.min(Number(brief.shots) || 3, MAX_SHOTS));
    const ops = [];
    ops.push({ id: 'script', kind: 'text', model: brief.textModel || 'local',
      prompt: `Write a ${durationSec}s short-form video script about: ${topic}. Strong hook in the first line. Do NOT invent statistics, percentages, or dollar figures — only claims that are true.` });
    for (let i = 0; i < shots; i++) {
      ops.push({ id: `image-${i + 1}`, kind: 'image', model: brief.imageModel || 'byok',
        prompt: `Shot ${i + 1} of ${shots} for "${topic}" — ${brief.style || 'clean, sovereign, atmospheric, high-contrast'}` });
    }
    if (brief.video) ops.push({ id: 'video', kind: 'video', model: brief.videoModel || 'byok', prompt: `Animate the hero shot for "${topic}"` });
    return ops;
  }

  function estimate(ops) {
    const byKind = {};
    let totalUsd = 0;
    for (const op of ops) { const c = costs[op.kind] ?? 0; totalUsd += c; byKind[op.kind] = Number(((byKind[op.kind] || 0) + c).toFixed(4)); }
    return { totalUsd: Number(totalUsd.toFixed(4)), byKind, opCount: ops.length };
  }

  function composeSpec(brief, items) {
    const durationSec = Math.max(5, Math.min(Number(brief?.durationSec) || 30, 180));
    return {
      composition: 'AtmosphereShort',
      fps: 30, width: 1080, height: 1920, durationSec, // vertical short-form
      scenes: items.map((it, i) => ({ index: i, id: it.id, kind: it.kind, ref: it.output?.ref ?? null, prompt: it.prompt })),
    };
  }

  /** PLAN ONLY — never spends. The default, safe entrypoint. */
  function plan(brief) {
    const ops = buildPlan(brief);
    return { willSpend: false, ops, estimate: estimate(ops), composition: composeSpec(brief, ops) };
  }

  /** EXECUTE — only spends when confirm:true is passed explicitly; otherwise returns the dry-run plan. */
  async function run(brief, { confirm = false } = {}) {
    const ops = buildPlan(brief);
    const est = estimate(ops);
    if (!confirm) return { executed: false, reason: 'dry-run (pass {confirm:true} to spend)', estimate: est, ops };
    if (typeof generate !== 'function') throw new Error('run({confirm:true}) needs an injected generate() backend');
    const results = [];
    let actualUsd = 0;
    for (const op of ops) {
      const r = await generate({ kind: op.kind, prompt: op.prompt, model: op.model });
      actualUsd += Number(r?.costUsd || 0);
      results.push({ ...op, output: r?.output ?? null });
    }
    return { executed: true, estimate: est, actualUsd: Number(actualUsd.toFixed(4)), results, composition: composeSpec(brief, results) };
  }

  return { plan, run, estimate, composeSpec, _buildPlan: buildPlan };
}
