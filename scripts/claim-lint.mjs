#!/usr/bin/env node
/**
 * claim-lint.mjs — the automated honesty/claim gate (issue #77; Unified Audit §7).
 *
 * The honesty discipline (STATE_OF_REALITY, L0–L5, ADR-0001/0002) has been enforced by review
 * only — and drift happened anyway (stale suite counts, fake model ids in docs, retired framing).
 * This lints PUBLIC-FACING docs for claims that are banned or known-false, so honesty is enforced
 * by CI, not vigilance.
 *
 * Scope: marketing/doc surfaces only (README, top-level *.md, doctrine, package READMEs). It does
 * NOT scan docs/operating/ or audit files — those legitimately QUOTE banned phrases as findings.
 * A line may opt out with the marker `claim-lint:allow` (for docs that discuss a banned term —
 * e.g. an ADR explaining why "second brain" is retired).
 *
 *   node scripts/claim-lint.mjs            # lint the default public surfaces
 *   node scripts/claim-lint.mjs --self-test
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Banned claims on public surfaces — each with the governing decision. */
export const BANNED = [
  // ADR-0002: a second brain stores notes; Atmosphere stores context/decisions/skills/workflows/execution/trust.
  { re: /\bsecond[- ]brain\b/i, why: '"second brain" framing is retired (ADR-0002) — the product is compounding intelligence, not note storage' },
  // EFL-007 (#67): these fake model ids never ran on the box; they must not appear as capability claims.
  { re: /qwen-2\.5-vlm-telegram-local|Qwen-2\.5-7B-Quantized-Local/, why: 'fake model id — never ran here; receipts/docs must name real models (EFL-007)' },
  // ADR-0001: the audit-consulting business is deprecated; its offers must not be marketed as current.
  { re: /\bAI Sovereignty Audit\b(?!.*\b(deprecated|legacy|historical|archived)\b)/i, why: 'audit-consulting offer is deprecated (ADR-0001) — only mention as legacy/historical' },
  // Honesty: never claim an unconditional live/real-time feed where a fallback exists (EFL-010 class).
  { re: /\bpulled in real[- ]time\b/i, why: 'unconditional real-time claim (EFL-010 class) — use honest two-state framing' },
];

/** Public-facing surfaces to lint (relative to repo root). */
export const SURFACES = [
  'README.md', 'ARCHITECTURE.md', 'NORTH_STAR.md', 'MODEL_ROUTING.md', 'CONTEXT_ROUTING.md',
  'STATE_OF_REALITY.md', 'STATE_OF_THE_ATMOSPHERE.md', 'SELF_IMPROVEMENT_LOOP.md', 'TRACE_SCHEMA.md',
  'docs/doctrine', 'packages/atmos-core/README.md', 'packages/api-shim/README.md',
  'packages/stratos-agent/README.md',
];

const ALLOW_MARKER = 'claim-lint:allow';

function* filesUnder(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isFile()) { yield p; return; }
  for (const e of fs.readdirSync(p)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    yield* filesUnder(path.join(p, e));
  }
}

/** Lint the given surfaces. Returns [{file, line, text, why}] violations. */
export function lintClaims({ root = ROOT, surfaces = SURFACES, banned = BANNED } = {}) {
  const violations = [];
  for (const s of surfaces) {
    for (const f of filesUnder(path.join(root, s))) {
      if (!/\.(md|mdx|txt)$/i.test(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((text, i) => {
        if (text.includes(ALLOW_MARKER)) return;
        for (const b of banned) {
          if (b.re.test(text)) violations.push({ file: path.relative(root, f), line: i + 1, text: text.trim().slice(0, 120), why: b.why });
        }
      });
    }
  }
  return violations;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const v = lintClaims();
  if (v.length) {
    console.error(`❌ claim-lint: ${v.length} banned/false claim(s) on public surfaces:\n`);
    for (const x of v) console.error(`  ${x.file}:${x.line}  ${x.text}\n      → ${x.why}\n`);
    console.error('Fix the claim, or (only for docs ABOUT the banned term) append the marker: claim-lint:allow');
    process.exit(1);
  }
  console.log('✅ claim-lint: no banned or known-false claims on public surfaces.');
}
