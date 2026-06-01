/**
 * model-manager.js — Universal Model Manager (CLEAN path: BYOK + local open-weights).
 *
 * Resolves each chat request to a backend from the request's `model` + configured keys. Per the
 * Codex Pattern-C review:
 *  - resolveRoute() runs on the RAW inbound model string; the caller MUST resolve BEFORE any local
 *    mutation (RAG/identity injection) and forward only the RAW body to BYOK providers.
 *  - a recognized cloud model with NO key returns an explicit error (no dishonest qwen substitution).
 *  - explicit provider capability map (not loose regex), with a forced-local escape hatch.
 *  - v1 supports OpenAI + Gemini (both OpenAI-compatible). Anthropic deferred. No mesh.
 *  - probes (hardware + Ollama /api/tags) are cached; local selection is gated by INSTALLED models.
 * NOT in scope (frozen, GROUNDED_STRATEGY §6): headless subscription scraping, frontier-output training.
 */
import os from 'node:os';
import { execFile } from 'node:child_process';
import fetch from 'node-fetch';

// Explicit provider map. Each: how to recognize its models, the OFFICIAL endpoint, the env key.
export const PROVIDERS = {
  openai: { matches: (m) => /^(gpt-|o1|o3|o4|chatgpt-)/i.test(m), endpoint: 'https://api.openai.com/v1/chat/completions', envKey: 'OPENAI_API_KEY', supported: true },
  google: { matches: (m) => /^gemini/i.test(m), endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', envKey: 'GEMINI_API_KEY', supported: true },
  // Anthropic uses /v1/messages (different shape); a narrow text-first adapter translates it.
  anthropic: { matches: (m) => /^claude/i.test(m), endpoint: 'https://api.anthropic.com/v1/messages', envKey: 'ANTHROPIC_API_KEY', supported: true, format: 'anthropic' },
  // OpenRouter = ONE BYOK key → 100+ models, addressed by a "vendor/model" slug (e.g.
  // "anthropic/claude-3.5-sonnet", "meta-llama/llama-3-70b"). OpenAI-compatible, so it reuses the raw
  // pass-through. Matched LAST: native providers win for their own (slash-free) names. Sovereign —
  // the user's own key, never logged; raw body only (no RAG/identity leaked to OpenRouter).
  openrouter: { matches: (m) => /\S\/\S/.test(m), endpoint: 'https://openrouter.ai/api/v1/chat/completions', envKey: 'OPENROUTER_API_KEY', supported: true },
};

const isForcedLocal = (m, env) =>
  /^local:/i.test(m) || /^(qwen|gemma|llama|mistral|phi|deepseek)/i.test(m) || env.STRATOS_FORCE_LOCAL === '1';

/**
 * Resolve a route from the RAW model string. Returns one of:
 *  { kind:'local', requestedModel } | { kind:'byok', provider, endpoint, envKey, model }
 *  | { kind:'error', provider, reason, status, allowAuto }
 */
export function resolveRoute(model, env = process.env) {
  const m = String(model || '').trim();
  if (isForcedLocal(m, env)) return { kind: 'local', requestedModel: m };
  for (const [provider, p] of Object.entries(PROVIDERS)) {
    if (p.matches(m)) {
      const allowAuto = env.BYOK_AUTO_LOCAL === '1';
      if (p.supported === false) {
        return { kind: 'error', provider, status: 501, allowAuto, reason: `Model "${m}" routes to ${provider}, which is recognized but not yet supported (v1 = OpenAI + Gemini). Use a local model or a supported provider.` };
      }
      const key = env[p.envKey];
      if (key && String(key).trim().length > 8) {
        return { kind: 'byok', provider, endpoint: p.endpoint, envKey: p.envKey, model: m, format: p.format || 'openai' };
      }
      return { kind: 'error', provider, status: 501, allowAuto, reason: `Model "${m}" routes to ${provider}, but ${p.envKey} is not configured. Set the key (BYOK) or use a local model.` };
    }
  }
  return { kind: 'local', requestedModel: m }; // unknown family → local
}

// ---- cached capacity + installed-model probes (never per-request shelling) ------------------
let _probe = null, _probeAt = 0;
const PROBE_TTL_MS = 60_000;

function detectCapacity() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 2500 }, (err, stdout) => {
      if (!err) {
        const mb = parseInt(String(stdout).split('\n')[0], 10);
        if (Number.isFinite(mb) && mb > 0) return resolve({ gb: Math.round(mb / 1024 * 10) / 10, kind: 'vram' });
      }
      resolve({ gb: Math.round(os.totalmem() / 1e9 * 10) / 10, kind: 'ram' }); // CPU-only fallback
    });
  });
}

async function installedModels(ollamaHost) {
  try {
    const res = await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.models || []).map((x) => x.name);
  } catch { return []; }
}

const TIERS = [
  { minGB: 18, model: 'gemma2:27b' },
  { minGB: 8, model: 'gemma2:9b' },
  { minGB: 0, model: 'qwen2.5:7b' },
];

/**
 * Pick the local model: honor an explicitly-requested INSTALLED model; else the best preference
 * tier that fits capacity AND is actually pulled; else any installed model; else the default.
 * Returns the ACTUAL concrete model (never an alias), so logs/clients are honest.
 */
export async function selectLocalModel({ ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', requested = '', defaultModel = process.env.LOCAL_MODEL_DEFAULT || 'qwen2.5:7b', probe = null } = {}) {
  const req = String(requested || '').replace(/^local:/i, '').trim();
  const now = Date.now();
  if (probe) { _probe = probe; } // tests inject
  else if (!_probe || now - _probeAt > PROBE_TTL_MS) {
    _probe = { cap: await detectCapacity(), installed: await installedModels(ollamaHost) };
    _probeAt = now;
  }
  const { cap, installed } = _probe;
  const base = (m) => m.split(':')[0];
  const has = (m) => installed.some((i) => i === m || base(i) === base(m));

  if (req && req !== 'default' && has(req)) return { model: req, capacityGB: cap.gb, capacityKind: cap.kind, installed: installed.length };
  for (const t of TIERS) if (cap.gb >= t.minGB && has(t.model)) return { model: t.model, capacityGB: cap.gb, capacityKind: cap.kind, installed: installed.length };
  return { model: installed[0] || defaultModel, capacityGB: cap.gb, capacityKind: cap.kind, installed: installed.length };
}

/** test/ops hook to clear the probe cache */
export function _resetProbeCache() { _probe = null; _probeAt = 0; }
