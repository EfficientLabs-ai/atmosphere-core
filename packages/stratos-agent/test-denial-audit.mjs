// test-denial-audit.mjs — DENIALS LEAVE A TRACE (red-team gap closed). Hermetic: tmp profile dirs,
// no network, no live services. Proves: append-only jsonl lands · field whitelist + scrub +
// truncation · disk-bounded rotation · a failing sink never throws into the deny path · node-authz
// audit hook fires on every denial class · CapabilityError construction records · gateway-auth 401
// persists the fact (route/method/peer) and NEVER the provided credential value.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'denial-audit-'));
const lines = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('denial-audit — every refusal is countable\n');

// The sink module is imported FIRST with a controlled profile dir so the modules that record via
// the env-driven default (capability-gate, gateway-auth) write into the test sandbox.
const PROFILE = tmp();
process.env.STRATOS_PROFILE_DIR = PROFILE;
const { recordDenial, makeAuditHook, denialAuditPath } = await import('./src/security/denial-audit.js');
const SINK = denialAuditPath();
assert.strictEqual(SINK, path.join(PROFILE, 'denial-audit.jsonl'));

await ok('append-only jsonl: two events → two parseable lines, whitelisted fields only', () => {
  assert.strictEqual(recordDenial({ gate: 'node-authz', reason: 'sender is REVOKED (fail-closed)', actor: 'did:atmos:abc', action: 'exec' }), true);
  assert.strictEqual(recordDenial({ gate: 'gateway-auth', reason: 'bad secret', route: '/v1/chat/completions', method: 'POST', headers: { authorization: 'Bearer leak-me' } }), true);
  const ls = lines(SINK);
  assert.strictEqual(ls.length, 2);
  assert.strictEqual(ls[0].gate, 'node-authz');
  assert.strictEqual(ls[0].actor, 'did:atmos:abc');
  assert.ok(ls[0].ts && !Number.isNaN(Date.parse(ls[0].ts)));
  // non-whitelisted fields (headers!) NEVER land — whitelist, not blocklist
  assert.strictEqual(ls[1].headers, undefined);
  assert.strictEqual(ls[1].route, '/v1/chat/completions');
});

await ok('scrub + truncation: token shapes redacted, oversized fields bounded', () => {
  const f = path.join(tmp(), 'scrub.jsonl');
  recordDenial({ gate: 'pairing', reason: 'refused with sk-aaaaaaaaaaaaaaaaaaaa and Bearer xyz.secret.token inside', actor: 'x'.repeat(900) }, { path: f });
  const [e] = lines(f);
  assert.ok(!e.reason.includes('sk-aaaaaaaaaaaaaaaaaaaa'), 'api-key shape must be redacted');
  assert.ok(!e.reason.includes('xyz.secret.token'), 'bearer value must be redacted');
  assert.ok(e.reason.includes('[REDACTED]'));
  assert.ok(e.actor.length <= 300, 'fields are truncated');
});

await ok('disk-bounded: rotation at maxBytes keeps the newest window (file → file.1)', () => {
  const f = path.join(tmp(), 'rot.jsonl');
  for (let i = 0; i < 50; i++) recordDenial({ gate: 'g', reason: 'r'.repeat(100) }, { path: f, maxBytes: 1024 });
  assert.ok(fs.existsSync(f + '.1'), 'rotated backup exists');
  assert.ok(fs.statSync(f).size <= 2048, 'live file stays bounded');
});

await ok('a failing sink never throws into the deny path (fail-open, fail-visible)', () => {
  const blocked = path.join(tmp(), 'iam-a-file');
  fs.writeFileSync(blocked, 'x'); // a FILE used as the parent dir → mkdir/append must fail (ENOTDIR)
  const r = recordDenial({ gate: 'g', reason: 'r' }, { path: path.join(blocked, 'denials.jsonl') });
  assert.strictEqual(r, false); // reported, not thrown
});

await ok('node-authz: injected audit hook fires on EVERY denial class, never on success-path errors only', async () => {
  const { authorizeMeshCommand, buildTrustSet } = await import('./src/identity/node-authz.js');
  const seen = [];
  const audit = (d) => seen.push(d);
  const trust = buildTrustSet({ revokedNodes: ['did:atmos:' + 'b'.repeat(40)] });
  // class 1: no envelope
  assert.strictEqual(authorizeMeshCommand(null, trust, { audit }).ok, false);
  // class 2: revoked sender (carries actor + action through to the hook)
  const revoked = { action: 'exec', sender_did: 'did:atmos:' + 'b'.repeat(40), ts: Date.now(), sig: { ed25519Sig: 'a', mldsaSig: 'b' } };
  assert.strictEqual(authorizeMeshCommand(revoked, trust, { audit }).ok, false);
  // class 3: unknown sender
  const unknown = { ...revoked, sender_did: 'did:atmos:' + 'c'.repeat(40) };
  assert.strictEqual(authorizeMeshCommand(unknown, trust, { audit }).ok, false);
  assert.strictEqual(seen.length, 3);
  assert.strictEqual(seen[1].actor, revoked.sender_did);
  assert.strictEqual(seen[1].action, 'exec');
  assert.ok(seen[1].reason.includes('REVOKED'));
  // a THROWING hook can never block the denial
  const bomb = () => { throw new Error('audit exploded'); };
  const v = authorizeMeshCommand(null, trust, { audit: bomb });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'no envelope');
});

await ok('capability-gate: constructing the denial records it (covers every throw site)', async () => {
  const before = fs.existsSync(SINK) ? lines(SINK).length : 0;
  const { parseCapabilities, assertStepAllowed } = await import('./src/security/capability-gate.js');
  try { assertStepAllowed(parseCapabilities({}), { action: 'click' }); assert.fail('should deny'); }
  catch (e) { assert.strictEqual(e.denied, true); }
  const ls = lines(SINK);
  assert.strictEqual(ls.length, before + 1);
  const e = ls[ls.length - 1];
  assert.strictEqual(e.gate, 'capability-gate');
  assert.ok(e.reason.includes('"click" not in declared capabilities'));
});

await ok('gateway-auth: 401 persists route/method/peer — and NEVER the provided credential', async () => {
  process.env.ATMOS_GATEWAY_SECRET = 'test-secret-value-for-denial-audit';
  const { requireGatewaySecret } = await import('../api-shim/src/gateway-auth.js');
  const before = lines(SINK).length;
  const req = { get: (h) => (h === 'authorization' ? 'Bearer wrong-credential-value' : ''), path: '/v1/chat/completions', method: 'POST', ip: '127.0.0.1' };
  let status = null;
  const res = { status: (s) => { status = s; return res; }, json: () => res };
  requireGatewaySecret(req, res, () => assert.fail('must not pass'));
  assert.strictEqual(status, 401);
  const e = lines(SINK)[before];
  assert.strictEqual(e.gate, 'gateway-auth');
  assert.strictEqual(e.route, '/v1/chat/completions');
  assert.strictEqual(e.method, 'POST');
  const raw = fs.readFileSync(SINK, 'utf8');
  assert.ok(!raw.includes('wrong-credential-value'), 'provided credential must never reach the sink');
  assert.ok(!raw.includes('test-secret-value-for-denial-audit'), 'the real secret must never reach the sink');
  delete process.env.ATMOS_GATEWAY_SECRET;
});

assert.strictEqual(pass, 7, `expected all 7 tests to run, got ${pass}`);
console.log(`\n✅ ${pass}/7 denial-audit tests passed — denials are persistent, bounded, secret-safe.`);
