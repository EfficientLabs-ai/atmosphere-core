/**
 * Pipeline engine test — exercises the Codex-required freshness state machine with INJECTED
 * deterministic runners (no model/child_process needed). Self-isolating temp dir.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipeline } from './src/pipeline/engine.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });
let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

// build a 3-stage demo pipeline (numbered dirs = order)
const P = path.join(ROOT, 'demo');
const mkStage = (id, body) => {
  const d = path.join(P, 'stages', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'stage.md'), `---\ntype: model\n---\n${body}`);
};
mkStage('01-upper', 'UPPERCASE the input.');
mkStage('02-reverse', 'REVERSE the input.');
mkStage('03-banner', 'BANNER the input.');

// deterministic model runner: transform based on the stage instruction keyword
const transform = ({ system, user }) =>
  system.includes('UPPERCASE') ? user.toUpperCase()
  : system.includes('REVERSE') ? [...user].reverse().join('')
  : system.includes('BANNER') ? `=== ${user} ===`
  : user;
const runners = { model: async (a) => transform(a) };
const runs = path.join(ROOT, 'runs');

console.log('=== pipeline engine ===');

// 1. fresh run
let r = await runPipeline(P, { runId: 'r1', input: 'hello', runners, runsRoot: runs });
ok(r.stages.every(s => s.status === 'done'), 'all stages ran (done)');
const final = fs.readFileSync(path.join(runs, 'r1', '03-banner', 'output.md'), 'utf8');
ok(final === '=== OLLEH ===', `pipeline composed correctly: "${final}" (banner∘reverse∘upper("hello"))`);
ok(fs.existsSync(path.join(runs, 'r1', '01-upper', 'prompt.md')), 'effective-input snapshot (prompt.md) written for provenance');

// 2. re-run, nothing changed → all fresh (skipped)
r = await runPipeline(P, { runId: 'r1', input: 'hello', runners, runsRoot: runs });
ok(r.stages.every(s => s.status === 'fresh'), 'unchanged re-run reuses everything (fresh)');

// 3. human edits stage 01 output → it is respected, downstream re-runs (stale via fingerprint)
fs.writeFileSync(path.join(runs, 'r1', '01-upper', 'output.md'), 'WORLD');
r = await runPipeline(P, { runId: 'r1', input: 'hello', runners, runsRoot: runs });
ok(r.stages[0].status === 'edited', 'stage 01 human edit detected as "edited" (not overwritten)');
ok(r.stages[1].status === 'done' && r.stages[2].status === 'done', 'downstream stages re-ran (invalidated by changed input)');
ok(fs.readFileSync(path.join(runs, 'r1', '01-upper', 'output.md'), 'utf8') === 'WORLD', 'edited output preserved');
ok(fs.readFileSync(path.join(runs, 'r1', '03-banner', 'output.md'), 'utf8') === '=== DLROW ===', 'final reflects the human edit (banner∘reverse("WORLD"))');

// 4. stopAfter halts
r = await runPipeline(P, { runId: 'r2', input: 'hi', runners, runsRoot: runs, stopAfter: '01-upper' });
ok(r.stages.length === 1 && r.stages[0].stage === '01-upper', 'stopAfter halts after the named stage');

// 5. a failing stage → failed + downstream blocked, no corruption
const boom = { model: async ({ system, user }) => { if (system.includes('REVERSE')) throw new Error('boom'); return transform({ system, user }); } };
r = await runPipeline(P, { runId: 'r3', input: 'hey', runners: boom, runsRoot: runs });
ok(r.stages[0].status === 'done' && r.stages[1].status === 'failed' && r.stages[2].status === 'blocked',
   'failure marks the stage failed and blocks downstream (no garbage output)');
ok(!fs.existsSync(path.join(runs, 'r3', '03-banner', 'output.md')), 'blocked stage wrote no output');

// 6. path traversal rejected
let threw = false;
try { await runPipeline(P, { runId: '../evil', input: 'x', runners, runsRoot: runs }); } catch { threw = true; }
ok(threw, 'path-traversal runId is rejected');

console.log(`\n✅ ALL ${pass} pipeline-engine checks passed.`);
