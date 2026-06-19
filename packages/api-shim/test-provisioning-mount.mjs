/**
 * test-provisioning-mount.mjs — the LIVE-PATH wiring: buildProvisioning() + the Supabase console
 * mirror + raw-body coexistence with the global JSON parser (the exact shape server.js mounts).
 *
 * Proves the seam that closes the revenue path on the bridge:
 *  1. SAFE-BY-DEFAULT: no bundle → webhook 503 (fail-closed), issuer Free floor.
 *  2. LIVE: injected verifyEvent + signing key + price map → webhook 200 handled, token issues + verifies.
 *  3. CONSOLE MIRROR: a verified paid event writes the SAME recompute result to the Supabase
 *     `subscriptions` row the console reads (asserted via an injected fake fetch).
 *  4. FAIL LOUD: Supabase creds absent → the mirror THROWS → webhook 500 (retry), NEVER a silent 200.
 *  5. RAW-BODY COEXISTENCE: mounted ahead of express.json() exactly like server.js — the signature
 *     sees raw bytes AND other routes still parse JSON.
 *
 * Hermetic: injected fake Stripe verifier + fake subscription source + fake Supabase fetch, tmp dirs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import { generateHybridKeyPair, verifyPayload } from '../stratos-agent/src/security/quantum-crypto.js';
import { createEntitlement } from './src/product/entitlement.js';
import { buildProvisioning } from './src/product/provisioning-mount.js';
import { createSupabaseFulfillment } from './src/product/supabase-fulfillment.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

// The live-issue assertions drive the route via the test-only x-efl-subject header (no injected
// resolver in this slice). That header path is fail-closed by default (Codex CRITICAL); opt in here.
process.env.ALLOW_HEADER_SUBJECT = '1';

const DAY = 86_400_000;
const prov = generateHybridKeyPair();
const periodEndSec = Math.round((Date.now() + 30 * DAY) / 1000);
const tierForPrice = (pid) => (pid === 'price_apex' ? 'apex' : null);
const apexSub = (over = {}) => ({ id: 'sub_1', status: 'active', current_period_end: periodEndSec, customer: 'cus_A', items: { data: [{ price: { id: 'price_apex', recurring: { interval: 'month' } } }] }, ...over });
const subs = { sub_1: apexSub() };

// test-mode verifier (a real deploy injects Stripe signature verify): trust the body as the event.
const verifyEvent = (rawBuf) => JSON.parse(Buffer.from(rawBuf).toString('utf8'));

// fake Supabase REST: capture upserts; assert the row the console would read.
function fakeSupabaseFetch(captured) {
  return async (url, init) => {
    captured.push({ url, body: JSON.parse(init.body), prefer: init.headers.prefer });
    return { status: 201, text: async () => '' };
  };
}

const webhookEvt = (id, type, object) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=test' }, body: JSON.stringify({ id, type, data: { object } }) });

function serve({ bundle, fulfillment }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-mount-'));
  const built = buildProvisioning({ bundle, fulfillment, storeDir: dir });
  const app = express();
  // EXACTLY like server.js: webhook (raw body) BEFORE the global JSON parser.
  app.use(built.webhookRouter);
  app.use(bodyParser.json());
  app.post('/echo', (req, res) => res.json({ got: req.body })); // proves JSON parser still works after
  app.use(built.issueRouter);
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${s.address().port}`, status: built.status, close: () => { s.close(); fs.rmSync(dir, { recursive: true, force: true }); } })); });
}

console.log('provisioning-mount — live-path wiring + Supabase console mirror\n');

// 1. SAFE-BY-DEFAULT: no bundle → 503 fail-closed, status.live false.
{
  const { base, status, close } = await serve({ bundle: null, fulfillment: { enabled: false, write: async () => {} } });
  ok(status.live === false && status.canSign === false, 'no bundle → status live:false canSign:false (safe default)');
  const r = await fetch(`${base}/v1/stripe/webhook`, webhookEvt('evt_x', 'customer.subscription.updated', subs.sub_1));
  ok(r.status === 503, 'no verifier injected → webhook 503 (fail-closed, nothing live by accident)');
  close();
}

// 2+3. LIVE bundle + console mirror: webhook 200 handled, token verifies, Supabase row written.
{
  const captured = [];
  const fulfillment = createSupabaseFulfillment({ url: 'https://proj.supabase.co', serviceKey: 'svc_test', fetchImpl: fakeSupabaseFetch(captured) });
  const bundle = { verifyEvent, tierForPrice, fetchSubscription: async (id) => subs[id] || null, provPrivBundle: prov.privateKey };
  const { base, status, close, ...rest } = await serve({ bundle, fulfillment });
  void rest;
  ok(status.live === true && status.canSign === true && status.consoleMirror === true, 'live bundle → status live:true canSign:true consoleMirror:true');

  const r1 = await fetch(`${base}/v1/stripe/webhook`, webhookEvt('evt_1', 'checkout.session.completed', { subscription: 'sub_1', customer: 'cus_A' }));
  const b1 = await r1.json();
  ok(r1.status === 200 && b1.handled === true, 'live webhook checkout.session.completed → 200 handled');

  // CONSOLE MIRROR: the same recompute result landed in the Supabase `subscriptions` upsert.
  const row = captured.at(-1)?.body?.[0];
  ok(captured.length === 1 && row?.subject === 'cus_A' && row?.tier === 'apex' && row?.grant === true, 'console mirror: Supabase subscriptions upsert carries subject=cus_A tier=apex grant=true');
  ok(/merge-duplicates/.test(captured.at(-1)?.prefer || ''), 'console mirror: upsert uses resolution=merge-duplicates (idempotent row of record)');

  // token issues + verifies offline.
  const r2 = await fetch(`${base}/v1/account/entitlement-token`, { headers: { 'x-efl-subject': 'cus_A' } });
  const b2 = await r2.json();
  ok(r2.status === 200 && b2.grant === true && b2.token?.format === 'efl.entitlement.v1', 'live issue → signed token');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-tok-'));
  const tokenPath = path.join(dir2, 'entitlement.json');
  fs.writeFileSync(tokenPath, JSON.stringify(b2.token));
  const resolved = createEntitlement({ verifyPayload }, { tokenPath, provisioningPublicKey: prov.publicKey }).resolve();
  ok(resolved.source === 'token' && resolved.tier === 'apex', 'issued token verifies offline → apex (LIVE LOOP CLOSED)');
  fs.rmSync(dir2, { recursive: true, force: true });

  // 5. RAW-BODY COEXISTENCE: the global JSON parser still works for a normal route after the webhook.
  const r3 = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hi: 1 }) });
  const b3 = await r3.json();
  ok(r3.status === 200 && b3.got?.hi === 1, 'raw-body webhook coexists with the global JSON parser (other routes still parse JSON)');

  close();
}

// 6. REQUIRE fetchSubscription (Codex HIGH F2): a bundle with a verifier but NO fetchSubscription must
//    FAIL CLOSED (503) — refetch-current-state is the primary out-of-order defense; the mount must not
//    silently run on the weak floor alone. status.live must also be false (and canFetch:false).
{
  const bundle = { verifyEvent, tierForPrice, provPrivBundle: prov.privateKey }; // NO fetchSubscription
  const { base, status, close } = await serve({ bundle, fulfillment: { enabled: true, write: async () => {} } });
  ok(status.live === false && status.canFetch === false, 'verifier WITHOUT fetchSubscription → status live:false, canFetch:false');
  const r = await fetch(`${base}/v1/stripe/webhook`, webhookEvt('evt_nofetch', 'customer.subscription.updated', subs.sub_1));
  ok(r.status === 503, 'verifier present but fetchSubscription absent → webhook 503 (fail-closed, not the weak floor)');
  close();
}

// 4. FAIL LOUD: Supabase creds absent → mirror throws → webhook 500 (retry), NEVER a silent 200-noop.
{
  const bundle = { verifyEvent, tierForPrice, fetchSubscription: async (id) => subs[id] || null, provPrivBundle: prov.privateKey };
  // no fulfillment override → buildProvisioning builds the real sink; with no SUPABASE_* it's disabled.
  const savedUrl = process.env.SUPABASE_URL; const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { base, status, close } = await serve({ bundle });
  ok(status.consoleMirror === false, 'no Supabase creds → consoleMirror:false');
  const r = await fetch(`${base}/v1/stripe/webhook`, webhookEvt('evt_loud', 'customer.subscription.updated', subs.sub_1));
  const b = await r.json();
  ok(r.status === 500 && b.retry === true, 'verified event but Supabase mirror unconfigured → 500 retry (FAIL LOUD, never silent 200-noop)');
  close();
  if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
  if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
}

console.log(`\n${fail ? '✖' : '✓'} provisioning-mount: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
