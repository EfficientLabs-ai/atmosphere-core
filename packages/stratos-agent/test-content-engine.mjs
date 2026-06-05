// test-content-engine.mjs — the reusable CONTENT ENGINE (personal-brand + company pipeline).
// Hermetic: a TEMP content dir, an INJECTED model fetch (no live daemon/Ollama/network), an injected
// build-log + clock + content dir via run() deps. Proves: angle selection SKIPS used angles; per-platform
// structure is assembled from the mocked model JSON; used.json updates (re-run → fresh, no repeats); the
// build log self-grows the bank; the capability gate (deny-by-default); and the honest fail-open degrade
// when the model endpoint is down (clear message, no crash, NO fabricated content).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './src/cli/stratos-cli.js';
import { parseCapabilities } from './src/security/capability-gate.js';
import { selectAngles, mineBuildLogAngles, parseModelJson, renderPiece } from './src/content/content-engine.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const text = (r) => r.lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

console.log('content engine — infinite, repeatable, sovereign-default pipeline\n');

// --- isolated private content dir -------------------------------------------------------------------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-content-'));
fs.writeFileSync(path.join(DIR, 'profile.md'), '# Profile\nVoice: authentic, abundance-not-bitter. Honesty rule: never fabricate metrics.\n');
fs.writeFileSync(path.join(DIR, 'angles.json'), JSON.stringify({ angles: [
  { id: 'a001', lane: 'labs', theme: 'data-sharecropping', hook_seed: 'There is a word for it: sharecropping.', status: 'unused' },
  { id: 'a002', lane: 'personal', theme: 'flint', hook_seed: 'I am from Flint.', status: 'unused' },
  { id: 'a003', lane: 'labs', theme: 'zero-cost', hook_seed: 'Watch an AI bill go to zero.', status: 'unused' },
] }, null, 2));
fs.writeFileSync(path.join(DIR, 'used.json'), JSON.stringify({ used: [] }));

// --- pure helpers ----------------------------------------------------------------------------------
const bank = JSON.parse(fs.readFileSync(path.join(DIR, 'angles.json'), 'utf8')).angles;
ok(selectAngles(bank, ['a001'], { lane: 'labs', n: 5 }).every((a) => a.id !== 'a001'), 'selectAngles SKIPS used angle ids');
ok(selectAngles(bank, [], { lane: 'personal', n: 5 }).every((a) => a.lane === 'personal' || a.lane === 'both'), 'selectAngles filters by lane');
const mined = mineBuildLogAngles(['feat: ship signed receipts', 'merge branch main', 'wip'], new Set());
ok(mined.length === 1 && mined[0].source === 'build-log', 'mineBuildLogAngles keeps real commits, drops merge/wip noise');
ok(parseModelJson('```json\n{"hook":"hi"}\n```').hook === 'hi', 'parseModelJson unwraps fenced JSON');
ok(renderPiece({ angle: { id: 'a1', theme: 't' }, platform: 'x', tone: 'raw', piece: { hook: 'H', thread: ['t1', 't2'], single: 'S', cta: 'C' } }).includes('THREAD'), 'renderPiece assembles X thread structure');

// --- mocked model: returns valid per-platform JSON --------------------------------------------------
const reqs = [];
const mockFetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  reqs.push({ url, model: body.model, system: body.messages[0].content });
  // Echo a schema-valid payload for whatever platform was asked (the user prompt names the schema keys).
  const u = body.messages[1].content;
  let piece;
  if (u.includes('PLATFORM: carousel')) piece = { hook: 'h', cover: 'cov', slides: ['s1', 's2', 's3'], cta: 'follow' };
  else if (u.includes('PLATFORM: linkedin')) piece = { hook: 'h', body: 'b', cta: 'follow' };
  else if (u.includes('PLATFORM: short-video')) piece = { hook: 'h', body: 'b', cta: 'follow', broll: 'aurora push-in' };
  else piece = { hook: 'h', thread: ['t1', 't2', 't3'], single: 's', cta: 'follow' };
  return { ok: true, status: 200, json: async () => ({ model: 'mock', choices: [{ message: { content: JSON.stringify(piece) } }] }) };
};
const NOW = new Date('2026-06-06T12:00:00Z');
const deps = (extra = {}) => ({ version: '0.0.0-test', contentDir: DIR, contentFetch: mockFetch, contentNow: NOW, buildLog: () => ['feat: wire the content engine'], ...extra });

// --- generate across all platforms + a couple tones -------------------------------------------------
let r = await run(['content', 'generate', '--lane', 'labs', '--platform', 'all', '--tone', 'raw', '--n', '2'], deps());
ok(r.code === 0, 'content generate exits 0 on a healthy run');
const t = text(r);
ok(/✓ \d+ piece\(s\)/.test(t), 'reports how many pieces were produced');
ok(/fresh angle\(s\) mined from the build log/.test(t), 'self-grows: mines a fresh angle from the build log');
const m = t.match(/→ (\S+\.md)/);
ok(m, 'writes a dated batch file path');
const batchMd = fs.readFileSync(m[1], 'utf8');
ok(batchMd.includes('THREAD') && batchMd.includes('COVER') && batchMd.includes('B-ROLL'), 'batch contains X-thread, carousel cover, and short-video b-roll structures');
ok(!/\b\d{2,}[%kK]?\s+(users|customers|signups|revenue)\b/.test(batchMd), 'batch carries no fabricated user/revenue metrics');
ok(reqs.every((q) => q.url.includes('127.0.0.1:4099') && q.system.includes('never fabricate')), 'sovereign-default endpoint + honesty rule in every system prompt');

// --- used.json updated; re-run is FRESH (no repeats) ------------------------------------------------
const used1 = JSON.parse(fs.readFileSync(path.join(DIR, 'used.json'), 'utf8')).used;
ok(used1.includes('a001') && used1.includes('a003'), 'used.json records the consumed angle ids');
r = await run(['content', 'generate', '--lane', 'labs', '--platform', 'x', '--n', '2'], deps({ buildLog: () => [] }));
const t2 = text(r);
ok(!/a001|a003/.test(t2) || /a002|bl-/.test(t2), 're-run draws DIFFERENT (unused) angles — no repeats');

// --- capability gate: deny-by-default ---------------------------------------------------------------
r = await run(['content', 'generate'], deps({ contentCaps: parseCapabilities({ capabilities: { actions: [] } }) }));
ok(r.code === 1 && /CAPABILITY DENIED/.test(text(r)), 'denied caps → fail-closed, no generation');

// --- honest degrade: model endpoint down ------------------------------------------------------------
const downFetch = async () => { throw new Error('ECONNREFUSED'); };
const DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-content-'));
fs.copyFileSync(path.join(DIR, 'profile.md'), path.join(DIR2, 'profile.md'));
fs.writeFileSync(path.join(DIR2, 'angles.json'), JSON.stringify({ angles: [{ id: 'x1', lane: 'labs', theme: 't', hook_seed: 'h', status: 'unused' }] }));
fs.writeFileSync(path.join(DIR2, 'used.json'), JSON.stringify({ used: [] }));
r = await run(['content', 'generate', '--n', '1'], deps({ contentDir: DIR2, contentFetch: downFetch, buildLog: () => [] }));
const dt = text(r);
ok(r.code === 1, 'down model → non-zero exit (no crash)');
ok(/unreachable/.test(dt) && /start your local daemon|CONTENT_ENDPOINT/.test(dt), 'degrade gives a clear, actionable message');
ok(!fs.existsSync(path.join(DIR2, 'batches')) || fs.readdirSync(path.join(DIR2, 'batches')).length === 0, 'degrade writes NO batch file — nothing fabricated');

// --- missing profile guard --------------------------------------------------------------------------
const DIR3 = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-content-'));
r = await run(['content', 'generate'], deps({ contentDir: DIR3 }));
ok(r.code === 1 && /no profile/.test(text(r)), 'missing profile → clear error, no crash');

// --- help -------------------------------------------------------------------------------------------
r = await run(['content'], deps());
ok(r.code === 1 && /content generate/.test(text(r)), 'bare `content` prints usage (non-zero)');
r = await run(['content', 'help'], deps());
ok(r.code === 0 && /sovereign/.test(text(r)) && /CONTENT_MODEL/.test(text(r)), 'help documents sovereign-default + configurable model');

// cleanup temp dirs
for (const d of [DIR, DIR2, DIR3]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }

console.log(`\n${pass} assertions passed.`);
