/**
 * workspace-tree.js — the FILES-FIRST OPERATIONAL UNIT (Increment 1 of the operating core).
 *
 * THE DURABLE ASSET is the user's living operational map: `Workspace > Project > Workflow > Task >
 * Subtask`, on disk, framework-agnostic. The filesystem is the contract; the model is a swappable
 * detail behind it (see ARCHITECTURE.md §"The primitive" and CONTEXT_CAPTURE_SCHEMA.md §"Operational
 * unit"). This module creates/resolves/lists that tree. It is the STORE leg of the canonical pipeline
 * `Input → Capture → Classify → Route → Store → Execute → Trace → Evaluate → Compress → Improve`.
 *
 * Creating a Task scaffolds EXACTLY the eight canonical entries the schema mandates:
 *   instructions.md · tools.json · data/ · memory/ · outputs/ · traces/ · evals/ · skills/
 *
 * DESIGN PRINCIPLES (matching the repo's existing primitives):
 *  - Pure fs, deterministic, idempotent (re-create never overwrites a user's files).
 *  - Path-traversal-safe: every name is a single sane segment; resolved paths can NEVER escape the
 *    workspaces root (the exact `path.resolve` + boundary-check idiom from icm-workspace.js).
 *  - No LLM, no network, no heavy deps — only node:fs / node:path.
 *  - State rooted at the existing stratos state dir convention (`.stratos-profile/`, cwd-relative,
 *    matching agent-config.js) under a `workspaces/` subtree; the root is configurable.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The eight canonical entries a Task folder holds (CONTEXT_CAPTURE_SCHEMA.md §Operational unit). */
export const TASK_FILES = Object.freeze(['instructions.md', 'tools.json']);
export const TASK_DIRS = Object.freeze(['data', 'memory', 'outputs', 'traces', 'evals', 'skills']);
export const TASK_SCAFFOLD = Object.freeze([...TASK_FILES, ...TASK_DIRS]);

/**
 * Default workspaces root: `<cwd>/.stratos-profile/workspaces`. Resolved lazily off process.cwd()
 * so the module is robust to the daemon's working directory and testable in an isolated temp dir
 * (exactly like agent-config.js). STRATOS_WORKSPACES_DIR / STRATOS_PROFILE_DIR override.
 */
export function defaultRoot() {
  if (process.env.STRATOS_WORKSPACES_DIR) return path.resolve(process.env.STRATOS_WORKSPACES_DIR);
  const base = process.env.STRATOS_PROFILE_DIR
    ? path.resolve(process.env.STRATOS_PROFILE_DIR)
    : path.join(process.cwd(), '.stratos-profile');
  return path.join(base, 'workspaces');
}

/**
 * Validate ONE path segment (a workspace/project/workflow/task/subtask name). Deny-by-default:
 * a name must be a single, non-empty segment of safe characters — no separators, no traversal, no
 * absolute escape, no NUL, no leading dot. This is the load-bearing security check: every public
 * function routes names through here before they touch the filesystem.
 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function safeSegment(name, role = 'name') {
  if (typeof name !== 'string') throw new Error(`${role} must be a string`);
  const s = name.trim();
  if (!s) throw new Error(`${role} is empty`);
  if (s === '.' || s === '..') throw new Error(`${role} "${s}" is not a valid path segment`);
  if (s.includes('/') || s.includes('\\') || s.includes('\0')) throw new Error(`${role} "${name}" contains a path separator`);
  if (!SEGMENT_RE.test(s)) throw new Error(`${role} "${name}" has invalid characters (use letters, digits, . _ - ; no leading dot)`);
  return s;
}

/**
 * Resolve a path inside `root` from already-validated segments and assert it cannot escape. Belt-and-
 * braces over safeSegment(): even if a caller bypassed validation, the final resolved path is checked
 * to be the root or strictly under it (the icm-workspace.js boundary idiom). Returns the absolute path.
 */
function within(root, ...segments) {
  const base = path.resolve(root);
  const p = path.resolve(base, ...segments);
  if (p !== base && !p.startsWith(base + path.sep)) {
    throw new Error('resolved path escapes the workspaces root');
  }
  return p;
}

/** mkdir -p, idempotent. */
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

/** Write a file ONLY if it does not already exist — idempotent, never clobbers user edits. */
function ensureFile(file, contents) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, contents);
}

/**
 * Build the absolute directory for a node, given the chain of validated segments. Levels:
 *   [workspace] [project] [workflow] [task] [subtask]
 * Each level deeper is just a sibling folder under its parent (the tree IS the directory layout).
 */
function nodeDir(root, segments) {
  return within(root, ...segments);
}

// ---- creators (idempotent, deterministic) ------------------------------------------------------

/** Create (or resolve) a Workspace. Returns { path, created }. */
export function createWorkspace(workspace, { root = defaultRoot() } = {}) {
  const ws = safeSegment(workspace, 'workspace');
  const dir = nodeDir(root, [ws]);
  const created = !fs.existsSync(dir);
  ensureDir(dir);
  // A session log lives at the workspace level — every capture appends a line here (see context-capture.js).
  ensureFile(path.join(dir, 'session.log'), '');
  return { path: dir, workspace: ws, created };
}

/** Create (or resolve) a Project under a Workspace. Returns { path, created }. */
export function createProject(workspace, project, { root = defaultRoot() } = {}) {
  const ws = safeSegment(workspace, 'workspace');
  const pr = safeSegment(project, 'project');
  createWorkspace(ws, { root });
  const dir = nodeDir(root, [ws, pr]);
  const created = !fs.existsSync(dir);
  ensureDir(dir);
  return { path: dir, workspace: ws, project: pr, created };
}

/** Create (or resolve) a Workflow under a Project. Returns { path, created }. */
export function createWorkflow(workspace, project, workflow, { root = defaultRoot() } = {}) {
  const ws = safeSegment(workspace, 'workspace');
  const pr = safeSegment(project, 'project');
  const wf = safeSegment(workflow, 'workflow');
  createProject(ws, pr, { root });
  const dir = nodeDir(root, [ws, pr, wf]);
  const created = !fs.existsSync(dir);
  ensureDir(dir);
  return { path: dir, workspace: ws, project: pr, workflow: wf, created };
}

const INSTRUCTIONS_MD = (task, chain) => `# Task: ${task}

> ${chain}

## Goal
<one line — what done looks like>

## Context
<what the agent needs to know; link entities in memory/>

## Constraints
<what must hold; what is off-limits>

## Done when
<verifiable success criteria>
`;

const TOOLS_JSON = JSON.stringify({
  // Per-task tool manifest (TARGET: resolved against the /mcp registry). Deny-by-default: an empty
  // allow list means no tool is permitted until declared here. Mirrors the capability-gate shape.
  capabilities: { actions: [], net: [], fs: [], secrets: [] },
  tools: [],
}, null, 2) + '\n';

/**
 * Create (or resolve) a Task under a Workflow, scaffolding EXACTLY the eight canonical entries
 * (instructions.md, tools.json, data/, memory/, outputs/, traces/, evals/, skills/). Idempotent:
 * a re-create adds only what is missing and never overwrites an existing file. Returns
 * { path, created, scaffolded }.
 */
export function createTask(workspace, project, workflow, task, { root = defaultRoot() } = {}) {
  const ws = safeSegment(workspace, 'workspace');
  const pr = safeSegment(project, 'project');
  const wf = safeSegment(workflow, 'workflow');
  const tk = safeSegment(task, 'task');
  createWorkflow(ws, pr, wf, { root });
  const dir = nodeDir(root, [ws, pr, wf, tk]);
  const created = !fs.existsSync(dir);
  ensureDir(dir);
  for (const d of TASK_DIRS) ensureDir(path.join(dir, d));
  const chain = [ws, pr, wf, tk].join(' / ');
  ensureFile(path.join(dir, 'instructions.md'), INSTRUCTIONS_MD(tk, chain));
  ensureFile(path.join(dir, 'tools.json'), TOOLS_JSON);
  return { path: dir, workspace: ws, project: pr, workflow: wf, task: tk, created, scaffolded: [...TASK_SCAFFOLD] };
}

/**
 * Create (or resolve) a Subtask under a Task. A Subtask is itself a fully-scaffolded Task folder
 * (same eight entries) nested under its parent task — so the unit is uniform all the way down.
 * Returns the same shape as createTask plus { parentTask }.
 */
export function createSubtask(workspace, project, workflow, task, subtask, { root = defaultRoot() } = {}) {
  const ws = safeSegment(workspace, 'workspace');
  const pr = safeSegment(project, 'project');
  const wf = safeSegment(workflow, 'workflow');
  const tk = safeSegment(task, 'task');
  const st = safeSegment(subtask, 'subtask');
  createTask(ws, pr, wf, tk, { root });
  const dir = nodeDir(root, [ws, pr, wf, tk, st]);
  const created = !fs.existsSync(dir);
  ensureDir(dir);
  for (const d of TASK_DIRS) ensureDir(path.join(dir, d));
  const chain = [ws, pr, wf, tk, st].join(' / ');
  ensureFile(path.join(dir, 'instructions.md'), INSTRUCTIONS_MD(st, chain));
  ensureFile(path.join(dir, 'tools.json'), TOOLS_JSON);
  return { path: dir, workspace: ws, project: pr, workflow: wf, task: tk, subtask: st, parentTask: tk, created, scaffolded: [...TASK_SCAFFOLD] };
}

// ---- resolvers + listing -----------------------------------------------------------------------

/**
 * Resolve a Task (or Subtask) from a slash path "ws/proj/wf/task[/subtask]". Validates every segment,
 * never escapes the root, and asserts the eight canonical entries exist (deny-by-default: an
 * incomplete folder is NOT a valid task). Returns { path, parts, scaffold: { ok, missing }, dirs }.
 */
export function resolveTask(taskPath, { root = defaultRoot(), requireScaffold = true } = {}) {
  if (typeof taskPath !== 'string' || !taskPath.trim()) throw new Error('task path is empty');
  const parts = taskPath.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 4 || parts.length > 5) {
    throw new Error('task path must be "workspace/project/workflow/task" (optionally /subtask)');
  }
  const roles = ['workspace', 'project', 'workflow', 'task', 'subtask'];
  const clean = parts.map((p, i) => safeSegment(p, roles[i]));
  const dir = nodeDir(root, clean);
  const missing = [];
  for (const f of TASK_FILES) if (!fs.existsSync(path.join(dir, f))) missing.push(f);
  for (const d of TASK_DIRS) {
    const p = path.join(dir, d);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) missing.push(d + '/');
  }
  const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  const ok = exists && missing.length === 0;
  if (requireScaffold && !ok) {
    throw new Error(exists ? `task at "${taskPath}" is incomplete (missing: ${missing.join(', ')})` : `no task at "${taskPath}"`);
  }
  const named = { workspace: clean[0], project: clean[1], workflow: clean[2], task: clean[3] };
  if (clean[4]) named.subtask = clean[4];
  return {
    path: dir,
    parts: clean,
    ...named,
    scaffold: { ok, missing },
    // Convenient absolute handles for the consumers (context-capture writes to data/+memory/; trace to traces/).
    dirs: Object.fromEntries(TASK_DIRS.map((d) => [d, path.join(dir, d)])),
  };
}

/**
 * List the tree rooted at a Workspace as a nested structure of {name, type, path, children}. Pure fs
 * walk; a directory holding the eight canonical entries is typed "task". Bounded by depth (5 levels:
 * ws/proj/wf/task/subtask). Never follows anything outside the root. Returns null if absent.
 */
export function listTree(workspace, { root = defaultRoot() } = {}) {
  const ws = safeSegment(workspace, 'workspace');
  const dir = nodeDir(root, [ws]);
  if (!fs.existsSync(dir)) return null;
  const isTask = (d) => TASK_SCAFFOLD.every((e) => fs.existsSync(path.join(d, e)));
  const walk = (d, name, depth) => {
    const node = { name, type: depth === 0 ? 'workspace' : (isTask(d) ? 'task' : 'node'), path: d, children: [] };
    if (depth >= 5) return node;
    let kids = [];
    try { kids = fs.readdirSync(d, { withFileTypes: true }); } catch { return node; }
    for (const k of kids.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!k.isDirectory()) continue;
      // never descend into the canonical task sub-dirs (data/, memory/, …) — they are content, not tree.
      if (node.type === 'task' && TASK_DIRS.includes(k.name)) continue;
      node.children.push(walk(path.join(d, k.name), k.name, depth + 1));
    }
    return node;
  };
  return walk(dir, ws, 0);
}

/** List all Workspaces under the root (names only). */
export function listWorkspaces({ root = defaultRoot() } = {}) {
  const base = path.resolve(root);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
