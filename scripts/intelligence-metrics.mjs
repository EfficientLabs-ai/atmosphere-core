#!/usr/bin/env node
/**
 * intelligence-metrics.mjs — compounding-intelligence metrics for the status surface (#79).
 *
 * The product is compounding intelligence (ADR-0002): the status page must show the GRAPH growing —
 * context, knowledge, skills, decisions, trust events, traces — not just uptime. This reads the live
 * stores READ-ONLY and emits one JSON object. Every source is independent and honest: absent/broken
 * store → value null + reason (never a fabricated count; truth gate applies to metrics too).
 *
 *   node scripts/intelligence-metrics.mjs          # JSON to stdout
 *
 * Sources (all local, sovereign):
 *   context_nodes      ambient_memory rows        (LanceDB .stratos-vector-store)
 *   knowledge_nodes    intercepted_reasoning rows (LanceDB)
 *   skills             cognitive_skills rows      (LanceDB)
 *   decisions          ADR files                  (command-center 05_decisions, if present)
 *   workflows          workflow dirs              (.stratos-profile/workspaces)
 *   trust_events       receipt lines              (*.receipt.jsonl under the profile)
 *   execution_traces   trace files                (workspaces *\/traces\/*.json)
 *   predictions        not built yet → null       (honest)
 *   cost_saved_usd     not measured yet → null    (honest — needs receipts→pricing mapping)
 *   time_saved_hours   not measured yet → null    (honest)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = process.env.STRATOS_PROFILE_DIR || path.join(ROOT, '.stratos-profile');
const CC_DECISIONS = process.env.EFL_DECISIONS_DIR || '/opt/efficient-labs/command-center/05_decisions';

const honest = (fn) => { try { const v = fn(); return { value: v, }; } catch (e) { return { value: null, reason: e.message.slice(0, 100) }; } };

async function lanceCount(table) {
  const lancedb = await import('@lancedb/lancedb');
  const db = await lancedb.connect(path.join(ROOT, '.stratos-vector-store'));
  const t = await db.openTable(table);
  return await t.countRows();
}

function* walk(dir, depth = 6) {
  if (depth < 0 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') yield* walk(p, depth - 1);
    else if (e.isFile()) yield p;
  }
}

export async function collectMetrics() {
  const out = { generated_for: 'efficientlabs status surface', source: 'intelligence-metrics.mjs (read-only, local)' };

  for (const [key, table] of [['context_nodes', 'ambient_memory'], ['knowledge_nodes', 'intercepted_reasoning'], ['skills', 'cognitive_skills']]) {
    try { out[key] = { value: await lanceCount(table) }; }
    catch (e) { out[key] = { value: null, reason: `vector store unavailable: ${e.message.slice(0, 80)}` }; }
  }

  out.decisions = honest(() => fs.readdirSync(CC_DECISIONS).filter((f) => /^ADR-.*\.md$/.test(f)).length);
  out.workflows = honest(() => {
    const ws = path.join(PROFILE, 'workspaces');
    let n = 0;
    for (const f of walk(ws, 4)) if (f.endsWith(path.join('', 'workflow.json')) || /\/workflows?\//.test(f)) n++;
    // fall back to counting workflow-level dirs in the canonical tree shape
    if (n === 0 && fs.existsSync(ws)) n = fs.readdirSync(ws).length;
    return n;
  });
  out.trust_events = honest(() => {
    // Segment-aware: rotated archives (*.segment) count too, and a rotation control line
    // ({_prev_head: ...} lineage marker) is NOT a receipt — never counted.
    let n = 0;
    const isReceiptLine = (l) => {
      try { return typeof JSON.parse(l)._prev_head !== 'string'; } catch { return false; }
    };
    for (const f of walk(PROFILE)) {
      if (f.endsWith('.receipt.jsonl') || f.endsWith('live-receipts.jsonl') || /live-receipts\.jsonl\..*\.segment$/.test(f)) {
        n += fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).filter(isReceiptLine).length;
      }
    }
    return n;
  });
  out.execution_traces = honest(() => {
    let n = 0;
    for (const f of walk(PROFILE)) if (/\/traces\/.*\.json$/.test(f)) n++;
    return n;
  });

  // Honest nulls — these capabilities are not built/measured yet (truth gate):
  out.predictions = { value: null, reason: 'prediction layer not built (post-SPRINT_001 roadmap)' };
  out.cost_saved_usd = { value: null, reason: 'not measured yet — needs receipts→pricing mapping (measurement before claims)' };
  out.time_saved_hours = { value: null, reason: 'not measured yet' };

  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) console.log(JSON.stringify(await collectMetrics(), null, 2));
