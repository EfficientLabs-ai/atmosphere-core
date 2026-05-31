/**
 * engine.js — Folder-Stage Pipeline Engine (ICM "folders over agents"), v1.
 *
 * Orchestrates FILES and STAGE STATE only; model/script execution is injected (testable + swappable
 * local/BYOK/mesh). Per the Codex Pattern-C review, the heart is the freshness model:
 *   inputFingerprint(stage) = sha256(stage body + prior output + resolved reads + model + runner)
 *   same fingerprint + matching outputHash -> fresh (skip)
 *   same fingerprint + different on-disk output -> edited (respect the human's edit, don't overwrite)
 *   different fingerprint -> stale (re-run). Because each fingerprint includes the PRIOR output,
 *   re-running/editing any stage naturally invalidates every downstream stage. No separate cascade.
 * All writes are atomic (tmp+rename); a `running` meta found at start = a prior crash -> re-run.
 * Script stages are TRUSTED FIRST-PARTY ONLY in v1 (not a sandbox) — see stage-runners.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SAFE = /^[A-Za-z0-9._-]+$/;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Math.floor(performance.now())}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
function writeMeta(file, obj) { atomicWrite(file, JSON.stringify(obj, null, 2)); }

/** realpath-based containment: resolve `parts` under `root`, reject anything that escapes it. */
function safeJoin(root, ...parts) {
  const target = path.resolve(root, ...parts);
  const realRoot = fs.realpathSync(root);
  let probe = target;
  while (!fs.existsSync(probe)) probe = path.dirname(probe); // canonicalize the existing prefix
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
    throw new Error(`path escapes root: ${parts.join('/')}`);
  }
  return target;
}

/** Minimal frontmatter parser: ---\nkey: value\nkey: [a, b]\n--- body. No YAML dependency. */
export function parseStage(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text.trim() };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (!mm) continue;
    let v = mm[2].trim().replace(/^["']|["']$/g, '');
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    fm[mm[1]] = v;
  }
  return { frontmatter: fm, body: (m[2] || '').trim() };
}

/** The numbered stage directories ARE the order (single source of truth). */
export function discoverStages(pipelineDir) {
  const stagesDir = path.join(pipelineDir, 'stages');
  return fs.readdirSync(stagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((id) => {
      if (!SAFE.test(id)) throw new Error(`unsafe stage id: ${id}`);
      const dir = path.join(stagesDir, id);
      const { frontmatter, body } = parseStage(fs.readFileSync(path.join(dir, 'stage.md'), 'utf8'));
      return { id, dir, frontmatter, body };
    });
}

/**
 * Run a pipeline. Engine = file/state orchestration; runners are injected.
 * @param {string} pipelineDir
 * @param {Object} opts { runId, input, runners:{model,script}, stopAfter?, force?, runsRoot?, model? }
 */
export async function runPipeline(pipelineDir, opts = {}) {
  const { runId = `run-${Date.now()}`, input = '', runners = {}, stopAfter = null, force = false, runsRoot = null } = opts;
  if (!SAFE.test(runId)) throw new Error(`invalid runId: ${runId}`);
  pipelineDir = fs.realpathSync(pipelineDir);

  const runDir = path.join(runsRoot || path.join(pipelineDir, 'runs'), runId);
  fs.mkdirSync(runDir, { recursive: true });
  const inputFile = path.join(runDir, 'input.md');
  if (!fs.existsSync(inputFile) || force) atomicWrite(inputFile, String(input));

  const stages = discoverStages(pipelineDir);
  const refDir = path.join(pipelineDir, 'reference');
  const results = [];
  let priorOutputPath = inputFile;
  let blocked = false;

  for (const stage of stages) {
    const sDir = path.join(runDir, stage.id);
    fs.mkdirSync(sDir, { recursive: true });
    const outFile = path.join(sDir, 'output.md');
    const metaFile = path.join(sDir, 'meta.json');
    const promptFile = path.join(sDir, 'prompt.md');

    if (blocked) {
      writeMeta(metaFile, { stage: stage.id, status: 'blocked' });
      results.push({ stage: stage.id, status: 'blocked' });
      continue;
    }

    const priorOutput = fs.readFileSync(priorOutputPath, 'utf8');

    // resolve declared reads (reference files), path-safe
    const readsList = Array.isArray(stage.frontmatter.reads) ? stage.frontmatter.reads
      : (stage.frontmatter.reads ? [stage.frontmatter.reads] : []);
    let readsText = '';
    for (const r of readsList) {
      if (!SAFE.test(r)) throw new Error(`invalid reads entry: ${r}`);
      readsText += `\n\n--- reference: ${r} ---\n${fs.readFileSync(safeJoin(refDir, r), 'utf8')}`;
    }

    const type = stage.frontmatter.type || 'model';
    const model = stage.frontmatter.model || opts.model || 'default';
    const inputFingerprint = sha256(JSON.stringify({ body: stage.body, priorOutput, readsText, model, runner: type }));

    // freshness decision
    let decision = 'run';
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* none */ }
    if (meta && !force && meta.status !== 'running') {
      if (meta.inputFingerprint === inputFingerprint && fs.existsSync(outFile)) {
        const curHash = sha256(fs.readFileSync(outFile, 'utf8'));
        decision = curHash === meta.outputHash ? 'fresh' : 'edited';
      }
    }

    if (decision === 'fresh' || decision === 'edited') {
      results.push({ stage: stage.id, status: decision });
      priorOutputPath = outFile; // the (possibly edited) output feeds the next stage
      if (stopAfter === stage.id) break;
      continue;
    }

    // RUN this stage
    atomicWrite(promptFile, `# Effective input — ${stage.id}\n\n## Stage instructions\n${stage.body}\n\n## Prior output\n${priorOutput}${readsText}\n`);
    writeMeta(metaFile, { stage: stage.id, status: 'running', inputFingerprint, model, runner: type, startedAt: Date.now() });
    try {
      let output;
      if (type === 'model') {
        if (typeof runners.model !== 'function') throw new Error('no model runner injected');
        output = await runners.model({ system: stage.body, user: `${priorOutput}${readsText}`, model });
      } else if (type === 'script') {
        if (typeof runners.script !== 'function') throw new Error('no script runner injected');
        const scriptName = stage.frontmatter.script;
        if (!scriptName || !SAFE.test(scriptName)) throw new Error(`invalid/missing script: ${scriptName}`);
        output = await runners.script({ scriptPath: safeJoin(stage.dir, scriptName), stdin: priorOutput, cwd: sDir, timeoutMs: 30000 });
      } else {
        throw new Error(`unknown stage type: ${type}`);
      }
      output = String(output ?? '');
      atomicWrite(outFile, output);
      writeMeta(metaFile, { stage: stage.id, status: 'done', inputFingerprint, outputHash: sha256(output), model, runner: type, endedAt: Date.now() });
      results.push({ stage: stage.id, status: 'done' });
      priorOutputPath = outFile;
    } catch (e) {
      writeMeta(metaFile, { stage: stage.id, status: 'failed', error: e.message, endedAt: Date.now() });
      results.push({ stage: stage.id, status: 'failed', error: e.message });
      blocked = true; // downstream stages become blocked
    }
    if (stopAfter === stage.id) break;
  }
  return { runId, runDir, stages: results };
}
