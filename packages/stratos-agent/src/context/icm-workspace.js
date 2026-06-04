/**
 * icm-workspace.js — the "folders over agents" substrate (Interpretable Context Methodology).
 *
 * The durable layer of an AI system is the CONTEXT/FILE ARCHITECTURE, not the agent or framework
 * (those depreciate every model update). The filesystem is the contract; the model/runner is a
 * swappable detail behind it. This module makes that contract concrete: a canonical 5-layer
 * workspace any agent — any model — can read, scaffold, and validate.
 *
 * The five layers (a workspace is one context space):
 *   L0  identity/   — WHO/WHAT this space is: the agent's identity, mission, voice, constraints.
 *   L1  routing/    — HOW to move between layers: which references to read, which model tier, when.
 *   L2  stages/     — the ordered STAGE CONTRACTS. LIVE: read+run by the folder-stage pipeline engine
 *                     (engine.js reads <workspace>/stages). Numbered stage dirs ARE the order.
 *   L3  reference/  — read-only REFERENCE MATERIAL the stages cite (knowledge, specs, examples).
 *   L4  artifacts/  — the WORKING ARTIFACTS: run outputs. LIVE: the pipeline engine writes runs here.
 *
 * L2/L4 are LIVE (wired to engine.js). L0/L1/L3 are added here as first-class layers so the whole
 * ICM grammar is one shape across every repo (atmos-core + the public carve-outs + dev/enterprise).
 *
 * Honest scope: this lays the durable CONTRACT + scaffold + validation. It does not itself run a
 * model; it gives every runner a stable, model-agnostic place to stand. Deny-by-default validation.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The canonical layer ladder. `dir` names align with engine.js (which reads `stages/`). */
export const ICM_LAYERS = [
  { id: 'identity',  dir: 'identity',  layer: 'L0', live: false, purpose: 'who/what this context space is' },
  { id: 'routing',   dir: 'routing',   layer: 'L1', live: false, purpose: 'how to route between layers + model tier' },
  { id: 'stages',    dir: 'stages',    layer: 'L2', live: true,  purpose: 'ordered stage contracts (pipeline engine)' },
  { id: 'reference', dir: 'reference', layer: 'L3', live: false, purpose: 'read-only reference material stages cite' },
  { id: 'artifacts', dir: 'artifacts', layer: 'L4', live: true,  purpose: 'working artifacts / run outputs' },
];

const byId = Object.fromEntries(ICM_LAYERS.map((l) => [l.id, l]));

/** Resolve a layer directory inside a workspace (validates the layer id; never escapes root). */
export function resolveLayer(root, id) {
  const l = byId[id];
  if (!l) throw new Error(`unknown ICM layer "${id}" (valid: ${ICM_LAYERS.map((x) => x.id).join(', ')})`);
  const dir = path.resolve(root, l.dir);
  if (dir !== path.resolve(root) && !dir.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('resolved layer escapes workspace root');
  }
  return dir;
}

/** Validate a workspace — deny-by-default: every layer dir + the ICM.md contract must exist. */
export function validateWorkspace(root) {
  const missing = [];
  if (!fs.existsSync(path.join(root, 'ICM.md'))) missing.push('ICM.md');
  for (const l of ICM_LAYERS) {
    const d = path.join(root, l.dir);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) missing.push(`${l.dir}/ (${l.layer})`);
  }
  return { ok: missing.length === 0, missing, layers: ICM_LAYERS };
}

const ICM_MD = `# ICM workspace — folders over agents

This directory is a **context space**. Its structure is the contract; the model or framework that
reads it is a swappable detail. Any agent — any model — can operate here by reading these layers in
order. Nothing below depends on a specific LLM, SDK, or framework version.

| Layer | Folder | Holds |
|---|---|---|
| **L0** | \`identity/\` | who/what this space is — identity, mission, voice, constraints |
| **L1** | \`routing/\` | how to route between layers; which reference to read; which model tier |
| **L2** | \`stages/\` | the ordered **stage contracts** (run by the folder-stage pipeline engine) |
| **L3** | \`reference/\` | read-only reference material the stages cite |
| **L4** | \`artifacts/\` | working artifacts — run outputs |

**Rule:** to change behaviour, edit the **files**, not the agent. Re-running a stage re-derives
everything downstream from its inputs (the engine fingerprints \`stage body + prior output + reads +
model + runner\`). Your edits to an artifact are respected, not overwritten.
`;

const IDENTITY_MD = `---
layer: L0
---
# Identity

- **Agent:** StratosAgent (override with STRATOS_AGENT_NAME)
- **What this space is:** <one line — the job this context space exists to do>
- **Voice / constraints:** sovereign, local-first, honest. Claim only what is measurable.
- **Owner:** <you>
`;

const ROUTES_MD = `---
layer: L1
---
# Routing

How a runner moves through this space:

1. Read **identity/** (L0) for who/what + constraints.
2. Consult this file (L1) for which **reference/** (L3) to load and the model tier to use.
3. Execute **stages/** (L2) in order; cite reference; write to **artifacts/** (L4).

\`\`\`
default_model_tier: local        # local | mesh | byok-frontier
read_reference: ["*"]            # globs into reference/ this space may load
escalate_to_frontier_when: <hard-reasoning predicate, opt-in only>
\`\`\`
`;

const SEEDS = { 'ICM.md': ICM_MD, 'identity/identity.md': IDENTITY_MD, 'routing/routes.md': ROUTES_MD };

/**
 * Scaffold the canonical workspace (idempotent — never overwrites existing files).
 * @returns {{created: string[], existed: string[]}}
 */
export function scaffoldWorkspace(root) {
  const created = [], existed = [];
  fs.mkdirSync(root, { recursive: true });
  for (const l of ICM_LAYERS) {
    const d = path.join(root, l.dir);
    if (fs.existsSync(d)) existed.push(`${l.dir}/`);
    else { fs.mkdirSync(d, { recursive: true }); created.push(`${l.dir}/`); }
  }
  for (const [rel, body] of Object.entries(SEEDS)) {
    const f = path.join(root, rel);
    if (fs.existsSync(f)) { existed.push(rel); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    created.push(rel);
  }
  return { created, existed };
}
