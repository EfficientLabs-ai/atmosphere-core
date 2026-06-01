/**
 * Signal adapter tests — pure logic: owner gating (deny-by-default), text-only, chunking, gateway routing.
 * The live signal-cli connection (start()) is operator-verified with a registered number.
 */
import assert from 'node:assert';
import { SignalAdapter } from './src/omni-gateway/signal-adapter.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const env = (over = {}) => ({ source: '+15550000001', sourceNumber: '+15550000001', dataMessage: { message: 'hello' }, ...over });

console.log('=== gating: deny-by-default ===');
const a = new SignalAdapter({ number: '+15559999999', ownerId: '+15550000001', verbose: false });
ok(a.shouldHandle(env()).handle === true, 'a message from the owner → handled');
ok(a.shouldHandle(env({ source: '+15559999999', sourceNumber: '+15559999999' })).handle === false, 'our own number → skipped');
ok(a.shouldHandle(env({ source: '+15558888888', sourceNumber: '+15558888888' })).handle === false, 'a non-owner → skipped (owner-gated)');
ok(a.shouldHandle(env({ dataMessage: null })).handle === false, 'a non-text envelope (e.g. receipt) → skipped');
ok(a.shouldHandle(env({ dataMessage: { message: '   ' } })).handle === false, 'an empty message → skipped');
const h = a.shouldHandle(env({ dataMessage: { message: 'what time is it' } }));
ok(h.handle === true && h.text === 'what time is it' && h.sender === '+15550000001', 'real prompt → handled, text + sender extracted');

console.log('\n=== no owner set → FAIL CLOSED unless explicitly opted into an open bot ===');
const closed = new SignalAdapter({ number: '+15559999999', verbose: false });
ok(closed.shouldHandle(env({ source: '+1555anyone', sourceNumber: '+1555anyone' })).handle === false, 'no owner → nobody is handled (fail-closed)');
ok(/no owner/.test(closed.shouldHandle(env({ source: '+1555anyone', sourceNumber: '+1555anyone' })).reason), 'the skip reason names the missing owner');
const open = new SignalAdapter({ number: '+15559999999', verbose: false, allowAnyone: true });
ok(open.shouldHandle(env({ source: '+1555anyone', sourceNumber: '+1555anyone' })).handle === true, 'allowAnyone opt-in → an open bot handles anyone');
ok(open.shouldHandle(env({ source: '+15559999999', sourceNumber: '+15559999999' })).handle === false, 'an open bot still skips its own number');

console.log('\n=== chunking + routing ===');
const parts = SignalAdapter.chunk('z'.repeat(5000));
ok(parts.length >= 3 && parts.every((p) => p.length <= 2000), 'a 5000-char reply splits into ≤2000-char chunks');
let seen = null;
const adapter = new SignalAdapter({ number: '+1', port: 4099, model: 'local', verbose: false, fetch: async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { json: async () => ({ choices: [{ message: { content: 'signal reply' } }] }) }; } });
ok((await adapter.askAgent('ping')) === 'signal reply' && seen.url === 'http://127.0.0.1:4099/v1/chat/completions', 'routes the prompt to the local gateway');

console.log('\n=== start() needs a number → safe no-op otherwise ===');
ok((await new SignalAdapter({ number: null, verbose: false }).start()) === false, 'no SIGNAL_NUMBER → start() returns false, never throws');

console.log(`\n✅ ALL ${pass} signal-adapter checks passed.`);
