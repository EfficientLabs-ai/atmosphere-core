/**
 * check-anonymization.mjs — gate run BEFORE any public-surface push (org flagship, product repos).
 *
 * Scans a directory for (a) internal substrate / infrastructure identifiers that must never go public
 * and (b) high-confidence secret material. The public brand terms (Efficient Labs, StratosAgent, The
 * Atmosphere, efficientlabs.ai) are explicitly allowed. Exits non-zero on any violation.
 *
 *   node scripts/check-anonymization.mjs [dir]      # default: org-flagship/
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// Internal-only identifiers (private upstream, methodology, infra, personal) — never public.
// Scope = genuinely sensitive: private-upstream/methodology names, infra hostnames/providers,
// personal paths/handles, cross-project key env names. We deliberately do NOT gate on internal
// DOC names (STATE_OF_REALITY/GROUNDED_STRATEGY) or a local DIR name (.secrets-vault) — those are
// neither secrets nor infra, and the code legitimately references the vault path. Case-insensitive.
const FORBIDDEN_TERMS = [
  'Solo-AI', 'Orchestral', 'Velocity Framework', 'RSVP methodology', 'K-meta', 'capability-router',
  'agent-control-plane', 'substrate freeze', 'ADR-00', 'claude-session',
  'Maximus', 'tailscale', 'ts.net', 'tailfcf', 'efficient-labs.tail', 'Hostinger',
  '/home/neo', 'neothearchitect', 'MEMCOMPUTE', 'N8N_API', 'TALLY_API',
];
// Infra IP shapes that shouldn't appear publicly (localhost 127.0.0.1 is allowed).
const FORBIDDEN_IP = [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, /\b192\.168\.\d{1,3}\.\d{1,3}\b/]; // CGNAT/Tailscale + private LAN
const STRICT_SECRET = [
  /sk-ant-[A-Za-z0-9_-]{20,}/, /sk-proj-[A-Za-z0-9_-]{20,}/, /\bAIza[A-Za-z0-9_-]{35}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const TEXT_RE = /\.(md|markdown|txt|json|ya?ml|js|mjs|cjs|sh|html?)$/i;

export function checkAnonymization(dir) {
  const violations = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) { walk(p); continue; }
      if (!TEXT_RE.test(e.name)) continue;
      let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const term of FORBIDDEN_TERMS) {
        if (new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(txt)) violations.push(`${rel}: internal term "${term}"`);
      }
      for (const re of FORBIDDEN_IP) { const m = txt.match(re); if (m) violations.push(`${rel}: infra IP "${m[0]}"`); }
      for (const re of STRICT_SECRET) { if (re.test(txt)) violations.push(`${rel}: secret-shaped content`); }
    }
  };
  walk(dir);
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.resolve(process.argv[2] || 'org-flagship');
  if (!fs.existsSync(dir)) { console.error(`no such dir: ${dir}`); process.exit(1); }
  const v = checkAnonymization(dir);
  if (v.length) {
    console.error(`❌ anonymization FAILED — ${v.length} violation(s):`);
    for (const x of v) console.error('  - ' + x);
    process.exit(1);
  }
  console.log(`✅ anonymization clean: ${dir}`);
}
