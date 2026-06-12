/**
 * skills-api.js — POST /v1/skills/publish (ATMOS_API_SPEC §2.11, fail-closed slice).
 *
 * Publishing rides two things that ALREADY exist: the hybrid skill seal (skill-seal.js — the same
 * Ed25519+ML-DSA-65 suite that signs receipts) and the lifecycle promotion gate. The gate is
 * INJECTED (`opts.lifecycleGate`) because the canonical gate lives in the operator plane outside
 * this repo — and its rule is enforced here fail-closed: NO gate wired ⇒ NO publish (an
 * un-validated promotion never goes through by omission).
 *
 *  - `target:"public"` is ALWAYS refused — publishing is on the protected list no standing grant
 *    moves (AUTH.md §7.1): L5, founder-only, decided outside this API.
 *  - local/workspace publish (R2/L4 behind the gate): loads the skill block from the local skills
 *    dir, seals it with the node identity, appends a publish entry, mints a `skill-run` receipt
 *    ref=`skill:publish:<id>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

const PASSTHROUGH = (req, res, next) => next();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TARGETS = new Set(['local', 'workspace', 'public']);

function resolveProfileDir(opts = {}) {
  return opts.profileDir || process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function createSkillsRouter(opts = {}) {
  const router = express.Router();
  const auth = opts.auth || PASSTHROUGH;
  const seal = opts.seal || null;                   // { sealSkillBlock } — skill-seal.js, injected
  const lifecycleGate = opts.lifecycleGate || null; // ({skill_id, target, block}) => {ok, reason?}
  const record = opts.record || null;               // synchronous receipt recorder
  const now = opts.now || (() => Date.now());
  const profileDir = resolveProfileDir(opts);
  const skillsDir = () => opts.skillsDir || process.env.STRATOS_SKILLS_DIR || path.join(profileDir, 'skills');
  const nodeKeysFile = () => process.env.STRATOS_NODE_KEYS || path.join(profileDir, 'node-keys.json');
  const publishedFile = () => path.join(profileDir, 'published-skills.jsonl');
  const deny = (res, code, message) => res.status(code).json({ error: { message, type: 'skills_api' } });

  // ── POST /v1/skills/publish ──
  router.post('/v1/skills/publish', auth, express.json({ limit: '256kb' }), (req, res) => {
    const { skill_id, target } = req.body || {};
    if (typeof skill_id !== 'string' || !ID_RE.test(skill_id)) return deny(res, 400, 'skill_id required (single safe segment)');
    if (!TARGETS.has(target)) return deny(res, 400, `target must be one of: ${[...TARGETS].join(' | ')}`);

    // PROTECTED, checked FIRST: public publishing is founder-only (AUTH.md §7.1 "Unmoved by this
    // section") — refused before the gate is even consulted, so no gate misconfiguration can open it.
    if (target === 'public') {
      return deny(res, 403, 'target "public" is L5 founder-only — publishing is on the protected list no standing grant moves (AUTH.md §7.1)');
    }

    // the skill block must exist locally — publish never invents an artifact
    let block;
    try { block = JSON.parse(fs.readFileSync(path.join(skillsDir(), skill_id + '.json'), 'utf8')); }
    catch { return deny(res, 404, `no local skill block for "${skill_id}" (skills/<id>.json)`); }
    if (block.skillId !== skill_id || !block.wasmHash) return deny(res, 422, 'skill block malformed: needs matching skillId + wasmHash');

    // lifecycle gate — fail-closed: absent gate refuses, a refusing gate refuses with its reason
    if (!lifecycleGate) return deny(res, 503, 'lifecycle gate unavailable — un-validated promotions are refused (fail-closed)');
    let gate;
    try { gate = lifecycleGate({ skill_id, target, block }); }
    catch (e) { return deny(res, 503, 'lifecycle gate error (refusing): ' + e.message); }
    if (!gate?.ok) return deny(res, 403, 'lifecycle gate refused the promotion: ' + (gate?.reason || 'no validation evidence'));

    // seal with THIS node's identity (the seal is itself a signed artifact)
    if (!seal?.sealSkillBlock) return deny(res, 503, 'seal module unavailable');
    let keys;
    try {
      const raw = JSON.parse(fs.readFileSync(nodeKeysFile(), 'utf8'));
      const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
      keys = { publicKey: dec(raw.publicKey), privateKey: dec(raw.privateKey) };
    } catch { return deny(res, 503, 'no node identity — a publish must be sealed by a real node key'); }
    let sealed;
    try { sealed = seal.sealSkillBlock({ skillId: block.skillId, wasmHash: block.wasmHash, metadata: block.metadata ?? {} }, keys); }
    catch (e) { return deny(res, 500, 'seal failed: ' + e.message); }

    const entry = { ts: new Date(now()).toISOString(), skill_id, target, origin: sealed.origin, wasm_hash: block.wasmHash };
    try { fs.appendFileSync(publishedFile(), JSON.stringify(entry) + '\n'); }
    catch (e) { return deny(res, 500, 'publish record write failed: ' + e.message); }

    let receipt_id = null;
    if (record) {
      receipt_id = record({
        ref: `skill:publish:${skill_id}`,
        input_hash: sha256(JSON.stringify({ skill_id, target, wasmHash: block.wasmHash })),
        output_hash: sha256(JSON.stringify(sealed.signatureSeal)),
      });
    }
    res.status(201).json({ published: true, target, seal: sealed, receipt_id });
  });

  return router;
}
