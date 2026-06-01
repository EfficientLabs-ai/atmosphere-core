/**
 * agent-config.js — the agent's OWN configuration (Codex-reviewed two-tier security model).
 *
 *  - agent-config.json : user PREFERENCES, non-secret, authoritative once it exists (env no longer
 *    overrides non-secret prefs after creation — env is for SECRETS + a one-time import only).
 *    Revision-guarded writes (compare-and-swap on `rev`) + atomic rename.
 *  - runtime-state.json : bootstrap/runtime state (owner binding, per-channel introShown). Security
 *    never gates on the user config's `configured`.
 *
 * Desired vs effective: config stores DESIRED state (disabled|requested|configured|ready);
 * effectiveCapabilities() reports what is actually usable. Secrets are NEVER stored here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isLanguage } from './languages.js';

// Resolved lazily off process.cwd() so the module is robust to the daemon's working directory
// (and testable in an isolated temp dir without import-time path capture).
const dir = () => path.join(process.cwd(), '.stratos-profile');
const configPath = () => path.join(dir(), 'agent-config.json');
const runtimePath = () => path.join(dir(), 'runtime-state.json');

const DEFAULTS = () => ({
  rev: 0,
  agentName: 'StratosAgent',
  language: 'en',                                                 // the agent replies in this language
  model: { provider: 'local', name: 'qwen2.5:7b' },               // the default brain (provider switch = CLI-only)
  // the model sources the user enabled in setup. local = Ollama open-weights; providers hold ONLY a vault
  // handle to the API key (the key itself lives encrypted in the vault, never here). The compliance router
  // reads this to know which backends exist.
  modelSources: { local: { enabled: true, name: 'qwen2.5:7b' }, providers: {} },
  // messaging channels you talk to the agent through. Each holds ONLY a vault handle to its bot token
  // (the token itself is encrypted in the vault). telegram is live; others are reserved for their adapters.
  messaging: {},
  permissions: { files: 'disabled', network: 'disabled', skills: 'disabled', shell: 'disabled' }, // CLI-only grants
  channels: { telegram: 'configured', slack: 'disabled', discord: 'disabled' },                    // desired states
  // routing prefs read by the gateway/router. costApproval: 'ask' (notify + approve each cloud spend),
  // 'auto-local' (prefer a capable local model; only spend if none can do it), 'always-spend' (proceed).
  routing: { saveApiSpend: false, costApproval: 'ask' },
  meshOptIn: false,
  configured: false,
});

const COST_APPROVAL_MODES = ['ask', 'auto-local', 'always-spend'];

function atomicWrite(file, obj) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Cross-process mutual exclusion for read-modify-write (the daemon and `stratos-ctl` can both write).
 * O_EXCL lock file makes the rev compare-and-swap genuinely atomic: only one writer is ever inside
 * the critical section, so two processes can't both pass the rev check and clobber each other. A
 * stale lock (crashed writer) older than 5s is reclaimed. Contention throws (caller retries).
 */
function withLock(fn) {
  fs.mkdirSync(dir(), { recursive: true });
  const lock = path.join(dir(), '.config.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx'); } } catch { /* lost the race */ }
    }
    if (fd === undefined) throw new Error('config is being written by another process; retry');
  }
  try { return fn(); }
  finally { try { fs.closeSync(fd); } catch { /* */ } try { fs.unlinkSync(lock); } catch { /* */ } }
}

let _cfg = null;
export function getConfig() {
  if (_cfg) return _cfg;
  const CONFIG = configPath();
  try { _cfg = { ...DEFAULTS(), ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; return _cfg; } catch { /* none */ }
  // One-time migration from .env.local (then config is authoritative for non-secrets).
  const cfg = DEFAULTS();
  try {
    const env = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
    const nm = env.match(/^\s*STRATOS_AGENT_NAME\s*=\s*"?([^"\n]+)"?/m);
    if (nm) cfg.agentName = nm[1].trim().slice(0, 48);
    if (/ATMOSPHERE_P2P_OPT_IN\s*=\s*"?(true|yes|1)/mi.test(env)) cfg.meshOptIn = true;
  } catch { /* no .env.local */ }
  atomicWrite(CONFIG, cfg);
  _cfg = cfg;
  return _cfg;
}

/** Revision-guarded update. mutate(cfg) edits in place; throws on a lost-update race. */
export function updateConfig(mutate) {
  const cur = getConfig();
  const expectedRev = cur.rev;
  const CONFIG = configPath();
  // Hold the lock across the WHOLE read-check-write so the compare-and-swap is atomic.
  return withLock(() => {
    let onDisk = cur;
    try { onDisk = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* fresh */ }
    if ((onDisk.rev ?? 0) !== expectedRev) { _cfg = null; throw new Error('config changed concurrently; retry'); }
    const next = { ...onDisk };
    mutate(next);
    next.rev = expectedRev + 1;
    atomicWrite(CONFIG, next);
    _cfg = next;
    return next;
  });
}

// ---- SAFE setters (the only ones reachable from chat; privileged ones are CLI-only) ----------
export function setAgentName(name) {
  const clean = String(name || '').trim().slice(0, 48);
  if (!clean) throw new Error('empty name');
  return updateConfig((c) => { c.agentName = clean; });
}
export function setLocalModel(name) {
  const clean = String(name || '').trim().toLowerCase();
  // chat may only switch among LOCAL open-weights (no cloud provider switch — that's a data-egress change)
  if (!/^(qwen|gemma|llama|mistral|phi|deepseek)[a-z0-9.:_-]*$/i.test(clean)) throw new Error('not a local model');
  return updateConfig((c) => { c.model = { provider: 'local', name: clean }; });
}
export function getAgentName() { return getConfig().agentName; }

/** The language the agent replies in. Validated against the catalog. */
export function setLanguage(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!isLanguage(c)) throw new Error(`unsupported language: ${code}`);
  return updateConfig((cfg) => { cfg.language = c; });
}
export function getLanguage() { return getConfig().language || 'en'; }

/** Routing prefs (cost-save + cloud-spend approval mode). Validated; unknown modes rejected. */
export function setRouting({ saveApiSpend, costApproval } = {}) {
  return updateConfig((c) => {
    const r = { ...DEFAULTS().routing, ...c.routing };
    if (saveApiSpend !== undefined) r.saveApiSpend = !!saveApiSpend;
    if (costApproval !== undefined) {
      if (!COST_APPROVAL_MODES.includes(costApproval)) throw new Error(`invalid costApproval (use ${COST_APPROVAL_MODES.join('|')})`);
      r.costApproval = costApproval;
    }
    c.routing = r;
  });
}
export function setMeshOptIn(on) { return updateConfig((c) => { c.meshOptIn = !!on; }); }
export function getRouting() { return { ...DEFAULTS().routing, ...getConfig().routing }; }

const PROVIDER_RE = /^[a-z0-9_-]+$/i;
/** Enable a local source (Ollama model). */
export function setLocalSource({ enabled = true, name } = {}) {
  return updateConfig((c) => {
    c.modelSources = { ...DEFAULTS().modelSources, ...c.modelSources };
    c.modelSources.local = { enabled: !!enabled, name: name || c.modelSources.local?.name || 'qwen2.5:7b' };
  });
}
/** Enable a provider with the VAULT HANDLE to its key (never the key itself). */
export function enableProvider(provider, keyHandle) {
  if (!PROVIDER_RE.test(String(provider || ''))) throw new Error('invalid provider');
  return updateConfig((c) => {
    c.modelSources = { ...DEFAULTS().modelSources, ...c.modelSources };
    c.modelSources.providers = { ...c.modelSources.providers, [provider]: { keyHandle: keyHandle || null } };
  });
}
export function disableProvider(provider) {
  return updateConfig((c) => {
    if (c.modelSources?.providers) { delete c.modelSources.providers[provider]; }
  });
}
export function getModelSources() { return { ...DEFAULTS().modelSources, ...getConfig().modelSources }; }

/** Enable a messaging channel: vault HANDLE(S) to its token(s), owner id, + non-secret per-channel config. */
export function setMessagingChannel(channel, { enabled = true, tokenHandle, appTokenHandle, ownerId, extra } = {}) {
  if (!PROVIDER_RE.test(String(channel || ''))) throw new Error('invalid channel');
  return updateConfig((c) => {
    c.messaging = { ...c.messaging };
    c.messaging[channel] = { enabled: !!enabled, tokenHandle: tokenHandle || null, appTokenHandle: appTokenHandle || null, ownerId: ownerId || null, extra: extra || null };
  });
}
export function getMessaging() { return { ...getConfig().messaging }; }

/** Desired→effective: what is actually usable, given installed local models + present cloud keys. */
export function effectiveCapabilities({ installedModels = [], env = process.env } = {}) {
  const c = getConfig();
  const base = (m) => String(m).split(':')[0];
  const modelReady = c.model.provider === 'local'
    ? installedModels.some((i) => base(i) === base(c.model.name))
    : !!env[`${c.model.provider.toUpperCase()}_API_KEY`];
  return {
    agentName: c.agentName,
    model: { ...c.model, state: modelReady ? 'ready' : 'requested' },
    permissions: c.permissions,                 // grants are CLI-only; reported as-is
    channels: c.channels,                       // 'configured' ≠ 'ready'; never overstated
    modelSources: { ...DEFAULTS().modelSources, ...c.modelSources },
    messaging: { ...c.messaging },
    routing: { ...DEFAULTS().routing, ...c.routing },
    meshOptIn: c.meshOptIn,
  };
}

// ---- runtime / owner state (separate file; security never gates on user config) --------------
function loadRuntime() { try { return JSON.parse(fs.readFileSync(runtimePath(), 'utf8')); } catch { return {}; } }
function saveRuntime(s) { atomicWrite(runtimePath(), s); }

/** Owner binding: env wins (STRATOS_OWNER_CHAT_ID), else the bound runtime owner. */
export function getOwner(env = process.env) { return env.STRATOS_OWNER_CHAT_ID || loadRuntime().ownerChatId || null; }
export function bindOwner(chatId) { return withLock(() => { const s = loadRuntime(); s.ownerChatId = String(chatId); saveRuntime(s); return s.ownerChatId; }); }
export function isOwner(chatId, env = process.env) {
  const owner = getOwner(env);
  return owner != null && String(chatId) === String(owner);
}
export function markConfigured() { try { return updateConfig((c) => { c.configured = true; }); } catch { return getConfig(); } }

export function _reset() { _cfg = null; } // test hook
