/**
 * skill-store.js — a tiny, dependency-free file-backed store for IMPORTED instruction skills.
 *
 * Native WASM skills live in `dist/skills/*.wasm` + `registry.json` (gsi-compiler.js owns those). Imported
 * SKILL.md instruction skills are a different shape (prose + caps, untrusted-by-default), so they get their
 * own JSON index here — kept separate so an imported foreign skill can never masquerade as a sealed one.
 *
 * Layout (under <skillsDir>/imported/):
 *   index.json            { [skillId]: { name, description, kind, trust, sealed, file, importedAt } }
 *   <skillId>.json        the full skill record (body + metadata + capabilities + provenance)
 */
import fs from 'node:fs';
import path from 'node:path';

export class SkillStore {
  constructor(skillsDir) {
    this.dir = path.join(skillsDir, 'imported');
    this.indexPath = path.join(this.dir, 'index.json');
  }
  _ensure() { if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true }); }
  _safe(id) { return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_'); }
  _index() { try { return JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); } catch { return {}; } }

  put(id, record) {
    this._ensure();
    const file = `${this._safe(id)}.json`;
    fs.writeFileSync(path.join(this.dir, file), JSON.stringify(record, null, 2));
    const idx = this._index();
    idx[id] = {
      name: record.name, description: record.description, kind: record.kind,
      trust: record.trust, sealed: !!record.sealed, file,
      importedAt: record.provenance?.importedAt || new Date().toISOString(),
    };
    fs.writeFileSync(this.indexPath, JSON.stringify(idx, null, 2));
    return record;
  }

  get(id) {
    const idx = this._index();
    const meta = idx[id];
    if (!meta) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, meta.file), 'utf8')); }
    catch { return null; }
  }

  list() {
    const idx = this._index();
    return Object.entries(idx).map(([id, m]) => ({ id, ...m }));
  }
}
