/**
 * improvement-engine.js — the SELF-IMPROVEMENT COMPRESSION engine (Increment 3 of the operating core).
 *
 * "Every eval gets compressed into something reusable." This is the final, closing hops of the canonical
 * loop (SELF_IMPROVEMENT_LOOP.md; TRACE_SCHEMA.md §Self-improvement):
 *
 *     trace → evaluation → lesson → updated instruction → reusable skill
 *
 * Increment 1 wrote the TRACE, Increment 2 scored it into an EVAL that EMITS candidate lessons on every
 * failed criterion. This module CONSUMES those lessons + the trace and performs the compression step,
 * persisting three durable artifacts under the Task folder:
 *
 *   1. a LESSON record           — distilled from the failed criteria + the eval's candidate lessons,
 *                                  written to <task>/skills/lessons/{lesson-id}.json (+ an index).
 *   2. an UPDATED INSTRUCTION     — the lesson's suggested_instruction appended to <task>/instructions.md
 *                                  under a managed "## Lessons learned" section. IDEMPOTENT: each applied
 *                                  lesson carries a stable id; a re-run never duplicates an already-applied
 *                                  lesson (the applied-ids ledger is the dedupe key).
 *   3. a REUSABLE SKILL scaffold  — ONLY when the eval PASSED. Seeded from the "what worked" trace path,
 *                                  emitted in the EXISTING SKILL.md format (skill-md.js) to
 *                                  <task>/skills/{skill-name}/skill.md + examples/ + tools.json, and
 *                                  registered through the EXISTING SkillStore (skill-store.js) so it loads
 *                                  back exactly like any other instruction skill. A FAILED run is NEVER
 *                                  promoted to a skill — you don't bottle a failure.
 *
 * DETERMINISTIC, RULE/TEMPLATE-BASED CORE — NO LLM, NO NETWORK. Same discipline as workspace-tree /
 * trace-engine / eval-engine: pure node:fs + the existing skill format; injectable clock for tests. The
 * lesson body and the skill body are produced by deterministic templating over the eval + trace. An
 * LLM-assisted distiller is an EXPLICIT `opts.distill` hook, OFF BY DEFAULT and HONEST: a throwing or
 * absent distiller degrades to the deterministic template — it NEVER fabricates a lesson or a skill.
 *
 * HONEST SCOPE (read this before extending it): this is GENERAL lesson→instruction→skill compression at
 * the operating-core level. It distills evals into prose lessons, patches instructions, and scaffolds
 * PORTABLE INSTRUCTION skills (the SKILL.md format — prose + capabilities, not executable code). It does
 * NOT, and is not meant to, auto-generate arbitrary executable code. That capability is the separate,
 * flag-gated, deterministic numeric-transform self-evolution loop in src/evolution/ (self-evolution.js
 * → skill-induction.js → gsi-compiler.js → skill-seal.js), which this engine COMPLEMENTS and never
 * modifies. The two are intentionally distinct: evolution mints signed executing WASM for a narrow
 * typed class; this engine compresses general task experience into reusable instruction/skill text.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveTask } from '../workspace/workspace-tree.js';
import { emitSkillMd, parseSkillMd } from '../skills/skill-md.js';
import { SkillStore } from '../skills/skill-store.js';
import { parseCapabilities } from '../security/capability-gate.js';

const asStr = (v) => (v == null ? '' : String(v));

/** The managed section header appended to instructions.md. Stable so re-runs find + extend it idempotently. */
export const LESSONS_HEADING = '## Lessons learned';
/** Marker that precedes the applied-lesson ledger inside the managed section (one HTML comment per id). */
const APPLIED_MARK = '<!-- applied-lesson:';

/** A stable, content-addressed id for a candidate lesson. Same criterion+detail+instruction ⇒ same id. */
export function lessonId(lesson = {}) {
  const basis = [asStr(lesson.criterion), asStr(lesson.severity), asStr(lesson.suggested_instruction || lesson.detail)].join('\0');
  const h = crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12);
  const slug = (asStr(lesson.criterion) || 'lesson').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lesson';
  return `lesson.${slug}.${h}`;
}

/** Slugify a name into a single safe path segment for a skill folder / skill id. */
function slugify(s, fallback = 'skill') {
  const out = asStr(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || fallback;
}

/**
 * DISTILL the eval's candidate lessons into a single LESSON record (deterministic template). The eval
 * emits one candidate lesson per FAILED criterion; we fold them into one record carrying the highest
 * severity, the per-criterion details, and the concrete suggested instructions to apply. The optional
 * `distill` hook may REPLACE the prose `body`/`summary` (never the structured fields); a throwing/absent/
 * malformed hook degrades to the deterministic template, never a fabricated lesson.
 */
function distillLesson(evalRecord, trace, distill) {
  const candidates = Array.isArray(evalRecord.lessons) ? evalRecord.lessons : [];
  const rank = { low: 1, medium: 2, high: 3 };
  const severity = candidates.reduce((acc, l) => (rank[l.severity] > rank[acc] ? l.severity : acc), 'low');
  const suggestions = [];
  for (const l of candidates) {
    const s = asStr(l.suggested_instruction).trim();
    if (s && !suggestions.includes(s)) suggestions.push(s);
  }
  const failedCriteria = candidates.map((l) => asStr(l.criterion)).filter(Boolean);

  // Deterministic template body.
  const lines = [];
  lines.push(`Eval of task "${asStr(evalRecord.task_id)}" did not pass (${evalRecord.score}/${evalRecord.max_score}).`);
  if (failedCriteria.length) lines.push(`Failed criteria: ${failedCriteria.join(', ')}.`);
  for (const l of candidates) {
    lines.push(`- ${asStr(l.criterion)} (${asStr(l.severity)}): ${asStr(l.detail)}`);
  }
  let body = lines.join('\n');
  let summary = suggestions[0] || `Address: ${failedCriteria.join(', ') || 'evaluation gaps'}.`;

  // OFF-BY-DEFAULT distiller (TARGET hook). May enrich the prose; structured fields stay authoritative.
  if (typeof distill === 'function') {
    try {
      const d = distill({ evalRecord, trace, candidates, severity, suggestions });
      if (d && typeof d === 'object') {
        if (typeof d.body === 'string' && d.body.trim()) body = d.body.trim();
        if (typeof d.summary === 'string' && d.summary.trim()) summary = d.summary.trim();
      }
    } catch { /* honest degrade: keep the deterministic template, never fabricate */ }
  }

  return { severity, failedCriteria, suggestions, summary, body };
}

/** Persist a LESSON record under <task>/skills/lessons/ and maintain a small index. Returns the record. */
function persistLesson(lessonsDir, record) {
  fs.mkdirSync(lessonsDir, { recursive: true });
  const file = path.join(lessonsDir, `${record.id}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  const indexPath = path.join(lessonsDir, 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { index = {}; }
  index[record.id] = { id: record.id, severity: record.severity, summary: record.summary, created: record.created, file: `${record.id}.json` };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  return { record, file };
}

/** Read the set of already-applied lesson ids from instructions.md (the idempotency ledger). */
function appliedIds(instructionsText) {
  const ids = new Set();
  const re = /<!--\s*applied-lesson:\s*([A-Za-z0-9._-]+)\s*-->/g;
  let m;
  while ((m = re.exec(instructionsText)) != null) ids.add(m[1]);
  return ids;
}

/**
 * Append a lesson's suggested instructions to instructions.md UNDER a managed "## Lessons learned"
 * section, IDEMPOTENTLY. Each lesson is fenced with `<!-- applied-lesson:{id} -->` so a re-run that sees
 * the id already present makes NO change. Returns { applied, instructionsFile, alreadyApplied }.
 */
function applyInstruction(instructionsFile, lesson) {
  let text = '';
  try { text = fs.readFileSync(instructionsFile, 'utf8'); } catch { text = ''; }
  const already = appliedIds(text);
  if (already.has(lesson.id)) {
    return { applied: false, alreadyApplied: true, instructionsFile };
  }

  // Build the block for THIS lesson — the marker (dedupe key) + the concrete instruction lines.
  const block = [];
  block.push(`${APPLIED_MARK}${lesson.id} -->`);
  const items = lesson.suggestions.length ? lesson.suggestions : [lesson.summary];
  for (const s of items) block.push(`- ${s}`);
  const blockText = block.join('\n');

  let next;
  if (text.includes(LESSONS_HEADING)) {
    // Extend the existing managed section: insert the block right after the heading line.
    next = text.replace(LESSONS_HEADING, `${LESSONS_HEADING}\n\n${blockText}`);
  } else {
    const sep = text.endsWith('\n') ? '\n' : '\n\n';
    next = `${text}${sep}${LESSONS_HEADING}\n\n${blockText}\n`;
  }
  if (!next.endsWith('\n')) next += '\n';
  fs.writeFileSync(instructionsFile, next);
  return { applied: true, alreadyApplied: false, instructionsFile };
}

/** The successful "what worked" steps a skill is seeded from — the non-error, summarized trace path. */
function successfulSteps(trace) {
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  return steps
    .filter((s) => s && s.kind !== 'error' && !/\berror\b|\bfailed\b|\bexception\b/i.test(asStr(s.summary)))
    .map((s) => ({ kind: asStr(s.kind), summary: asStr(s.summary), tool: asStr(s.tool), permission: asStr(s.permission) }));
}

/**
 * Scaffold a REUSABLE SKILL from a PASSED eval's trace, in the EXISTING SKILL.md format. Writes:
 *   <task>/skills/{skill-name}/skill.md       (emitSkillMd — portable frontmatter + body)
 *   <task>/skills/{skill-name}/tools.json     (the capabilities the worked path used; deny-by-default)
 *   <task>/skills/{skill-name}/examples/used-trace.json   (the "what worked" example)
 * and REGISTERS the skill through the existing SkillStore (rooted at <task>/skills) so it loads back.
 * Returns { id, name, dir, skillMdFile, toolsFile, examplesDir, record }.
 */
function scaffoldSkill(skillsDir, { name, trace, evalRecord, now }) {
  const skillName = name || `${slugify(evalRecord.task_id)}-skill`;
  const slug = slugify(skillName, 'skill');
  const dir = path.join(skillsDir, slug);
  const examplesDir = path.join(dir, 'examples');
  fs.mkdirSync(examplesDir, { recursive: true });

  const worked = successfulSteps(trace);
  const toolsUsed = Array.from(new Set(worked.map((s) => s.tool).filter(Boolean)));
  const permissions = Array.from(new Set(worked.map((s) => s.permission).filter(Boolean)));

  // Deterministic SKILL.md body — the reusable "how it worked" recipe distilled from the trace path.
  const bodyLines = [];
  bodyLines.push(`# ${skillName}`);
  bodyLines.push('');
  bodyLines.push(`Reusable skill compressed from a PASSING run of task "${asStr(evalRecord.task_id)}".`);
  bodyLines.push('');
  bodyLines.push('## What worked');
  bodyLines.push('');
  if (worked.length) {
    for (const s of worked) {
      const tl = s.tool ? ` [${s.tool}]` : '';
      bodyLines.push(`1. (${s.kind})${tl} ${s.summary || '—'}`.replace(/^1\./, '-'));
    }
  } else {
    bodyLines.push('- (no per-step summaries recorded on the trace)');
  }
  bodyLines.push('');
  bodyLines.push('## When to use');
  bodyLines.push('');
  bodyLines.push(`Apply this when the task resembles "${asStr(evalRecord.task_id)}" and the same tools are available.`);
  const body = bodyLines.join('\n') + '\n';

  // The capabilities the worked path actually used — deny-by-default, mirrors the task tools.json shape.
  const capManifest = { capabilities: { actions: toolsUsed.slice(), net: [], fs: [], secrets: [] } };
  const caps = parseCapabilities(capManifest);
  const toolsJson = {
    capabilities: { actions: toolsUsed.slice(), net: [], fs: [], secrets: [] },
    tools: toolsUsed.slice(),
    permissions,
  };

  const description = `Reusable skill distilled from a passing run of ${asStr(evalRecord.task_id)}`;
  const metadata = {
    source: 'self-improve',
    origin_task: asStr(evalRecord.task_id),
    eval_score: `${evalRecord.score}/${evalRecord.max_score}`,
    capabilities: { actions: toolsUsed.slice() },
  };

  // Emit in the EXISTING SKILL.md format (skill-md.js) — portable frontmatter + body.
  const skillMd = emitSkillMd({ name: skillName, description, metadata, body });
  const skillMdFile = path.join(dir, 'skill.md');
  fs.writeFileSync(skillMdFile, skillMd);

  const toolsFile = path.join(dir, 'tools.json');
  fs.writeFileSync(toolsFile, JSON.stringify(toolsJson, null, 2) + '\n');

  // The "what worked" example seeded from the successful trace path.
  const exampleFile = path.join(examplesDir, 'used-trace.json');
  fs.writeFileSync(exampleFile, JSON.stringify({ task_id: evalRecord.task_id, steps: worked, outputs: trace.outputs || [] }, null, 2) + '\n');

  // Build the skill RECORD in the same shape importSkillMd produces, and register it via the EXISTING
  // SkillStore so it loads back exactly like any other instruction skill. The store roots at <task>/skills
  // and keeps its own imported/ index (a self-improve skill is a locally-authored instruction skill).
  const id = `selfimprove.${slug}`;
  const record = {
    id,
    name: skillName,
    description,
    body,
    metadata,
    kind: 'instruction',
    trust: 'local',                 // authored by THIS node from its own passing run (not foreign/untrusted)
    sealed: false,
    capabilities: caps,
    provenance: {
      source: 'self-improve',
      origin_task: asStr(evalRecord.task_id),
      created: new Date(now()).toISOString(),
    },
  };
  const store = new SkillStore(skillsDir);
  store.put(id, record);

  return { id, name: skillName, slug, dir, skillMdFile, toolsFile, examplesDir, exampleFile, record, store };
}

/**
 * improve({ taskPath, trace, evalRecord, ... }) — the COMPRESSION step. Consumes the eval's candidate
 * lessons + the trace and persists the lesson, the (idempotent) instruction update, and — only when the
 * eval PASSED — a reusable SKILL scaffold in the existing SKILL.md/SkillStore format.
 *
 * @param {object} o
 *   @param {string}  o.taskPath     slash path "ws/proj/wf/task[/subtask]" (must exist). Defaults from
 *                                   the eval's workspace/project/workflow/task_id if omitted.
 *   @param {object}  o.trace        the trace record (as written by trace-engine / read by readTrace).
 *   @param {object}  o.evalRecord   the EvalRecord (as written by eval-engine; carries .lessons + .passed).
 *   @param {string}  [o.root]       workspaces root (default: workspace-tree.defaultRoot()).
 *   @param {string}  [o.skillName]  name for the scaffolded skill (passed run only). Defaults from task_id.
 *   @param {function}[o.distill]    *** TARGET, OFF BY DEFAULT *** LLM-assisted lesson distiller hook.
 *   @param {function}[o.now]        injectable clock (ms) for deterministic tests.
 * @returns {object} {
 *     passed, lesson:{record,file}|null, instruction:{applied,alreadyApplied,instructionsFile}|null,
 *     skill:{id,name,dir,...}|null, taskPath
 *   }
 */
export function improve(o = {}) {
  if (!o || typeof o !== 'object') throw new Error('improve(o): options object required');
  const trace = o.trace;
  const evalRecord = o.evalRecord;
  if (!trace || typeof trace !== 'object' || !Array.isArray(trace.steps)) {
    throw new Error('improve: a valid trace record (o.trace with steps[]) is required');
  }
  if (!evalRecord || typeof evalRecord !== 'object' || typeof evalRecord.passed !== 'boolean') {
    throw new Error('improve: a valid EvalRecord (o.evalRecord with .passed) is required');
  }

  const taskPath = o.taskPath
    || [evalRecord.workspace, evalRecord.project, evalRecord.workflow, evalRecord.task_id].filter(Boolean).join('/');
  const t = resolveTask(taskPath, o.root ? { root: o.root } : {});
  const now = o.now || Date.now;

  const skillsDir = t.dirs.skills;          // <task>/skills/
  const instructionsFile = path.join(t.path, 'instructions.md');

  const result = { passed: evalRecord.passed, lesson: null, instruction: null, skill: null, taskPath };

  // ── LESSON + INSTRUCTION — always, when the eval emitted candidate lessons (i.e. something failed). ──
  const candidates = Array.isArray(evalRecord.lessons) ? evalRecord.lessons : [];
  if (candidates.length) {
    const distilled = distillLesson(evalRecord, trace, o.distill);
    // Stable id from the highest-severity / first candidate so re-runs dedupe deterministically.
    const id = lessonId(candidates[0]);
    const record = {
      id,
      task_id: asStr(evalRecord.task_id),
      created: new Date(now()).toISOString(),
      severity: distilled.severity,
      failed_criteria: distilled.failedCriteria,
      suggestions: distilled.suggestions,
      summary: distilled.summary,
      body: distilled.body,
      source_eval: { score: evalRecord.score, max_score: evalRecord.max_score, passed: evalRecord.passed },
    };
    result.lesson = persistLesson(path.join(skillsDir, 'lessons'), record);
    // The lesson, with its id, drives the IDEMPOTENT instruction update.
    result.instruction = applyInstruction(instructionsFile, { id, suggestions: distilled.suggestions, summary: distilled.summary });
  }

  // ── REUSABLE SKILL — ONLY on a PASSED eval (you don't bottle a failure). ─────────────────────────
  if (evalRecord.passed) {
    result.skill = scaffoldSkill(skillsDir, { name: o.skillName, trace, evalRecord, now });
  }

  return result;
}

/** Load a scaffolded skill back via the EXISTING SkillStore (rooted at <task>/skills). */
export function loadSkill(skillsDir, id) {
  return new SkillStore(skillsDir).get(id);
}

/** Read a persisted LESSON record back. */
export function readLesson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
