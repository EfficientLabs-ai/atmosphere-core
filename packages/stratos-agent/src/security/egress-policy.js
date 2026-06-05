/**
 * egress-policy.js — POLICY-AS-CODE EGRESS FIREWALL for StratosAgent's sandbox.
 *
 * WHY THIS EXISTS (the anti-exfiltration boundary): the sovereign / anti-surveillance thesis is only
 * real if a sandboxed skill physically CANNOT phone home. A prior red-team flagged that the WASI
 * sandbox's network check was a STUB (only a bare `*` wildcard granted egress) and that it forwarded
 * caller-supplied env wholesale (a secret-exfil vector). This module is the declarative, hot-reloadable,
 * default-DENY policy that the sandbox now enforces BEFORE any outbound attempt.
 *
 * DEFAULT-DENY + FAIL-CLOSED throughout: a missing policy, a parse error, an ambiguous/malformed rule,
 * or an unparseable request all resolve to DENY. There is no "allow on error" path anywhere here.
 *
 * ── COMPOSITION WITH THE CAPABILITY GATE (read this) ──────────────────────────────────────────────
 * This firewall does NOT replace capability-gate.js's per-skill `net` allowlist — it COMPOSES with it.
 * The EFFECTIVE allowlist for a given skill is the INTERSECTION:
 *
 *        effective_allow(host)  ⇔  (host ∈ skill.caps.net)  AND  (host allowed by host policy)
 *
 * A skill can reach a host ONLY if that host is permitted by BOTH layers:
 *   - the skill's sealed-manifest `net` caps (what the skill DECLARED it needs — least privilege), AND
 *   - the operator's host egress policy (what THIS NODE permits to leave the box at all).
 * Either layer can deny; neither alone can grant. A host in the policy but not in the skill's caps is
 * DENIED; a host in the skill's caps but not in the policy is DENIED. Both empty ⇒ no egress (the safe
 * default that keeps existing capless skills working: no caps + no policy = zero egress).
 *
 * The capability gate keeps doing exact-host membership on the skill side (assertStepAllowed). This
 * module adds the operator/node-level policy with per-method / per-path granularity and SAFE suffix
 * matching, then `assertEgressAllowed(req, policy, { caps })` enforces the intersection.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';

/** Thrown on any denied egress. fail-closed: callers that catch nothing get a hard stop. */
export class EgressDenied extends Error {
  constructor(reason, detail = {}) {
    super(`EGRESS DENIED: ${reason}`);
    this.name = 'EgressDenied';
    this.denied = true;
    this.reason = reason;
    this.detail = detail;
  }
}

// A host label is a normal DNS label sequence: letters/digits/hyphens per label, dot-separated, no
// empty labels, no leading/trailing dot, no path/scheme/port/userinfo smuggled in. This is the anti-
// spoofing gate: anything that isn't a clean hostname is rejected BEFORE matching, so traversal- or
// URL-shaped junk ("github.com/../evil", "github.com:80@evil") can never match a rule.
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*$/i;

/** Normalize + validate a hostname. Returns lowercased host or null if it is not a clean hostname. */
export function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  // Strip a trailing dot (FQDN root) but reject anything else non-hostname-shaped.
  if (h.endsWith('.')) h = h.slice(0, -1);
  // Reject obvious smuggling: scheme, path, query, port, userinfo, whitespace, wildcards-in-host.
  if (/[\s/\\?#@:]/.test(h)) return null;
  if (h.includes('..')) return null;            // empty label / traversal-shaped
  if (!HOST_RE.test(h)) return null;
  return h;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);

/**
 * Normalize ONE allow-rule into a strict canonical shape, or return null (⇒ the rule is dropped, NOT
 * trusted — fail-closed). A rule is { host, methods?, paths? }:
 *   - host:    exact hostname ("api.github.com") OR a SAFE suffix (".github.com" — leading dot REQUIRED
 *              for suffix semantics; it matches the apex and any sub-label but NOT "evil-github.com" or
 *              "github.com.attacker.com"). A bare "github.com" is EXACT only.
 *   - methods: optional uppercased HTTP method allowlist; absent/empty ⇒ all methods (for this host).
 *   - paths:   optional list of path PREFIXES (each must start with "/"); absent/empty ⇒ all paths.
 */
function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const rawHost = rule.host;
  if (typeof rawHost !== 'string' || !rawHost.trim()) return null;

  let suffix = false;
  let hostPart = rawHost.trim().toLowerCase();
  if (hostPart.startsWith('.')) {
    suffix = true;
    hostPart = hostPart.slice(1); // validate the bare domain the dot prefixes
  }
  const host = normalizeHost(hostPart);
  if (!host) return null;                  // malformed host ⇒ drop (fail-closed), never a wildcard
  if (host === '*' || hostPart.includes('*')) return null; // no bare wildcards, ever

  let methods = null;
  if (rule.methods != null) {
    if (!Array.isArray(rule.methods)) return null;
    const ms = rule.methods.map((m) => String(m).toUpperCase().trim()).filter(Boolean);
    for (const m of ms) if (!METHODS.has(m)) return null;   // unknown method ⇒ drop the whole rule
    methods = ms.length ? Array.from(new Set(ms)) : null;
  }

  let paths = null;
  if (rule.paths != null) {
    if (!Array.isArray(rule.paths)) return null;
    const ps = rule.paths.map((p) => String(p)).filter((p) => p.length);
    for (const p of ps) {
      if (!p.startsWith('/')) return null;          // must be an absolute path prefix
      if (p.includes('..')) return null;            // no traversal in a rule path
    }
    paths = ps.length ? ps : null;
  }

  return { host, suffix, methods, paths };
}

/**
 * loadPolicy(src): parse a policy from a JSON string, a tiny hand-rolled YAML subset, or an object.
 * Canonical shape:  { version?, default: "deny", allow: [ {host, methods?, paths?}, ... ] }
 * `default` MUST be "deny" (or absent ⇒ deny). Any other value, or a parse error, throws — and every
 * caller treats a throw as DENY (fail-closed). Returns a frozen, normalized policy:
 *   { default: 'deny', allow: Rule[], source?, _malformed: number }
 * Malformed rules are dropped (counted in _malformed) rather than silently widening the policy.
 */
export function loadPolicy(src) {
  let obj;
  if (src && typeof src === 'object') {
    obj = src;
  } else if (typeof src === 'string') {
    const text = src.trim();
    if (!text) throw new EgressDenied('empty policy source');
    obj = text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : parseTinyYaml(text);
  } else {
    throw new EgressDenied('policy source must be a string or object');
  }
  if (!obj || typeof obj !== 'object') throw new EgressDenied('policy is not an object');

  const dflt = (obj.default == null ? 'deny' : String(obj.default).toLowerCase());
  if (dflt !== 'deny') throw new EgressDenied(`policy default must be "deny" (got "${dflt}") — fail-closed`);

  const rawAllow = Array.isArray(obj.allow) ? obj.allow : [];
  const allow = [];
  let malformed = 0;
  for (const r of rawAllow) {
    const norm = normalizeRule(r);
    if (norm) allow.push(norm); else malformed++;
  }
  const policy = { default: 'deny', allow, _malformed: malformed };
  if (obj.version != null) policy.version = obj.version;
  return Object.freeze(policy);
}

/**
 * parseTinyYaml: a deliberately TINY YAML subset (no new dep — the project hand-rolls parsers elsewhere).
 * Supports exactly what an egress policy needs:
 *   default: deny
 *   allow:
 *     - host: api.github.com
 *       methods: [GET, POST]
 *       paths: [/repos, /user]
 *     - host: .githubusercontent.com
 * List values may be inline ([a, b]) or a bare scalar. Anything it cannot parse cleanly throws ⇒ DENY.
 */
export function parseTinyYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const out = { allow: [] };
  let cur = null; // current allow-rule object being built
  for (let raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, ''); // strip comments
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      const m = body.match(/^([a-z_]+)\s*:\s*(.*)$/i);
      if (!m) throw new EgressDenied(`unparseable policy line: ${body}`);
      const [, key, val] = m;
      if (key === 'allow') { cur = null; continue; }   // entries follow as "- host: ..."
      out[key] = parseYamlScalar(val);
      continue;
    }

    // Indented: an allow list entry ("- host: x") or a continuation field of the current entry.
    if (body.startsWith('- ')) {
      cur = {};
      out.allow.push(cur);
      const after = body.slice(2).trim();
      assignYamlField(cur, after);
    } else {
      if (!cur) throw new EgressDenied(`policy field with no list entry: ${body}`);
      assignYamlField(cur, body);
    }
  }
  return out;
}

function assignYamlField(target, body) {
  const m = body.match(/^([a-z_]+)\s*:\s*(.*)$/i);
  if (!m) throw new EgressDenied(`unparseable policy field: ${body}`);
  target[m[1]] = parseYamlScalar(m[2]);
}

function parseYamlScalar(val) {
  const v = String(val).trim();
  if (v === '') return '';
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return v.replace(/^["']|["']$/g, '');
}

/**
 * hostMatchesRule: SAFE host match. Exact rules match the host verbatim. Suffix rules (leading-dot in
 * the source) match the apex domain and any sub-label boundary — but ONLY on a real label boundary, so
 * a ".github.com" rule matches "github.com" and "api.github.com" yet NEVER "evil-github.com" (no dot
 * boundary) or "github.com.attacker.com" (the rule domain is not a SUFFIX-on-a-boundary of that host).
 */
export function hostMatchesRule(host, rule) {
  if (!rule.suffix) return host === rule.host;
  if (host === rule.host) return true;                 // suffix also covers the apex
  return host.endsWith('.' + rule.host);               // boundary-anchored: ".github.com" needs a dot
}

function methodMatches(rule, method) {
  if (!rule.methods) return true;                       // no method restriction ⇒ all methods
  if (method == null) return true;                      // request didn't pin a method ⇒ host-level check
  return rule.methods.includes(String(method).toUpperCase());
}

function pathMatches(rule, path) {
  if (!rule.paths) return true;                         // no path restriction ⇒ all paths
  if (path == null) return false;                       // rule pins paths but request gave none ⇒ DENY
  const p = String(path);
  if (p.includes('..')) return false;                   // never match a traversal-shaped request path
  return rule.paths.some((pre) => p === pre || p.startsWith(pre.endsWith('/') ? pre : pre + '/') || p.startsWith(pre));
}

/**
 * assertEgressAllowed(req, policy, { caps } = {}): the enforcement point. req = { host, method?, path? }.
 * Returns the matched rule on ALLOW; throws EgressDenied on any denial (fail-closed). When `caps` is
 * provided (a parsed-capabilities object from capability-gate.js), enforces the INTERSECTION: the host
 * must ALSO be in caps.net. Composition rule documented at the top of this file.
 */
export function assertEgressAllowed(req, policy, opts = {}) {
  if (!req || typeof req !== 'object') throw new EgressDenied('malformed request');
  const host = normalizeHost(req.host);
  if (!host) throw new EgressDenied('request host is not a clean hostname', { host: req.host });

  if (!policy || typeof policy !== 'object' || policy.default !== 'deny' || !Array.isArray(policy.allow)) {
    throw new EgressDenied('no usable policy (fail-closed)', { host });
  }

  // Layer 1 — skill caps (least privilege). If caps were supplied, the host MUST be in caps.net.
  const caps = opts.caps;
  if (caps && Array.isArray(caps.net)) {
    if (!caps.net.includes(host)) {
      throw new EgressDenied(`host "${host}" not in skill's declared net caps`, { host, layer: 'caps' });
    }
  }

  // Layer 2 — host policy (operator/node). The host (+ method + path) must match an allow-rule.
  const method = req.method == null ? null : String(req.method);
  const path = req.path == null ? null : String(req.path);
  for (const rule of policy.allow) {
    if (!hostMatchesRule(host, rule)) continue;
    if (!methodMatches(rule, method)) continue;
    if (!pathMatches(rule, path)) continue;
    return rule; // ALLOW — in BOTH layers
  }
  throw new EgressDenied(`host "${host}" not permitted by egress policy`, { host, method, path, layer: 'policy' });
}

/** Non-throwing convenience: { allowed, reason?, rule?, layer? }. Used by the CLI `egress check`. */
export function checkEgress(req, policy, opts = {}) {
  try {
    const rule = assertEgressAllowed(req, policy, opts);
    return { allowed: true, rule };
  } catch (e) {
    if (e instanceof EgressDenied) return { allowed: false, reason: e.reason, layer: e.detail?.layer || null };
    return { allowed: false, reason: e.message, layer: null };
  }
}

/**
 * EgressPolicy: a hot-reloadable wrapper around a policy file. Re-reads on mtime change (lazy, on any
 * access) or on an explicit reload(). FAIL-CLOSED: if the file is missing or unparseable, the active
 * policy becomes a default-DENY empty policy (no allow-rules) rather than the last-good one — a broken
 * edit must not keep a stale allowlist live. `lastError` records why, for honest CLI reporting.
 */
export class EgressPolicy {
  constructor(opts = {}) {
    this.path = opts.path || null;
    this.policy = DENY_ALL;
    this.lastError = null;
    this._mtimeMs = 0;
    if (opts.source != null) {
      try { this.policy = loadPolicy(opts.source); } catch (e) { this.lastError = e.message; this.policy = DENY_ALL; }
    } else if (this.path) {
      this.reload();
    }
  }

  /** Force a re-read from disk. Returns the active policy (default-deny on any error). */
  reload() {
    if (!this.path) return this.policy;
    try {
      const st = fs.statSync(this.path);
      this._mtimeMs = st.mtimeMs;
      const text = fs.readFileSync(this.path, 'utf8');
      this.policy = loadPolicy(text);
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
      this.policy = DENY_ALL;       // fail-closed: a broken/missing file = deny everything
    }
    return this.policy;
  }

  /** Lazily reload if the file changed since last read, then return the active policy. */
  current() {
    if (this.path) {
      try {
        const st = fs.statSync(this.path);
        if (st.mtimeMs !== this._mtimeMs) this.reload();
      } catch (e) {
        if (this.lastError == null) { this.lastError = e.message; this.policy = DENY_ALL; }
      }
    }
    return this.policy;
  }

  assert(req, opts = {}) { return assertEgressAllowed(req, this.current(), opts); }
  check(req, opts = {}) { return checkEgress(req, this.current(), opts); }
}

/** The canonical empty default-DENY policy: nothing leaves the box. */
export const DENY_ALL = Object.freeze({ default: 'deny', allow: [], _malformed: 0 });

/**
 * connectorHostsToRules(connectors): derive allow-rules from the agent's onboarded connectors. A
 * connector is a natural, operator-blessed egress destination. We ONLY derive a rule when a connector
 * carries an explicit `host` (or `hosts: []`) field — we do NOT guess hosts from sidecar commands
 * (that would be ambiguous, and ambiguity must fail-closed). Returns Rule[] (already normalized).
 */
export function connectorHostsToRules(connectors) {
  const rules = [];
  for (const c of Array.isArray(connectors) ? connectors : []) {
    const hosts = [];
    if (typeof c?.host === 'string') hosts.push(c.host);
    if (Array.isArray(c?.hosts)) for (const h of c.hosts) if (typeof h === 'string') hosts.push(h);
    for (const h of hosts) {
      const norm = normalizeRule({ host: h });
      if (norm) rules.push(norm);
    }
  }
  return rules;
}
