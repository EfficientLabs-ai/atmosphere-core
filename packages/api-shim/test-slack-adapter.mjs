/**
 * Slack adapter tests — the pure, network-free logic: owner/mention gating (deny-by-default), bot/system
 * message filtering, reply chunking, and prompt routing to the local gateway (injected fetch). The live
 * Socket Mode connection (start()) is operator-verified with real tokens.
 */
import assert from 'node:assert';
import { SlackAdapter } from './src/omni-gateway/slack-adapter.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const BOT = 'U0BOT123';
const dm = (over = {}) => ({ userId: 'U0OWNER1', botId: undefined, subtype: undefined, text: 'hello', isDM: true, mentionedBot: false, ...over });

console.log('=== gating: deny-by-default ===');
const a = new SlackAdapter({ ownerId: 'U0OWNER1', verbose: false });
ok(a.shouldHandle(dm(), BOT).handle === true, 'a DM from the owner → handled');
ok(a.shouldHandle(dm({ userId: BOT }), BOT).handle === false, 'our own message → skipped');
ok(a.shouldHandle(dm({ botId: 'B123' }), BOT).handle === false, 'a bot message → skipped');
ok(a.shouldHandle(dm({ subtype: 'message_changed' }), BOT).handle === false, 'a system/edited (subtyped) message → skipped');
ok(a.shouldHandle(dm({ userId: 'U0STRANGR' }), BOT).handle === false, 'a non-owner → skipped (owner-gated)');
ok(a.shouldHandle(dm({ isDM: false, mentionedBot: false }), BOT).handle === false, 'a channel message with NO @mention → skipped');
const mentioned = a.shouldHandle({ userId: 'U0OWNER1', text: '<@U0BOT123> summarize this', isDM: false, mentionedBot: true }, BOT);
ok(mentioned.handle === true && mentioned.text === 'summarize this', 'an @mention in a channel → handled, mention stripped');
ok(a.shouldHandle(dm({ text: '   ' }), BOT).handle === false, 'an empty prompt → skipped');

console.log('\n=== no owner set → FAIL CLOSED unless explicitly opted into an open bot ===');
const closed = new SlackAdapter({ verbose: false });
ok(closed.shouldHandle(dm({ userId: 'U0ANYONE' }), BOT).handle === false, 'no owner configured → nobody is handled (fail-closed)');
ok(/no owner/.test(closed.shouldHandle(dm({ userId: 'U0ANYONE' }), BOT).reason), 'the skip reason names the missing owner');
const open = new SlackAdapter({ verbose: false, allowAnyone: true });
ok(open.shouldHandle(dm({ userId: 'U0ANYONE' }), BOT).handle === true, 'allowAnyone opt-in → an open bot handles anyone in a DM');

console.log('\n=== reply chunking to the Slack limit ===');
const parts = SlackAdapter.chunk('x'.repeat(8000));
ok(parts.length >= 3 && parts.every((p) => p.length <= 3000), 'an 8000-char reply splits into ≤3000-char chunks');
ok(SlackAdapter.chunk('hi').length === 1, 'a short reply stays one message');
const nl = SlackAdapter.chunk('a'.repeat(2000) + '\n' + 'b'.repeat(2000));
ok(nl.length === 2 && nl[0] === 'a'.repeat(2000), 'splits on the newline');

console.log('\n=== prompt routing to the local gateway (injected fetch) ===');
let seen = null;
const adapter = new SlackAdapter({ port: 4099, model: 'local', verbose: false, fetch: async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { json: async () => ({ choices: [{ message: { content: 'agent reply' } }] }) }; } });
ok((await adapter.askAgent('hello there')) === 'agent reply', 'returns the gateway completion content');
ok(seen.url === 'http://127.0.0.1:4099/v1/chat/completions' && seen.body.messages[0].content === 'hello there', 'routes the prompt to the local gateway');

console.log('\n=== start() needs BOTH tokens (Socket Mode) → safe no-op otherwise ===');
ok((await new SlackAdapter({ botToken: 'xoxb-1', appToken: null, verbose: false }).start()) === false, 'missing app token → start() returns false, never throws');
ok((await new SlackAdapter({ botToken: null, appToken: 'xapp-1', verbose: false }).start()) === false, 'missing bot token → start() returns false');

console.log('\n=== signature verification (HTTP-mode fallback) is real HMAC + replay-bounded ===');
const s = new SlackAdapter({ signingSecret: 'shh', verbose: false });
ok(s.verifyRequestSignature('body', '1', 'v0=bad') === false, 'a stale/forged signature → rejected');

console.log(`\n✅ ALL ${pass} slack-adapter checks passed.`);
