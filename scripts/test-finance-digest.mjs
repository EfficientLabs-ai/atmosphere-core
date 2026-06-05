/**
 * test-finance-digest.mjs — HERMETIC tests for the FINANCE-DIGEST automation.
 *
 * Everything external is mocked/injected: the Stripe fetch, the Telegram send, the owner resolver,
 * and `now`. No live Stripe, no live Telegram, no real keys, no real .stratos-profile. Verifies:
 *   - buildDigest formats real-shaped Stripe data correctly (balance/charges/customers/subs+MRR)
 *   - a Stripe-endpoint error → that line reads "unavailable", NEVER a fabricated number
 *   - formatDigest output is honest + compact + HTML-safe
 *   - missing Stripe key → clean exit, NOTHING sent
 *   - missing owner / missing bot token → clean exit, NOTHING sent
 *   - --dry-run → NEVER calls send, prints the digest
 *   - happy path → sends exactly once to the bound owner with parse_mode HTML
 *   - the vault reader never throws and honors a PASTE_ placeholder as "absent"
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDigest, formatDigest, sendToOwner, run, readVaultSecret,
} from './finance-digest.mjs';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

// A mock Stripe fetch driven by a route→payload map. Returns {ok,json} or {ok:false} for "error".
function mockStripeFetch(routes) {
  return async (url) => {
    for (const [needle, payload] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (payload === '__ERROR__') return { ok: false, status: 500 };
        return { ok: true, json: async () => payload };
      }
    }
    return { ok: false, status: 404 };
  };
}

const NOW = Date.UTC(2026, 5, 6, 12, 0, 0); // fixed clock

console.log('=== buildDigest: real-shaped data formats correctly ===');
{
  const fetchImpl = mockStripeFetch({
    '/balance': { available: [{ amount: 120000, currency: 'usd' }], pending: [{ amount: 79700, currency: 'usd' }] },
    '/charges': { data: [
      { paid: true, status: 'succeeded', amount: 79700, currency: 'usd', balance_transaction: { fee: 2611, net: 77089 } },
      { paid: true, status: 'succeeded', amount: 79700, currency: 'usd', balance_transaction: { fee: 2611, net: 77089 } },
      { paid: false, status: 'failed', amount: 79700, currency: 'usd' }, // must be ignored
    ] },
    '/customers': { data: [{ id: 'cus_1' }, { id: 'cus_2' }] },
    '/subscriptions': { data: [
      { items: { data: [{ quantity: 1, price: { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } },
      { items: { data: [{ quantity: 1, price: { unit_amount: 120000, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } } }] } }, // 120000/12 = 10000/mo
    ] },
  });
  const d = await buildDigest({ key: 'sk_test_MOCK', fetchImpl, now: NOW });
  ok(d.balance.available && d.balance.byCurrency.usd.available === 120000 && d.balance.byCurrency.usd.pending === 79700, 'balance: available + pending by currency');
  ok(d.charges24h.available && d.charges24h.count === 2, 'charges: only paid+succeeded counted (failed ignored)');
  ok(d.charges24h.gross === 159400 && d.charges24h.fees === 5222 && d.charges24h.net === 154178, 'charges: gross/fees/net summed from balance_transaction');
  ok(d.customers24h.available && d.customers24h.count === 2, 'customers: 24h count');
  ok(d.subscriptions.available && d.subscriptions.active === 2, 'subs: active count');
  ok(d.subscriptions.mrrCents === 14900, 'subs: MRR normalizes yearly→monthly (4900/mo + 120000/12=10000/mo = 14900)');

  const msg = formatDigest(d, { date: new Date(NOW) });
  ok(msg.includes('$1,200.00 avail / $797.00 pending'), 'format: balance line');
  ok(msg.includes('2 charges, $1,594.00 gross'), 'format: 24h charges line');
  ok(msg.includes('$1,541.78 net') && msg.includes('$52.22 fees'), 'format: net + fees shown when known');
  ok(msg.includes('New customers (24h):</b> 2'), 'format: new customers line');
  ok(msg.includes('2 active') && msg.includes('$149.00 MRR'), 'format: subscriptions + MRR line');
  ok(!/unavailable/.test(msg), 'format: nothing marked unavailable when all data present');
}

console.log('\n=== Stripe-endpoint error → "unavailable", never a fabricated number ===');
{
  const fetchImpl = mockStripeFetch({
    '/balance': '__ERROR__',
    '/charges': '__ERROR__',
    '/customers': { data: [{ id: 'cus_x' }] },
    '/subscriptions': '__ERROR__',
  });
  const d = await buildDigest({ key: 'sk_test_MOCK', fetchImpl, now: NOW });
  ok(d.balance.available === false, 'balance error → available:false');
  ok(d.charges24h.available === false && d.charges24h.gross === 0, 'charges error → available:false, no invented gross');
  ok(d.customers24h.available === true && d.customers24h.count === 1, 'working endpoint still reports honestly');
  const msg = formatDigest(d, { date: new Date(NOW) });
  ok(msg.includes('<b>Balance:</b> <i>unavailable</i>'), 'format: balance shows unavailable, not $0 fabricated');
  ok(msg.includes('<b>24h charges:</b> <i>unavailable</i>'), 'format: charges shows unavailable');
  ok(msg.includes('<b>Subscriptions:</b> <i>unavailable</i>'), 'format: subscriptions shows unavailable');
  ok(!/\$\d/.test(msg.split('\n').filter(l => /unavailable/.test(l)).join('')), 'no $-number on any unavailable line');
}

console.log('\n=== HTML safety + zero-state honesty ===');
{
  const d = {
    balance: { available: true, byCurrency: { usd: { available: 0, pending: 0 } } },
    charges24h: { available: true, count: 0, gross: 0, fees: 0, net: 0, currency: 'usd' },
    customers24h: { available: true, count: 0 },
    subscriptions: { available: true, active: 0, mrrCents: 0, currency: 'usd' },
  };
  const msg = formatDigest(d, { date: new Date(NOW) });
  ok(msg.includes('0 charges, $0.00 gross'), 'zero-state: honest 0 charges (real zero, not unavailable)');
  ok(msg.includes('none active'), 'zero-state: no active subscriptions');
  ok(msg.includes('observer, not the operator'), 'footer present (founder = observer)');
}

console.log('\n=== run(): missing Stripe key → clean exit, NOTHING sent ===');
{
  let sendCalls = 0;
  const fetchImpl = async (url) => { if (url.includes('telegram')) sendCalls++; return { ok: true, json: async () => ({}) }; };
  const logs = [];
  const r = await run({ env: {}, cwd: '/nonexistent-vault-dir', fetchImpl, log: (m) => logs.push(m), now: NOW });
  ok(r.ok === false && r.reason === 'no-stripe-key' && r.sent === false, 'no key → ok:false, reason no-stripe-key, sent:false');
  ok(sendCalls === 0, 'no key → send never called');
  ok(logs.join('\n').includes('STRIPE key not configured') && !logs.join('\n').includes('sk_'), 'no key → clear message, no secret echoed');
}

console.log('\n=== run(): --dry-run → prints digest, NEVER calls send ===');
{
  let sendCalls = 0;
  const fetchImpl = (url, opts) => {
    if (url.includes('telegram')) { sendCalls++; return Promise.resolve({ ok: true, json: async () => ({}) }); }
    // Stripe routes
    if (url.includes('/balance')) return Promise.resolve({ ok: true, json: async () => ({ available: [{ amount: 5000, currency: 'usd' }], pending: [] }) });
    return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
  };
  const logs = [];
  const r = await run({ dryRun: true, env: { STRIPE_SECRET_KEY: 'sk_test_MOCK' }, cwd: '/nonexistent', fetchImpl, log: (m) => logs.push(m), now: NOW });
  ok(r.dryRun === true && r.sent === false, 'dry-run → sent:false');
  ok(sendCalls === 0, 'dry-run → send never called');
  ok(logs.join('\n').includes('dry-run') && logs.join('\n').includes('Balance:'), 'dry-run → digest printed to stdout');
  ok(!logs.join('\n').includes('sk_test_MOCK'), 'dry-run → key never printed');
}

console.log('\n=== run(): no owner bound → clean exit, NOTHING sent ===');
{
  let sendCalls = 0;
  const fetchImpl = (url) => {
    if (url.includes('telegram')) { sendCalls++; return Promise.resolve({ ok: true, json: async () => ({}) }); }
    return Promise.resolve({ ok: true, json: async () => ({ data: [], available: [], pending: [] }) });
  };
  const r = await run({
    env: { STRIPE_SECRET_KEY: 'sk_test_MOCK' }, cwd: '/nonexistent', fetchImpl,
    getOwnerFn: () => null, log: () => {}, now: NOW,
  });
  ok(r.ok === false && r.reason === 'no-owner' && r.sent === false, 'no owner → ok:false, no-owner, sent:false');
  ok(sendCalls === 0, 'no owner → send never called (never to a wrong/unset chat)');
}

console.log('\n=== run(): owner bound but no bot token → clean exit, NOTHING sent ===');
{
  let sendCalls = 0;
  const fetchImpl = (url) => {
    if (url.includes('telegram')) { sendCalls++; return Promise.resolve({ ok: true, json: async () => ({}) }); }
    return Promise.resolve({ ok: true, json: async () => ({ data: [], available: [], pending: [] }) });
  };
  const r = await run({
    env: { STRIPE_SECRET_KEY: 'sk_test_MOCK' }, cwd: '/nonexistent', fetchImpl,
    getOwnerFn: () => '12345', log: () => {}, now: NOW,
  });
  ok(r.ok === false && r.reason === 'no-token' && r.sent === false, 'no bot token → ok:false, no-token, sent:false');
  ok(sendCalls === 0, 'no bot token → send never called');
}

console.log('\n=== run(): happy path → sends exactly once to the bound owner (HTML) ===');
{
  // Vault dir with a real bot token row (hermetic temp dir, fake token value).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-vault-'));
  fs.mkdirSync(path.join(tmp, '.secrets-vault'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.secrets-vault', 'env_blueprint.md'),
    '| Key | Value |\n|---|---|\n| `TELEGRAM_BOT_TOKEN` | 999:FAKE_TEST_TOKEN |\n');

  const calls = [];
  const fetchImpl = (url, opts) => {
    if (url.includes('api.telegram.org')) {
      calls.push({ url, body: JSON.parse(opts.body), parse: JSON.parse(opts.body).parse_mode });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (url.includes('/balance')) return Promise.resolve({ ok: true, json: async () => ({ available: [{ amount: 79700, currency: 'usd' }], pending: [] }) });
    if (url.includes('/customers')) return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: 'c1' }] }) });
    return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
  };
  const r = await run({
    env: { STRIPE_SECRET_KEY: 'sk_test_MOCK' }, cwd: tmp, fetchImpl,
    getOwnerFn: () => '55512345', log: () => {}, now: NOW,
  });
  ok(r.ok === true && r.sent === true, 'happy path → ok:true, sent:true');
  ok(calls.length === 1, 'send called exactly once');
  ok(calls[0].url.includes('/bot999:FAKE_TEST_TOKEN/sendMessage'), 'send uses bot token from vault in the URL path');
  ok(String(calls[0].body.chat_id) === '55512345', 'send targets the bound owner chat id ONLY');
  ok(calls[0].parse === 'HTML', 'send uses parse_mode HTML');
  ok(calls[0].body.text.includes('Efficient Labs'), 'send body is the digest');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== sendToOwner: guards (no token / no owner) never call fetch ===');
{
  let n = 0;
  const f = () => { n++; return Promise.resolve({ ok: true }); };
  ok((await sendToOwner('x', { token: '', ownerChatId: '1', fetchImpl: f })).reason === 'no-token', 'no token → reason no-token');
  ok((await sendToOwner('x', { token: 't', ownerChatId: null, fetchImpl: f })).reason === 'no-owner', 'no owner → reason no-owner');
  ok(n === 0, 'guarded sends never hit the network');
}

console.log('\n=== readVaultSecret: env wins, PASTE_ placeholder = absent, never throws ===');
{
  ok(readVaultSecret('STRIPE_SECRET_KEY', { env: { STRIPE_SECRET_KEY: 'sk_env' }, cwd: '/nope' }) === 'sk_env', 'env var wins');
  ok(readVaultSecret('STRIPE_SECRET_KEY', { env: { STRIPE_SECRET_KEY: 'PASTE_HERE' }, cwd: '/nope' }) === null, 'PASTE_ placeholder treated as absent');
  ok(readVaultSecret('MISSING_KEY', { env: {}, cwd: '/nope' }) === null, 'missing vault dir → null, no throw');
}

console.log(`\n\x1b[32m✅ finance-digest: all ${pass} assertions passed.\x1b[0m`);
