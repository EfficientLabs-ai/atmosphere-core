// test-identity-broker.mjs — brokered, short-lived, audience-bound assertions (IDJAG-style).
import assert from 'node:assert';
import crypto from 'node:crypto';
import { IdentityBroker, BrokerError } from './src/identity/identity-broker.js';

let pass = 0, clock = 1_000_000_000_000, n = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const denied = (fn) => { try { fn(); return false; } catch (e) { return e instanceof BrokerError && e.denied; } };
const now = () => clock;
const jti = () => `jti-${++n}`;
const SUB = 'did:atmos:agent1', AUD = 'api.github.com';

console.log('identity broker — agent transacts without holding the credential\n');

const mk = () => new IdentityBroker({ secret: 'broker-secret', ttlMs: 300000, now, jti });

ok('grant → issue → verify round-trips for the granted audience+scope', () => {
  const B = mk();
  B.grant({ subject: SUB, audience: AUD, scopes: ['issues.read', 'issues.write'] });
  const tok = B.issue({ subject: SUB, audience: AUD, scope: 'issues.write' });
  const v = B.verify(tok, { audience: AUD, scope: 'issues.write' });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.claims.sub, SUB);
  assert.strictEqual(v.claims.aud, AUD);
});

ok('deny-by-default: no grant ⇒ refused; scope beyond grant ⇒ refused', () => {
  const B = mk();
  assert.ok(denied(() => B.issue({ subject: SUB, audience: AUD, scope: 'issues.read' }))); // no grant
  B.grant({ subject: SUB, audience: AUD, scopes: ['issues.read'] });
  assert.ok(denied(() => B.issue({ subject: SUB, audience: AUD, scope: 'issues.write' }))); // beyond grant
});

ok('the token is a scoped ASSERTION — never the underlying credential', () => {
  const B = mk();
  B.grant({ subject: SUB, audience: AUD, scopes: ['issues.read'] });
  const tok = B.issue({ subject: SUB, audience: AUD, scope: 'issues.read' });
  const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
  assert.ok(!('secret' in payload) && !('credential' in payload) && !('apiKey' in payload));
  assert.ok(payload.exp > payload.iat && payload.jti); // short-lived + unique
});

ok('audience-bound: a token for one audience does not verify for another', () => {
  const B = mk();
  B.grant({ subject: SUB, audience: AUD, scopes: ['x'] });
  const tok = B.issue({ subject: SUB, audience: AUD, scope: 'x' });
  assert.strictEqual(B.verify(tok, { audience: 'evil.example' }).ok, false);
});

ok('short-lived: verify rejects an expired assertion', () => {
  const B = mk();
  B.grant({ subject: SUB, audience: AUD, scopes: ['x'] });
  const tok = B.issue({ subject: SUB, audience: AUD, scope: 'x' });
  clock += 301_000; // jump past the 300s TTL
  assert.strictEqual(B.verify(tok, { audience: AUD }).ok, false);
  clock -= 301_000;
});

ok('tamper-evident: forged signature and edited payload both fail', () => {
  const B = mk();
  B.grant({ subject: SUB, audience: AUD, scopes: ['read'] });
  const tok = B.issue({ subject: SUB, audience: AUD, scope: 'read' });
  const [h, p] = tok.split('.');
  assert.strictEqual(B.verify(`${h}.${p}.deadbeef`, { audience: AUD }).ok, false); // forged sig
  const elevated = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), scope: ['admin'] })).toString('base64url');
  assert.strictEqual(B.verify(`${h}.${elevated}.${tok.split('.')[2]}`, { audience: AUD }).ok, false); // edited payload
});

ok('capability tie-in: cannot mint for a host the skill did not declare', () => {
  const B = mk();
  B.grant({ subject: SUB, audience: AUD, scopes: ['x'] });
  // skill declared net allows only api.github.com → issuing for AUD ok, but a different audience is refused
  B.grant({ subject: SUB, audience: 'api.stripe.com', scopes: ['x'] });
  B.issue({ subject: SUB, audience: AUD, scope: 'x', capabilities: { net: ['api.github.com'] } }); // ok
  assert.ok(denied(() => B.issue({ subject: SUB, audience: 'api.stripe.com', scope: 'x', capabilities: { net: ['api.github.com'] } })));
});

ok('revoke removes the grant (issue then refused)', () => {
  const B = mk();
  B.grant({ subject: SUB, audience: AUD, scopes: ['x'] });
  B.issue({ subject: SUB, audience: AUD, scope: 'x' });
  B.revoke({ subject: SUB, audience: AUD });
  assert.ok(denied(() => B.issue({ subject: SUB, audience: AUD, scope: 'x' })));
});

ok('asymmetric (PQC-style) signer/verifier path works', () => {
  const signer = (i) => crypto.createHash('sha256').update('SK' + i).digest('base64url');
  const verifier = (i, s) => s === crypto.createHash('sha256').update('SK' + i).digest('base64url');
  const B = new IdentityBroker({ signer, verifier, now, jti });
  B.grant({ subject: SUB, audience: AUD, scopes: ['x'] });
  const tok = B.issue({ subject: SUB, audience: AUD, scope: 'x' });
  assert.strictEqual(B.verify(tok, { audience: AUD }).ok, true);
  assert.strictEqual(B.verify(`${tok}tampered`, { audience: AUD }).ok, false);
});

console.log(`\n✅ ${pass}/${pass} identity-broker tests passed — short-lived, audience-bound, deny-by-default.`);
