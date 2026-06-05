/**
 * skill-md.js — SKILL.md / agentskills.io portability for StratosAgent.
 *
 * WHY THIS EXISTS (the network-effect MOAT): StratosAgent's native skills are signed-WASM blocks behind a
 * hybrid PQC seal (gsi-compiler.js + skill-seal.js + capability-gate.js). That makes them sovereign but, by
 * itself, a WALLED GARDEN. The wider agent ecosystem (Claude, Codex, OpenClaw, Hermes via agentskills.io /
 * clawhub) trades skills as a portable markdown format — "SKILL.md": a `---`-fenced YAML-ish frontmatter
 * (name, description, optional metadata) followed by a markdown instruction body. This module makes the two
 * interoperable in BOTH directions WITHOUT discarding the sovereign seal:
 *
 *   parseSkillMd / emitSkillMd   — the portable wire format (hand-rolled frontmatter, no YAML dep).
 *   importSkillMd                — ingest a FOREIGN skill, UNTRUSTED-by-default, least-privilege caps.
 *   exportSkillMd                — emit one of THIS node's skills as portable SKILL.md, with provenance.
 *
 * SECURITY POSTURE (non-negotiable):
 *   - A foreign .md is, by default, an INSTRUCTION/prose skill: stored + capability-gated, NEVER auto-run.
 *   - Deny-by-default capabilities. We NEVER auto-grant net/fs/secrets/compute to a foreign skill. The only
 *     caps an import can carry are ones explicitly DECLARED in its frontmatter `capabilities` block, and even
 *     those are filtered to a conservative allowlist of action verbs (no net/fs/secrets/compute from a .md).
 *   - Trust is labelled truthfully: imported ⇒ `trust: "untrusted"` until a seal is verified. We never claim
 *     provenance (did:atmos origin) we cannot cryptographically back.
 *   - The capability gate (capability-gate.js) is the runtime enforcement point — this module only DECLARES.
 */
import crypto from 'node:crypto';
import { parseCapabilities } from '../security/capability-gate.js';

// A foreign markdown skill may, at most, ASK for these inert "instruction" actions. Anything touching the
// real world (net/fs/secrets/compute, browser automation verbs like click/type/navigate) is refused at
// import — a sealed, locally-recompiled skill is the only path to those, and that requires THIS node's key.
const SAFE_IMPORT_ACTIONS = new Set(['instruction.read', 'prompt.read', 'memory.read', 'note.read']);

// Hard ceilings so a hostile/oversized .md can't exhaust memory or smuggle a giant body.
const MAX_INPUT_BYTES = 256 * 1024;        // 256 KiB total document
const MAX_FRONTMATTER_LINES = 200;
const MAX_BODY_BYTES = 200 * 1024;

// ---------------------------------------------------------------------------
// Frontmatter scalar/list parsing — hand-rolled, deliberately tiny, no YAML dep.
// Handles: quoted ("..."/'...') + unquoted scalars, `true/false/null`, integers,
// inline `[a, b, c]` lists, and block list items ("  - x"). Unknown shapes ⇒ raw string.
// ---------------------------------------------------------------------------

function stripQuotes(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    const inner = t.slice(1, -1);
    // Only double quotes get escape handling; single quotes are literal (YAML-ish).
    return t[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  return t;
}

function coerceScalar(raw) {
  const t = raw.trim();
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n;
  }
  return stripQuotes(t);
}

function parseInlineList(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  // Split on commas that are not inside quotes.
  const parts = [];
  let cur = '', q = null;
  for (const ch of inner) {
    if (q) { if (ch === q) q = null; cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (ch === ',') { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => coerceScalar(p)).filter((v) => v !== '');
}

/**
 * parseSkillMd(text) -> { name, description, metadata, body, raw }
 * Tolerant: missing frontmatter ⇒ everything is body; malformed lines are skipped, never thrown on.
 */
export function parseSkillMd(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`SKILL.md exceeds max size (${MAX_INPUT_BYTES} bytes)`);
  }
  // Normalize newlines; a leading BOM/blank lines before the fence are tolerated.
  const src = raw.replace(/\r\n?/g, '\n').replace(/^﻿/, '');

  const meta = {};
  let body = src;

  // Frontmatter is an opening `---` on its own line (allowing leading blank lines) and a closing `---`.
  const fmMatch = src.match(/^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/);
  if (fmMatch) {
    const block = fmMatch[1];
    body = src.slice(fmMatch[0].length);
    const lines = block.split('\n').slice(0, MAX_FRONTMATTER_LINES);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
      const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (!m) { i++; continue; }                 // not a key: value line — skip, don't throw
      const key = m[1];
      const rest = m[2];
      if (rest.trim() === '') {
        // Possible block list: collect following "  - item" lines.
        const items = [];
        let j = i + 1;
        while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
          items.push(coerceScalar(lines[j].replace(/^\s*-\s+/, '')));
          j++;
        }
        meta[key] = items;          // empty list if no items followed
        i = j;
        continue;
      }
      if (/^\[.*\]$/.test(rest.trim())) meta[key] = parseInlineList(rest);
      else meta[key] = coerceScalar(rest);
      i++;
    }
  }

  // `name` and `description` are the two conventional top-level fields; surface them, keep the rest in metadata.
  const name = typeof meta.name === 'string' ? meta.name : (meta.name != null ? String(meta.name) : '');
  const description = typeof meta.description === 'string' ? meta.description
    : (meta.description != null ? String(meta.description) : '');
  const metadata = { ...meta };
  delete metadata.name;
  delete metadata.description;

  return { name, description, metadata, body: body.replace(/^\n+/, ''), raw };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function emitScalar(v) {
  if (v === true || v === false || v === null) return String(v);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = String(v ?? '');
  // Quote when the value could be mis-parsed (leading/trailing space, special chars, looks like a list/number/bool).
  if (s === '' || /^[\s]|[\s]$|[:#\[\]"']|^(true|false|null|~|-?\d+)$/.test(s) || s.includes('\n')) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
  }
  return s;
}

function emitFrontmatterValue(key, v) {
  if (Array.isArray(v)) {
    if (v.length === 0) return `${key}: []`;
    return `${key}: [${v.map((x) => emitScalar(x)).join(', ')}]`;
  }
  if (v !== null && typeof v === 'object') {
    // Nested object (e.g. provenance / capabilities) → inline JSON, which round-trips as a quoted scalar
    // but stays human-readable. Kept compact; parseSkillMd reads it back as a string the caller can JSON.parse.
    return `${key}: ${emitScalar(JSON.stringify(v))}`;
  }
  return `${key}: ${emitScalar(v)}`;
}

/**
 * emitSkillMd(skill) -> portable SKILL.md string.
 * `skill`: { name, description, metadata?, body?, provenance? }
 * When `provenance` is supplied (a sealed skill being exported), it is emitted as a dedicated frontmatter
 * block so a shared skill carries verifiable origin (did:atmos) + signature reference while staying portable.
 */
export function emitSkillMd(skill = {}) {
  const name = skill.name != null ? String(skill.name) : '';
  const description = skill.description != null ? String(skill.description) : '';
  const metadata = (skill.metadata && typeof skill.metadata === 'object') ? skill.metadata : {};
  const body = typeof skill.body === 'string' ? skill.body : '';

  const lines = ['---', emitFrontmatterValue('name', name), emitFrontmatterValue('description', description)];

  for (const [k, v] of Object.entries(metadata)) {
    if (k === 'name' || k === 'description' || k === 'provenance') continue; // reserved / emitted separately
    if (v === undefined) continue;
    lines.push(emitFrontmatterValue(k, v));
  }

  // Provenance block (the sovereign hook): emitted last, as a single inline-JSON frontmatter key so any
  // SKILL.md consumer can ignore it harmlessly, while a Stratos node can verify origin + signature ref.
  const prov = skill.provenance ?? metadata.provenance;
  if (prov && typeof prov === 'object') {
    lines.push(emitFrontmatterValue('provenance', prov));
  }

  lines.push('---', '');
  return lines.join('\n') + (body ? body.replace(/\n*$/, '\n') : '');
}

// ---------------------------------------------------------------------------
// Import — untrusted-by-default
// ---------------------------------------------------------------------------

/** Stable content id for an imported skill, content-addressed so re-imports dedupe. */
export function skillIdFor(name, body) {
  const slug = String(name || 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
  const h = crypto.createHash('sha256').update(String(name || '')).update('\0').update(String(body || '')).digest('hex').slice(0, 12);
  return `imported.${slug}.${h}`;
}

/**
 * Derive the CONSERVATIVE, least-privilege capability declaration for a FOREIGN markdown skill.
 * Deny-by-default: we start from an empty declaration and admit ONLY explicitly-declared action verbs that
 * sit on the inert SAFE_IMPORT_ACTIONS allowlist. net / fs / secrets / compute can NEVER be granted to a
 * foreign .md here — those require local re-compilation under this node's key (the sealed path).
 */
export function deriveImportCapabilities(metadata = {}) {
  const declared = (metadata && typeof metadata === 'object' && metadata.capabilities) || {};
  let askedActions = [];
  if (Array.isArray(declared.actions)) askedActions = declared.actions;
  else if (typeof declared.actions === 'string') askedActions = [declared.actions];
  const safeActions = askedActions.filter((a) => typeof a === 'string' && SAFE_IMPORT_ACTIONS.has(a));
  const refused = askedActions.filter((a) => !safeActions.includes(a));
  // Whatever else they asked for (net/fs/secrets/compute) is recorded as refused, never granted.
  for (const k of ['net', 'fs', 'secrets', 'compute']) {
    if (declared[k] != null && !(Array.isArray(declared[k]) && declared[k].length === 0)) {
      refused.push(k);
    }
  }
  // Build the strict, gate-shaped capabilities object (parseCapabilities re-normalizes deny-by-default).
  const caps = parseCapabilities({ capabilities: { actions: safeActions } });
  return { caps, granted: safeActions, refused };
}

/**
 * importSkillMd(text, opts) — ingest a foreign SKILL.md as an untrusted, capability-gated instruction skill.
 *
 * opts:
 *   store      — { put(skillId, record) } sink (injectable; tests pass a stub). Optional.
 *   source     — free-text provenance hint (e.g. "agentskills.io", a URL). Recorded as CLAIMED, not verified.
 *   compileGsi — async (manifest) => sealedRecord. If provided AND the .md declares a deterministic
 *                `pathway`/`computation`, the skill MAY be routed through the GSI compiler to be sealed
 *                ON IMPORT with THIS node's key, recording the original author as provenance (NOT
 *                impersonating them). Absent ⇒ always stored as an inert instruction skill.
 *
 * Returns the registered skill record (also handed to store.put when present).
 */
export async function importSkillMd(text, opts = {}) {
  const parsed = parseSkillMd(text);
  if (Buffer.byteLength(parsed.body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error(`SKILL.md body exceeds max size (${MAX_BODY_BYTES} bytes)`);
  }
  if (!parsed.name) throw new Error('SKILL.md missing required `name` frontmatter');

  const { caps, granted, refused } = deriveImportCapabilities(parsed.metadata);
  const id = skillIdFor(parsed.name, parsed.body);

  // Author provenance is CLAIMED by the document; we record it truthfully as unverified.
  const claimedAuthor = parsed.metadata.author ?? parsed.metadata.origin ?? null;

  const base = {
    id,
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    metadata: parsed.metadata,
    kind: 'instruction',
    trust: 'untrusted',           // imported ⇒ untrusted until a seal verifies. Stated honestly.
    sealed: false,
    capabilities: caps,           // deny-by-default; only inert instruction verbs may be present
    grantedCapabilities: granted,
    refusedCapabilities: refused,
    provenance: {
      imported: true,
      source: opts.source ? String(opts.source) : null,
      claimedAuthor: claimedAuthor != null ? String(claimedAuthor) : null,
      verified: false,            // we did NOT verify a did:atmos seal for a foreign .md
      importedAt: new Date().toISOString(),
    },
  };

  // OPTIONAL sealed-on-import path: only for a declared DETERMINISTIC pathway, and only if a compiler is
  // injected. The seal is THIS node's — we re-author, recording the original author as provenance.
  // A deterministic pathway declaration must be a real OBJECT (not an array, not a scalar/inline-JSON
  // string). An ecosystem .md almost never carries one, so the conservative default is "stay instruction".
  // The only way to seal-on-import is an explicit, structured object decl + an injected compiler.
  const decl = parsed.metadata.computation || parsed.metadata.pathway;
  const isObjectDecl = decl && typeof decl === 'object' && !Array.isArray(decl);
  let record = base;
  if (opts.compileGsi && isObjectDecl) {
    const manifest = {
      id,
      kind: decl.computation ? 'computational' : (decl.kind || 'computational'),
      ...decl,
      // Provenance the compiler records — the original author, NOT a forged origin.
      importedFrom: { source: base.provenance.source, claimedAuthor: base.provenance.claimedAuthor },
    };
    const sealed = await opts.compileGsi(manifest);
    record = {
      ...base,
      kind: 'computational',
      sealed: true,
      trust: 'sealed-locally',     // sealed under THIS node's key; origin is us, author is recorded provenance
      sealedRef: sealed && (sealed.wasmHash || sealed.file || sealed.id) || null,
      provenance: { ...base.provenance, sealedByThisNode: true },
    };
  }

  if (opts.store && typeof opts.store.put === 'function') {
    await opts.store.put(id, record);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * exportSkillMd(skillId, opts) — emit one of THIS node's skills as a portable SKILL.md.
 *
 * opts:
 *   store    — { get(skillId) => record } source (injectable). Required unless `record` is passed.
 *   record   — the skill record directly (bypasses the store).
 *   originDid — this node's did:atmos (for the provenance block); falls back to the record's.
 *
 * The emitted SKILL.md is portable (plain frontmatter + body) AND carries a provenance block referencing
 * the PQC origin + signature ref when the skill is sealed — so a peer can verify where it came from.
 */
export function exportSkillMd(skillId, opts = {}) {
  let record = opts.record;
  if (!record && opts.store && typeof opts.store.get === 'function') record = opts.store.get(skillId);
  if (!record) throw new Error(`skill not found: ${skillId}`);

  const provenance = {
    node: opts.originDid || record.originDid || record.provenance?.node || null,
    sealed: !!record.sealed,
  };
  if (record.sealed) {
    provenance.signatureRef = record.sealedRef || record.wasmHash || record.signatureRef || null;
    provenance.algorithm = 'hybrid-pqc(ed25519+ml-dsa-65)';
  }
  // If this skill was itself imported, be HONEST in the export: surface the upstream claim, unverified.
  if (record.provenance?.imported) {
    provenance.reexported = true;
    provenance.upstreamSource = record.provenance.source || null;
    provenance.upstreamClaimedAuthor = record.provenance.claimedAuthor || null;
    provenance.upstreamVerified = false;
  }

  return emitSkillMd({
    name: record.name || skillId,
    description: record.description || '',
    metadata: record.metadata || {},
    body: record.body || '',
    provenance,
  });
}

export { SAFE_IMPORT_ACTIONS };
