/**
 * Discord adapter tests — the pure, network-free logic: owner/mention gating (deny-by-default), reply
 * chunking to Discord's limit, and prompt routing to the local gateway (injected fetch). The live
 * discord.js connection (start()) is operator-verified with a real bot token.
 */
import assert from 'node:assert';
import { DiscordAdapter } from './src/omni-gateway/discord-adapter.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const BOT = 'bot-999';
const dm = (over = {}) => ({ authorId: 'owner-1', authorBot: false, content: 'hello', isDM: true, mentionedBot: false, ...over });

console.log('=== gating: deny-by-default ===');
let a = new DiscordAdapter({ ownerId: 'owner-1', verbose: false });
ok(a.shouldHandle(dm(), BOT).handle === true, 'a DM from the owner → handled');
ok(a.shouldHandle(dm({ authorId: BOT }), BOT).handle === false, 'our own message → skipped');
ok(a.shouldHandle(dm({ authorBot: true }), BOT).handle === false, 'another bot → skipped');
ok(a.shouldHandle(dm({ authorId: 'stranger' }), BOT).handle === false, 'a non-owner → skipped (owner-gated)');
ok(a.shouldHandle(dm({ isDM: false, mentionedBot: false }), BOT).handle === false, 'a server message with NO @mention → skipped');
const mentioned = a.shouldHandle({ authorId: 'owner-1', authorBot: false, isDM: false, mentionedBot: true, content: '<@999> summarize this' }, BOT);
ok(mentioned.handle === true && mentioned.text === 'summarize this', 'an @mention in a server → handled, mention stripped');
ok(a.shouldHandle(dm({ content: '   ' }), BOT).handle === false, 'an empty prompt → skipped');

console.log('\n=== no owner set → FAIL CLOSED (serves nobody) unless explicitly opted into an open bot ===');
const closed = new DiscordAdapter({ verbose: false });
ok(closed.shouldHandle(dm({ authorId: 'anyone' }), BOT).handle === false, 'no owner configured → nobody is handled (fail-closed)');
ok(/no owner/.test(closed.shouldHandle(dm({ authorId: 'anyone' }), BOT).reason), 'the skip reason names the missing owner + how to open it');
const open = new DiscordAdapter({ verbose: false, allowAnyone: true });
ok(open.shouldHandle(dm({ authorId: 'anyone' }), BOT).handle === true, 'allowAnyone opt-in → an open bot handles anyone in a DM');
ok(open.shouldHandle(dm({ authorId: BOT }), BOT).handle === false, 'an open bot still skips its own messages');

console.log('\n=== reply chunking to the 2000-char limit ===');
const long = 'x'.repeat(5000);
const parts = DiscordAdapter.chunk(long);
ok(parts.length >= 3 && parts.every((p) => p.length <= 1900), 'a 5000-char reply splits into ≤1900-char chunks');
ok(DiscordAdapter.chunk('short').length === 1, 'a short reply stays one message');
const nlParts = DiscordAdapter.chunk('a'.repeat(1000) + '\n' + 'b'.repeat(1000)); // 2001 chars, one newline
ok(nlParts.length === 2 && nlParts[0] === 'a'.repeat(1000), 'splits on the newline (first chunk ends cleanly at it)');

console.log('\n=== prompt routing to the local gateway (injected fetch) ===');
let seen = null;
const adapter = new DiscordAdapter({ port: 4099, model: 'local', verbose: false, fetch: async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { json: async () => ({ choices: [{ message: { content: 'agent says hi' } }] }) }; } });
const reply = await adapter.askAgent('what is the weather');
ok(reply === 'agent says hi', 'returns the gateway completion content');
ok(seen.url === 'http://127.0.0.1:4099/v1/chat/completions', 'routes to the local gateway chat endpoint');
ok(seen.body.messages[0].content === 'what is the weather' && seen.body.model === 'local', 'sends the prompt + configured model');
const empty = new DiscordAdapter({ verbose: false, fetch: async () => ({ json: async () => ({}) }) });
ok((await empty.askAgent('x')) === '(no response from the agent)', 'a malformed gateway response → safe fallback');

console.log('\n=== no token → start() is a safe no-op (dry-run) ===');
ok((await new DiscordAdapter({ token: null, verbose: false }).start()) === false, 'start() with no token returns false, never throws');

console.log(`\n✅ ALL ${pass} discord-adapter checks passed.`);
