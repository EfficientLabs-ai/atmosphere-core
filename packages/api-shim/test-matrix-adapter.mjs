/**
 * Matrix adapter tests — the pure, network-free logic: owner gating (deny-by-default), text-only
 * filtering, reply chunking, prompt routing to the local gateway (injected fetch). The live homeserver
 * connection (start()) is operator-verified with a real access token.
 */
import assert from 'node:assert';
import { MatrixAdapter } from './src/omni-gateway/matrix-adapter.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const BOT = '@stratos:matrix.org';
const msg = (over = {}) => ({ type: 'm.room.message', msgtype: 'm.text', sender: '@owner:matrix.org', body: 'hello', ...over });

console.log('=== gating: deny-by-default ===');
const a = new MatrixAdapter({ ownerId: '@owner:matrix.org', verbose: false });
ok(a.shouldHandle(msg(), BOT).handle === true, 'a text message from the owner → handled');
ok(a.shouldHandle(msg({ sender: BOT }), BOT).handle === false, 'our own message → skipped');
ok(a.shouldHandle(msg({ sender: '@stranger:matrix.org' }), BOT).handle === false, 'a non-owner → skipped (owner-gated)');
ok(a.shouldHandle(msg({ msgtype: 'm.image' }), BOT).handle === false, 'a non-text (image) message → skipped');
ok(a.shouldHandle(msg({ type: 'm.room.member' }), BOT).handle === false, 'a non-message event (membership) → skipped');
ok(a.shouldHandle(msg({ body: '   ' }), BOT).handle === false, 'an empty body → skipped');
const handled = a.shouldHandle(msg({ body: 'what is the weather' }), BOT);
ok(handled.handle === true && handled.text === 'what is the weather', 'a real prompt → handled, text extracted');

console.log('\n=== no owner set → responds to anyone, still skips self ===');
const open = new MatrixAdapter({ verbose: false });
ok(open.shouldHandle(msg({ sender: '@anyone:matrix.org' }), BOT).handle === true, 'no owner configured → anyone is handled');
ok(open.shouldHandle(msg({ sender: BOT }), BOT).handle === false, 'still skips its own messages');

console.log('\n=== reply chunking ===');
const parts = MatrixAdapter.chunk('y'.repeat(10000));
ok(parts.length >= 3 && parts.every((p) => p.length <= 4000), 'a 10000-char reply splits into ≤4000-char chunks');
ok(MatrixAdapter.chunk('hi').length === 1, 'a short reply stays one message');

console.log('\n=== prompt routing to the local gateway (injected fetch) ===');
let seen = null;
const adapter = new MatrixAdapter({ port: 4099, model: 'local', verbose: false, fetch: async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { json: async () => ({ choices: [{ message: { content: 'matrix reply' } }] }) }; } });
ok((await adapter.askAgent('hi agent')) === 'matrix reply', 'returns the gateway completion content');
ok(seen.url === 'http://127.0.0.1:4099/v1/chat/completions' && seen.body.messages[0].content === 'hi agent', 'routes the prompt to the local gateway');

console.log('\n=== start() needs homeserver + token → safe no-op otherwise ===');
ok((await new MatrixAdapter({ baseUrl: 'https://matrix.org', accessToken: null, verbose: false }).start()) === false, 'missing access token → start() returns false, never throws');
ok((await new MatrixAdapter({ baseUrl: null, accessToken: 'syt_x', verbose: false }).start()) === false, 'missing homeserver → start() returns false');

console.log(`\n✅ ALL ${pass} matrix-adapter checks passed.`);
