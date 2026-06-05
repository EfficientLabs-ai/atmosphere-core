// test-egress-policy.mjs — policy-as-code egress firewall (default-DENY, fail-closed, caps∩policy).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPolicy, assertEgressAllowed, checkEgress, EgressDenied, EgressPolicy,
  normalizeHost, hostMatchesRule, parseTinyYaml, DENY_ALL, connectorHostsToRules,
} from './src/security/egress-policy.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const denied = (fn) => { try { fn(); return false; } catch (e) { return e instanceof EgressDenied && e.denied === true; } };
const allowReq = (req, pol, opts) => { assertEgressAllowed(req, pol, opts); return true; };

console.log('egress-policy — default-DENY, fail-closed, suffix anti-spoofing, caps∩policy\n');

// ── default-deny ──────────────────────────────────────────────────────────────────────────────
ok('empty policy ⇒ unlisted host DENIED', () => {
  const pol = loadPolicy({ default: 'deny', allow: [] });
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'github.com' }, pol)), true);
});
ok('DENY_ALL denies everything', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'github.com' }, DENY_ALL)), true);
});
ok('default other than "deny" is rejected (fail-closed)', () => {
  assert.throws(() => loadPolicy({ default: 'allow', allow: [] }), EgressDenied);
});

// ── allowed host ──────────────────────────────────────────────────────────────────────────────
const pol = loadPolicy({ default: 'deny', allow: [
  { host: 'api.github.com' },
  { host: '.githubusercontent.com' },
  { host: 'api.stripe.com', methods: ['POST'], paths: ['/v1/charges'] },
] });
ok('exact allowed host ⇒ ALLOW', () => { assert.strictEqual(allowReq({ host: 'api.github.com' }, pol), true); });
ok('exact host: a different host is DENIED', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'github.com' }, pol)), true);
});

// ── suffix match + anti-spoofing ────────────────────────────────────────────────────────────────
ok('suffix rule matches apex', () => { assert.strictEqual(allowReq({ host: 'githubusercontent.com' }, pol), true); });
ok('suffix rule matches sub-label on a dot boundary', () => {
  assert.strictEqual(allowReq({ host: 'raw.githubusercontent.com' }, pol), true);
});
ok('SPOOF: evil-githubusercontent.com DENIED (no dot boundary)', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'evil-githubusercontent.com' }, pol)), true);
});
ok('SPOOF: githubusercontent.com.attacker.com DENIED (suffix not boundary-anchored)', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'githubusercontent.com.attacker.com' }, pol)), true);
});
ok('SPOOF: x.github.com.evil.com DENIED', () => {
  const p2 = loadPolicy({ default: 'deny', allow: [{ host: '.github.com' }] });
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'x.github.com.evil.com' }, p2)), true);
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'evil-github.com' }, p2)), true);
  assert.strictEqual(allowReq({ host: 'api.github.com' }, p2), true);  // legit still allowed
});
ok('hostMatchesRule direct: boundary semantics', () => {
  const r = { host: 'github.com', suffix: true };
  assert.strictEqual(hostMatchesRule('github.com', r), true);
  assert.strictEqual(hostMatchesRule('api.github.com', r), true);
  assert.strictEqual(hostMatchesRule('evil-github.com', r), false);
  assert.strictEqual(hostMatchesRule('github.com.evil.com', r), false);
});

// ── traversal / malformed host normalization ────────────────────────────────────────────────────
ok('traversal/url-shaped hosts normalize to null ⇒ DENY', () => {
  for (const h of ['github.com/../evil', 'github.com:80@evil', 'http://github.com', 'a..b.com', 'gi thub.com', '*.github.com']) {
    assert.strictEqual(normalizeHost(h), null, h);
    assert.strictEqual(denied(() => assertEgressAllowed({ host: h }, pol)), true);
  }
});

// ── method/path granularity ──────────────────────────────────────────────────────────────────────
ok('method granularity: allowed method ⇒ ALLOW', () => {
  assert.strictEqual(allowReq({ host: 'api.stripe.com', method: 'POST', path: '/v1/charges' }, pol), true);
});
ok('method granularity: wrong method ⇒ DENY', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'api.stripe.com', method: 'DELETE', path: '/v1/charges' }, pol)), true);
});
ok('path granularity: outside the path prefix ⇒ DENY', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'api.stripe.com', method: 'POST', path: '/v1/refunds' }, pol)), true);
});
ok('path-pinned rule with no request path ⇒ DENY', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'api.stripe.com', method: 'POST' }, pol)), true);
});

// ── caps ∩ policy intersection ───────────────────────────────────────────────────────────────────
ok('host in policy but NOT in skill caps ⇒ DENY', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'api.github.com' }, pol, { caps: { net: ['api.stripe.com'] } })), true);
});
ok('host in skill caps but NOT in policy ⇒ DENY', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'evil.com' }, pol, { caps: { net: ['evil.com'] } })), true);
});
ok('host in BOTH caps AND policy ⇒ ALLOW', () => {
  assert.strictEqual(allowReq({ host: 'api.github.com' }, pol, { caps: { net: ['api.github.com'] } }), true);
});
ok('empty caps.net ⇒ everything DENIED (no egress is the safe default)', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'api.github.com' }, pol, { caps: { net: [] } })), true);
});

// ── fail-closed on malformed / missing policy ────────────────────────────────────────────────────
ok('malformed JSON source throws (⇒ caller treats as DENY)', () => {
  assert.throws(() => loadPolicy('{ not json'), Error);
});
ok('malformed rules are DROPPED, not trusted', () => {
  const p = loadPolicy({ default: 'deny', allow: [
    { host: 'ok.com' },
    { host: 'bad host with space' },
    { host: '*' },
    { host: 'm.com', methods: ['FOO'] },     // unknown method ⇒ whole rule dropped
    { host: 'p.com', paths: ['no-leading-slash'] },
    { nothost: true },
  ] });
  assert.strictEqual(p.allow.length, 1);
  assert.strictEqual(p.allow[0].host, 'ok.com');
  assert.strictEqual(p._malformed, 5);
});
ok('null/garbage request ⇒ DENY', () => {
  assert.strictEqual(denied(() => assertEgressAllowed(null, pol)), true);
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 123 }, pol)), true);
});
ok('no usable policy object ⇒ DENY', () => {
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'github.com' }, { default: 'allow' })), true);
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'github.com' }, null)), true);
});

// ── tiny YAML subset ─────────────────────────────────────────────────────────────────────────────
ok('tiny YAML subset parses an allow policy', () => {
  const yaml = [
    '# egress policy',
    'default: deny',
    'allow:',
    '  - host: api.github.com',
    '    methods: [GET, POST]',
    '    paths: [/repos, /user]',
    '  - host: .githubusercontent.com',
  ].join('\n');
  const p = loadPolicy(yaml);
  assert.strictEqual(p.allow.length, 2);
  assert.strictEqual(p.allow[0].host, 'api.github.com');
  assert.deepStrictEqual(p.allow[0].methods, ['GET', 'POST']);
  assert.strictEqual(p.allow[1].suffix, true);
  assert.strictEqual(allowReq({ host: 'api.github.com', method: 'GET', path: '/repos/x' }, p), true);
  assert.strictEqual(denied(() => assertEgressAllowed({ host: 'api.github.com', method: 'DELETE', path: '/repos/x' }, p)), true);
});
ok('garbage YAML ⇒ throws (fail-closed)', () => {
  assert.throws(() => parseTinyYaml('this is : not : valid : yaml :::'), EgressDenied);
});

// ── checkEgress non-throwing helper ──────────────────────────────────────────────────────────────
ok('checkEgress returns {allowed, reason, layer}', () => {
  const a = checkEgress({ host: 'api.github.com' }, pol);
  assert.strictEqual(a.allowed, true);
  const dd = checkEgress({ host: 'evil.com' }, pol);
  assert.strictEqual(dd.allowed, false);
  assert.strictEqual(dd.layer, 'policy');
  const cd = checkEgress({ host: 'api.github.com' }, pol, { caps: { net: [] } });
  assert.strictEqual(cd.layer, 'caps');
});

// ── hot-reload (mtime change + explicit reload) ──────────────────────────────────────────────────
ok('EgressPolicy hot-reloads on file change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-'));
  const f = path.join(dir, 'egress-policy.json');
  fs.writeFileSync(f, JSON.stringify({ default: 'deny', allow: [] }));
  const ep = new EgressPolicy({ path: f });
  assert.strictEqual(ep.check({ host: 'api.github.com' }).allowed, false);    // denied initially
  // change the file (bump mtime explicitly to be robust on fast filesystems)
  fs.writeFileSync(f, JSON.stringify({ default: 'deny', allow: [{ host: 'api.github.com' }] }));
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(f, future, future);
  assert.strictEqual(ep.check({ host: 'api.github.com' }).allowed, true);     // picked up the change
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('EgressPolicy fail-closed on a missing file', () => {
  const ep = new EgressPolicy({ path: path.join(os.tmpdir(), 'does-not-exist-egress.json') });
  assert.strictEqual(ep.check({ host: 'api.github.com' }).allowed, false);
  assert.ok(ep.lastError);
});
ok('EgressPolicy fail-closed (deny-all) on a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-'));
  const f = path.join(dir, 'p.json');
  fs.writeFileSync(f, '{ corrupt');
  const ep = new EgressPolicy({ path: f });
  assert.strictEqual(ep.current().allow.length, 0);
  assert.strictEqual(ep.check({ host: 'github.com' }).allowed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── connector-derived rules (natural allowlist source) ───────────────────────────────────────────
ok('connectorHostsToRules derives rules only from explicit host fields', () => {
  const rules = connectorHostsToRules([
    { name: 'gh', host: 'api.github.com' },
    { name: 'cdn', hosts: ['.githubusercontent.com', 'bad host'] },
    { name: 'nohost', command: 'node x.js' },   // no host ⇒ no rule (no guessing — fail-closed)
  ]);
  assert.strictEqual(rules.length, 2);
  assert.strictEqual(rules[0].host, 'api.github.com');
  assert.strictEqual(rules[1].suffix, true);
});

console.log(`\n${pass} assertions passed.`);
