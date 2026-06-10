/**
 * gen-composio-ci-catalog.mjs — derive a small CI fixture from the full MIT Composio catalog.
 *
 * WHY: the real catalog (services/composio/docs/public/data/toolkits.json, ~17 MB) is gitignored
 * (the whole /services/ vendored clone is), so GitHub Actions checks out without it and
 * test-composio-sovereign.mjs fail-hards in CI (it asserts >=1000 toolkits). This generator
 * produces a faithful but tiny fixture: every toolkit's metadata (so listToolkits().length stays
 * >=1000), with the full per-action `tools` list kept ONLY for the executable toolkits the test
 * actually exercises (github, gmail, slack). Source data is MIT (ComposioHQ/composio).
 *
 * Run from repo root:  node packages/stratos-agent/test/fixtures/gen-composio-ci-catalog.mjs
 * The CI workflow points the loader at the output via STRATOS_COMPOSIO_DATA.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.STRATOS_COMPOSIO_SRC ||
  path.resolve(HERE, '../../../../services/composio/docs/public/data/toolkits.json');
const OUT = path.resolve(HERE, 'composio-catalog.ci.json');

// Toolkits whose action list the test resolves via getAction()/listActions() — keep their full tools.
const KEEP_TOOLS = new Set(['github', 'gmail', 'slack']);

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
if (!Array.isArray(raw)) throw new Error('source catalog is not an array');

const trimmed = raw.map((t) => {
  const slug = String(t.slug || '');
  const base = {
    slug,
    name: t.name || slug,
    category: t.category || null,
    authSchemes: Array.isArray(t.authSchemes) ? t.authSchemes : [],
    toolCount: t.toolCount ?? (Array.isArray(t.tools) ? t.tools.length : 0),
  };
  if (KEEP_TOOLS.has(slug.toLowerCase()) && Array.isArray(t.tools)) {
    base.tools = t.tools.map((a) => ({ slug: a.slug, name: a.name || a.slug, description: a.description || '' }));
  }
  return base;
});

fs.writeFileSync(OUT, JSON.stringify(trimmed));
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`wrote ${trimmed.length} toolkits → ${OUT} (${kb} KB; full tools kept for: ${[...KEEP_TOOLS].join(', ')})`);
