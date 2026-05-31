/**
 * self-evolution-runtime.js — the ONE seam that wires the proven SelfEvolutionEngine
 * (OBSERVE→LEARN→DISTRIBUTE→VERIFY→EXECUTE, built + tested in stratos-agent) into the
 * live api-shim daemon, behind hard flag gates.
 *
 * Safety contract (why this is safe to ship into the running bridge):
 *  - EVERY capability is OFF by default. With no STRATOS_EVOLUTION* env vars set, this
 *    module is fully inert: getEngine() returns null, observe()/tryServe() no-op, and the
 *    daemon behaves byte-for-byte as before. A PM2 reload therefore changes NOTHING until
 *    a flag is explicitly flipped — the integration is opt-in, not opt-out.
 *  - The master switch STRATOS_EVOLUTION gates engine construction itself. The sub-flags
 *    (OBSERVE/EXECUTE) cannot do anything unless the master is on — one kill switch.
 *  - OBSERVE and EXECUTE NEVER throw into the request path. Any failure degrades to
 *    "no skill" and the normal Ollama/LLM path answers. Self-evolution can't break serving.
 *  - EXECUTE only runs a skill that is (a) a confident semantic match, (b) present on disk,
 *    and (c) PQC-signature-verified against our node key — triple-gated inside the engine.
 *
 * Honest scope (no theater):
 *  - The OBSERVE/EXECUTE chat path is real but NARROW: it learns and serves the
 *    *deterministic numeric-transform class* (a prompt carrying an integer operand whose
 *    answer is an integer). Those accumulate as typed I/O examples that the night shift's
 *    Tier-A inducer turns into signed, executing wasm — a genuine latency win (instant vs
 *    ~100 s local LLM) for that class. Free-form prose carries no typed examples, so
 *    OBSERVE records nothing for it and EXECUTE never matches it — by design, not by stub.
 *  - DISTRIBUTE/VERIFY (P2P skill gossip) is built + unit-proven in the engine but is NOT
 *    wired here: this VPS is firewalled with no second peer, so live broadcast would be
 *    untested. It activates once a real second node exists.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SelfEvolutionEngine,
  loadOrCreateNodeKeys
} from '../../stratos-agent/src/evolution/self-evolution.js';

const ON = (v) => v === '1' || /^(true|yes|on)$/i.test(String(v || ''));

const EVOLUTION_ENABLED = ON(process.env.STRATOS_EVOLUTION);          // master: build engine + LEARN
const OBSERVE_ENABLED   = ON(process.env.STRATOS_EVOLUTION_OBSERVE);  // capture successful traces
const EXECUTE_ENABLED   = ON(process.env.STRATOS_EVOLUTION_EXECUTE);  // serve from verified wasm

// Repo root: this file is packages/api-shim/src/ -> up three.
const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..', '..');
const NODE_KEYS_FILE  = process.env.STRATOS_NODE_KEYS || path.join(ROOT, '.stratos-profile', 'node-keys.json');
const DIST_SKILLS_DIR = process.env.STRATOS_SKILLS_DIR || path.join(ROOT, 'packages', 'stratos-agent', 'dist', 'skills');

let _engine = null;

/** Lazily build (and cache) the engine. Returns null when evolution is disabled. */
export function getEngine() {
  if (!EVOLUTION_ENABLED) return null;
  if (_engine) return _engine;
  try {
    const keyBundle = loadOrCreateNodeKeys(NODE_KEYS_FILE);
    _engine = new SelfEvolutionEngine({
      keyBundle,
      distSkillsDir: DIST_SKILLS_DIR,
      executeEnabled: EXECUTE_ENABLED,
      verbose: true
    });
    console.log('🧬 [SelfEvolution] engine online'
      + ` (observe=${OBSERVE_ENABLED ? 'on' : 'off'}, execute=${EXECUTE_ENABLED ? 'on' : 'off'}).`);
  } catch (e) {
    console.warn('⚠️ [SelfEvolution] engine init failed — staying inert:', e.message);
    _engine = null;
  }
  return _engine;
}

export function isEnabled() { return EVOLUTION_ENABLED; }

/** Hook B (LEARN): start the nightly compile scheduler on daemon boot, if enabled. */
export function startLearnScheduler() {
  const eng = getEngine();
  if (!eng) return false;
  try {
    eng.startScheduler(process.env.STRATOS_NIGHTSHIFT_CRON || undefined);
    console.log('🌙 [SelfEvolution] night-shift LEARN scheduler started.');
    return true;
  } catch (e) {
    console.warn('⚠️ [SelfEvolution] could not start scheduler:', e.message);
    return false;
  }
}

// --- numeric-transform extraction (the honest OBSERVE/EXECUTE substrate) -------------
// A compute intent is a prompt that carries a single integer operand. We canonicalize the
// intent by masking the operand to <N> so "double 21" and "double 4" share one skill id.
const INT_RE = /-?\d+/;

function extractNumericInput(prompt) {
  const m = String(prompt || '').match(INT_RE);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
function canonicalIntent(prompt) {
  return String(prompt || '').trim().replace(INT_RE, '<N>').replace(/\s+/g, ' ').slice(0, 200);
}
function parseIntegerAnswer(text) {
  // Accept an answer that is (or cleanly contains) a single integer result.
  const t = String(text || '').trim();
  const only = t.match(/^-?\d+$/);
  if (only) return Number(only[0]);
  const m = t.match(/(?:=|is|equals|answer[:\s]*)\s*(-?\d+)\b/i);
  if (m) return Number(m[1]);
  return null;
}

/**
 * Hook E (EXECUTE): if a verified wasm skill confidently matches this prompt's transform,
 * run it and return { text, skillId } to serve instead of the LLM. Returns null otherwise.
 * Never throws.
 */
export async function tryServe(prompt) {
  const eng = getEngine();
  if (!eng || !EXECUTE_ENABLED) return null;
  try {
    const input = extractNumericInput(prompt);
    if (input === null) return null;                 // not a numeric-transform intent
    const intent = canonicalIntent(prompt);
    const out = await eng.resolveAndExecute(intent, input); // triple-gated inside
    if (!out || out.result === undefined || out.result === null) return null;
    return { text: String(out.result), skillId: out.skillId, distance: out.distance };
  } catch (e) {
    console.warn('⚠️ [SelfEvolution] EXECUTE skipped:', e.message);
    return null;
  }
}

/**
 * Hook A (OBSERVE): after a successful local completion, if the exchange encodes a typed
 * numeric I/O example, record it so the night shift can induce + compile a skill. No-op for
 * free-form prose (nothing typed to learn). Never throws.
 */
export async function observe(prompt, answerText) {
  const eng = getEngine();
  if (!eng || !OBSERVE_ENABLED) return null;
  try {
    const input = extractNumericInput(prompt);
    if (input === null) return null;
    const output = parseIntegerAnswer(answerText);
    if (output === null) return null;                // answer wasn't a clean integer
    const intent = canonicalIntent(prompt);
    return await eng.captureSuccess({ intent, examples: [{ input, output }] });
  } catch (e) {
    console.warn('⚠️ [SelfEvolution] OBSERVE skipped:', e.message);
    return null;
  }
}
