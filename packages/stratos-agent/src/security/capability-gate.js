/**
 * capability-gate.js — least-privilege enforcement for signed skills.
 *
 * WHY THIS EXISTS (the trust boundary Codex flagged as build-#1): the SkillExecutor already
 * REFUSES tampered/unsigned skills (skill-seal + verifyWasmSkill). But a *validly signed* skill
 * was still free to run ANY automation step — the exact class of problem that turned OpenClaw's
 * skill ecosystem into a malware vector. This gate closes it: a skill must DECLARE the
 * capabilities it needs inside its manifest, and at run time it may do ONLY what it declared.
 *
 * Tamper-proof by construction: the `capabilities` block lives inside `stratos.gsi.pathway`, which
 * is covered by the hybrid PQC seal (skill-seal.js binds skillId + wasmHash + metadata/manifest).
 * Editing the declared capabilities breaks the seal, so a skill cannot quietly grant itself more.
 *
 * Deny-by-default throughout: anything not explicitly declared is refused, fail-closed.
 *
 * Capability schema (all optional; absent ⇒ denied):
 *   capabilities: {
 *     compute : boolean,    // may instantiate wasm + call compute()
 *     actions : string[],   // automation step types permitted (e.g. "click","type","read")
 *     net     : string[],   // egress host allowlist (exact host match); absent/[]  ⇒ no network
 *     fs      : string[],   // filesystem path prefixes permitted; absent/[] ⇒ no filesystem
 *     secrets : string[],   // named secret scopes the skill may request (NAMES only, never values)
 *   }
 */

const STRING_LIST = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length) : []);

/** Normalize a manifest's declared capabilities into a strict, deny-by-default shape. */
export function parseCapabilities(manifest) {
  const c = (manifest && typeof manifest === 'object' && manifest.capabilities) || {};
  return {
    compute: c.compute === true,
    actions: STRING_LIST(c.actions),
    net: STRING_LIST(c.net),
    fs: STRING_LIST(c.fs),
    secrets: STRING_LIST(c.secrets),
  };
}

class CapabilityError extends Error {
  constructor(msg) { super(`CAPABILITY DENIED: ${msg}`); this.name = 'CapabilityError'; this.denied = true; }
}

/** A computational skill may run only if it declared the `compute` capability. */
export function assertComputeAllowed(caps) {
  if (!caps.compute) throw new CapabilityError('skill did not declare the "compute" capability');
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

/**
 * Assert a single automation step is within the skill's declared capabilities.
 * Deny-by-default: the step's action must be declared, and any net/fs target it touches
 * must be on the corresponding allowlist. Throws CapabilityError otherwise.
 */
export function assertStepAllowed(caps, step) {
  if (!step || typeof step !== 'object') throw new CapabilityError('malformed step');
  const action = step.action || step.type;
  if (typeof action !== 'string' || !action) throw new CapabilityError('step declares no action/type');
  if (!caps.actions.includes(action)) {
    throw new CapabilityError(`action "${action}" not in declared capabilities [${caps.actions.join(', ') || 'none'}]`);
  }
  // Network target (step.url / step.host) must be on the egress allowlist.
  const host = step.host || (step.url ? hostOf(step.url) : null);
  if (host && !caps.net.includes(host)) {
    throw new CapabilityError(`network egress to "${host}" not in declared net allowlist [${caps.net.join(', ') || 'none'}]`);
  }
  // Filesystem target (step.path) must sit under a declared prefix.
  if (typeof step.path === 'string' && step.path.length) {
    const ok = caps.fs.some((prefix) => step.path === prefix || step.path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'));
    if (!ok) throw new CapabilityError(`filesystem path "${step.path}" not under declared fs prefixes [${caps.fs.join(', ') || 'none'}]`);
  }
  // Secret scope (step.secret) must be a declared NAME (values never appear here).
  if (typeof step.secret === 'string' && step.secret.length && !caps.secrets.includes(step.secret)) {
    throw new CapabilityError(`secret scope "${step.secret}" not in declared secrets [${caps.secrets.join(', ') || 'none'}]`);
  }
  return true;
}

/**
 * Derive the MINIMAL capabilities a manifest needs (least-privilege) — for the compiler to stamp
 * into the manifest BEFORE it is sealed. Computational ⇒ {compute}. Automation ⇒ exactly the
 * actions/hosts/paths/secrets its steps use, nothing more. An author-set `capabilities` block
 * should be respected by the caller (the compiler) rather than overwritten.
 */
export function deriveCapabilities(manifest) {
  const m = manifest || {};
  if (m.kind === 'computational' || m.computation) return { compute: true };
  const steps = Array.isArray(m.steps) ? m.steps : [];
  const actions = new Set(), net = new Set(), fsp = new Set(), secrets = new Set();
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const a = s.action || s.type; if (typeof a === 'string' && a) actions.add(a);
    const h = s.host || (s.url ? hostOf(s.url) : null); if (h) net.add(h);
    if (typeof s.path === 'string' && s.path) fsp.add(s.path);
    if (typeof s.secret === 'string' && s.secret) secrets.add(s.secret);
  }
  const caps = {};
  if (actions.size) caps.actions = [...actions];
  if (net.size) caps.net = [...net];
  if (fsp.size) caps.fs = [...fsp];
  if (secrets.size) caps.secrets = [...secrets];
  return caps;
}

export { CapabilityError };
